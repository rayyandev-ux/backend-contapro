import type { FastifyPluginAsync } from 'fastify';
import { Prisma } from '@prisma/client';
import { z } from 'zod';

export const analysisRoutes: FastifyPluginAsync = async (app) => {
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

  const UpdateSummaryBody = z.object({ summary: z.string().min(1) });

  // Actualiza el resumen del análisis asociado a un documento
  app.patch('/:documentId/summary', { schema: { summary: 'Actualizar resumen de análisis' } }, async (req, res) => {
    const userId = requireAuth(req, res);
    if (!userId) return;
    const documentId = (req.params as any).documentId as string;

    // Validar cuerpo
    const parse = UpdateSummaryBody.safeParse(req.body);
    if (!parse.success) return res.badRequest('Datos inválidos');
    const { summary } = parse.data;

    // Verificar que el documento exista y sea del usuario
    const doc = await app.prisma.document.findUnique({ where: { id: documentId } });
    if (!doc || doc.userId !== userId) return res.notFound('Documento no encontrado');

    // Crear o actualizar análisis
    const existing = await app.prisma.analysis.findUnique({ where: { documentId } });
    if (existing) {
      const updated = await app.prisma.analysis.update({ where: { documentId }, data: { summary } });
      return res.send({ ok: true, analysis: updated });
    } else {
      const created = await app.prisma.analysis.create({ data: { documentId, summary, total: null, details: Prisma.JsonNull } });
      return res.send({ ok: true, analysis: created });
    }
  });
};