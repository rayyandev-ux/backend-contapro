import OpenAI from 'openai';
import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';
import { runPythonOCR } from './pythonOCR.js';
import { runPythonLLM } from './pythonLLM.js';

export function createOpenAI(app: FastifyInstance) {
  const apiKey = process.env.OPENAI_API_KEY;
  const client = new OpenAI({ apiKey });
  const MODEL = (process.env.OPENAI_MODEL || 'gpt-4o-mini').trim();

  async function cachedCompletion(key: string, prompt: string) {
    const ttl = config.cacheTtlSeconds;
    const existing = await app.prisma.aiCache.findUnique({ where: { key } });
    if (existing) return existing.value as any;

    const completion = await client.chat.completions.create({
      model: MODEL,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.2,
    });
    const result = completion.choices[0]?.message?.content ?? '';
    await app.prisma.aiCache.create({ data: { key, value: { result }, ttl } });
    return { result };
  }

  return {
    async summarizeText(app: FastifyInstance, text: string) {
      const key = crypto.createHash('sha256').update('sum:' + text).digest('hex');
      return cachedCompletion(key, `Resume el siguiente texto en 1-2 líneas:\n${text}`);
    },
    async extractExpenseFields(app: FastifyInstance, meta: { filename: string; mimeType: string; size: number }, fileBuffer?: Buffer) {
      const bufHash = fileBuffer ? crypto.createHash('sha256').update(fileBuffer).digest('hex') : 'no-buffer';
      const key = crypto.createHash('sha256').update('expense:' + JSON.stringify(meta) + ':' + bufHash).digest('hex');
      const cached = await app.prisma.aiCache.findUnique({ where: { key } });
      if (cached) return (cached.value as any);

      const promptText = `Eres una IA experta en análisis de documentos financieros, especializada en facturas y boletas de venta.
Recibirás una imagen o texto extraído de una factura o boleta, y tu tarea es identificar y estructurar la información clave de manera precisa y estandarizada.

Debes analizar cuidadosamente el documento y devolver únicamente un JSON válido, con los siguientes campos:
{
  "tipo_documento": "factura o boleta",
  "proveedor": "nombre del comercio o empresa emisora",
  "ruc_proveedor": "RUC o número de identificación del proveedor (si existe)",
  "fecha_emision": "YYYY-MM-DD",
  "monto_total": "monto total del documento",
  "moneda": "PEN, USD, etc.",
  "categoria_gasto": "categoría del gasto detectada o nueva",
  "numero_documento": "número o serie del documento",
  "items": [
    {
      "descripcion": "nombre del producto o servicio",
      "cantidad": "cantidad comprada",
      "precio_unitario": "precio por unidad",
      "subtotal": "subtotal del ítem"
    }
  ],
  "observaciones": "comentarios o detalles adicionales relevantes"
}

Reglas de extracción:
- Si un dato no aparece en el documento, deja su valor vacío ("") sin inventarlo.
- Detecta automáticamente si el documento es factura o boleta.
- Usa formato ISO 8601 para las fechas (YYYY-MM-DD).
- Redondea los montos a dos decimales.
- Si hay varios ítems, incluye todos en la lista "items".
- No incluyas texto, explicaciones o comentarios fuera del JSON.
- Los montos deben usar punto como separador decimal. Si el documento usa coma decimal (1.234,56), conviértelo a 1234.56.
- Identifica la moneda: 'PEN' (símbolo 'S/') o 'USD' (símbolo '$'). Si no está explícito, asume 'PEN'.

Categorías base:
- alimentación, transporte, servicios, entretenimiento, educación, salud, vivienda, tecnología, otros.
- Si el gasto pertenece a una categoría nueva, identifícala con un nombre claro y coherente (por ejemplo: "ropa", "mascotas", "viajes") y asigna ese valor en "categoria_gasto".

Instrucción final:
Devuelve solo el JSON final sin texto adicional, encabezados ni explicaciones.`;

      let result: any = {
        tipo_documento: /factura/i.test(meta.filename) ? 'factura' : 'boleta',
        fecha_emision: new Date().toISOString().slice(0, 10),
        proveedor: 'Desconocido',
        monto_total: Math.round((Math.random() * 10000)) / 100,
        moneda: 'PEN',
        numero_documento: '',
        items: null,
        observaciones: `Documento ${meta.filename} (${meta.mimeType}), tamaño ${meta.size} bytes`,
      };
      // Forzar uso de LLM en Python siempre que haya imagen
      const usePythonLLM = true;
      if (usePythonLLM && fileBuffer) {
        const pyRes = await runPythonLLM(app, fileBuffer, meta.mimeType);
        if (pyRes) result = pyRes;
      }

      // Si no estamos usando Python, intentar con cliente Node
      if (!usePythonLLM) {
      try {
        // Build multimodal message when file buffer is provided
        let messages: any[];
        if (fileBuffer) {
          const b64 = fileBuffer.toString('base64');
          const dataUrl = `data:${meta.mimeType};base64,${b64}`;
          messages = [
            { role: 'user', content: [{ type: 'text', text: promptText }, { type: 'image_url', image_url: { url: dataUrl } }] },
          ];
        } else {
          messages = [{ role: 'user', content: promptText }];
        }
        const completion = await client.chat.completions.create({
          model: MODEL,
          messages,
          temperature: 0.2,
          response_format: {
            type: 'json_schema',
            json_schema: {
              name: 'expense_extraction_es',
              strict: true,
              schema: {
                type: 'object',
                properties: {
                  tipo_documento: { type: 'string', enum: ['factura','boleta','FACTURA','BOLETA'] },
                  proveedor: { type: 'string' },
                  ruc_proveedor: { anyOf: [{ type: 'string' }, { type: 'null' }] },
                  fecha_emision: { type: 'string' },
                  monto_total: { anyOf: [{ type: 'number' }, { type: 'string' }] },
                  moneda: { type: 'string' },
                  categoria_gasto: { anyOf: [{ type: 'string' }, { type: 'null' }] },
                  numero_documento: { anyOf: [{ type: 'string' }, { type: 'null' }] },
                  items: {
                    anyOf: [
                      { type: 'array', items: { type: 'object', properties: { descripcion: { type: 'string' }, cantidad: { anyOf: [{ type: 'number' }, { type: 'string' }] }, precio_unitario: { anyOf: [{ type: 'number' }, { type: 'string' }] }, subtotal: { anyOf: [{ type: 'number' }, { type: 'string' }] } }, required: ['descripcion'] } },
                      { type: 'null' }
                    ]
                  },
                  observaciones: { anyOf: [{ type: 'string' }, { type: 'null' }] }
                },
                required: ['tipo_documento','proveedor','fecha_emision','monto_total','moneda'],
                additionalProperties: false,
              },
            },
          },
        });
        const text = completion.choices[0]?.message?.content ?? '';
        const parsed = JSON.parse(text);
        if (parsed && typeof parsed === 'object') result = parsed;
      } catch (e) {
        // Fallback heurístico si no hay API o error
      }
      }

      // Si faltan datos críticos, intentar OCR Python como fallback y fusionar
      const isEmpty = (v: any) => v == null || String(v).trim() === '';
      const isUnknown = (v: any) => {
        const s = String(v ?? '').trim().toLowerCase();
        return s === '' || s === 'desconocido' || s === 'unknown' || s === 'n/a' || s === 'no disponible' || s === '—';
      };
      const needFallback = (
        (!fileBuffer) ? false : (
          isEmpty(result?.proveedor) || isUnknown(result?.proveedor) ||
          isEmpty(result?.fecha_emision) ||
          (isEmpty(result?.monto_total) || (typeof result?.monto_total !== 'number' && parseAmount(result?.monto_total) === 0)) ||
          isEmpty(result?.numero_documento) || isUnknown(result?.numero_documento)
        )
      );
      if (needFallback && fileBuffer) {
        const py = await runPythonOCR(app, fileBuffer, meta.mimeType);
        if (py) {
          // Merge conservador: sólo rellenar campos vacíos
          if ((isEmpty(result.proveedor) || isUnknown(result.proveedor)) && py.proveedor) result.proveedor = py.proveedor;
          if ((isEmpty(result.ruc_proveedor) || isUnknown(result.ruc_proveedor)) && py.ruc_proveedor) result.ruc_proveedor = py.ruc_proveedor;
          if ((isEmpty(result.fecha_emision) || isUnknown(result.fecha_emision)) && py.fecha_emision) result.fecha_emision = py.fecha_emision;
          if ((isEmpty(result.monto_total) || parseAmount(result.monto_total) === 0) && py.monto_total) result.monto_total = py.monto_total;
          if ((isEmpty(result.moneda) || isUnknown(result.moneda)) && py.moneda) result.moneda = py.moneda;
          if ((isEmpty(result.numero_documento) || isUnknown(result.numero_documento)) && py.numero_documento) result.numero_documento = py.numero_documento;
          if ((isEmpty(result.categoria_gasto) || isUnknown(result.categoria_gasto)) && py.categoria_gasto) result.categoria_gasto = py.categoria_gasto;
          // Observaciones: anexar trazas OCR si no hay summary
          if (isEmpty(result.observaciones) && py.text) result.observaciones = `OCR: ${py.text.slice(0, 400)}`;

          // Si ambos tienen monto_total pero difieren mucho, preferir OCR
          try {
            const llmAmt = parseAmount(result.monto_total);
            const ocrAmt = parseAmount(py.monto_total);
            if (ocrAmt > 0 && llmAmt > 0) {
              const rel = Math.abs(ocrAmt - llmAmt) / Math.max(1, llmAmt);
              if (rel > 0.4) { // diferencia > 40%
                result.monto_total = ocrAmt;
                if (py.moneda) result.moneda = py.moneda;
              }
            }
          } catch {}
        }
      }

      // Utilidades de normalización/validación
      function onlyDigits(s?: string | null) { return String(s ?? '').replace(/\D+/g, ''); }
      function validDate(s?: string | null) { return !!String(s ?? '').match(/^\d{4}-\d{2}-\d{2}$/); }
      function approx(a?: number | null, b?: number | null, tol = 0.02) { if (typeof a !== 'number' || typeof b !== 'number') return false; const rel = Math.abs(a - b) / Math.max(1, b); return rel <= tol; }
      function parseAmount(input: any): number {
        if (typeof input === 'number') return input;
        const s = String(input ?? '').trim();
        if (!s) return 0;
        const cleaned = s.replace(/SOLES|USD|US\s?\$|S\/|[A-Z$]/gi, '').trim();
        const lastDot = cleaned.lastIndexOf('.');
        const lastComma = cleaned.lastIndexOf(',');
        let normalized = cleaned;
        if (lastComma > lastDot) { // comma as decimal
          normalized = cleaned.replace(/\./g, '').replace(',', '.');
        } else { // dot as decimal, remove commas
          normalized = cleaned.replace(/,/g, '');
        }
        const n = Number(normalized.replace(/[^0-9.]/g, ''));
        return isFinite(n) ? n : 0;
      }
      function normalizeDate(s?: string | null): string | null {
        const str = String(s ?? '').trim();
        if (!str) return null;
        if (/^\d{4}-\d{2}-\d{2}$/.test(str)) return str;
        const m = str.match(/^([0-3]?\d)[\/-]([0-1]?\d)[\/-](\d{4})$/); // DD/MM/YYYY
        if (m) {
          const dd = m[1].padStart(2,'0');
          const mm = m[2].padStart(2,'0');
          const yyyy = m[3];
          return `${yyyy}-${mm}-${dd}`;
        }
        const m2 = str.match(/^(\d{4})[\/-]([0-1]?\d)[\/-]([0-3]?\d)$/); // YYYY/MM/DD
        if (m2) {
          const yyyy = m2[1];
          const mm = m2[2].padStart(2,'0');
          const dd = m2[3].padStart(2,'0');
          return `${yyyy}-${mm}-${dd}`;
        }
        return null;
      }
      function normalizeCurrency(s?: string | null): 'PEN' | 'USD' {
        const v = String(s ?? '').toUpperCase();
        if (v.includes('USD') || v.includes('US$') || v.includes('$')) return 'USD';
        if (v.includes('PEN') || v.includes('S/') || v.includes('SOLES')) return 'PEN';
        return v === 'USD' ? 'USD' : 'PEN';
      }

      // Clasificación por proveedor/cadena y normalización de categoría
      function normalizeCategoryName(cat?: string | null) {
        const c = String(cat ?? '').trim().toLowerCase();
        if (!c) return undefined;
        if (/alimentaci[óo]n/.test(c)) return 'Alimentación';
        if (/transporte/.test(c)) return 'Transporte';
        if (/servicios?/.test(c)) return 'Servicios';
        if (/entretenimiento|ocio/.test(c)) return 'Entretenimiento';
        if (/educaci[óo]n|colegio|universidad/.test(c)) return 'Educación';
        if (/salud|farmacia|botica/.test(c)) return 'Salud';
        if (/vivienda|hogar|casa|mueble|electrodom[ée]stico|ferreter[ií]a/.test(c)) return 'Vivienda';
        if (/tecnolog[ií]a|electr[óo]nica|computadora|celular|smartphone|laptop/.test(c)) return 'Tecnología';
        if (/impuestos?/.test(c)) return 'Impuestos';
        return c ? c.charAt(0).toUpperCase() + c.slice(1) : undefined;
      }
      const providerRaw = (result.provider ?? result.proveedor ?? 'Desconocido');
      const provider = providerRaw.toLowerCase();
      let categoryName = normalizeCategoryName(result.categoryName ?? result.categoria_gasto);
      if (!categoryName) {
        if (/metro|tottus|plaza|wong|bodega|market|supermercado|comida|restaurante/.test(provider)) categoryName = 'Alimentación';
        else if (/uber|cabify|bus|taxi|peaje|transporte|combustible|gasolina|grifo/.test(provider)) categoryName = 'Transporte';
        else if (/claro|movistar|entel|internet|luz|agua|gas|telefono|celular|servicio/.test(provider)) categoryName = 'Servicios';
        else if (/farmacia|botica|clinica|hospital|salud|medic/.test(provider)) categoryName = 'Salud';
        else if (/colegio|universidad|curso|educacion|libro/.test(provider)) categoryName = 'Educación';
        else if (/cine|netflix|spotify|entretenimiento|ocio|evento/.test(provider)) categoryName = 'Entretenimiento';
        else if (/hogar|casa|mueble|electrodomestico|ferreteria|vivienda/.test(provider)) categoryName = 'Vivienda';
        else if (/laptop|computador|celular|smartphone|tecnolog[ií]a|electr[óo]nica/.test(provider)) categoryName = 'Tecnología';
        else if (/impuesto|tributo|sunat|municipalidad|predial/.test(provider)) categoryName = 'Impuestos';
        else categoryName = 'Otros';
      }

      // Normalize and sanitize result
      const typeRaw = (result.type ?? result.tipo_documento ?? '').toString();
      const typeNorm = /factura/i.test(typeRaw) ? 'FACTURA' : 'BOLETA';
      const issuedAtNorm = normalizeDate(result.issuedAt ?? result.fecha_emision) ?? new Date().toISOString().slice(0,10);
      const totalsInput = result.totals ?? null;
      const totals = totalsInput ? totalsInput : { total: result.monto_total ?? 0, currency: result.moneda ?? 'PEN', subtotal: null, taxes: null };
      const currencyNorm = normalizeCurrency(totals.currency ?? (result.moneda ?? 'PEN'));
      const totalNum = typeof (totals.total ?? result.monto_total) === 'number' ? (totals.total ?? result.monto_total) : parseAmount(totals.total ?? result.monto_total);
      const providerNorm = ((result.provider ?? result.proveedor) || 'Desconocido').trim();
      const docNumberNorm = (result.docNumber ?? result.numero_documento ?? null) ? String(result.docNumber ?? result.numero_documento).trim() : null;
      const rucDigits = String(result.ruc_proveedor ?? '').replace(/\D+/g,'');
      const emitter = result.emitter || { name: providerNorm || null, idType: rucDigits ? 'RUC' : null, idNumber: rucDigits || null };
      const receiver = result.receiver || null;
      let items: any = Array.isArray(result.items) ? result.items : null;
      if (Array.isArray(items) && items.length && items[0] && (items[0].descripcion || items[0].precio_unitario || items[0].subtotal)) {
        items = items.map((it: any) => ({
          description: String(it.descripcion ?? '').trim(),
          quantity: it.cantidad != null ? parseAmount(it.cantidad) : null,
          unitPrice: it.precio_unitario != null ? parseAmount(it.precio_unitario) : null,
          lineTotal: it.subtotal != null ? parseAmount(it.subtotal) : null,
          taxRate: null,
        })).filter((x: any) => x.description);
      }
      let subtotal = typeof totals.subtotal === 'number' ? totals.subtotal : null;
      let taxes = Array.isArray(totals.taxes) ? totals.taxes : null;

      // Compute IGV if missing
      if ((subtotal == null || !Array.isArray(taxes) || taxes.length === 0) && totalNum > 0) {
        const igvRate = 0.18;
        subtotal = Number((totalNum / (1 + igvRate)).toFixed(2));
        const igvAmount = Number((totalNum - subtotal).toFixed(2));
        taxes = [{ name: 'IGV', rate: 18, amount: igvAmount }];
      }

      // Validations and anomaly detection
      const anomalies: string[] = Array.isArray(result?.classification?.anomalies) ? result.classification.anomalies.slice(0) : [];
      if (emitter.idType === 'RUC' && onlyDigits(emitter.idNumber).length !== 11) anomalies.push('RUC emisor inválido');
      if (emitter.idType === 'DNI' && onlyDigits(emitter.idNumber).length !== 8) anomalies.push('DNI emisor inválido');
      if (receiver && receiver.idType === 'RUC' && onlyDigits(receiver.idNumber).length !== 11) anomalies.push('RUC receptor inválido');
      if (receiver && receiver.idType === 'DNI' && onlyDigits(receiver.idNumber).length !== 8) anomalies.push('DNI receptor inválido');
      if (!validDate(issuedAtNorm)) anomalies.push('Fecha inválida');
      if (items && items.length > 0) {
        const sumLines = items.reduce((acc: number, it: any) => acc + (typeof it.lineTotal === 'number' ? it.lineTotal : 0), 0);
        if (!approx(sumLines, totalNum)) anomalies.push('Suma de ítems no coincide con total');
      }
      const classification = {
        documentType: typeNorm,
        signatures: { hasSignature: !!result?.classification?.signatures?.hasSignature, hasStamp: !!result?.classification?.signatures?.hasStamp },
        anomalies,
      };

      // Resolver categoría en BD
      let categoryId: string | undefined;
      try {
        const existing = await app.prisma.category.findUnique({ where: { name: categoryName } });
        if (existing) categoryId = existing.id;
        else {
          const created = await app.prisma.category.create({ data: { name: categoryName } });
          categoryId = created.id;
        }
      } catch {}

      // Build normalized value
      const value = {
        type: typeNorm,
        docNumber: docNumberNorm,
        issuedAt: issuedAtNorm,
        provider: providerNorm,
        description: (result.description ?? result.observaciones ?? null),
        emitter,
        receiver,
        items,
        totals: { subtotal, taxes, total: totalNum, currency: currencyNorm },
        payment: result.payment ?? null,
        classification,
        categoryName,
        summary: (result.summary ?? result.observaciones ?? `Documento ${meta.filename} (${meta.mimeType}), tamaño ${meta.size} bytes`),
        categoryId,
        raw: result,
      };

      // Simple XML builder (sin librerías)
      function esc(s: any) { return String(s ?? '').replace(/[<&>]/g, ch => ch === '<' ? '&lt;' : ch === '>' ? '&gt;' : '&amp;'); }
      function el(name: string, content: string | null) { return content == null ? `<${name}/>` : `<${name}>${content}</${name}>`; }
      function objToXml(obj: any): string {
        let xml = '<ExpenseExtraction>';
        xml += el('Type', obj.type);
        xml += el('DocNumber', obj.docNumber);
        xml += el('IssuedAt', obj.issuedAt);
        xml += el('Provider', esc(obj.provider));
        xml += el('Description', obj.description ? esc(obj.description) : null);
        xml += '<Emitter>' + el('Name', obj.emitter?.name) + el('IdType', obj.emitter?.idType) + el('IdNumber', obj.emitter?.idNumber) + '</Emitter>';
        if (obj.receiver) xml += '<Receiver>' + el('Name', obj.receiver?.name) + el('IdType', obj.receiver?.idType) + el('IdNumber', obj.receiver?.idNumber) + '</Receiver>';
        if (Array.isArray(obj.items)) {
          xml += '<Items>' + obj.items.map((it: any) => `<Item>${el('Description', esc(it.description))}${el('Quantity', it.quantity?.toString() ?? null)}${el('UnitPrice', it.unitPrice?.toString() ?? null)}${el('LineTotal', it.lineTotal?.toString() ?? null)}${el('TaxRate', it.taxRate?.toString() ?? null)}</Item>`).join('') + '</Items>';
        }
        xml += '<Totals>' + el('Subtotal', obj.totals?.subtotal?.toString() ?? null) + (Array.isArray(obj.totals?.taxes) ? '<Taxes>' + obj.totals.taxes.map((t: any) => `<Tax>${el('Name', t.name)}${el('Rate', t.rate?.toString() ?? null)}${el('Amount', t.amount?.toString() ?? null)}</Tax>`).join('') + '</Taxes>' : '<Taxes/>') + el('Total', obj.totals?.total?.toString()) + el('Currency', obj.totals?.currency) + '</Totals>';
        if (obj.payment) {
          xml += '<Payment>' + el('Method', obj.payment.method) + el('CardLast4', obj.payment.cardLast4) + el('DueDate', obj.payment.dueDate) + el('PaidDate', obj.payment.paidDate) + el('TransactionId', obj.payment.transactionId) + '</Payment>';
        }
        xml += '<Classification>' + el('DocumentType', obj.classification?.documentType) + '<Signatures>' + el('HasSignature', String(!!obj.classification?.signatures?.hasSignature)) + el('HasStamp', String(!!obj.classification?.signatures?.hasStamp)) + '</Signatures>' + (Array.isArray(obj.classification?.anomalies) ? '<Anomalies>' + obj.classification.anomalies.map((a: string) => el('Anomaly', esc(a))).join('') + '</Anomalies>' : '<Anomalies/>') + '</Classification>';
        xml += el('CategoryName', obj.categoryName);
        xml += el('Summary', esc(obj.summary));
        if (obj.categoryId) xml += el('CategoryId', obj.categoryId);
        xml += '</ExpenseExtraction>';
        return xml;
      }
      const xml = objToXml(value);

      const cachedValue = { ...value, xml };
      await app.prisma.aiCache.create({ data: { key, value: cachedValue, ttl: config.cacheTtlSeconds } });
      return cachedValue;
    },
  };
}