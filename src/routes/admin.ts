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
    const users = await app.prisma.user.findMany({ select: { id: true, email: true, name: true, plan: true, role: true, createdAt: true } });
    return res.send({ ok: true, items: users });
  });

  const UpdatePlanBody = z.object({ plan: z.enum(['FREE', 'PREMIUM']) });
  app.patch('/users/:id/plan', { schema: { summary: 'Cambiar plan (admin)' } }, async (req, res) => {
    const userId = requireAuth(req, res);
    if (!userId) return;
    if (!(await requireAdmin(userId, res))) return;
    const id = (req.params as any).id as string;
    const parse = UpdatePlanBody.safeParse(req.body);
    if (!parse.success) return res.badRequest('Datos inválidos');
    const { plan } = parse.data;
    const exists = await app.prisma.user.findUnique({ where: { id } });
    if (!exists) return res.notFound('Usuario no existe');
    const updated = await app.prisma.user.update({ where: { id }, data: { plan } });
    return res.send({ ok: true, user: { id: updated.id, plan: updated.plan } });
  });
};