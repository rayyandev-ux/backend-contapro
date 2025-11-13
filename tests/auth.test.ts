import { describe, it, expect, beforeAll } from 'vitest';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import jwt from '@fastify/jwt';
import { prisma } from '../src/plugins/prisma';
import { authRoutes } from '../src/routes/auth';

describe('auth', () => {
  const app = Fastify();
  beforeAll(async () => {
    await app.register(prisma);
    await app.register(cookie);
    await app.register(jwt, { secret: 'test-secret' });
    await app.register(authRoutes, { prefix: '/api/auth' });
  });

  it('registers and logs in', async () => {
    const email = `test${Math.random()}@example.com`;
    const reg = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { email, password: '123456' } });
    expect(reg.statusCode).toBe(200);
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: '123456' } });
    expect(login.statusCode).toBe(200);
  });
});