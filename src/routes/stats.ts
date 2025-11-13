import type { FastifyPluginAsync } from 'fastify';

export const statsRoutes: FastifyPluginAsync = async (app) => {
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

  // Sumas por categoría del mes dado
  app.get('/expenses/by-category', { schema: { summary: 'Gastos por categoría (mes)' } }, async (req, res) => {
    const userId = requireAuth(req, res);
    if (!userId) return;
    const q = (req.query || {}) as Record<string, string>;
    const now = new Date();
    const month = q.month ? Number(q.month) : now.getMonth() + 1;
    const year = q.year ? Number(q.year) : now.getFullYear();
    const start = new Date(year, month - 1, 1);
    const end = new Date(year, month, 0, 23, 59, 59, 999);
    const items = await app.prisma.expense.findMany({ where: { userId, issuedAt: { gte: start, lte: end } }, include: { category: true } });
    const map = new Map<string, number>();
    for (const it of items) {
      const key = it.category?.name || 'Sin categoría';
      map.set(key, (map.get(key) || 0) + it.amount);
    }
    const out = Array.from(map.entries()).map(([category, total]) => ({ category, total }));
    return res.send({ ok: true, items: out, month, year });
  });

  // Sumas por mes del año dado
  app.get('/expenses/by-month', { schema: { summary: 'Gastos por mes (año)' } }, async (req, res) => {
    const userId = requireAuth(req, res);
    if (!userId) return;
    const q = (req.query || {}) as Record<string, string>;
    const now = new Date();
    const year = q.year ? Number(q.year) : now.getFullYear();
    const start = new Date(year, 0, 1);
    const end = new Date(year, 11, 31, 23, 59, 59, 999);
    const items = await app.prisma.expense.findMany({ where: { userId, issuedAt: { gte: start, lte: end } } });
    const arr = Array.from({ length: 12 }, () => 0);
    for (const it of items) {
      const m = new Date(it.issuedAt).getMonth();
      arr[m] += it.amount;
    }
    const out = arr.map((total, i) => ({ month: i + 1, total }));
    return res.send({ ok: true, items: out, year });
  });
};