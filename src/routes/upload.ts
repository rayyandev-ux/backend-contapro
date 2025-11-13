import type { FastifyPluginAsync } from 'fastify';
import multipart from '@fastify/multipart';
import { createOpenAI } from '../services/openai.js';
import sharp from 'sharp';
import fs from 'node:fs/promises';
import path from 'node:path';

export const uploadRoutes: FastifyPluginAsync = async (app) => {
  app.register(multipart);

  app.post('/', { schema: { summary: 'Upload document' } }, async (req, res) => {
    const token = req.cookies.session;
    if (!token) return res.unauthorized('No autenticado');
    let userId: string;
    try {
      const payload = app.jwt.verify(token) as { sub: string };
      userId = payload.sub;
    } catch {
      return res.unauthorized('Token inválido');
    }

    const mp = await (req as any).file();
    if (!mp) return res.badRequest('Archivo requerido');

    const filename = mp.filename as string;
    const mimeType = mp.mimetype as string;
    const buf = await mp.toBuffer();

    app.log.info({ msg: 'upload: received file', filename, mimeType, size: buf.length });

    // Preprocess image to improve OCR/vision robustness (rotate, grayscale, normalize, resize, PNG)
    let analysisBuffer: Buffer = buf;
    let analysisMime: string = mimeType;
    try {
      if (mimeType?.startsWith('image/')) {
        const processed = await sharp(buf)
          .rotate() // auto orient
          .greyscale()
          .normalize()
          .resize({ width: 2000, withoutEnlargement: true })
          .png({ compressionLevel: 9 })
          .toBuffer();
        analysisBuffer = processed;
        analysisMime = 'image/png';
      }
    } catch {}

    // Ensure uploads directory
    const uploadsDir = path.join(process.cwd(), 'uploads');
    await fs.mkdir(uploadsDir, { recursive: true });
    // Save file to disk with a unique name
    const uniqueName = `${Date.now()}_${filename.replace(/[^a-zA-Z0-9_.-]/g, '_')}`;
    const filePath = path.join(uploadsDir, uniqueName);
    await fs.writeFile(filePath, buf);

    // Create document record
    const doc = await app.prisma.document.create({ data: { userId, filename, mimeType, storagePath: filePath } });

    // Ask AI to extract structured fields and classify
    const ai = createOpenAI(app);
    const extraction = await ai.extractExpenseFields(app, {
      filename,
      mimeType: analysisMime,
      size: analysisBuffer.length,
    }, analysisBuffer);

    app.log.info({ msg: 'upload: extraction summary', summary: extraction?.summary, totals: extraction?.totals, provider: extraction?.provider });

    // Enforce Free plan limits
    const user = await app.prisma.user.findUnique({ where: { id: userId } });
    if (!user) return res.unauthorized('No autenticado');
    const type = extraction.type as 'FACTURA' | 'BOLETA';
    if (user.plan === 'FREE') {
      const issued = new Date(extraction.issuedAt ?? Date.now());
      const start = new Date(issued.getFullYear(), issued.getMonth(), 1);
      const end = new Date(issued.getFullYear(), issued.getMonth() + 1, 0, 23, 59, 59, 999);
      const count = await app.prisma.expense.count({ where: { userId, type, issuedAt: { gte: start, lte: end } } });
      if (count >= 10) return res.tooManyRequests('Límite del plan Free alcanzado para ' + type.toLowerCase());
    }

    // Create expense from extraction
    const exp = await app.prisma.expense.create({
      data: {
        userId,
        type,
        source: 'DOCUMENT',
        issuedAt: new Date(extraction.issuedAt ?? Date.now()),
        provider: extraction.provider ?? 'Proveedor desconocido',
        description: extraction.description ?? undefined,
        amount: typeof extraction?.totals?.total === 'number' ? extraction.totals.total : 0,
        currency: extraction?.totals?.currency ?? 'PEN',
        categoryId: extraction.categoryId ?? null,
        documentId: doc.id,
      },
    });

    // Save analysis with structured details
    await app.prisma.analysis.create({ data: { documentId: doc.id, summary: extraction.summary ?? 'Documento procesado', total: exp.amount, details: extraction } });

    // Notify via Telegram if linked
    try {
      const tg: any = (app as any).telegram;
      if (tg && user.telegramId) {
        const currency = exp.currency || 'PEN';
        const amt = exp.amount.toFixed(2);
        const issued = new Date(exp.issuedAt).toLocaleDateString();
        const text = `🧾 Nuevo gasto registrado\nProveedor: ${exp.provider}\nMonto: ${amt} ${currency}\nFecha: ${issued}`;
        await tg.sendMessage(user.telegramId, text);
      }
    } catch (e) {
      app.log.error({ msg: 'telegram notify failed (upload)', e });
    }

    return res.send({ ok: true, summary: extraction.summary, expenseId: exp.id, json: extraction, xml: extraction.xml });
  });
};