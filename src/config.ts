import dotenv from 'dotenv';
// Ensure .env values override any existing environment variables (e.g., system-level)
dotenv.config({ override: true });

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
  flowBaseUrl: process.env.FLOW_BASE_URL || 'https://www.flow.cl/api',
  usdToPen: Number(process.env.USD_TO_PEN || 3.8),
  flowMonthlyPlan: process.env.FLOW_PLAN_MONTH_ID || 'contapro-month',
  flowAnnualPlan: process.env.FLOW_PLAN_YEAR_ID || 'contapro-year',
  flowForcePayment: String(process.env.FLOW_FORCE_PAYMENT || '').toLowerCase() === 'true',
};