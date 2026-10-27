import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { AMOUNT, validDocument, validateCustomer, createPayment, paymentStatus, handle } from '../lib/payments.js';

const originalFetch = globalThis.fetch;
const originalKey = process.env.BLACKCAT_API_KEY;
afterEach(() => { globalThis.fetch = originalFetch; if (originalKey === undefined) delete process.env.BLACKCAT_API_KEY; else process.env.BLACKCAT_API_KEY = originalKey; });
const customer = () => ({ name:'Cliente de Teste', email:'teste@example.com', emailConfirm:'teste@example.com', document:'529.982.247-25', phone:'(11) 99999-9999', requestId:randomUUID() });
const providerSale = (extra = {}) => ({ success:true, data:{ transactionId:'TXN-TEST-001', amount:34700, status:'PENDING', paymentData:{ copyPaste:'000201-PIX-DE-TESTE-NAO-PAGAR', qrCodeBase64:'data:image/png;base64,aGVsbG8=', expiresAt:'2030-10-28T12:00:00.000Z' }, ...extra } });
function provider(response = providerSale(), inspect = () => {}) {
  process.env.BLACKCAT_API_KEY = 'test-only-not-a-real-key';
  globalThis.fetch = async (url, options) => { inspect(url, options); return new Response(JSON.stringify(response), { status:200, headers:{'Content-Type':'application/json'} }); };
}

test('validates CPF and CNPJ checksums and rejects malformed documents', () => {
  assert.equal(validDocument('529.982.247-25'), true);
  assert.equal(validDocument('11.222.333/0001-81'), true);
  for (const n of ['11111111111','12345678901','11222333000180','1','']) assert.equal(validDocument(n), false);
});
test('normalizes data and rejects mismatching emails, short names and invalid phones', () => {
  const data = validateCustomer(customer());
  assert.equal(data.document.number,'52998224725'); assert.equal(data.phone,'11999999999');
  assert.throws(() => validateCustomer({ ...customer(), emailConfirm:'outro@example.com' }), /emails/);
  assert.throws(() => validateCustomer({ ...customer(), name:'Ana' }), /nome completo/);
  assert.throws(() => validateCustomer({ ...customer(), phone:'123' }), /celular/);
});
test('server fixes amount and product regardless of browser input; sends Black Cat schema', async () => {
  provider(providerSale(), (url, options) => {
    assert.equal(url, 'https://api.blackcatoficial.com/api/sales/create-sale');
    assert.equal(options.headers['X-API-Key'], 'test-only-not-a-real-key');
    const body = JSON.parse(options.body);
    assert.equal(body.amount, AMOUNT); assert.equal(body.items[0].unitPrice, AMOUNT);
    assert.equal(body.items[0].title, 'Combo Vitalício EAA DELTA'); assert.equal(body.items[0].tangible, false);
    assert.equal(body.paymentMethod,'pix'); assert.equal(body.customer.document.type,'cpf');
  });
  const result = await createPayment({ ...customer(), amount:1, items:[] });
  assert.equal(result.amount,34700); assert.match(result.code,/^000201/);
  assert.ok(result.token); assert.equal(JSON.stringify(result).includes('test-only-not-a-real-key'), false);
});
test('duplicate concurrent requests reuse the same in-memory request', async () => {
  let count = 0; provider(providerSale(), () => count++);
  const data = customer(); const [a,b] = await Promise.all([createPayment(data), createPayment(data)]);
  assert.equal(count,1); assert.deepEqual(a,b);
});
test('does not accept a provider response for another amount', async () => {
  provider(providerSale({ amount:100 })); await assert.rejects(createPayment(customer()),/Pix válido/);
});
test('rejects forged status tokens and checks provider amount and transaction', async () => {
  provider(); const payment = await createPayment(customer());
  await assert.rejects(paymentStatus(payment.token + 'bad'), /inválida/);
  provider(providerSale({status:'PAID'})); assert.deepEqual(await paymentStatus(payment.token),{status:'PAID'});
  provider(providerSale({status:'PAID', amount:1})); await assert.rejects(paymentStatus(payment.token),/validar/);
  provider(providerSale({status:'PAID', transactionId:'ANOTHER'})); await assert.rejects(paymentStatus(payment.token),/validar/);
});
test('missing credentials never generate a mock Pix', async () => {
  delete process.env.BLACKCAT_API_KEY;
  await assert.rejects(createPayment(customer()), error => error.status === 503);
});
test('provider failure is sanitized and failed retries are not repeated immediately', async () => {
  process.env.BLACKCAT_API_KEY = 'test-key'; let calls = 0;
  globalThis.fetch = async () => { calls++; return new Response(JSON.stringify({error:'secret-key-customer-data'}),{status:401}); };
  const data = customer();
  await assert.rejects(createPayment(data), error => error.status === 502 && !error.message.includes('secret'));
  await assert.rejects(createPayment(data)); assert.equal(calls,1);
});
test('unsafe remote QR image URLs are excluded; copy and paste still works', async () => {
  provider(providerSale({paymentData:{copyPaste:'000201-test',qrCodeBase64:'https://evil.example/track'}}));
  const result = await createPayment(customer()); assert.equal(result.image,null); assert.equal(result.code,'000201-test');
});
async function http(method, body, headers = {}) {
  const req = Readable.from([typeof body === 'string' ? body : JSON.stringify(body)]);
  req.method = method; req.headers = {'content-type':'application/json', host:'localhost:3000', ...headers};
  req.socket = {remoteAddress:randomUUID()};
  const res = { headers:{}, setHeader(k,v){this.headers[k] = v;}, end(value){this.body = JSON.parse(value);} };
  await handle(req,res,'create'); return res;
}
test('HTTP rejects cross-origin, malformed JSON, oversized bodies and wrong method', async () => {
  assert.equal((await http('GET',{})).statusCode,405);
  assert.equal((await http('POST',customer(),{origin:'https://other.example'})).statusCode,403);
  assert.equal((await http('POST','{invalid')).statusCode,400);
  assert.equal((await http('POST','x'.repeat(17000))).statusCode,413);
  assert.equal((await http('POST',customer(),{'content-type':'text/plain'})).statusCode,415);
});
test('HTTP success is no-store and includes only public payment fields', async () => {
  provider(); const response = await http('POST',customer());
  assert.equal(response.statusCode,200); assert.equal(response.headers['Cache-Control'],'no-store');
  assert.deepEqual(Object.keys(response.body).sort(),['amount','code','expiresAt','image','token']);
});
