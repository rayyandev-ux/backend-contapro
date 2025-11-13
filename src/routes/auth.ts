import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { hashPassword, verifyPassword } from '../services/hash.js';
import { config } from '../config.js';

export const authRoutes: FastifyPluginAsync = async (app) => {
  const RegisterBody = z.object({ email: z.string().email(), password: z.string().min(6), name: z.string().optional() });
  const LoginBody = z.object({ email: z.string().email(), password: z.string().min(6) });

  app.post('/register', {
    schema: { summary: 'Register', body: { type: 'object', properties: { email: { type: 'string' }, password: { type: 'string' }, name: { type: 'string' } } } }
  }, async (req, res) => {
    const parse = RegisterBody.safeParse(req.body);
    if (!parse.success) return res.badRequest('Datos inválidos');
    const { email, password, name } = parse.data;
    const exists = await app.prisma.user.findUnique({ where: { email } });
    if (exists) return res.conflict('Usuario ya existe');
    const hashed = await hashPassword(password);
    const user = await app.prisma.user.create({ data: { email, password: hashed, name, role: config.adminEmail && email === config.adminEmail ? 'ADMIN' : 'USER' } });
    const token = app.jwt.sign({ sub: user.id }, { expiresIn: '7d' });
    res.setCookie('session', token, {
      httpOnly: true,
      sameSite: 'none',
      path: '/',
      secure: process.env.NODE_ENV === 'production',
      domain: config.cookieDomain || undefined,
    });
    return res.send({ ok: true });
  });

  app.post('/login', {
    schema: { summary: 'Login', body: { type: 'object', properties: { email: { type: 'string' }, password: { type: 'string' } } } }
  }, async (req, res) => {
    const parse = LoginBody.safeParse(req.body);
    if (!parse.success) return res.badRequest('Datos inválidos');
    const { email, password } = parse.data;
    const user = await app.prisma.user.findUnique({ where: { email } });
    if (!user) return res.unauthorized('Credenciales inválidas');
    const ok = await verifyPassword(user.password, password);
    if (!ok) return res.unauthorized('Credenciales inválidas');
    // Escalar a ADMIN en login si coincide adminEmail
    if (config.adminEmail && email === config.adminEmail && user.role !== 'ADMIN') {
      await app.prisma.user.update({ where: { id: user.id }, data: { role: 'ADMIN' } });
    }
    const token = app.jwt.sign({ sub: user.id }, { expiresIn: '7d' });
    res.setCookie('session', token, {
      httpOnly: true,
      sameSite: 'none',
      path: '/',
      secure: process.env.NODE_ENV === 'production',
      domain: config.cookieDomain || undefined,
    });
    return res.send({ ok: true });
  });

  app.post('/logout', { schema: { summary: 'Logout' } }, async (_req, res) => {
    res.clearCookie('session', { path: '/', domain: config.cookieDomain || undefined });
    return res.code(204).send();
  });

  app.get('/me', { schema: { summary: 'Current user' } }, async (req, res) => {
    const token = req.cookies.session;
    if (!token) return res.unauthorized('No autenticado');
    try {
      const payload = app.jwt.verify(token) as { sub: string };
      const user = await app.prisma.user.findUnique({ where: { id: payload.sub }, select: { id: true, email: true, name: true, role: true, plan: true } });
      if (!user) return res.unauthorized('No autenticado');
      return res.send({ ok: true, user });
    } catch {
      return res.unauthorized('Token inválido');
    }
  });
};