// Assembles the static web app for the Cloudflare Worker (Workers Static Assets): public/ + core/.
// The browser imports the shared core modules (reference data, seed persona list) directly.
import fs from 'node:fs';
const OUT = 'build/site';
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
fs.cpSync('public', OUT, { recursive: true, filter: (src) => !src.endsWith('main-local.js') && !src.endsWith('api-local.js') });
fs.cpSync('core', `${OUT}/core`, { recursive: true });
const csp = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";
fs.writeFileSync(`${OUT}/_headers`, `/*\n  Content-Security-Policy: ${csp}\n  X-Content-Type-Options: nosniff\n  X-Frame-Options: DENY\n  Referrer-Policy: no-referrer\n  Strict-Transport-Security: max-age=31536000; includeSubDomains\n  Permissions-Policy: camera=(), microphone=(), geolocation=()\n`);
console.log(`Built ${OUT}`);
