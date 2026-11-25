# APAPA Technologies PCS: Port Community System showcase

A working prototype of the Port Community System described in the synopsis: one secure platform where the Port Authority, Customs, shipping lines, terminals, government agencies, forwarders, cargo owners, banks and hauliers process every port transaction on the same shipment record.

This is a **showcase build**. Data is seeded, payments go through a simulated gateway, and e-mail, SMS, webhooks and partner systems are simulated. Business rules are real and enforced.

## Run it

| Way | Command | Notes |
|---|---|---|
| Shared server, locally | `npm ci && npm start` then open http://localhost:8787 | Runs the Cloudflare Worker, Durable Object and D1 locally through wrangler. Needs a `.dev.vars` file with `PCS_SECRET=` (32+ random characters). |
| Single file | open `dist/pcs-showcase-offline.html` | Whole platform runs in the browser; changes stay in that browser. |
| Tests | `npm test` | Engine: end-to-end 12-step flow plus RBAC, scoping, validation, atomicity, tamper detection, lockout. |
| Shared-server acceptance | `npm run test:worker` | Starts the Worker locally (demo mode on, then off). Two people on two devices complete steps 1 to 12 on one shipment with live hand-over, invite-only accounts and 2-step verification; probes lockout, CSRF, reset links, deactivation and the demo switch. |
| Rebuild single file | `npm run build` | Uses esbuild (dev only). |

In demo mode every seeded persona's password is `demo1234` and the sign-in page lists them. With demo mode off, the password is not shown and those personas cannot sign in.

## Shared server on Cloudflare Workers

```
browser ──HTTPS/WebSocket──▶ Worker (worker/index.js)        sign-in, API, static app
                                 │  RPC                        D1: sessions, credentials, invites, rate limits
                                 ▼
                         Durable Object "Ledger"               one instance for the whole platform
                         (worker/ledger.js)                    runs core/engine.js in memory, pushes live updates
                                 │
                                 ▼
                         D1 table `commands`                   append-only command log, replayed on start
```

- **One writer.** Every command goes through the single Ledger instance in order, and is acknowledged only after its row is in D1. If the D1 write fails, the Ledger reloads from D1, so memory never runs ahead of the log.
- **Live hand-over.** Each open screen holds a WebSocket to the Ledger. Every committed change refreshes every screen, and notifications addressed to the viewer's organisation pop up with an Open button.
- **Sign-in (invite-only).** No public sign-up. The Port Authority onboards organisations and invites their administrator; each administrator invites their own staff. Invitations and reset links are single-use, stored hashed, valid 7 days and 1 hour.
- **Passwords.** At least 12 characters, common and personal passwords refused. Stored as PBKDF2-SHA256 (100,000 iterations, the Workers maximum) over an HMAC pepper held only in the Worker secret, so a copy of the database alone cannot be cracked offline. Five failures lock the account for 15 minutes; logins are also rate limited per IP and per email.
- **2-step verification.** Authenticator-app codes (TOTP), mandatory for the Port Authority, Customs and banks (`MFA_ORG_TYPES`), optional for others. Secrets are encrypted at rest, codes cannot be replayed, and 8 one-time recovery codes are issued.
- **Sessions.** Random tokens stored hashed, per browser tab, 12-hour limit and 2-hour idle limit. Password change or reset, sign-out-everywhere and deactivation end sessions and live connections at once.
- **Audit.** Sign-in events (logins, failures, invitations, resets, 2-step changes, recovery-code use) join the same hash-chained audit trail. Secrets never enter the command log.
- **Demo switch.** `DEMO_MODE=on` shows one-click personas with the published password, exempts those shared personas from 2-step verification, and allows data reset. `off` removes all of that.

### Deploy

1. `npx wrangler login`
2. The D1 database `parasyte-pcs` already exists with its tables, and its id is in `wrangler.worker.jsonc` (for a fresh account: `npx wrangler d1 create parasyte-pcs`, paste the id, then `npx wrangler d1 migrations apply parasyte-pcs --remote -c wrangler.worker.jsonc`).
3. `openssl rand -base64 48 | npx wrangler secret put PCS_SECRET -c wrangler.worker.jsonc` (keep it: rotating it invalidates every password).
4. Optional: `SETUP_TOKEN` (needed when `DEMO_MODE=off`, to create the first Port Authority administrator with `POST /api/setup`), and `RESEND_API_KEY` + `MAIL_FROM` for real invitation and reset emails. Without email, administrators copy the invitation link from the screen and send it themselves, and self-service reset is switched off.
5. `npm run deploy:worker` (applies D1 migrations, builds `build/site`, deploys).

Set `DEMO_MODE`, `SEED` and `APP_URL` in `wrangler.worker.jsonc`. The existing Cloudflare Pages showcase keeps using `wrangler.toml` and `dist/`.

## How the synopsis maps to the build

| Synopsis requirement | Where it lives |
|---|---|
| 1. Register / login, role-based access | Invite-only onboarding by the Port Authority with CAC/TIN checks (the in-browser showcase keeps public registration with approval), org admins invite users, 2-step verification for the Port Authority, Customs and banks, 5-strike lockout, permission matrix in `core/reference.js` enforced in `core/engine.js`; row-level scoping in `core/queries.js` |
| 2. Submit shipment data (manifest, B/L) | Vessel call notice, CSV/API/form manifest with ISO 6346 container check digits, IMO check digits, aggregated validation errors, controlled amendments |
| 3. Reuse common data | Vessel registry, trading-party registry, consignee matching by TIN; declarations pre-fill 14 fields from the manifest and the reuse rate is a KPI |
| 4. Request port / regulatory services | Berth allocation (overlap detection), agency permits, delivery orders, exam positioning, truck call-up, each routed to the deciding org with an SLA clock |
| 5. Customs & authority processing | Explainable risk engine (green/yellow/red), duty/VAT/CISS/ETLS assessment, documentary review, queries, joint exam with discrepancy re-assessment and penalty; importer compliance history feeds future risk |
| 6. Terminal operations | Arrival, discharge to yard slots, yard map, exam bay moves, storage accrual, terminal release |
| 7. Payments | Invoices raised automatically per beneficiary, one consolidated payment for many invoices, simulated decline, bank reconciliation and settlement |
| 8. Consolidation & approvals | Seven-condition release checklist; one Port Authority release order replaces separate approvals (optional auto-release) |
| 9. Cargo release | Release order and per-container electronic gate passes with expiry |
| 10. Gate & cargo movement | Gate verification of pass + booked truck plate; mismatches refused and alerted; partial and full gate-out |
| 11. Notifications | Event-driven notices to every concerned org, with simulated e-mail/SMS/webhook outbox; real-time push and hand-over pop-ups over WebSockets |
| 12. Close & reporting | Delivery confirmation closes the shipment and records dwell, clearance and end-to-end KPIs; live KPI dashboard and stage bottleneck analysis |
| Security, audit, transaction tracing | Every action written to a SHA-256 hash-chained audit trail with per-shipment trace IDs; chain verification; CSV export |
| HA / DR / monitoring | Append-only command log replays to an identical state (one-click DR drill replays the D1 log and proves it), D1 Time Travel point-in-time restore, `/api/health`, Prometheus `/api/metrics`, atomic commands |
| Integration layer | API-key partner API (`/api/v1/*`), keys stored hashed, public tracking API |

## Architecture

```
core/          Isomorphic domain (runs in Node and the browser)
  engine.js    Commands, business rules, RBAC, audit chain, replay
  queries.js   Read models, scoped per organisation
  reference.js Org types, permissions, tariff, settings (GUESS values flagged)
  seed.js      Drives the real engine through realistic interleaved scenarios
worker/        Cloudflare Worker: index.js (API, sign-in), ledger.js (Durable Object), auth.js, crypto.js
migrations/    D1 schema
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

Real Customs, TOS, bank and payment-gateway integrations; SSO and argon2id password hashing (PBKDF2 is used because Workers lacks argon2 natively); ledger snapshots so start-up replay stays fast as the log grows; document upload storage; multi-region deployment; formal penetration test.

## Deploy to Cloudflare Pages (testing)

The `dist/` folder is a ready static site: the whole platform runs in each tester's browser with the seeded data, and each tester's changes stay in their own browser (Configuration → Reset restores the scenario). No server, database or secrets are needed.

**Dashboard (no tools needed):** Cloudflare dashboard → Workers & Pages → Create → Pages → Connect to Git → pick `Parasyte-cloud/port` → Framework preset: None, Build command: *(leave empty)*, Build output directory: `dist` → Save and Deploy. Every push to `main` redeploys.

**Command line:** `npx wrangler login` then `npx wrangler pages deploy dist --project-name parasyte-pcs`.

To restrict testers, put the Pages URL behind Cloudflare Access (Zero Trust → Access → Applications → add the `*.pages.dev` hostname and allow testers' emails).

If you change the source, run `npm ci && npm run build` and commit the new `dist/`, or set the Pages build command to `npm ci && npm run build`.
