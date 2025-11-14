import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import sensible from '@fastify/sensible';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import oauth2 from '@fastify/oauth2';
import jwt from '@fastify/jwt';
import { config } from './config.js';
import { prisma } from './plugins/prisma.js';
import { authRoutes } from './routes/auth.js';
import { historyRoutes } from './routes/history.js';
import { uploadRoutes } from './routes/upload.js';
import { metricsRoutes } from './routes/metrics.js';
import { expensesRoutes } from './routes/expenses.js';
import { budgetRoutes } from './routes/budget.js';
import { categoriesRoutes } from './routes/categories.js';
import { documentsRoutes } from './routes/documents.js';
import { adminRoutes } from './routes/admin.js';
import { statsRoutes } from './routes/stats.js';
import { integrationsRoutes } from './routes/integrations.js';
import { TelegramService } from './services/telegram.js';
import { analysisRoutes } from './routes/analysis.js';
import { paymentsRoutes } from './routes/payments.js';

async function buildServer() {
  const fastify = Fastify({ logger: true });

  await fastify.register(sensible);
  await fastify.register(helmet);
  await fastify.register(cors, { origin: true, credentials: true });
  await fastify.register(cookie, { hook: 'onRequest' });
  await fastify.register(jwt, { secret: config.jwtSecret });
  await fastify.register(rateLimit, { max: config.rateLimitMax, timeWindow: '1 minute' });
  await fastify.register(swagger, {
    openapi: {
      info: { title: 'ContaPRO API', version: '0.1.0' },
      servers: [{ url: 'http://localhost:' + config.port }],
    },
  });
  // Swagger UI opcional: se puede habilitar registrando '@fastify/swagger-ui' si está instalado

  // Plugins
  await fastify.register(prisma);

  // Google OAuth2 (opcional, requiere credenciales)
  try {
    const clientId = process.env.GOOGLE_CLIENT_ID?.trim();
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET?.trim();
    const callbackUri = (process.env.GOOGLE_CALLBACK_URL || `http://localhost:${config.port}/api/auth/google/callback`).trim();
    if (clientId && clientSecret) {
      await fastify.register(oauth2, {
        name: 'googleOAuth2',
        scope: ['profile', 'email'],
        credentials: {
          client: { id: clientId, secret: clientSecret },
          auth: oauth2.GOOGLE_CONFIGURATION,
        },
        startRedirectPath: '/api/auth/google',
        callbackUri,
      });
    } else {
      fastify.log.info('Google OAuth2 no configurado (faltan GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET).');
    }
  } catch (e) {
    fastify.log.warn({ msg: 'Error configurando OAuth2', error: String(e) });
  }

  // Routes
  await fastify.register(authRoutes, { prefix: '/api/auth' });
  await fastify.register(historyRoutes, { prefix: '/api/history' });
  await fastify.register(expensesRoutes, { prefix: '/api/expenses' });
  await fastify.register(uploadRoutes, { prefix: '/api/upload' });
  await fastify.register(categoriesRoutes, { prefix: '/api/categories' });
  await fastify.register(budgetRoutes, { prefix: '/api/budget' });
  await fastify.register(documentsRoutes, { prefix: '/api/documents' });
  await fastify.register(analysisRoutes, { prefix: '/api/analysis' });
  await fastify.register(integrationsRoutes, { prefix: '/api/integrations' });
  await fastify.register(paymentsRoutes, { prefix: '/api/payments' });
  await fastify.register(adminRoutes, { prefix: '/api/admin' });
  await fastify.register(statsRoutes, { prefix: '/api/stats' });
  await fastify.register(metricsRoutes, { prefix: '/metrics' });

  // Telegram bot polling (optional)
  if (config.telegramBotToken) {
    const tg = new TelegramService(fastify, config.telegramBotToken);
    (fastify as any).telegram = tg;
    tg.startPolling();
  }

  fastify.get('/health', async () => ({ ok: true }));

  return fastify;
}

buildServer()
  .then((app) => app.listen({ port: config.port, host: '0.0.0.0' }))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });