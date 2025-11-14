import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

export const adminRoutes: FastifyPluginAsync = async (app) => {
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

  async function requireAdmin(userId: string, res: any): Promise<boolean> {
    const user = await app.prisma.user.findUnique({ where: { id: userId }, select: { role: true } });
    if (!user || user.role !== 'ADMIN') {
      res.forbidden('Requiere rol admin');
      return false;
    }
    return true;
  }

  app.get('/users', { schema: { summary: 'Listar usuarios (admin)' } }, async (req, res) => {
    const userId = requireAuth(req, res);
    if (!userId) return;
    if (!(await requireAdmin(userId, res))) return;
    const users = await app.prisma.user.findMany({ select: { id: true, email: true, name: true, plan: true, role: true, createdAt: true, planExpires: true } });
    return res.send({ ok: true, items: users });
  });

  const UpdatePlanBody = z.object({
    plan: z.enum(['FREE', 'PREMIUM']),
    months: z.number().int().min(1).max(36).optional(),
    planExpires: z.string().optional(), // ISO string or YYYY-MM-DD
  });
  app.patch('/users/:id/plan', { schema: { summary: 'Cambiar plan y duración (admin)' } }, async (req, res) => {
    const userId = requireAuth(req, res);
    if (!userId) return;
    if (!(await requireAdmin(userId, res))) return;
    const id = (req.params as any).id as string;
    const parse = UpdatePlanBody.safeParse(req.body);
    if (!parse.success) return res.badRequest('Datos inválidos');
    const { plan, months, planExpires } = parse.data;
    const exists = await app.prisma.user.findUnique({ where: { id } });
    if (!exists) return res.notFound('Usuario no existe');
    let data: any = { plan };
    if (plan === 'PREMIUM') {
      // If explicit planExpires provided, use it; otherwise extend by months
      if (planExpires) {
        const exp = new Date(planExpires);
        if (isNaN(exp.getTime())) {
          return res.badRequest('Fecha de vencimiento inválida');
        }
        app.log.info({
          msg: 'admin:update_plan',
          targetUserId: id,
          plan,
          overrideExpiresInput: planExpires,
          newExpires: exp.toISOString(),
        });
        data.planExpires = exp;
      } else {
        const m = months ?? 1;
        const now = new Date();
        const base = exists?.planExpires && new Date(exists.planExpires) > now ? new Date(exists.planExpires) : now;
        const expires = new Date(base);
        expires.setMonth(expires.getMonth() + m);
        app.log.info({
          msg: 'admin:update_plan',
          targetUserId: id,
          plan,
          months: m,
          baseDate: base.toISOString(),
          newExpires: expires.toISOString(),
        });
        data.planExpires = expires;
      }
    } else {
      data.planExpires = null;
    }
    const updated = await app.prisma.user.update({ where: { id }, data });
    return res.send({ ok: true, user: { id: updated.id, plan: updated.plan, planExpires: updated.planExpires } });
  });

  app.delete('/users/:id', { schema: { summary: 'Eliminar usuario (admin)' } }, async (req, res) => {
    const userId = requireAuth(req, res);
    if (!userId) return;
    if (!(await requireAdmin(userId, res))) return;
    const id = (req.params as any).id as string;
    if (!id) return res.badRequest('ID inválido');
    if (id === userId) return res.badRequest('No puedes borrar tu propia cuenta desde admin');

    const exists = await app.prisma.user.findUnique({ where: { id }, select: { id: true } });
    if (!exists) return res.notFound('Usuario no existe');

    const docs = await app.prisma.document.findMany({ where: { userId: id }, select: { id: true } });
    const docIds = docs.map(d => d.id);

    const result: Record<string, number> = {};
    await app.prisma.$transaction(async (tx) => {
      const delExpenses = await tx.expense.deleteMany({ where: { userId: id } });
      result.expenses = delExpenses.count;
      const delAnalyses = await tx.analysis.deleteMany({ where: { documentId: { in: docIds } } });
      result.analyses = delAnalyses.count;
      const delDocuments = await tx.document.deleteMany({ where: { userId: id } });
      result.documents = delDocuments.count;
      const delBudgets = await tx.budget.deleteMany({ where: { userId: id } });
      result.budgets = delBudgets.count;
      const delPayments = await tx.payment.deleteMany({ where: { userId: id } });
      result.payments = delPayments.count;
      await tx.user.delete({ where: { id } });
    });

    app.log.info({ msg: 'admin:delete_user', targetUserId: id, deleted: result });
    return res.code(204).send();
  });
};