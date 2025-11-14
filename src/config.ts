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
  frontendUrl: process.env.FRONTEND_URL || 'http://localhost:3000',
  backendPublicUrl: process.env.BACKEND_PUBLIC_URL || 'http://localhost:8080',
  flowApiKey: process.env.FLOW_API_KEY || '',
  flowSecretKey: process.env.FLOW_SECRET_KEY || '',
  flowBaseUrl: process.env.FLOW_BASE_URL || 'https://www.flow.com.pe/api',
  usdToPen: Number(process.env.USD_TO_PEN || 3.8),
};