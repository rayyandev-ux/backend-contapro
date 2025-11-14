import type { FastifyInstance } from 'fastify';
import nodemailer from 'nodemailer';

type Locale = 'es' | 'en';

function renderTemplate(opts: { code: string; verifyUrl: string; brandName: string; brandColor: string; logoUrl?: string; locale: Locale }) {
  const { code, verifyUrl, brandName, brandColor, logoUrl, locale } = opts;
  const t = (key: string) => {
    const dict: Record<string, Record<Locale, string>> = {
      subject: { es: `Tu código de verificación - ${brandName}`, en: `Your verification code - ${brandName}` },
      heading: { es: 'Verifica tu cuenta', en: 'Verify your account' },
      intro: { es: 'Tu código de verificación es:', en: 'Your verification code is:' },
      button: { es: 'Verificar cuenta', en: 'Verify account' },
      footer: { es: 'Si no solicitaste este correo, ignóralo.', en: 'If you did not request this email, please ignore it.' },
    };
    return dict[key]?.[locale] || dict[key]?.es || key;
  };

  const text = `${t('intro')} ${code}\n\n${verifyUrl}`;
  const html = `
    <div style="font-family: Arial, sans-serif; background:#f9fafb; padding:24px;">
      <div style="max-width:600px; margin:0 auto; background:#ffffff; border:1px solid #e5e7eb; border-radius:12px;">
        <div style="padding:20px 24px; display:flex; align-items:center; gap:12px; border-bottom:1px solid #e5e7eb;">
          ${logoUrl ? `<img src="${logoUrl}" alt="${brandName}" style="height:32px;">` : ''}
          <strong style="font-size:16px; color:#111827;">${brandName}</strong>
        </div>
        <div style="padding:24px;">
          <h2 style="margin:0 0 12px; color:#111827; font-size:20px;">${t('heading')}</h2>
          <p style="margin:0 0 16px; color:#374151;">${t('intro')}</p>
          <div style="font-size:28px; font-weight:700; letter-spacing:6px; color:#111827; margin-bottom:16px;">${code}</div>
          <a href="${verifyUrl}" style="display:inline-block; background:${brandColor}; color:#ffffff; text-decoration:none; padding:10px 16px; border-radius:8px;">${t('button')}</a>
          <p style="margin-top:24px; color:#6b7280; font-size:12px;">${t('footer')}</p>
        </div>
      </div>
    </div>`;

  return { subject: t('subject'), text, html };
}

function renderResetTemplate(opts: { code: string; resetUrl: string; brandName: string; brandColor: string; logoUrl?: string; locale: Locale }) {
  const { code, resetUrl, brandName, brandColor, logoUrl, locale } = opts;
  const t = (key: string) => {
    const dict: Record<string, Record<Locale, string>> = {
      subject: { es: `Restablece tu contraseña - ${brandName}`, en: `Reset your password - ${brandName}` },
      heading: { es: 'Restablece tu contraseña', en: 'Reset your password' },
      intro: { es: 'Tu código para restablecer es:', en: 'Your reset code is:' },
      button: { es: 'Continuar al restablecimiento', en: 'Continue to reset' },
      footer: { es: 'Si no solicitaste este correo, ignóralo.', en: 'If you did not request this email, please ignore it.' },
    };
    return dict[key]?.[locale] || dict[key]?.es || key;
  };

  const text = `${t('intro')} ${code}\n\n${resetUrl}`;
  const html = `
    <div style="font-family: Arial, sans-serif; background:#f9fafb; padding:24px;">
      <div style="max-width:600px; margin:0 auto; background:#ffffff; border:1px solid #e5e7eb; border-radius:12px;">
        <div style="padding:20px 24px; display:flex; align-items:center; gap:12px; border-bottom:1px solid #e5e7eb;">
          ${logoUrl ? `<img src="${logoUrl}" alt="${brandName}" style="height:32px;">` : ''}
          <strong style="font-size:16px; color:#111827;">${brandName}</strong>
        </div>
        <div style="padding:24px;">
          <h2 style="margin:0 0 12px; color:#111827; font-size:20px;">${t('heading')}</h2>
          <p style="margin:0 0 16px; color:#374151;">${t('intro')}</p>
          <div style="font-size:28px; font-weight:700; letter-spacing:6px; color:#111827; margin-bottom:16px;">${code}</div>
          <a href="${resetUrl}" style="display:inline-block; background:${brandColor}; color:#ffffff; text-decoration:none; padding:10px 16px; border-radius:8px;">${t('button')}</a>
          <p style="margin-top:24px; color:#6b7280; font-size:12px;">${t('footer')}</p>
        </div>
      </div>
    </div>`;

  return { subject: t('subject'), text, html };
}

export async function sendVerificationEmail(app: FastifyInstance, to: string, code: string, options?: { locale?: Locale }) {
  const host = process.env.SMTP_HOST || 'smtp.maileroo.com';
  const port = Number(process.env.SMTP_PORT || 587);
  const secure = String(process.env.SMTP_SECURE || '').toLowerCase() === 'true' || port === 465;
  const user = process.env.MAILEROO_USER || '';
  const pass = process.env.MAILEROO_PASSWORD || '';
  const from = process.env.MAIL_FROM || 'ContaPRO <no-reply@contapro.lat>';
  const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
  const brandName = process.env.EMAIL_BRAND_NAME || 'ContaPRO';
  const brandColor = process.env.EMAIL_BRAND_COLOR || '#2563EB';
  const logoUrl = process.env.EMAIL_LOGO_URL || '';
  const locale: Locale = (options?.locale || (process.env.EMAIL_LOCALE as Locale) || 'es') as Locale;

  if (!user || !pass) {
    app.log.warn({ msg: 'Maileroo SMTP credentials missing. Email sending disabled.', to, code });
    // Fallback para desarrollo: log del código
    app.log.info({
      msg: 'Verification code (fallback)',
      to,
      code,
      verifyLink: `${frontendUrl}/verify?email=${encodeURIComponent(to)}`,
    });
    return;
  }

  const transport = nodemailer.createTransport({
    host,
    port,
    secure,
    auth: { user, pass },
  });

  const verifyUrl = `${frontendUrl}/verify?email=${encodeURIComponent(to)}`;
  const { subject, text, html } = renderTemplate({ code, verifyUrl, brandName, brandColor, logoUrl: logoUrl || undefined, locale });

  try {
    const info = await transport.sendMail({ from, to, subject, text, html });
    app.log.info({ msg: 'Verification email sent', to, messageId: info.messageId });
  } catch (err) {
    app.log.error({ msg: 'Failed to send verification email', to, err });
    throw err;
  }
}

export function generateCode(): string {
  // 6 dígitos
  return String(Math.floor(100000 + Math.random() * 900000));
}

export async function sendPasswordResetEmail(app: FastifyInstance, to: string, code: string, options?: { locale?: Locale }) {
  const host = process.env.SMTP_HOST || 'smtp.maileroo.com';
  const port = Number(process.env.SMTP_PORT || 587);
  const secure = String(process.env.SMTP_SECURE || '').toLowerCase() === 'true' || port === 465;
  const user = process.env.MAILEROO_USER || '';
  const pass = process.env.MAILEROO_PASSWORD || '';
  const from = process.env.MAIL_FROM || 'ContaPRO <no-reply@contapro.lat>';
  const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
  const brandName = process.env.EMAIL_BRAND_NAME || 'ContaPRO';
  const brandColor = process.env.EMAIL_BRAND_COLOR || '#2563EB';
  const logoUrl = process.env.EMAIL_LOGO_URL || '';
  const locale: Locale = (options?.locale || (process.env.EMAIL_LOCALE as Locale) || 'es') as Locale;

  if (!user || !pass) {
    app.log.warn({ msg: 'Maileroo SMTP credentials missing. Email sending disabled.', to, code });
    app.log.info({ msg: 'Password reset code (fallback)', to, code, resetUrl: `${frontendUrl}/reset?email=${encodeURIComponent(to)}` });
    return;
  }

  const transport = nodemailer.createTransport({ host, port, secure, auth: { user, pass } });
  const resetUrl = `${frontendUrl}/reset?email=${encodeURIComponent(to)}`;
  const { subject, text, html } = renderResetTemplate({ code, resetUrl, brandName, brandColor, logoUrl: logoUrl || undefined, locale });
  try {
    const info = await transport.sendMail({ from, to, subject, text, html });
    app.log.info({ msg: 'Password reset email sent', to, messageId: info.messageId });
  } catch (err) {
    app.log.error({ msg: 'Failed to send password reset email', to, err });
    throw err;
  }
}