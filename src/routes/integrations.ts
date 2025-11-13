import type { FastifyPluginAsync } from 'fastify';
import { config } from '../config';

export const integrationsRoutes: FastifyPluginAsync = async (app) => {
  function requireAuth(req: any, res: any): string | void {
    const token = req.cookies.session;
    if (!token) {
      res.unauthorized('No autenticado');
      return;
    }
    try {
      const payload = app.jwt.verify(token) as { sub: string };
      return payload.sub;
    } catch {
      res.unauthorized('Token inválido');
      return;
    }
  }

  // Estado de Telegram
  app.get('/telegram/status', { schema: { summary: 'Estado de integracion Telegram' } }, async (req, res) => {
    const userId = requireAuth(req, res);
    if (!userId) return;
    if (!config.telegramBotToken) return res.send({ ok: false, error: 'Bot no configurado' });
    const user = await app.prisma.user.findUnique({ where: { id: userId }, select: { telegramId: true } });
    const me = await (app as any).telegram?.getMe();
    return res.send({ ok: true, linked: !!user?.telegramId, botUsername: me?.username || config.telegramBotName || undefined });
  });

  // Generar código y deep-link
  app.post('/telegram/link', { schema: { summary: 'Generar link de vinculación Telegram' } }, async (req, res) => {
    const userId = requireAuth(req, res);
    if (!userId) return;
    if (!config.telegramBotToken) return res.badRequest('Bot no configurado');
    const me = await (app as any).telegram?.getMe();
    const username = me?.username || config.telegramBotName;
    if (!username) return res.badRequest('Nombre de bot no disponible');
    const code = Math.random().toString(36).slice(2, 8);
    const key = `tg_link:${code}`;
    await app.prisma.aiCache.upsert({
      where: { key },
      update: { value: { userId }, ttl: 600 },
      create: { key, value: { userId }, ttl: 600 },
    });
    const deepLink = `https://t.me/${username}?start=${code}`;
    return res.send({ ok: true, code, deepLink, botUsername: username });
  });

  // Desvincular
  app.post('/telegram/unlink', { schema: { summary: 'Desvincular Telegram' } }, async (req, res) => {
    const userId = requireAuth(req, res);
    if (!userId) return;
    await app.prisma.user.update({ where: { id: userId }, data: { telegramId: null } });
    return res.send({ ok: true });
  });

  // Probar envío
  app.post('/telegram/test', { schema: { summary: 'Enviar mensaje de prueba por Telegram' } }, async (req, res) => {
    const userId = requireAuth(req, res);
    if (!userId) return;
    const user = await app.prisma.user.findUnique({ where: { id: userId }, select: { telegramId: true } });
    if (!user?.telegramId) return res.badRequest('No vinculado');
    await (app as any).telegram?.sendMessage(user.telegramId, '🔔 Prueba de notificación desde ContaPRO');
    return res.send({ ok: true });
  });
};