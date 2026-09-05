// Demo: paywall a tiny API in BSV. Starts a free upstream API, then a paywall proxy
// in front of it, and shows the 402 quote a caller gets before paying.
//
//   node example.js
//   curl -s http://localhost:8402/quote        # -> 402 with an x402 BSV quote
//   # to actually pay, use @bsvkey/x402-bsv-client with a funded key against :8402
//
import http from 'node:http';
import { createPaywallServer } from './index.js';

const PAY_TO = process.env.PAY_TO || '1LdqUbdZ6GY71KxThU6aKfuKXxgmTn82cv';

// 1) an existing upstream API (imagine this is yours — no x402 code in it)
const upstream = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ resource: req.url, now: new Date().toISOString(), data: 'the paid payload' }));
});
upstream.listen(9000, () => console.log('upstream API on :9000'));

// 2) a BSV paywall in front of it — 500 sat per call, /health is free
createPaywallServer({
  origin: 'http://localhost:9000',
  payTo: PAY_TO,
  priceSats: 500,
  description: 'Demo paid API',
  free: (req) => (req.url || '').startsWith('/health'),
}).listen(8402, () => {
  console.log('paywall proxy on :8402  (pays -> ' + PAY_TO + ')');
  console.log('\nTry:');
  console.log('  curl -s http://localhost:8402/health   # free, proxied');
  console.log('  curl -si http://localhost:8402/quote   # 402 with an x402 BSV quote');
  console.log('\nTo pay: point @bsvkey/x402-bsv-client at http://localhost:8402/quote with a funded key.');
});
