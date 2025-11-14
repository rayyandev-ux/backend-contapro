import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

export const expensesRoutes: FastifyPluginAsync = async (app) => {
  const ManualExpenseBody = z.object({
    type: z.enum(['FACTURA', 'BOLETA']),
    issuedAt: z.string(),
    provider: z.string().min(1),
    description: z.string().optional(),
    amount: z.number().positive(),
    currency: z.string().default('PEN'),
    categoryId: z.string().optional(),
  });

  const UpdateExpenseBody = z.object({
    type: z.enum(['FACTURA', 'BOLETA']).optional(),
    issuedAt: z.string().optional(),
    provider: z.string().min(1).optional(),
    description: z.string().nullable().optional(),
    amount: z.number().positive().optional(),
    currency: z.string().optional(),
    // Permitir desasignar categoría con null
    categoryId: z.string().nullable().optional(),
  });

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

  app.get('/', { schema: { summary: 'List expenses' } }, async (req, res) => {
    const userId = requireAuth(req, res);
    if (!userId) return;

    const q = (req.query || {}) as Record<string, string>;
    const type = q.type as 'FACTURA' | 'BOLETA' | undefined;
    const provider = q.provider;
    const categoryId = q.categoryId;
    const start = q.start ? new Date(q.start) : undefined;
    const end = q.end ? new Date(q.end) : undefined;

    const where: any = { userId };
    if (type) where.type = type;
    if (provider) where.provider = { contains: provider, mode: 'insensitive' };
    if (categoryId) where.categoryId = categoryId;
    if (start || end) where.issuedAt = {};
    if (start) where.issuedAt.gte = start;
    if (end) where.issuedAt.lte = end;

    const items = await app.prisma.expense.findMany({ where, include: { category: true, document: true }, orderBy: { issuedAt: 'desc' } });
    return res.send({ ok: true, items });
  });

  app.get('/:id', { schema: { summary: 'Get expense' } }, async (req, res) => {
    const userId = requireAuth(req, res);
    if (!userId) return;
    const id = (req.params as any).id as string;
    const exp = await app.prisma.expense.findUnique({ where: { id }, include: { category: true, document: { include: { analysis: true } }, user: { select: { id: true, email: true } } } });
    if (!exp || exp.userId !== userId) return res.notFound('No encontrado');
    return res.send({ ok: true, item: exp });
  });

  app.delete('/:id', { schema: { summary: 'Delete expense' } }, async (req, res) => {
    const userId = requireAuth(req, res);
    if (!userId) return;
    const id = (req.params as any).id as string;
    const exp = await app.prisma.expense.findUnique({ where: { id } });
    if (!exp || exp.userId !== userId) return res.notFound('No encontrado');
    await app.prisma.expense.delete({ where: { id } });
    return res.code(204).send();
  });

  app.put('/:id', { schema: { summary: 'Update expense' } }, async (req, res) => {
    const userId = requireAuth(req, res);
    if (!userId) return;
    const id = (req.params as any).id as string;

    const exp = await app.prisma.expense.findUnique({ where: { id } });
    if (!exp || exp.userId !== userId) return res.notFound('No encontrado');

    const parse = UpdateExpenseBody.safeParse(req.body);
    if (!parse.success) return res.badRequest('Datos inválidos');
    const data = parse.data;

    const updateData: any = {};
    if (data.type) updateData.type = data.type;
    if (data.issuedAt) updateData.issuedAt = new Date(data.issuedAt);
    if (typeof data.provider === 'string') updateData.provider = data.provider;
    if (data.description !== undefined) updateData.description = data.description ?? null;
    if (typeof data.amount === 'number') updateData.amount = data.amount;
    if (typeof data.currency === 'string') updateData.currency = data.currency;
    if (data.categoryId !== undefined) updateData.categoryId = data.categoryId ?? null;

    const updated = await app.prisma.expense.update({ where: { id }, data: updateData, include: { category: true, document: true } });
    return res.send({ ok: true, item: updated });
  });

  app.post('/', { schema: { summary: 'Create manual expense' } }, async (req, res) => {
    const userId = requireAuth(req, res);
    if (!userId) return;

    const parse = ManualExpenseBody.safeParse(req.body);
    if (!parse.success) return res.badRequest('Datos inválidos');
    const data = parse.data;

    // Enforce plan limits considering Premium expiration
    const user = await app.prisma.user.findUnique({ where: { id: userId } });
    if (!user) return res.unauthorized('No autenticado');
    const now = new Date();
    const premiumActivo = user.plan === 'PREMIUM' && user.planExpires && user.planExpires > now;
    if (!premiumActivo) {
      const issued = new Date(data.issuedAt);
      const start = new Date(issued.getFullYear(), issued.getMonth(), 1);
      const end = new Date(issued.getFullYear(), issued.getMonth() + 1, 0, 23, 59, 59, 999);
      const count = await app.prisma.expense.count({ where: { userId, type: data.type, issuedAt: { gte: start, lte: end } } });
      if (count >= 10) return res.tooManyRequests('Límite del plan Free alcanzado para ' + data.type.toLowerCase());
    }

    const exp = await app.prisma.expense.create({
      data: {
        userId,
        type: data.type,
        source: 'MANUAL',
        issuedAt: new Date(data.issuedAt),
        provider: data.provider,
        description: data.description,
        amount: data.amount,
        currency: data.currency,
        categoryId: data.categoryId,
      },
    });
    // Notify via Telegram if linked
    try {
      const user = await app.prisma.user.findUnique({ where: { id: userId }, select: { telegramId: true } });
      const tg: any = (app as any).telegram;
      if (tg && user?.telegramId) {
        const amt = exp.amount.toFixed(2);
        const issued = new Date(exp.issuedAt).toLocaleDateString();
        const text = `✍️ Gasto manual creado\nProveedor: ${exp.provider}\nMonto: ${amt} ${exp.currency}\nFecha: ${issued}`;
        await tg.sendMessage(user.telegramId, text);
      }
    } catch (e) {
      app.log.error({ msg: 'telegram notify failed (manual expense)', e });
    }
    return res.send({ ok: true, item: exp });
  });
};