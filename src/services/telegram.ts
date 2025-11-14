import type { FastifyInstance } from 'fastify';
import sharp from 'sharp';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createOpenAI } from './openai.js';

type TelegramUpdate = {
  update_id: number;
  message?: {
    message_id: number;
    date: number;
    chat: { id: number; type: string; username?: string; first_name?: string };
    text?: string;
    caption?: string;
    document?: { file_id: string; file_name?: string; mime_type?: string; file_size?: number };
    photo?: Array<{ file_id: string; width?: number; height?: number; file_size?: number }>;
  };
};

export class TelegramService {
  private app: FastifyInstance;
  private token: string;
  private baseUrl: string;
  private offset = 0;
  private polling = false;
  private botUsername: string | undefined;

  constructor(app: FastifyInstance, token: string) {
    this.app = app;
    this.token = token;
    this.baseUrl = `https://api.telegram.org/bot${token}`;
  }

  async getMe(): Promise<{ username?: string } | null> {
    try {
      const res = await fetch(`${this.baseUrl}/getMe`);
      const data = await res.json();
      if (data?.ok) {
        this.botUsername = data.result?.username;
        return { username: this.botUsername };
      }
    } catch (e) {
      this.app.log.error({ msg: 'telegram getMe failed', e });
    }
    return null;
  }

  async sendMessage(chatId: string | number, text: string) {
    try {
      await fetch(`${this.baseUrl}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text })
      });
    } catch (e) {
      this.app.log.error({ msg: 'telegram sendMessage failed', e });
    }
  }

  private extractStartCode(text?: string): string | undefined {
    if (!text) return undefined;
    const t = text.trim();
    // Solo aceptar explícitamente "/start <code>" o "start <code>"
    const m = t.match(/^\/start\s+([A-Za-z0-9_-]{4,32})$/i) || t.match(/^start\s+([A-Za-z0-9_-]{4,32})$/i);
    return m ? m[1] : undefined;
  }

  private async completeLink(code: string, chatId: number) {
    // Lookup link code in AiCache with TTL
    const key = `tg_link:${code}`;
    const entry = await this.app.prisma.aiCache.findUnique({ where: { key } });
    if (!entry) return false;
    const ageSec = (Date.now() - new Date(entry.createdAt).getTime()) / 1000;
    if (ageSec > (entry.ttl || 0)) {
      await this.app.prisma.aiCache.delete({ where: { key } }).catch(() => {});
      return false;
    }
    const value = entry.value as any;
    const userId = value?.userId as string | undefined;
    if (!userId) return false;
    await this.app.prisma.user.update({ where: { id: userId }, data: { telegramId: String(chatId) } });
    await this.app.prisma.aiCache.delete({ where: { key } }).catch(() => {});
    return true;
  }

  private async getFilePath(fileId: string): Promise<string | null> {
    try {
      const res = await fetch(`${this.baseUrl}/getFile?file_id=${encodeURIComponent(fileId)}`);
      const data = await res.json();
      if (data?.ok && data.result?.file_path) return data.result.file_path as string;
    } catch (e) {
      this.app.log.error({ msg: 'telegram getFile failed', e });
    }
    return null;
  }

  private async downloadFile(filePath: string): Promise<Buffer | null> {
    try {
      const url = `https://api.telegram.org/file/bot${this.token}/${filePath}`;
      const res = await fetch(url);
      if (!res.ok) return null;
      const ab = await res.arrayBuffer();
      return Buffer.from(ab);
    } catch (e) {
      this.app.log.error({ msg: 'telegram download file failed', e });
      return null;
    }
  }

  private async findLinkedUser(chatId: number) {
    const user = await this.app.prisma.user.findFirst({ where: { telegramId: String(chatId) } });
    return user;
  }

  private async processUploadedBuffer(chatId: number, filename: string, mimeType: string, buf: Buffer) {
    const user = await this.findLinkedUser(chatId);
    if (!user) {
      await this.sendMessage(chatId, 'No estás vinculado. Genera un enlace desde el dashboard para vincular tu cuenta.');
      return;
    }

    // Preprocesar imagen similar al flujo web
    let analysisBuffer: Buffer = buf;
    let analysisMime: string = mimeType;
    try {
      if (mimeType?.startsWith('image/')) {
        const processed = await sharp(buf)
          .rotate()
          .greyscale()
          .normalize()
          .resize({ width: 2000, withoutEnlargement: true })
          .png({ compressionLevel: 9 })
          .toBuffer();
        analysisBuffer = processed;
        analysisMime = 'image/png';
      }
    } catch {}

    // Guardar archivo en uploads
    const uploadsDir = path.join(process.cwd(), 'uploads');
    await fs.mkdir(uploadsDir, { recursive: true });
    const uniqueName = `${Date.now()}_${(filename || 'archivo').replace(/[^a-zA-Z0-9_.-]/g, '_')}`;
    const filePath = path.join(uploadsDir, uniqueName);
    await fs.writeFile(filePath, buf);

    // Crear documento
    const doc = await this.app.prisma.document.create({ data: { userId: user.id, filename: filename || uniqueName, mimeType, storagePath: filePath } });

    // Extraer con IA
    const ai = createOpenAI(this.app);
    const extraction = await ai.extractExpenseFields(this.app, {
      filename: filename || uniqueName,
      mimeType: analysisMime,
      size: analysisBuffer.length,
    }, analysisBuffer);

    const type = (extraction.type as 'FACTURA' | 'BOLETA') || 'BOLETA';
    // Límite plan según expiración de Premium
    const now = new Date();
    const premiumActivo = user.plan === 'PREMIUM' && user.planExpires && user.planExpires > now;
    if (!premiumActivo) {
      const issued = new Date(extraction.issuedAt ?? Date.now());
      const start = new Date(issued.getFullYear(), issued.getMonth(), 1);
      const end = new Date(issued.getFullYear(), issued.getMonth() + 1, 0, 23, 59, 59, 999);
      const count = await this.app.prisma.expense.count({ where: { userId: user.id, type, issuedAt: { gte: start, lte: end } } });
      if (count >= 10) {
        await this.sendMessage(chatId, `Límite del plan Free alcanzado para ${type.toLowerCase()}.`);
        return;
      }
    }

    const exp = await this.app.prisma.expense.create({
      data: {
        userId: user.id,
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

    await this.app.prisma.analysis.create({ data: { documentId: doc.id, summary: extraction.summary ?? 'Documento procesado', total: exp.amount, details: extraction } });

    const amt = exp.amount.toFixed(2);
    const issuedStr = new Date(exp.issuedAt).toLocaleDateString();
    await this.sendMessage(chatId, `🧾 Documento analizado y gasto registrado\nProveedor: ${exp.provider}\nMonto: ${amt} ${exp.currency}\nFecha: ${issuedStr}`);
  }

  // Conversación para gasto manual (/add)
  private async getConv(chatId: number): Promise<any | null> {
    const key = `tg_conv:${chatId}`;
    const entry = await this.app.prisma.aiCache.findUnique({ where: { key } });
    return entry ? entry.value : null;
  }
  private async setConv(chatId: number, state: any) {
    const key = `tg_conv:${chatId}`;
    await this.app.prisma.aiCache.upsert({ where: { key }, update: { value: state, ttl: 900 }, create: { key, value: state, ttl: 900 } });
  }
  private async clearConv(chatId: number) {
    const key = `tg_conv:${chatId}`;
    await this.app.prisma.aiCache.delete({ where: { key } }).catch(() => {});
  }

  private async startManual(chatId: number) {
    const user = await this.findLinkedUser(chatId);
    if (!user) {
      await this.sendMessage(chatId, 'No estás vinculado. Vincula tu cuenta desde el dashboard.');
      return;
    }
    await this.setConv(chatId, { step: 'type', data: {} });
    await this.sendMessage(chatId, 'Crear gasto manual. Tipo? (FACTURA/BOLETA)');
  }

  private async handleManual(chatId: number, text: string) {
    const user = await this.findLinkedUser(chatId);
    if (!user) return;
    const conv = await this.getConv(chatId);
    if (!conv) return;
    const t = text.trim();
    const data = conv.data || {};
    const mapType = (s: string): 'FACTURA' | 'BOLETA' | null => {
      const v = s.trim().toLowerCase();
      if (['factura', 'fact', 'fac'].includes(v)) return 'FACTURA';
      if (['boleta', 'ticket', 'tiquete', 'bole', 'recibo', 'comprobante'].includes(v)) return 'BOLETA';
      return null;
    };
    switch (conv.step) {
      case 'type': {
        const mt = mapType(t) || t.toUpperCase();
        if (mt !== 'FACTURA' && mt !== 'BOLETA') {
          await this.sendMessage(chatId, 'Tipo inválido. Escribe FACTURA o BOLETA (también acepto: factura/fac, boleta/ticket/recibo).');
          return;
        }
        data.type = mt;
        conv.step = 'amount';
        await this.setConv(chatId, { step: conv.step, data });
        await this.sendMessage(chatId, 'Monto? (ej. 123.45)');
        return;
      }
      case 'amount': {
        const n = Number(t.replace(',', '.'));
        if (!isFinite(n) || n <= 0) {
          await this.sendMessage(chatId, 'Monto inválido. Ingresa un número positivo.');
          return;
        }
        data.amount = n;
        conv.step = 'currency';
        await this.setConv(chatId, { step: conv.step, data });
        await this.sendMessage(chatId, 'Moneda? (PEN/USD). Deja vacío para PEN.');
        return;
      }
      case 'currency': {
        const up = t ? t.toUpperCase() : 'PEN';
        data.currency = up === 'USD' ? 'USD' : 'PEN';
        conv.step = 'provider';
        await this.setConv(chatId, { step: conv.step, data });
        await this.sendMessage(chatId, 'Proveedor?');
        return;
      }
      case 'provider': {
        if (!t) {
          await this.sendMessage(chatId, 'Proveedor inválido. Ingresa un nombre.');
          return;
        }
        data.provider = t;
        conv.step = 'date';
        await this.setConv(chatId, { step: conv.step, data });
        await this.sendMessage(chatId, 'Fecha? (YYYY-MM-DD). Deja vacío para hoy.');
        return;
      }
      case 'date': {
        let dt: Date;
        if (!t) dt = new Date();
        else {
          const m = t.match(/^\d{4}-\d{2}-\d{2}$/);
          dt = m ? new Date(t) : new Date();
        }
        data.issuedAt = dt.toISOString();
        conv.step = 'description';
        await this.setConv(chatId, { step: conv.step, data });
        await this.sendMessage(chatId, 'Descripción (opcional). Escribe texto o "skip".');
        return;
      }
      case 'description': {
        if (t && t.toLowerCase() !== 'skip') data.description = t;
        // Enforce FREE plan
        if (user.plan === 'FREE') {
          const issued = new Date(data.issuedAt);
          const start = new Date(issued.getFullYear(), issued.getMonth(), 1);
          const end = new Date(issued.getFullYear(), issued.getMonth() + 1, 0, 23, 59, 59, 999);
          const count = await this.app.prisma.expense.count({ where: { userId: user.id, type: data.type, issuedAt: { gte: start, lte: end } } });
          if (count >= 10) {
            await this.clearConv(chatId);
            await this.sendMessage(chatId, `Límite del plan Free alcanzado para ${String(data.type).toLowerCase()}.`);
            return;
          }
        }
        const exp = await this.app.prisma.expense.create({
          data: {
            userId: user.id,
            type: data.type,
            source: 'MANUAL',
            issuedAt: new Date(data.issuedAt),
            provider: data.provider,
            description: data.description,
            amount: data.amount,
            currency: data.currency,
          }
        });
        await this.clearConv(chatId);
        const amt = exp.amount.toFixed(2);
        await this.sendMessage(chatId, `✅ Gasto creado: ${exp.provider} - ${amt} ${exp.currency}`);
        return;
      }
    }
  }

  private async sendHelp(chatId: number) {
    const lines = [
      'Comandos disponibles:',
      '• Envía una foto o documento para registrar un gasto automáticamente.',
      '• /add — crear gasto manual guiado. Tipo: FACTURA o BOLETA (también: factura/fac, boleta/ticket/recibo).',
      '• /saldo — ver presupuesto del mes y gasto acumulado.',
      '• /gastos — listar últimos 5 gastos.',
      '• /ayuda — ver esta ayuda.'
    ];
    await this.sendMessage(chatId, lines.join('\n'));
  }

  private async sendSummary(chatId: number) {
    const user = await this.findLinkedUser(chatId);
    if (!user) {
      await this.sendMessage(chatId, 'No estás vinculado. Vincula tu cuenta desde el dashboard.');
      return;
    }
    const now = new Date();
    const month = now.getMonth();
    const year = now.getFullYear();
    const start = new Date(year, month, 1);
    const end = new Date(year, month + 1, 0, 23, 59, 59, 999);
    const budget = await this.app.prisma.budget.findUnique({ where: { userId_year_month: { userId: user.id, month: month + 1, year } } });
    const agg = await this.app.prisma.expense.aggregate({ _sum: { amount: true }, where: { userId: user.id, issuedAt: { gte: start, lte: end } } });
    const spent = agg._sum.amount || 0;
    const remaining = (budget?.amount ?? 0) - spent;
    const fmt = (n: number) => `${n.toFixed(2)} PEN`;
    await this.sendMessage(chatId, `📊 Mes actual\nPresupuesto: ${fmt(budget?.amount || 0)}\nGasto: ${fmt(spent)}\nRestante: ${fmt(remaining)}`);
  }

  private async sendLastExpenses(chatId: number) {
    const user = await this.findLinkedUser(chatId);
    if (!user) {
      await this.sendMessage(chatId, 'No estás vinculado. Vincula tu cuenta desde el dashboard.');
      return;
    }
    const items = await this.app.prisma.expense.findMany({ where: { userId: user.id }, orderBy: { issuedAt: 'desc' }, take: 5 });
    if (items.length === 0) {
      await this.sendMessage(chatId, 'No hay gastos registrados aún.');
      return;
    }
    const lines = items.map(it => `• ${new Date(it.issuedAt).toLocaleDateString()} — ${it.provider}: ${it.amount.toFixed(2)} ${it.currency}`);
    await this.sendMessage(chatId, ['Últimos gastos:', ...lines].join('\n'));
  }

  private async handleMessage(msg: TelegramUpdate['message']) {
    if (!msg) return;
    const chatId = msg.chat.id;
    // Archivos primero
    if (msg.document) {
      const fp = await this.getFilePath(msg.document.file_id);
      if (!fp) return this.sendMessage(chatId, 'No se pudo obtener el archivo.');
      const buf = await this.downloadFile(fp);
      if (!buf) return this.sendMessage(chatId, 'No se pudo descargar el archivo.');
      const filename = msg.document.file_name || 'archivo';
      const mime = msg.document.mime_type || 'application/octet-stream';
      await this.processUploadedBuffer(chatId, filename, mime, buf);
      return;
    }
    if (msg.photo && msg.photo.length > 0) {
      const best = msg.photo[msg.photo.length - 1];
      const fp = await this.getFilePath(best.file_id);
      if (!fp) return this.sendMessage(chatId, 'No se pudo obtener la foto.');
      const buf = await this.downloadFile(fp);
      if (!buf) return this.sendMessage(chatId, 'No se pudo descargar la foto.');
      await this.processUploadedBuffer(chatId, 'foto.jpg', 'image/jpeg', buf);
      return;
    }

    const text = (msg.text || msg.caption || '').trim();
    if (!text) return;

    // Vinculación con /start <code>
    const code = this.extractStartCode(text);
    if (code) {
      const linked = await this.completeLink(code, chatId);
      if (linked) await this.sendMessage(chatId, '✅ Vinculación exitosa. Ya puedes enviar fotos o documentos.');
      else await this.sendMessage(chatId, '❌ Código inválido o expirado. Genera uno nuevo desde el dashboard.');
      return;
    }

    // Conversación manual activa
    const conv = await this.getConv(chatId);
    if (conv) {
      if (/^\/cancel$/i.test(text)) {
        await this.clearConv(chatId);
        await this.sendMessage(chatId, 'Operación cancelada.');
        return;
      }
      await this.handleManual(chatId, text);
      return;
    }

    // Comandos
    if (/^\/add$/i.test(text)) return this.startManual(chatId);
    if (/^\/(saldo|summary)$/i.test(text)) return this.sendSummary(chatId);
    if (/^\/(gastos|expenses)$/i.test(text)) return this.sendLastExpenses(chatId);
    if (/^\/(ayuda|help)$/i.test(text)) return this.sendHelp(chatId);

    // Texto común: mostrar ayuda
    return this.sendHelp(chatId);
  }

  async startPolling() {
    if (this.polling) return;
    this.polling = true;
    await this.getMe();
    this.app.log.info({ msg: 'telegram: polling started', bot: this.botUsername });
    const loop = async () => {
      if (!this.polling) return;
      try {
        const res = await fetch(`${this.baseUrl}/getUpdates?timeout=25&offset=${this.offset}`);
        const data = await res.json();
        if (data?.ok && Array.isArray(data.result)) {
          const updates: TelegramUpdate[] = data.result;
          for (const u of updates) {
            this.offset = Math.max(this.offset, (u.update_id || 0) + 1);
            await this.handleMessage(u.message);
          }
        }
      } catch (e) {
        this.app.log.error({ msg: 'telegram: polling error', e });
      }
      setTimeout(loop, 1000);
    };
    loop();
  }
}