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
  flowPlan?: string; // optional Flow plan identifier (for subscriptions)
};

function signParamsAmpersand(params: Record<string, any>): string {
  const keys = Object.keys(params).sort();
  const str = keys.map((k) => `${k}=${params[k]}`).join('&');
  const hmac = crypto.createHmac('sha256', config.flowSecretKey);
  hmac.update(str);
  return hmac.digest('hex');
}

function signParamsConcat(params: Record<string, any>): string {
  const keys = Object.keys(params).sort();
  const str = keys.map((k) => `${k}${params[k]}`).join('');
  const hmac = crypto.createHmac('sha256', config.flowSecretKey);
  hmac.update(str);
  return hmac.digest('hex');
}

export async function createPaymentLink(p: CreatePaymentParams): Promise<{ url: string }>{
  if (!config.flowApiKey || !config.flowSecretKey) throw new Error('Flow no configurado');

  function composeRedirectUrl(url: string, token?: string): string {
    if (!url) return '';
    if (token && !/([?&])token=/.test(url)) {
      const sep = url.includes('?') ? '&' : '?';
      return `${url}${sep}token=${encodeURIComponent(token)}`;
    }
    return url;
  }

  async function postVariant(path: string, params: Record<string, any>, contentType: 'application/x-www-form-urlencoded' | 'application/json', signer: 'ampersand' | 'concat') {
    const s = signer === 'ampersand' ? signParamsAmpersand(params) : signParamsConcat(params);
    let res: Response;
    let text: string;
    let data: any = {};
    if (contentType === 'application/x-www-form-urlencoded') {
      const form = new URLSearchParams();
      for (const [k, v] of Object.entries({ ...params, s })) form.append(k, String(v));
      res = await fetch(`${config.flowBaseUrl}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: form.toString(),
      });
      text = await res.text();
    } else {
      const bodyJson = JSON.stringify({ ...params, s });
      res = await fetch(`${config.flowBaseUrl}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: bodyJson,
      });
      text = await res.text();
    }
    try { data = JSON.parse(text); } catch { /* keep raw text */ }
    return { ok: res.ok, status: res.status, data, text };
  }

  // Basic config log (without exposing secrets) to help diagnose sandbox credentials issues
  console.log('Flow config check', {
    baseUrl: config.flowBaseUrl,
    sandbox: /sandbox/.test(config.flowBaseUrl),
    apiKeySet: Boolean(config.flowApiKey),
    secretSet: Boolean(config.flowSecretKey),
  });

  async function ensureCustomerId(email: string): Promise<string> {
    const name = String(email.split('@')[0] || 'Usuario');
    const createAttempts: Array<{ params: Record<string, any>; note: string }> = [
      { params: { apiKey: config.flowApiKey, email }, note: 'customer create email' },
      { params: { apiKey: config.flowApiKey, email, name }, note: 'customer create email+name' },
      { params: { apiKey: config.flowApiKey, email, name, lastName: 'ContaPRO' }, note: 'customer create email+name+lastName' },
    ];
    const results: string[] = [];
    for (const attempt of createAttempts) {
      const res = await postVariant('/customer/create', attempt.params, 'application/x-www-form-urlencoded', 'ampersand');
      if (res.ok) {
        const id = String(res.data?.customerId || res.data?.id || res.data?.customer?.id || '');
        if (id) return id;
        results.push(`customer ok-without-id (${attempt.note}) body=${res.text}`);
      } else {
        const msg = String(res.data?.message || res.data?.error || `Error ${res.status}`);
        results.push(`customer ${msg} (${attempt.note}) body=${res.text}`);
        if (/exists/i.test(msg)) {
          // Try to fetch existing customer by email
          const getPaths = ['/customer/getByEmail', '/customer/get', '/customer/find'];
          for (const path of getPaths) {
            const getRes = await postVariant(path, { apiKey: config.flowApiKey, email }, 'application/x-www-form-urlencoded', 'ampersand');
            if (getRes.ok) {
              const id = String(getRes.data?.customerId || getRes.data?.id || getRes.data?.customer?.id || '');
              if (id) return id;
              results.push(`customer-get ok-without-id (${path}) body=${getRes.text}`);
            } else {
              const msg2 = String(getRes.data?.message || getRes.data?.error || `Error ${getRes.status}`);
              results.push(`customer-get ${msg2} (${path}) body=${getRes.text}`);
            }
          }
        }
      }
    }
    throw new Error('Flow customer error: ' + results.join(' | '));
  }

  const base = {
    apiKey: config.flowApiKey,
    commerceOrder: p.orderId,
    subject: p.subject,
    currency: p.currency,
    amount: Number(p.amount.toFixed(2)),
    email: p.email,
  };

  const results: string[] = [];

  // If a Flow plan is provided and not forced to use payment, try subscription/create first
  if (p.flowPlan && !config.flowForcePayment) {
    try {
      const customerId = await ensureCustomerId(p.email);
      const subsParamsCamel = { apiKey: config.flowApiKey, planId: p.flowPlan, customerId, urlReturn: p.urlReturn, urlConfirmation: p.urlNotify };
      const subsRes = await postVariant('/subscription/create', subsParamsCamel, 'application/x-www-form-urlencoded', 'concat');
      if (subsRes.ok) {
        const url = String((subsRes.data && (subsRes.data.url || subsRes.data.redirectUrl)) || '');
        const token = String(subsRes.data?.token || subsRes.data?.Token || '');
        const redirect = composeRedirectUrl(url, token);
        if (redirect) {
          console.log('Flow subscription/create success', { url: redirect, planId: p.flowPlan });
          return { url: redirect };
        }
        results.push(`subscription ok-without-url body=${subsRes.text}`);
      } else {
        const msg = String(subsRes.data?.message || subsRes.data?.error || `Error ${subsRes.status}`);
        results.push(`subscription ${msg} body=${subsRes.text}`);
      }
    } catch (err: any) {
      results.push(String(err?.message || err));
    }
  }

  // Fallback: payment/create with required urlConfirmation
  const paymentCamel = { ...base, urlReturn: p.urlReturn, urlConfirmation: p.urlNotify };
  const payRes = await postVariant('/payment/create', paymentCamel, 'application/x-www-form-urlencoded', 'concat');
  if (payRes.ok) {
    const url = String((payRes.data && (payRes.data.url || payRes.data.redirectUrl)) || '');
    const token = String(payRes.data?.token || payRes.data?.Token || '');
    const redirect = composeRedirectUrl(url, token);
    if (redirect) {
      console.log('Flow payment/create success', { url: redirect });
      return { url: redirect };
    }
    results.push(`payment ok-without-url body=${payRes.text}`);
  } else {
    const msg = String(payRes.data?.message || payRes.data?.error || `Error ${payRes.status}`);
    results.push(`payment ${msg} body=${payRes.text}`);
    // Try lowercase params variant for robustness
    const paymentLower = { ...base, urlreturn: p.urlReturn, urlconfirmation: p.urlNotify };
    const payResLower = await postVariant('/payment/create', paymentLower, 'application/x-www-form-urlencoded', 'concat');
    if (payResLower.ok) {
      const url = String((payResLower.data && (payResLower.data.url || payResLower.data.redirectUrl)) || '');
      const token = String(payResLower.data?.token || payResLower.data?.Token || '');
      const redirect = composeRedirectUrl(url, token);
      if (redirect) {
        console.log('Flow payment/create success (lowercase)', { url: redirect });
        return { url: redirect };
      }
      results.push(`payment ok-without-url (lowercase) body=${payResLower.text}`);
    } else {
      const msgL = String(payResLower.data?.message || payResLower.data?.error || `Error ${payResLower.status}`);
      results.push(`payment ${msgL} (lowercase) body=${payResLower.text}`);
    }
  }

  throw new Error('Flow error: ' + results.join(' | '));
}

export function verifyWebhookSignature(params: Record<string, any>): boolean {
  const provided = String(params?.s || params?.signature || '');
  const clone = { ...params };
  delete clone.s;
  delete clone.signature;
  const expected = signParamsAmpersand(clone);
  return Boolean(provided) && provided === expected;
}