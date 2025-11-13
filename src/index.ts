import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import sensible from '@fastify/sensible';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import jwt from '@fastify/jwt';
import { config } from './config';
import { prisma } from './plugins/prisma';
import { authRoutes } from './routes/auth';
import { historyRoutes } from './routes/history';
import { uploadRoutes } from './routes/upload';
import { metricsRoutes } from './routes/metrics';
import { expensesRoutes } from './routes/expenses';
import { budgetRoutes } from './routes/budget';
import { categoriesRoutes } from './routes/categories';
import { documentsRoutes } from './routes/documents';
import { adminRoutes } from './routes/admin';
import { statsRoutes } from './routes/stats';
import { integrationsRoutes } from './routes/integrations';
import { TelegramService } from './services/telegram';
import { analysisRoutes } from './routes/analysis';

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