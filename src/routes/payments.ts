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
    const currency: 'USD' | 'PEN' = 'USD';

    const amountUsd = plan === 'MONTHLY' ? 4.99 : 24.99;
    const amount = amountUsd;
    const user = await app.prisma.user.findUnique({ where: { id: userId }, select: { email: true } });
    if (!user) return res.unauthorized('No autenticado');

    const orderId = `cp${Math.random().toString(36).slice(2,10)}${Date.now().toString(36).slice(-4)}`; // ~14 chars, alphanumeric
    await app.prisma.payment.create({ data: { userId, provider: 'FLOW', orderId, period: plan, currency, amount, status: 'PENDING' } });

    const subject = `ContaPRO Premium ${plan === 'MONTHLY' ? 'Mensual' : 'Anual'}`;
    const urlReturn = `${config.frontendUrl}/payments/success`;
    const urlNotify = `${config.backendPublicUrl}/api/payments/flow/webhook`;
    try {
      const flowPlan = plan === 'ANNUAL' ? config.flowAnnualPlan : config.flowMonthlyPlan;
      const { url } = await createPaymentLink({ email: user.email, amount, currency, orderId, subject, urlReturn, urlNotify, flowPlan });
      // Log diagnostic info for troubleshooting redirect issues
      app.log.info({ orderId, plan, currency, flowPlan, url }, 'Flow checkout created');
      return res.send({ ok: true, redirectUrl: url });
    } catch (e: any) {
      await app.prisma.payment.update({ where: { orderId }, data: { status: 'CANCELLED' } }).catch(() => {});
      return res.internalServerError(e?.message || 'Error creando pago');
    }
  });

  // Defensive handler: some clients may attempt GET to this endpoint.
  // Keep semantics clear by responding with Method Not Allowed and guidance.
  app.get('/checkout', async (req, res) => {
    res.code(405).send({ ok: false, error: 'Method Not Allowed', message: 'Use POST /api/payments/checkout' });
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