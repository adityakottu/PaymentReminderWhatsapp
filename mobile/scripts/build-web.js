'use strict';

/**
 * Copy the web UI (../public) into www/ for the native app and add a
 * Content-Security-Policy suitable for the app: scripts/styles only from the
 * bundle, API calls only over HTTPS to the configured server.
 */
const fs = require('fs');
const path = require('path');

const src = path.join(__dirname, '..', '..', 'public');
const out = path.join(__dirname, '..', 'www');

fs.rmSync(out, { recursive: true, force: true });
fs.cpSync(src, out, { recursive: true });

const csp = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data: blob:",
  'connect-src https:',
  "base-uri 'self'",
  "form-action 'none'",
].join('; ');
const indexPath = path.join(out, 'index.html');
const html = fs.readFileSync(indexPath, 'utf8');
if (!html.includes('<meta charset="utf-8">')) throw new Error('index.html changed – update build-web.js');
fs.writeFileSync(indexPath, html.replace('<meta charset="utf-8">', `<meta charset="utf-8">\n  <meta http-equiv="Content-Security-Policy" content="${csp}">`));
console.info(`Web assets copied to ${path.relative(process.cwd(), out) || out}`);
