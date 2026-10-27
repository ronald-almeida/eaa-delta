const $ = (selector) => document.querySelector(selector);
const form = $('#checkout-form');
const dialog = $('#pix-dialog');
const generate = $('.generate-button');
const openCopy = $('#open-copy');
const error = $('#form-error');
const codeField = $('#pix-code');
const copy = $('#copy-pix');
const check = $('#check-status');
let payment = null;
let requestId = crypto.randomUUID();
let customerSnapshot = '';
let busy = false;
let polling = null;
let checking = false;
let terminal = false;
const numbers = (value) => value.replace(/\D/g, '');

function clearValidity(event) { event.target.setCustomValidity(''); event.target.removeAttribute('aria-invalid'); }
form.addEventListener('input', clearValidity);
form.addEventListener('invalid', (event) => event.target.setAttribute('aria-invalid', 'true'), true);
$('#document').addEventListener('input', (event) => {
  const n = numbers(event.target.value).slice(0,14);
  event.target.value = n.length <= 11
    ? n.replace(/^(\d{3})(\d)/, '$1.$2').replace(/^(\d{3})\.(\d{3})(\d)/, '$1.$2.$3').replace(/(\d{3})\.(\d{3})\.(\d{3})(\d)/, '$1.$2.$3-$4')
    : `${n.slice(0,2)}.${n.slice(2,5)}.${n.slice(5,8)}/${n.slice(8,12)}${n.length > 12 ? '-' + n.slice(12) : ''}`;
});
$('#phone').addEventListener('input', (event) => {
  const n = numbers(event.target.value).slice(0,11);
  event.target.value = n.replace(/^(\d{2})(\d)/, '($1) $2').replace(n.length > 10 ? /(\d{5})(\d)/ : /(\d{4})(\d)/, '$1-$2');
});

async function post(path, body) {
  let response;
  try { response = await fetch(path, { method:'POST', headers:{ 'Content-Type':'application/json' }, body:JSON.stringify(body), signal:AbortSignal.timeout(25000) }); }
  catch { throw new Error('A conexão foi interrompida. Aguarde um momento antes de tentar novamente.'); }
  const data = await response.json().catch(() => null);
  if (!response.ok || !data) throw new Error(data?.error || 'Não foi possível concluir a solicitação. Tente novamente.');
  return data;
}

function showPayment() {
  $('#pix-image').removeAttribute('src');
  $('#qr-frame').hidden = terminal || !payment.image;
  if (payment.image) $('#pix-image').src = payment.image;
  if (!terminal) $('#modal-description').textContent = payment.image ? 'Escaneie o QR Code ou copie o código abaixo.' : 'Copie o código e pague pelo aplicativo do seu banco.';
  codeField.value = payment.code;
  $('#expires-at').textContent = payment.expiresAt ? `Válido até ${new Date(payment.expiresAt).toLocaleString('pt-BR', { dateStyle:'short', timeStyle:'short' })}` : '';
  $('#copy-feedback').textContent = '';
  $('#status-feedback').textContent = '';
  if (!dialog.open) dialog.showModal();
  if (!terminal) {
    checkPayment(false);
    clearInterval(polling);
    polling = setInterval(() => { if (!document.hidden) checkPayment(false); }, 12000);
  }
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (busy) return;
  error.hidden = true;
  if ($('#email').value.trim().toLowerCase() !== $('#email-confirm').value.trim().toLowerCase()) {
    $('#email-confirm').setCustomValidity('Os emails precisam ser iguais.');
    $('#email-confirm').reportValidity(); return;
  }
  const body = Object.fromEntries(new FormData(form));
  const snapshot = JSON.stringify(body);
  if (payment && snapshot === customerSnapshot) { showPayment(); return; }
  if (snapshot !== customerSnapshot) { requestId = crypto.randomUUID(); customerSnapshot = snapshot; payment = null; }
  busy = true; generate.disabled = true; openCopy.disabled = true;
  generate.querySelector('span').textContent = 'Gerando seu Pix…';
  form.setAttribute('aria-busy','true');
  // Keep customer fields stable until this request completes.
  const inputs = [...form.querySelectorAll('input')];
  inputs.forEach(input => input.readOnly = true);
  try {
    payment = await post('/api/pix', { ...body, requestId });
    terminal = false;
    $('#payment-status').className = 'payment-status';
    $('#status-text').textContent = 'Aguardando pagamento';
    $('#modal-title').textContent = 'Pague com Pix';
    copy.disabled = false; check.hidden = false; $('#new-pix').hidden = true;
    showPayment();
  } catch (err) { error.textContent = err.message; error.hidden = false; error.scrollIntoView({ behavior:'smooth', block:'nearest' }); }
  finally {
    busy = false; generate.disabled = false; openCopy.disabled = false;
    inputs.forEach(input => input.readOnly = false);
    generate.querySelector('span').textContent = payment ? 'Ver código QR' : 'Gerar código QR';
    form.removeAttribute('aria-busy');
  }
});
openCopy.addEventListener('click', () => form.requestSubmit());
$('#close-modal').addEventListener('click', () => dialog.close());
dialog.addEventListener('click', event => { if (event.target === dialog) { const r = dialog.getBoundingClientRect(); if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) dialog.close(); } });
dialog.addEventListener('close', () => clearInterval(polling));

copy.addEventListener('click', async () => {
  if (!payment || terminal) return;
  try {
    await navigator.clipboard.writeText(payment.code);
    $('#copy-feedback').textContent = 'Código copiado! Agora abra o aplicativo do seu banco.';
  } catch {
    codeField.focus(); codeField.select();
    $('#copy-feedback').textContent = 'Selecione e copie o código acima manualmente.';
  }
});

async function checkPayment(manual) {
  if (!payment || checking || terminal) return;
  checking = true; check.disabled = true;
  const currentPayment = payment;
  if (manual) $('#status-feedback').textContent = 'Consultando pagamento…';
  try {
    const result = await post('/api/status', { token:payment.token });
    if (payment !== currentPayment) return;
    const expired = payment.expiresAt && new Date(payment.expiresAt).getTime() <= Date.now();
    const state = result.status === 'PENDING' && expired ? 'EXPIRED' : result.status;
    const labels = { PENDING:'Aguardando pagamento', PAID:'Pagamento confirmado!', CANCELLED:'Pix cancelado ou expirado', REFUNDED:'Pagamento estornado', EXPIRED:'Este código Pix expirou' };
    $('#status-text').textContent = labels[state] || 'Aguardando pagamento';
    $('#status-feedback').textContent = manual && state === 'PENDING' ? 'Ainda aguardando a confirmação do banco.' : '';
    if (state !== 'PENDING') {
      terminal = true; clearInterval(polling); copy.disabled = true; check.hidden = true;
      $('#new-pix').hidden = state === 'PAID' || state === 'REFUNDED';
      $('#payment-status').className = `payment-status ${state === 'PAID' ? 'paid' : 'ended'}`;
      $('#qr-frame').hidden = true;
      if (state === 'PAID') { $('#modal-title').textContent = 'Pagamento confirmado'; $('#modal-description').textContent = 'Seu pagamento foi confirmado pela Black Cat.'; }
      else { $('#modal-description').textContent = 'Este código não está mais disponível para pagamento.'; }
    }
  } catch (err) { if (payment === currentPayment) $('#status-feedback').textContent = manual ? err.message : 'Não foi possível atualizar o status. Tentaremos novamente.'; }
  finally { checking = false; check.disabled = false; }
}
check.addEventListener('click', () => checkPayment(true));
$('#new-pix').addEventListener('click', () => { dialog.close(); payment = null; terminal = false; requestId = crypto.randomUUID(); form.requestSubmit(); });
