import type { FastifyPluginAsync } from 'fastify';

export const historyRoutes: FastifyPluginAsync = async (app) => {
  app.get('/', { schema: { summary: 'Get history' } }, async (req, res) => {
    const token = req.cookies.session;
    if (!token) return res.unauthorized('No autenticado');
    try {
      const payload = app.jwt.verify(token) as { sub: string };
      const docs = await app.prisma.document.findMany({ where: { userId: payload.sub }, include: { analysis: true }, orderBy: { uploadedAt: 'desc' } });
      return res.send({ ok: true, items: docs.map(d => ({ id: d.id, filename: d.filename, uploadedAt: d.uploadedAt, summary: d.analysis?.summary, total: d.analysis?.total })) });
    } catch {
      return res.unauthorized('Token inválido');
    }
  });
};