// @bsvkey/x402-paywall — put a BSV (x402) paywall in front of ANY HTTP API.
//
// Your rail meters ONE resource today (inference). This turns it into infrastructure
// anyone can adopt: a provider drops this in front of their existing API and starts
// charging per call in BSV — no accounts, no card, no code in their handler.
//
//   (a) middleware — gate your own routes:
//       const gate = paywall({ payTo: '1Ldq…', priceSats: 500 });
//       http.createServer((req, res) => gate(req, res, () => myHandler(req, res)));
//
//   (b) reverse proxy — gate an existing upstream API, zero code in it:
//       createPaywallServer({ origin: 'http://localhost:9000', payTo: '1Ldq…', priceSats: 500 })
//         .listen(8080);
//
// The gate: no X-PAYMENT header → 402 with an x402 quote. With X-PAYMENT → settle it
// through a facilitator (defaults to BSVKey's), then serve/forward the resource and
// return X-PAYMENT-RESPONSE (the on-chain settlement). Zero deps (Node 18+ global fetch).
//
// Settlement-agnostic by design: `asset`/`scheme`/`network`/`facilitatorUrl` are config,
// so a different rail (e.g. XRP on XRPL, or USDC) works the moment a facilitator for that
// scheme exists — the gate logic is identical, it just proxies /settle to that facilitator.

import http from 'node:http';

const DEFAULT_FACILITATOR = 'https://inference.bsvkey.com/v1/x402';

function baseOf(facilitatorUrl) {
  return String(facilitatorUrl || DEFAULT_FACILITATOR).replace(/\/x402\/?$/, '');
}

// --- pricing: fixed sats, or USD pinned (settled in the sats equivalent) ---------
let _rate = { v: 0, at: 0 };
async function bsvUsd(facilitatorUrl) {
  if (Date.now() - _rate.at < 60000 && _rate.v) return _rate.v;
  try {
    const r = await fetch(`${baseOf(facilitatorUrl)}/pricebook`);
    const j = await r.json();
    if (j && j.bsvUsd > 0) _rate = { v: j.bsvUsd, at: Date.now() };
  } catch {}
  return _rate.v || 0;
}
async function priceSats(opts) {
  if (opts.priceSats) return Math.max(1, Math.round(opts.priceSats));
  if (opts.priceUsd) {
    const rate = await bsvUsd(opts.facilitatorUrl);
    if (rate > 0) return Math.max(1, Math.ceil((opts.priceUsd / rate) * 1e8));
  }
  return Math.max(1, Math.round(opts.priceSats || 1));
}

// --- x402 v1 payment requirements for this resource ------------------------------
function requirements(opts, sats, resource) {
  return {
    scheme: opts.scheme || 'bsv-p2pkh',
    network: opts.network || 'bsv',
    maxAmountRequired: String(sats),
    resource,
    description: opts.description || 'Paid API access',
    mimeType: 'application/json',
    payTo: opts.payTo,
    maxTimeoutSeconds: opts.maxTimeoutSeconds || 120,
    asset: opts.asset || 'BSV',
    extra: { facilitatorUrl: opts.facilitatorUrl || DEFAULT_FACILITATOR, ...(opts.priceUsd ? { priceUsd: opts.priceUsd } : {}) },
  };
}

function send402(res, reqs, errorReason) {
  const body = JSON.stringify({ x402Version: 1, error: errorReason || 'payment required', accepts: [reqs] });
  res.writeHead(402, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

function decodeXPayment(header) {
  try { return JSON.parse(Buffer.from(String(header), 'base64').toString('utf8')); } catch { return null; }
}

async function settle(opts, reqs, paymentPayload) {
  const url = (opts.facilitatorUrl || DEFAULT_FACILITATOR).replace(/\/$/, '') + '/settle';
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ paymentRequirements: reqs, paymentPayload }),
  });
  return r.json().catch(() => ({ success: false, errorReason: `facilitator ${r.status}` }));
}

// --- the gate --------------------------------------------------------------------
// paywall(opts) -> async (req, res, next?). If paid, calls next() (middleware) or
// forwards to opts.origin (proxy). opts.free(req) can exempt paths (health, docs).
export function paywall(opts = {}) {
  if (!opts.payTo) throw new Error('paywall: opts.payTo (a receiving address) is required');
  return async function gate(req, res, next) {
    try {
      if (typeof opts.free === 'function' && opts.free(req)) return proceed(req, res, next, opts, null);
      const resource = opts.resource || `https://${req.headers.host || 'api'}${(req.url || '').split('?')[0]}`;
      const sats = await priceSats(opts);
      const reqs = requirements(opts, sats, resource);

      const xpay = req.headers['x-payment'];
      if (!xpay) return send402(res, reqs);
      const pp = decodeXPayment(xpay);
      if (!pp) return send402(res, reqs, 'invalid X-PAYMENT header (expected base64 JSON)');
      const result = await settle(opts, reqs, pp.payload ? pp : { ...pp });
      if (!result || result.success !== true) return send402(res, reqs, (result && result.errorReason) || 'payment not settled');

      const xresp = Buffer.from(JSON.stringify({ success: true, transaction: result.transaction, network: result.network, payer: result.payer, amount: reqs.maxAmountRequired })).toString('base64');
      res.setHeader('X-PAYMENT-RESPONSE', xresp);
      return proceed(req, res, next, opts, result);
    } catch (e) {
      const body = JSON.stringify({ error: 'paywall error', detail: String((e && e.message) || e) });
      res.writeHead(500, { 'content-type': 'application/json' }); res.end(body);
    }
  };
}

async function proceed(req, res, next, opts, settlement) {
  if (typeof next === 'function') return next(); // middleware mode: your app serves it
  if (opts.origin) return proxyToOrigin(req, res, opts.origin);
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: true, paid: !!settlement, settlement }));
}

async function proxyToOrigin(req, res, origin) {
  const target = origin.replace(/\/$/, '') + (req.url || '/');
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;
  const headers = { ...req.headers };
  delete headers['x-payment']; delete headers['host']; delete headers['content-length'];
  const up = await fetch(target, { method: req.method, headers, body, redirect: 'manual' });
  const buf = Buffer.from(await up.arrayBuffer());
  const outHeaders = {};
  up.headers.forEach((v, k) => { if (!/^(content-encoding|transfer-encoding|connection)$/i.test(k)) outHeaders[k] = v; });
  // preserve the settlement header we already set
  const xr = res.getHeader('X-PAYMENT-RESPONSE'); if (xr) outHeaders['X-PAYMENT-RESPONSE'] = xr;
  res.writeHead(up.status, outHeaders);
  res.end(buf);
}

// Convenience: a standalone reverse-proxy server that gates an upstream `origin`.
export function createPaywallServer(opts = {}) {
  const gate = paywall(opts);
  return http.createServer((req, res) => gate(req, res));
}

export default paywall;
