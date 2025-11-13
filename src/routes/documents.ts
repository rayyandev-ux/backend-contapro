import type { FastifyPluginAsync } from 'fastify';
import fs from 'node:fs/promises';

export const documentsRoutes: FastifyPluginAsync = async (app) => {
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

  app.get('/:id/download', { schema: { summary: 'Descargar documento' } }, async (req, res) => {
    const userId = requireAuth(req, res);
    if (!userId) return;
    const id = (req.params as any).id as string;
    const doc = await app.prisma.document.findUnique({ where: { id } });
    if (!doc || doc.userId !== userId) return res.notFound('No encontrado');
    if (!doc.storagePath) return res.badRequest('Documento sin archivo');

    try {
      const file = await fs.readFile(doc.storagePath);
      res.header('Content-Type', doc.mimeType);
      const safeName = doc.filename.replace(/[^a-zA-Z0-9_.-]/g, '_');
      res.header('Content-Disposition', `attachment; filename="${safeName}"`);
      return res.send(file);
    } catch (e) {
      app.log.error(e);
      return res.internalServerError('No se pudo leer el archivo');
    }
  });

  // Vista previa inline del documento (útil para imágenes)
  app.get('/:id/preview', { schema: { summary: 'Previsualizar documento' } }, async (req, res) => {
    const userId = requireAuth(req, res);
    if (!userId) return;
    const id = (req.params as any).id as string;
    const doc = await app.prisma.document.findUnique({ where: { id } });
    if (!doc || doc.userId !== userId) return res.notFound('No encontrado');
    if (!doc.storagePath) return res.badRequest('Documento sin archivo');

    try {
      const file = await fs.readFile(doc.storagePath);
      res.header('Content-Type', doc.mimeType);
      const safeName = doc.filename.replace(/[^a-zA-Z0-9_.-]/g, '_');
      // inline para permitir que el navegador intente renderizar (imágenes, pdf)
      res.header('Content-Disposition', `inline; filename="${safeName}"`);
      return res.send(file);
    } catch (e) {
      app.log.error(e);
      return res.internalServerError('No se pudo leer el archivo');
    }
  });
};