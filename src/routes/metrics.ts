import type { FastifyPluginAsync } from 'fastify';
import client from 'prom-client';

const collectDefaultMetrics = client.collectDefaultMetrics;
collectDefaultMetrics({ prefix: 'contapro_' });

export const metricsRoutes: FastifyPluginAsync = async (app) => {
  app.get('/', { schema: { summary: 'Prometheus metrics' } }, async (_req, res) => {
    res.header('Content-Type', client.register.contentType);
    return res.send(await client.register.metrics());
  });
};