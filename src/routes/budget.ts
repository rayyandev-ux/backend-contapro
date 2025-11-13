import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

export const budgetRoutes: FastifyPluginAsync = async (app) => {
  const SetBudgetBody = z.object({
    month: z.number().min(1).max(12),
    year: z.number().min(2000).max(3000),
    amount: z.number().positive(),
    currency: z.string().default('PEN'),
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

  app.get('/', { schema: { summary: 'Get monthly budget' } }, async (req, res) => {
    const userId = requireAuth(req, res);
    if (!userId) return;
    const q = (req.query || {}) as Record<string, string>;
    const now = new Date();
    const month = q.month ? Number(q.month) : now.getMonth() + 1;
    const year = q.year ? Number(q.year) : now.getFullYear();
    const source = (q.source || 'issued').toLowerCase(); // 'issued' | 'created'
    const start = new Date(year, month - 1, 1);
    const end = new Date(year, month, 0, 23, 59, 59, 999);
    const budget = await app.prisma.budget.findUnique({ where: { userId_year_month: { userId, year, month } } });
    const dateField = source === 'created' ? 'createdAt' : 'issuedAt';
    const spentAgg = await app.prisma.expense.aggregate({ _sum: { amount: true }, where: { userId, [dateField]: { gte: start, lte: end } } as any });
    const spent = spentAgg._sum.amount || 0;
    return res.send({ ok: true, budget, spent, remaining: (budget?.amount ?? 0) - spent });
  });

  app.post('/', { schema: { summary: 'Set monthly budget' } }, async (req, res) => {
    const userId = requireAuth(req, res);
    if (!userId) return;
    const parse = SetBudgetBody.safeParse(req.body);
    if (!parse.success) return res.badRequest('Datos inválidos');
    const { month, year, amount, currency } = parse.data;
    const up = await app.prisma.budget.upsert({
      where: { userId_year_month: { userId, month, year } },
      update: { amount, currency },
      create: { userId, month, year, amount, currency },
    });
    return res.send({ ok: true, budget: up });
  });
};