// Offline checks for the gate: a local stub facilitator and a local stub origin
// stand in for the real ones, so nothing leaves 127.0.0.1.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { paywall, createPaywallServer } from '../index.js';

const PAY_TO = 'test-pay-to-address';

function listen(handler) {
  return new Promise((resolve) => {
    const srv = http.createServer(handler);
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}
const urlOf = (srv) => `http://127.0.0.1:${srv.address().port}`;
const xpay = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64');

// Stub facilitator: settles only payloads carrying { ok: true }.
const settled = [];
const facilitator = await listen(async (req, res) => {
  let body = '';
  for await (const c of req) body += c;
  const j = JSON.parse(body);
  settled.push(j);
  const ok = j.paymentPayload?.payload?.ok === true;
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(ok
    ? { success: true, transaction: 'ab'.repeat(32), network: 'bsv', payer: 'payer' }
    : { success: false, errorReason: 'rejected by stub' }));
});
const FAC = `${urlOf(facilitator)}/v1/x402`;

// Stub origin for proxy mode.
const origin = await listen((req, res) => {
  res.writeHead(200, { 'content-type': 'application/json', 'x-origin': 'yes' });
  res.end(JSON.stringify({ path: req.url, sawPayment: 'x-payment' in req.headers }));
});

const servers = [facilitator, origin];
after(() => servers.forEach((s) => s.close()));

async function gated(opts) {
  const gate = paywall({ payTo: PAY_TO, facilitatorUrl: FAC, ...opts });
  const srv = await listen((req, res) => gate(req, res, () => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('paid content');
  }));
  servers.push(srv);
  return urlOf(srv);
}

test('payTo is required', () => {
  assert.throws(() => paywall({}), /payTo/);
});

test('no X-PAYMENT returns a 402 x402 quote', async () => {
  const base = await gated({ priceSats: 500, description: 'test api' });
  const r = await fetch(`${base}/data?x=1`);
  assert.equal(r.status, 402);
  const j = await r.json();
  assert.equal(j.x402Version, 1);
  const [a] = j.accepts;
  assert.equal(a.scheme, 'bsv-p2pkh');
  assert.equal(a.network, 'bsv');
  assert.equal(a.maxAmountRequired, '500');
  assert.equal(a.payTo, PAY_TO);
  assert.equal(a.description, 'test api');
  assert.match(a.resource, /\/data$/, 'query string is not part of the resource');
  assert.equal(a.extra.facilitatorUrl, FAC);
});

test('a malformed X-PAYMENT header is refused with a 402', async () => {
  const base = await gated({ priceSats: 1 });
  const r = await fetch(base, { headers: { 'x-payment': '%%%not-base64-json%%%' } });
  assert.equal(r.status, 402);
  assert.match((await r.json()).error, /invalid X-PAYMENT/);
});

test('an unsettled payment is refused and the handler does not run', async () => {
  const base = await gated({ priceSats: 1 });
  const r = await fetch(base, { headers: { 'x-payment': xpay({ payload: { ok: false } }) } });
  assert.equal(r.status, 402);
  assert.equal((await r.json()).error, 'rejected by stub');
});

test('a settled payment runs the handler and returns X-PAYMENT-RESPONSE', async () => {
  const base = await gated({ priceSats: 700 });
  const r = await fetch(base, { headers: { 'x-payment': xpay({ payload: { ok: true } }) } });
  assert.equal(r.status, 200);
  assert.equal(await r.text(), 'paid content');
  const resp = JSON.parse(Buffer.from(r.headers.get('x-payment-response'), 'base64').toString('utf8'));
  assert.equal(resp.success, true);
  assert.equal(resp.transaction, 'ab'.repeat(32));
  assert.equal(resp.amount, '700');
  assert.equal(settled.at(-1).paymentRequirements.maxAmountRequired, '700');
});

test('free(req) skips payment', async () => {
  const base = await gated({ priceSats: 1, free: (req) => req.url === '/health' });
  assert.equal((await fetch(`${base}/health`)).status, 200);
  assert.equal((await fetch(`${base}/other`)).status, 402);
});

test('proxy mode forwards to the origin without the X-PAYMENT header', async () => {
  const srv = createPaywallServer({ payTo: PAY_TO, facilitatorUrl: FAC, priceSats: 1, origin: urlOf(origin) });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  servers.push(srv);
  assert.equal((await fetch(`${urlOf(srv)}/v1/thing`)).status, 402);
  const r = await fetch(`${urlOf(srv)}/v1/thing`, { headers: { 'x-payment': xpay({ payload: { ok: true } }) } });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('x-origin'), 'yes');
  assert.ok(r.headers.get('x-payment-response'));
  assert.deepEqual(await r.json(), { path: '/v1/thing', sawPayment: false });
});
