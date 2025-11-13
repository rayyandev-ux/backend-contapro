import 'dotenv/config';

export const config = {
  port: Number(process.env.PORT || 8080),
  jwtSecret: String(process.env.JWT_SECRET || 'dev-secret'),
  cacheTtlSeconds: Number(process.env.CACHE_TTL_SECONDS || 900),
  rateLimitMax: Number(process.env.RATE_LIMIT_MAX || 100),
  adminEmail: process.env.ADMIN_EMAIL || '',
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || '',
  telegramBotName: process.env.TELEGRAM_BOT_NAME || '',
  cookieDomain: process.env.COOKIE_DOMAIN || '',
};