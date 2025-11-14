import crypto from 'node:crypto';
import { config } from '../config.js';

type CreatePaymentParams = {
  email: string;
  amount: number;
  currency: 'USD' | 'PEN';
  orderId: string;
  subject: string;
  urlReturn: string;
  urlNotify: string;
};

function signParams(params: Record<string, any>): string {
  const keys = Object.keys(params).sort();
  const str = keys.map((k) => `${k}=${params[k]}`).join('&');
  const hmac = crypto.createHmac('sha256', config.flowSecretKey);
  hmac.update(str);
  return hmac.digest('hex');
}

export async function createPaymentLink(p: CreatePaymentParams): Promise<{ url: string }>{
  if (!config.flowApiKey || !config.flowSecretKey) throw new Error('Flow no configurado');
  const payload: Record<string, any> = {
    apiKey: config.flowApiKey,
    commerceOrder: p.orderId,
    subject: p.subject,
    currency: p.currency,
    amount: Number(p.amount.toFixed(2)),
    email: p.email,
    urlReturn: p.urlReturn,
    urlNotify: p.urlNotify,
  };
  const s = signParams(payload);
  const body = { ...payload, s };
  const res = await fetch(`${config.flowBaseUrl}/payment/create`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(String(data?.message || data?.error || `Error ${res.status}`));
  const url = String(data?.url || data?.redirectUrl || '');
  if (!url) throw new Error('Respuesta sin URL de pago');
  return { url };
}

export function verifyWebhookSignature(params: Record<string, any>): boolean {
  const provided = String(params?.s || params?.signature || '');
  const clone = { ...params };
  delete clone.s;
  delete clone.signature;
  const expected = signParams(clone);
  return Boolean(provided) && provided === expected;
}