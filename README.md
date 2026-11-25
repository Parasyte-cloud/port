# Parasyte PCS: Port Community System showcase

A working prototype of the Port Community System described in the synopsis: one secure platform where the Port Authority, Customs, shipping lines, terminals, government agencies, forwarders, cargo owners, banks and hauliers process every port transaction on the same shipment record.

This is a **showcase build**. Data is seeded, payments go through a simulated gateway, and e-mail, SMS, webhooks and partner systems are simulated. Business rules are real and enforced.

## Run it

| Way | Command | Notes |
|---|---|---|
| Hosted server | `npm start` (Node 22+) then open http://localhost:8080 | Zero runtime dependencies. Data persists in `data/commands.jsonl`. `PORT`, `PCS_DATA_DIR`, `PCS_SECRET` are configurable. |
| Single file | open `dist/pcs-showcase-offline.html` | Whole platform runs in the browser; changes stay in that browser. |
| Tests | `npm test` | End-to-end 12-step flow plus RBAC, scoping, validation, atomicity, tamper detection, lockout. |
| Rebuild single file | `npm i && npm run build` | Uses esbuild (dev only). |

Every demo user's password is `demo1234`. The sign-in page lists one-click personas for every role.

## How the synopsis maps to the build

| Synopsis requirement | Where it lives |
|---|---|
| 1. Register / login, role-based access | Public registration with CAC/TIN checks, Port Authority approval, org admins manage users, 5-strike lockout, permission matrix in `core/reference.js` enforced in `core/engine.js`; row-level scoping in `core/queries.js` |
| 2. Submit shipment data (manifest, B/L) | Vessel call notice, CSV/API/form manifest with ISO 6346 container check digits, IMO check digits, aggregated validation errors, controlled amendments |
| 3. Reuse common data | Vessel registry, trading-party registry, consignee matching by TIN; declarations pre-fill 14 fields from the manifest and the reuse rate is a KPI |
| 4. Request port / regulatory services | Berth allocation (overlap detection), agency permits, delivery orders, exam positioning, truck call-up, each routed to the deciding org with an SLA clock |
| 5. Customs & authority processing | Explainable risk engine (green/yellow/red), duty/VAT/CISS/ETLS assessment, documentary review, queries, joint exam with discrepancy re-assessment and penalty; importer compliance history feeds future risk |
| 6. Terminal operations | Arrival, discharge to yard slots, yard map, exam bay moves, storage accrual, terminal release |
| 7. Payments | Invoices raised automatically per beneficiary, one consolidated payment for many invoices, simulated decline, bank reconciliation and settlement |
| 8. Consolidation & approvals | Seven-condition release checklist; one Port Authority release order replaces separate approvals (optional auto-release) |
| 9. Cargo release | Release order and per-container electronic gate passes with expiry |
| 10. Gate & cargo movement | Gate verification of pass + booked truck plate; mismatches refused and alerted; partial and full gate-out |
| 11. Notifications | Event-driven notices to every concerned org, with simulated e-mail/SMS/webhook outbox; real-time push via server-sent events |
| 12. Close & reporting | Delivery confirmation closes the shipment and records dwell, clearance and end-to-end KPIs; live KPI dashboard and stage bottleneck analysis |
| Security, audit, transaction tracing | Every action written to a SHA-256 hash-chained audit trail with per-shipment trace IDs; chain verification; CSV export |
| HA / DR / monitoring | Append-only command log replays to an identical state (one-click DR drill proves it), `/api/health`, Prometheus `/api/metrics`, stateless signed sessions, atomic commands |
| Integration layer | API-key partner API (`/api/v1/*`), keys stored hashed, public tracking API |

## Architecture

```
core/          Isomorphic domain (runs in Node and the browser)
  engine.js    Commands, business rules, RBAC, audit chain, replay
  queries.js   Read models, scoped per organisation
  reference.js Org types, permissions, tariff, settings (GUESS values flagged)
  seed.js      Drives the real engine through realistic interleaved scenarios
server.js      Zero-dependency HTTP server, auth, API, SSE, persistence
public/        Web client (vanilla JS modules)
test/          node:test end-to-end tests
```

Commands are the only way to change state. Each successful command is appended to the log; the log replays deterministically, so backups, DR and audit all rest on one source.

## Guesses to confirm (marked GUESS in the app)

- Exchange rate, CIF factor, VAT/CISS/ETLS bases, duty rates per HS heading, risk thresholds and weights.
- Port dues, terminal handling, storage, free days, carrier DO fees, exam penalty rate.
- SLA hours per service type, gate pass validity.
- Org names in the seed are fictional placeholders (“Port Authority (Demo)”, “Customs Service (Demo)”).

## Production gaps (deliberately out of scope for a showcase)

Real Customs, TOS, bank and payment-gateway integrations; SSO/MFA and argon2id password hashing; a relational/event store with replication instead of a JSONL file; document upload storage; multi-region deployment; formal penetration test.

## Deploy to Cloudflare Pages (testing)

The `dist/` folder is a ready static site: the whole platform runs in each tester's browser with the seeded data, and each tester's changes stay in their own browser (Configuration → Reset restores the scenario). No server, database or secrets are needed.

**Dashboard (no tools needed):** Cloudflare dashboard → Workers & Pages → Create → Pages → Connect to Git → pick `Parasyte-cloud/port` → Framework preset: None, Build command: *(leave empty)*, Build output directory: `dist` → Save and Deploy. Every push to `main` redeploys.

**Command line:** `npx wrangler login` then `npx wrangler pages deploy dist --project-name parasyte-pcs`.

To restrict testers, put the Pages URL behind Cloudflare Access (Zero Trust → Access → Applications → add the `*.pages.dev` hostname and allow testers' emails).

If you change the source, run `npm ci && npm run build` and commit the new `dist/`, or set the Pages build command to `npm ci && npm run build`.
