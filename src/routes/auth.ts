import type { FastifyPluginAsync } from 'fastify';
import crypto from 'node:crypto';
import { z } from 'zod';
import { hashPassword, verifyPassword } from '../services/hash.js';
import { sendVerificationEmail, sendPasswordResetEmail, generateCode } from '../services/email.js';
import { config } from '../config.js';

export const authRoutes: FastifyPluginAsync = async (app) => {
  const RegisterBody = z.object({ email: z.string().email(), password: z.string().min(6), name: z.string().optional() });
  const LoginBody = z.object({ email: z.string().email(), password: z.string().min(6), remember: z.boolean().optional() });
  const VerifyBody = z.object({ email: z.string().email(), code: z.string().length(6) });
  const ResendBody = z.object({ email: z.string().email() });
  const ForgotBody = z.object({ email: z.string().email() });
  const ResetBody = z.object({ email: z.string().email(), code: z.string().length(6), password: z.string().min(6) });

  function cookieOpts(req: any) {
    const isProd = process.env.NODE_ENV === 'production';
    const host = String(req.headers?.host || '').split(':')[0];
    const isLocalHost = host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
    const cfgDomain = (config.cookieDomain || '').trim();
    const domain = cfgDomain && cfgDomain !== 'localhost' && host.endsWith(cfgDomain) ? cfgDomain : undefined;
    return {
      httpOnly: true,
      // En localhost, usar Lax para evitar el bloqueo de Chrome (SameSite=None requiere Secure)
      sameSite: (isLocalHost ? 'lax' : 'none') as const,
      path: '/',
      secure: isProd,
      domain,
    };
  }

  // Registro con verificación por código
  app.post('/register', {
    schema: { summary: 'Register (with email verification)', body: { type: 'object', properties: { email: { type: 'string' }, password: { type: 'string' }, name: { type: 'string' } } } }
  }, async (req, res) => {
    const parse = RegisterBody.safeParse(req.body);
    if (!parse.success) return res.badRequest('Datos inválidos');
    const { email, password, name } = parse.data;
    const exists = await app.prisma.user.findUnique({ where: { email } });
    if (exists) return res.conflict('Usuario ya existe');
    const hashed = await hashPassword(password);
    const code = generateCode();
    const expires = new Date(Date.now() + 15 * 60 * 1000); // 15 minutos
    await app.prisma.user.create({
      data: {
        email,
        password: hashed,
        name,
        role: config.adminEmail && email === config.adminEmail ? 'ADMIN' : 'USER',
        emailVerified: false,
        verificationCode: code,
        verificationExpires: expires,
        trialEnds: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      },
    });
    const locale = String((req.headers as any)['accept-language'] || '').toLowerCase().startsWith('en') ? 'en' : 'es';
    await sendVerificationEmail(app, email, code, { locale });
    return res.send({ ok: true, needsVerification: true });
  });

  // Login sólo si email verificado
  app.post('/login', {
    schema: { summary: 'Login', body: { type: 'object', properties: { email: { type: 'string' }, password: { type: 'string' }, remember: { type: 'boolean' } } } }
  }, async (req, res) => {
    const parse = LoginBody.safeParse(req.body);
    if (!parse.success) return res.badRequest('Datos inválidos');
    const { email, password, remember } = parse.data;
    const user = await app.prisma.user.findUnique({ where: { email } });
    if (!user) return res.unauthorized('Credenciales inválidas');
    const ok = await verifyPassword(user.password, password);
    if (!ok) return res.unauthorized('Credenciales inválidas');
    if (!user.emailVerified) return res.forbidden('Cuenta no verificada');
    // Escalar a ADMIN en login si coincide adminEmail
    if (config.adminEmail && email === config.adminEmail && user.role !== 'ADMIN') {
      await app.prisma.user.update({ where: { id: user.id }, data: { role: 'ADMIN' } });
    }
    const expiresIn = remember ? '30d' : '7d';
    const token = app.jwt.sign({ sub: user.id }, { expiresIn });
    const baseOpts = cookieOpts(req);
    res.setCookie('session', token, { ...baseOpts, maxAge: remember ? 30 * 24 * 60 * 60 : undefined });
    return res.send({ ok: true });
  });

  // Verificar código
  app.post('/verify', { schema: { summary: 'Verify email by code' } }, async (req, res) => {
    const parse = VerifyBody.safeParse(req.body);
    if (!parse.success) return res.badRequest('Datos inválidos');
    const { email, code } = parse.data;
    const user = await app.prisma.user.findUnique({ where: { email } });
    if (!user || user.emailVerified !== false) return res.badRequest('Estado inválido');
    if (!user.verificationCode || !user.verificationExpires) return res.badRequest('No hay código activo');
    const now = Date.now();
    if (user.verificationCode !== code) return res.badRequest('Código inválido');
    if (user.verificationExpires.getTime() < now) return res.badRequest('Código expirado');
    const updated = await app.prisma.user.update({
      where: { id: user.id },
      data: { emailVerified: true, verificationCode: null, verificationExpires: null },
      select: { id: true },
    });
    const token = app.jwt.sign({ sub: updated.id }, { expiresIn: '7d' });
    res.setCookie('session', token, cookieOpts(req));
    return res.send({ ok: true });
  });

  // Reenviar código
  app.post('/resend', { schema: { summary: 'Resend verification code' } }, async (req, res) => {
    const parse = ResendBody.safeParse(req.body);
    if (!parse.success) return res.badRequest('Datos inválidos');
    const { email } = parse.data;
    const user = await app.prisma.user.findUnique({ where: { email } });
    if (!user) return res.notFound('No existe');
    if (user.emailVerified) return res.badRequest('Ya verificado');
    const code = generateCode();
    const expires = new Date(Date.now() + 15 * 60 * 1000);
    await app.prisma.user.update({ where: { id: user.id }, data: { verificationCode: code, verificationExpires: expires } });
    const locale = String((req.headers as any)['accept-language'] || '').toLowerCase().startsWith('en') ? 'en' : 'es';
    await sendVerificationEmail(app, email, code, { locale });
    return res.send({ ok: true });
  });

  // Solicitar recuperación de contraseña
  app.post('/forgot', { schema: { summary: 'Forgot password (request reset code)' } }, async (req, res) => {
    const parse = ForgotBody.safeParse(req.body);
    if (!parse.success) return res.badRequest('Datos inválidos');
    const { email } = parse.data;
    const user = await app.prisma.user.findUnique({ where: { email } });
    // Responder siempre ok para no revelar existencia
    if (!user) {
      return res.send({ ok: true });
    }
    const code = generateCode();
    const expires = new Date(Date.now() + 15 * 60 * 1000);
    await app.prisma.user.update({ where: { id: user.id }, data: { resetCode: code, resetExpires: expires } });
    const locale = String((req.headers as any)['accept-language'] || '').toLowerCase().startsWith('en') ? 'en' : 'es';
    await sendPasswordResetEmail(app, email, code, { locale });
    return res.send({ ok: true });
  });

  // Restablecer contraseña con código
  app.post('/reset', { schema: { summary: 'Reset password by code' } }, async (req, res) => {
    const parse = ResetBody.safeParse(req.body);
    if (!parse.success) return res.badRequest('Datos inválidos');
    const { email, code, password } = parse.data;
    const user = await app.prisma.user.findUnique({ where: { email } });
    if (!user || !user.resetCode || !user.resetExpires) return res.badRequest('Código inválido');
    const now = Date.now();
    if (user.resetCode !== code) return res.badRequest('Código inválido');
    if (user.resetExpires.getTime() < now) return res.badRequest('Código expirado');
    const hashed = await hashPassword(password);
    const updated = await app.prisma.user.update({ where: { id: user.id }, data: { password: hashed, resetCode: null, resetExpires: null }, select: { id: true } });
    const token = app.jwt.sign({ sub: updated.id }, { expiresIn: '7d' });
    res.setCookie('session', token, cookieOpts(req));
    return res.send({ ok: true });
  });

  app.post('/logout', { schema: { summary: 'Logout' } }, async (req, res) => {
    const opts = cookieOpts(req);
    res.clearCookie('session', { path: '/', domain: opts.domain });
    return res.code(204).send();
  });

  app.get('/me', { schema: { summary: 'Current user' } }, async (req, res) => {
    const token = req.cookies.session;
    if (!token) return res.unauthorized('No autenticado');
    try {
      const payload = app.jwt.verify(token) as { sub: string };
      const user = await app.prisma.user.findUnique({
        where: { id: payload.sub },
        select: { id: true, email: true, name: true, role: true, plan: true, emailVerified: true, trialEnds: true, planExpires: true },
      });
      if (!user) return res.unauthorized('No autenticado');
      return res.send({ ok: true, user });
    } catch {
      return res.unauthorized('Token inválido');
    }
  });

  // Callback de Google OAuth2
  app.get('/google/callback', { schema: { summary: 'Google OAuth callback' } }, async (req, res) => {
    if (!(app as any).googleOAuth2) {
      return res.serviceUnavailable('OAuth no configurado');
    }
    try {
      const token = await (app as any).googleOAuth2.getAccessTokenFromAuthorizationCodeFlow(req);
      const accessToken: string = token?.access_token;
      if (!accessToken) return res.badRequest('Token inválido');
      const uinfoRes = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', { headers: { Authorization: `Bearer ${accessToken}` } });
      const uinfo = await uinfoRes.json().catch(() => ({}));
      const email = String(uinfo?.email || '').toLowerCase();
      const googleId = String(uinfo?.sub || '');
      const emailVerified = Boolean(uinfo?.email_verified);
      if (!email || !googleId) return res.badRequest('Perfil de Google incompleto');

      let user = await app.prisma.user.findFirst({ where: { OR: [{ googleId }, { email }] } });
      if (!user) {
        const randomPass = await hashPassword('oauth-google:' + crypto.randomUUID());
        user = await app.prisma.user.create({
          data: {
            email,
            password: randomPass,
            name: uinfo?.name || undefined,
            role: email === config.adminEmail ? 'ADMIN' : 'USER',
            googleId,
            emailVerified: emailVerified || true,
          },
        });
      } else if (!user.googleId) {
        user = await app.prisma.user.update({ where: { id: user.id }, data: { googleId, emailVerified: emailVerified || user.emailVerified } });
      }

      const jwtToken = app.jwt.sign({ sub: user.id }, { expiresIn: '7d' });
      res.setCookie('session', jwtToken, {
        httpOnly: true,
        sameSite: 'lax',
        path: '/',
        secure: process.env.NODE_ENV === 'production',
        domain: (config.cookieDomain || undefined) || undefined,
      });
      const dest = config.frontendUrl + '/dashboard';
      res.redirect(dest);
    } catch (e) {
      app.log.error({ msg: 'Google OAuth error', error: String(e) });
      return res.internalServerError('OAuth error');
    }
  });
};