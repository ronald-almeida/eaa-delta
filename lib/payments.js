import { createHmac, timingSafeEqual } from 'node:crypto';

export const AMOUNT = 59940;
const API_URL = 'https://api.blackcatoficial.com/api';
const pending = new Map();
const attempts = new Map();
export class CheckoutError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}
const digits = (value) => String(value ?? '').replace(/\D/g, '');

export function validDocument(value) {
  const n = digits(value);
  if (!/^(\d{11}|\d{14})$/.test(n) || /^(\d)\1+$/.test(n)) return false;
  const check = (part, weights) => {
    const mod = [...part].reduce((sum, digit, i) => sum + Number(digit) * weights[i], 0) % 11;
    return mod < 2 ? 0 : 11 - mod;
  };
  const cpf = n.length === 11;
  const size = cpf ? 9 : 12;
  const w1 = cpf ? [10,9,8,7,6,5,4,3,2] : [5,4,3,2,9,8,7,6,5,4,3,2];
  const w2 = cpf ? [11,10,9,8,7,6,5,4,3,2] : [6,5,4,3,2,9,8,7,6,5,4,3,2];
  return check(n.slice(0,size),w1) === Number(n[size]) && check(n.slice(0,size+1),w2) === Number(n[size+1]);
}

export function validateCustomer(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new CheckoutError('Dados inválidos. Revise o formulário.');
  const name = String(body.name ?? '').trim().replace(/\s+/g, ' ');
  const email = String(body.email ?? '').trim().toLowerCase();
  const confirm = String(body.emailConfirm ?? '').trim().toLowerCase();
  const document = digits(body.document);
  const phone = digits(body.phone);
  if (name.length < 5 || name.length > 120 || name.split(' ').length < 2) throw new CheckoutError('Informe seu nome completo.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) throw new CheckoutError('Informe um email válido.');
  if (email !== confirm) throw new CheckoutError('Os emails precisam ser iguais.');
  if (!validDocument(document)) throw new CheckoutError('Informe um CPF ou CNPJ válido.');
  if (!/^[1-9]\d{9,10}$/.test(phone)) throw new CheckoutError('Informe seu celular com DDD.');
  return { name, email, phone, document: { number: document, type: document.length === 11 ? 'cpf' : 'cnpj' } };
}

function key() {
  const value = process.env.BLACKCAT_API_KEY?.trim();
  if (!value) throw new CheckoutError('O pagamento está temporariamente indisponível. Tente novamente mais tarde.', 503);
  return value;
}

async function request(path, options = {}) {
  let response;
  try {
    response = await fetch(`${API_URL}${path}`, {
      ...options,
      headers: { 'Content-Type': 'application/json', 'X-API-Key': key() },
      signal: AbortSignal.timeout(20000)
    });
  } catch (error) {
    if (error instanceof CheckoutError) throw error;
    throw new CheckoutError('Não foi possível confirmar a solicitação. Aguarde um momento antes de tentar novamente.', 502);
  }
  const result = await response.json().catch(() => null);
  if (!response.ok || !result?.success || !result.data) {
    // Never expose upstream errors, credentials or customer data.
    const message = response.status === 429
      ? 'Muitas tentativas. Aguarde um minuto e tente novamente.'
      : response.status === 400 || response.status === 422
        ? 'Não foi possível gerar o Pix. Confira os dados informados e tente novamente.'
        : 'O serviço de pagamento está indisponível no momento. Tente novamente mais tarde.';
    throw new CheckoutError(message, response.status === 429 ? 429 : 502);
  }
  return result.data;
}

function signToken(transactionId, amount) {
  const payload = Buffer.from(JSON.stringify({ id: transactionId, amount, exp: Date.now() + 2 * 86400000 })).toString('base64url');
  return `${payload}.${createHmac('sha256', key()).update(payload).digest('base64url')}`;
}

export function readToken(token) {
  if (typeof token !== 'string' || token.length > 2048) throw new CheckoutError('Consulta inválida.', 403);
  const [payload, signature, extra] = token.split('.');
  if (!payload || !signature || extra) throw new CheckoutError('Consulta inválida.', 403);
  const expected = createHmac('sha256', key()).update(payload).digest();
  const actual = Buffer.from(signature, 'base64url');
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new CheckoutError('Consulta inválida.', 403);
  let data;
  try { data = JSON.parse(Buffer.from(payload, 'base64url').toString()); } catch { throw new CheckoutError('Consulta inválida.', 403); }
  if (!data.id || data.amount !== AMOUNT || !Number.isFinite(data.exp) || data.exp < Date.now()) throw new CheckoutError('Esta consulta expirou.', 403);
  return data;
}

export async function createPayment(body) {
  const customer = validateCustomer(body);
  key();
  const requestId = String(body.requestId ?? '');
  if (!/^[a-f0-9-]{36}$/.test(requestId)) throw new CheckoutError('Solicitação inválida. Atualize a página.');
  const fingerprint = createHmac('sha256', key()).update(JSON.stringify(customer)).digest('hex');
  const cacheKey = `${requestId}:${fingerprint}`;
  const now = Date.now();
  for (const [id, entry] of pending) if (entry.until < now) pending.delete(id);
  if (pending.has(cacheKey)) return pending.get(cacheKey).promise;
  if (pending.size > 500) throw new CheckoutError('Aguarde um momento e tente novamente.', 429);
  const promise = (async () => {
    const sale = await request('/sales/create-sale', { method: 'POST', body: JSON.stringify({
      amount: AMOUNT, currency: 'BRL', paymentMethod: 'pix',
      items: [{ title: 'Combo Vitalício EAA DELTA', unitPrice: AMOUNT, quantity: 1, tangible: false }],
      customer, pix: { expiresInDays: 1 }, externalRef: `delta-${requestId}`
    }) });
    const code = sale.paymentData?.copyPaste || sale.paymentData?.qrCode;
    if (!sale.transactionId || Number(sale.amount) !== AMOUNT || typeof code !== 'string' || !code.startsWith('000201') || code.length > 10000) {
      throw new CheckoutError('O provedor não retornou um Pix válido. Aguarde antes de tentar novamente.', 502);
    }
    const rawImage = sale.paymentData?.qrCodeBase64;
    let image = null;
    if (typeof rawImage === 'string' && rawImage.length < 1000000) {
      if (/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=\r\n]+$/.test(rawImage)) image = rawImage;
      else if (/^[A-Za-z0-9+/=\r\n]+$/.test(rawImage)) image = `data:image/png;base64,${rawImage}`;
    }
    const expiry = new Date(sale.paymentData?.expiresAt);
    return { amount: AMOUNT, code, image, expiresAt: Number.isNaN(expiry.getTime()) ? null : expiry.toISOString(), token: signToken(sale.transactionId, AMOUNT) };
  })();
  // Short-lived process memory only. No disk, database, logs or browser storage.
  // ExternalRef helps reconciliation, but the provider does not document idempotency.
  pending.set(cacheKey, { promise, until: now + 10 * 60000 });
  return promise;
}

export async function paymentStatus(token) {
  const payment = readToken(token);
  const sale = await request(`/sales/${encodeURIComponent(payment.id)}/status`);
  if (sale.transactionId !== payment.id || Number(sale.amount) !== AMOUNT) throw new CheckoutError('Não foi possível validar este pagamento.', 502);
  if (!['PENDING','PAID','CANCELLED','REFUNDED'].includes(sale.status)) throw new CheckoutError('Status de pagamento indisponível.', 502);
  return { status: sale.status };
}

export async function handle(req, res, action) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  const send = (status, value) => { res.statusCode = status; res.end(JSON.stringify(value)); };
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return send(405, { error: 'Método não permitido.' }); }
  try {
    // Browser requests must be same-origin; Origin-less server clients still undergo validation.
    if (req.headers.origin && new URL(req.headers.origin).host !== req.headers.host) throw new CheckoutError('Origem não permitida.', 403);
    if (!req.headers['content-type']?.startsWith('application/json')) throw new CheckoutError('Formato de solicitação inválido.', 415);
    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || 'unknown';
    const now = Date.now();
    for (const [id, item] of attempts) if (item.until < now) attempts.delete(id);
    const id = `${action}:${ip}`;
    const limit = action === 'create' ? 8 : 30;
    const attempt = attempts.get(id) || { count: 0, until: now + 60000 };
    if (++attempt.count > limit || attempts.size > 5000) throw new CheckoutError('Muitas tentativas. Aguarde um minuto.', 429);
    attempts.set(id, attempt);
    let body = req.body;
    if (body === undefined) {
      let raw = '';
      for await (const chunk of req) { raw += chunk; if (Buffer.byteLength(raw) > 16384) throw new CheckoutError('Solicitação muito grande.', 413); }
      try { body = JSON.parse(raw); } catch { throw new CheckoutError('Solicitação inválida.'); }
    } else if (typeof body === 'string') {
      if (Buffer.byteLength(body) > 16384) throw new CheckoutError('Solicitação muito grande.', 413);
      try { body = JSON.parse(body); } catch { throw new CheckoutError('Solicitação inválida.'); }
    }
    if (Buffer.byteLength(JSON.stringify(body) || '') > 16384) throw new CheckoutError('Solicitação muito grande.', 413);
    const result = action === 'create' ? await createPayment(body) : await paymentStatus(body?.token);
    send(200, result);
  } catch (error) {
    send(error instanceof CheckoutError ? error.status : 500, { error: error instanceof CheckoutError ? error.message : 'Não foi possível concluir a solicitação. Tente novamente.' });
  }
}
