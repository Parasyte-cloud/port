// Builds dist/pcs-showcase.html: a single self-contained file that runs the whole PCS in the browser.
import { build } from 'esbuild';
import fs from 'node:fs';
const r = await build({ entryPoints: ['public/main-local.js'], bundle: true, format: 'iife', minify: true, write: false, target: 'es2022', legalComments: 'none' });
const js = r.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
const css = fs.readFileSync('public/styles.css', 'utf8');
fs.mkdirSync('dist', { recursive: true });
const html = `<title>Parasyte PCS</title>
<meta name="claude:viewport-fit-sides" content="cover">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Archivo:wght@500;600;700&family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans:wght@400;500;600&display=swap">
<style>${css}</style>
<div id="app"></div>
<script>${js}</script>
`;
fs.writeFileSync('dist/pcs-showcase.html', html);
// Full standalone document for opening directly from disk.
fs.writeFileSync('dist/pcs-showcase-offline.html', `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">${html.replace('<div id="app"></div>', '</head><body><div id="app"></div>')}</body></html>`);
// Cloudflare Pages / any static host: dist/index.html plus security headers.
fs.copyFileSync('dist/pcs-showcase-offline.html', 'dist/index.html');
fs.writeFileSync('dist/_headers', `/*\n  X-Content-Type-Options: nosniff\n  X-Frame-Options: DENY\n  Referrer-Policy: no-referrer\n  Permissions-Policy: camera=(), microphone=(), geolocation=()\n`);
console.log(`dist/pcs-showcase.html ${(html.length / 1024).toFixed(0)} KB`);
