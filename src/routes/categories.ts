import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

export const categoriesRoutes: FastifyPluginAsync = async (app) => {
  const CreateBody = z.object({ name: z.string().min(2) });

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

  app.get('/', { schema: { summary: 'List categories' } }, async (_req, res) => {
    const cats = await app.prisma.category.findMany({ orderBy: { name: 'asc' } });
    return res.send({ ok: true, items: cats });
  });

  app.post('/', { schema: { summary: 'Create category' } }, async (req, res) => {
    const userId = requireAuth(req, res);
    if (!userId) return;
    const parse = CreateBody.safeParse(req.body);
    if (!parse.success) return res.badRequest('Datos inválidos');
    const { name } = parse.data;
    const exists = await app.prisma.category.findUnique({ where: { name } });
    if (exists) return res.conflict('Categoría ya existe');
    const cat = await app.prisma.category.create({ data: { name } });
    return res.send({ ok: true, item: cat });
  });
};