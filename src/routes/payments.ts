import type { FastifyPluginAsync } from 'fastify';
import { config } from '../config.js';
import { createPaymentLink, verifyWebhookSignature } from '../services/flow.js';

export const paymentsRoutes: FastifyPluginAsync = async (app) => {
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

  app.post('/checkout', { schema: { summary: 'Create Flow payment checkout' } }, async (req, res) => {
    const userId = requireAuth(req, res);
    if (!userId) return;
    const body: any = req.body || {};
    const plan: 'MONTHLY' | 'ANNUAL' = (body.plan === 'ANNUAL' ? 'ANNUAL' : 'MONTHLY');
    const currency: 'USD' | 'PEN' = (body.currency === 'PEN' ? 'PEN' : 'USD');

    const amountUsd = plan === 'MONTHLY' ? 4.99 : 24.99;
    const amount = currency === 'USD' ? amountUsd : Number((amountUsd * config.usdToPen).toFixed(2));
    const user = await app.prisma.user.findUnique({ where: { id: userId }, select: { email: true } });
    if (!user) return res.unauthorized('No autenticado');

    const orderId = `cp_${Date.now()}_${Math.random().toString(36).slice(2,8)}`;
    await app.prisma.payment.create({ data: { userId, provider: 'FLOW', orderId, period: plan, currency, amount, status: 'PENDING' } });

    const subject = `ContaPRO Premium ${plan === 'MONTHLY' ? 'Mensual' : 'Anual'}`;
    const urlReturn = `${config.frontendUrl}/payments/success`;
    const urlNotify = `${config.backendPublicUrl}/api/payments/flow/webhook`;
    try {
      const { url } = await createPaymentLink({ email: user.email, amount, currency, orderId, subject, urlReturn, urlNotify });
      return res.send({ ok: true, redirectUrl: url });
    } catch (e: any) {
      await app.prisma.payment.update({ where: { orderId }, data: { status: 'CANCELLED' } }).catch(() => {});
      return res.internalServerError(e?.message || 'Error creando pago');
    }
  });

  app.post('/flow/webhook', { schema: { summary: 'Flow webhook' } }, async (req, res) => {
    const body: any = req.body || {};
    // expected fields: commerceOrder, status, s(signature)
    if (!verifyWebhookSignature(body)) {
      return res.badRequest('Firma inválida');
    }
    const orderId = String(body.commerceOrder || body.orderId || '');
    const status = String(body.status || '').toUpperCase();
    if (!orderId) return res.badRequest('Sin orderId');

    const payment = await app.prisma.payment.findUnique({ where: { orderId } });
    if (!payment) return res.notFound('Pago no encontrado');

    if (status === 'SUCCESS' || status === 'PAID') {
      await app.prisma.payment.update({ where: { orderId }, data: { status: 'PAID' } });
      const months = payment.period === 'ANNUAL' ? 12 : 1;
      const now = new Date();
      const user = await app.prisma.user.findUnique({ where: { id: payment.userId }, select: { planExpires: true } });
      const base = user?.planExpires && user.planExpires > now ? user.planExpires : now;
      const expires = new Date(base);
      expires.setMonth(expires.getMonth() + months);
      await app.prisma.user.update({ where: { id: payment.userId }, data: { plan: 'PREMIUM', planExpires: expires } });
      return res.send({ ok: true });
    }
    if (status === 'CANCELLED' || status === 'FAILED') {
      await app.prisma.payment.update({ where: { orderId }, data: { status: 'CANCELLED' } });
      return res.send({ ok: true });
    }
    return res.send({ ok: true });
  });
};