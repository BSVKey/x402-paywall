# @bsvkey/x402-paywall

Put a **BSV [x402](https://x402.org) paywall in front of any HTTP API.** Charge per
call in BSV — no accounts, no cards, no code in your handler. Agents pay each request
and get an on-chain settlement txid back.

```bash
npm i @bsvkey/x402-paywall
```

## Two ways to use it

**1. Reverse proxy** — gate an existing API with zero changes to it:

```js
import { createPaywallServer } from '@bsvkey/x402-paywall';

createPaywallServer({
  origin: 'http://localhost:9000',      // your existing API
  payTo: '1YourBsvAddress…',            // where the money lands
  priceSats: 500,                        // or: priceUsd: 0.002
  free: (req) => req.url.startsWith('/health'),  // exempt some routes
}).listen(8080);
// now http://localhost:8080/* is your API, paywalled in BSV.
```

**2. Middleware** — gate your own routes:

```js
import http from 'node:http';
import { paywall } from '@bsvkey/x402-paywall';

const gate = paywall({ payTo: '1YourBsvAddress…', priceUsd: 0.002 });
http.createServer((req, res) => gate(req, res, () => {
  // only runs after the caller has paid
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ data: 'your paid response' }));
})).listen(8080);
```

## How it works

1. Request with no `X-PAYMENT` header → **402** with an x402 quote (`accepts`).
2. The caller pays (e.g. with [`@bsvkey/x402-bsv-client`](https://www.npmjs.com/package/@bsvkey/x402-bsv-client)) and retries with `X-PAYMENT`.
3. The gate **settles the payment through a facilitator** (defaults to BSVKey's, which broadcasts on BSV), then serves/forwards the resource and returns `X-PAYMENT-RESPONSE` (the settlement txid).

You run a facilitator or use the hosted one — the gate just needs a `/settle` endpoint.

## Config

| Option | Meaning |
|---|---|
| `payTo` **(required)** | Address the payment pays. |
| `priceSats` / `priceUsd` | Flat price per call (USD is pinned, settled in the sats equivalent). |
| `facilitatorUrl` | Defaults to `https://inference.bsvkey.com/v1/x402`. Point at your own to keep 100%. |
| `origin` | Upstream API URL (reverse-proxy mode). |
| `free(req)` | Predicate to exempt routes (health, docs, free tier). |
| `asset` / `scheme` / `network` | Default BSV (`bsv-p2pkh` / `bsv`). |

## Other rails (XRP, USDC, …)

The gate is **settlement-agnostic** — it just proxies `/settle` to whatever facilitator
handles the `scheme` you configure. So a different asset (XRP on XRPL, USDC on an EVM
chain) works the moment a facilitator for that scheme exists; set `asset`/`scheme`/
`network`/`facilitatorUrl` and the gate logic is unchanged. Only BSV has a live facilitator
today ([the BSVKey one](https://inference.bsvkey.com/v1/x402)).

MIT.
