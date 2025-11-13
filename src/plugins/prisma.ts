import fp from 'fastify-plugin';
import { PrismaClient } from '@prisma/client';

export const prisma = fp(async (fastify) => {
  const client = new PrismaClient();
  await client.$connect();
  fastify.decorate('prisma', client);
  fastify.addHook('onClose', async () => {
    await client.$disconnect();
  });
});

declare module 'fastify' {
  interface FastifyInstance {
    prisma: PrismaClient;
  }
}