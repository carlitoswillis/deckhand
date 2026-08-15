// Web UI. Node v22, built-in http only, zero dependencies.
//
// Same seam as everything else: this server reads the snapshot file, it does not
// collect anything itself. It's a second consumer of the Phase 1 output, which
// is the architecture PLAN.md asks for.
//
// Style: low-key, no glow, thin uniform cards. Deliberately unfashionable —
// this is a page you glance at, not one you look at.
//
// Port 7789 by default; DECKHAND_PORT overrides it.
//
// Binds all interfaces by default so it's reachable over Tailscale from a
// phone. Set DECKHAND_HOST=127.0.0.1 for loopback only.

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The page lives in its own file rather than a template literal in here. It was
// inline until a single backtick inside a JS comment terminated the literal and
// the whole module stopped parsing (2026-08-14) — a hazard with no upside, since
// nothing in the page is interpolated from the server.
const UI_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'ui.html');

const PORT = Number(process.env.DECKHAND_PORT ?? 7789);
const HOST = process.env.DECKHAND_HOST ?? '0.0.0.0';

export function serve(snapshotPath) {
  const server = createServer(async (req, res) => {
    try {
      await route(req, res, snapshotPath);
    } catch (err) {
      json(res, 500, { error: err?.message ?? String(err) });
    }
  });

  server.listen(PORT, HOST, () => {
    console.log(`deckhand ui → http://localhost:${PORT}  (bound ${HOST})`);
  });

  return server;
}

async function route(req, res, snapshotPath) {
  const url = new URL(req.url, `http://${req.headers.host}`);

  // Read per request: it costs nothing at this scale and means editing the
  // page doesn't require restarting the server.
  if (url.pathname === '/') return html(res, await readFile(UI_PATH, 'utf8'));

  if (url.pathname === '/api/snapshot') {
    try {
      return json(res, 200, JSON.parse(await readFile(snapshotPath, 'utf8')));
    } catch {
      return json(res, 404, { error: 'no snapshot yet — run a scan' });
    }
  }

  if (url.pathname === '/api/providers') {
    const { providerStatus } = await import('./llm.mjs');
    return json(res, 200, await providerStatus());
  }

  if (url.pathname === '/api/ask' && req.method === 'POST') {
    const body = await readBody(req);
    const snapshot = JSON.parse(await readFile(snapshotPath, 'utf8'));
    const { askAboutMac, factAboutMac } = await import('./ask.mjs');

    const result = body.fact
      ? await factAboutMac(snapshot, { provider: body.provider || undefined })
      : await askAboutMac(snapshot, body.question ?? '', { provider: body.provider || undefined });

    return json(res, 200, {
      ok: result.ok,
      text: result.text,
      error: result.error,
      provider: result.provider,
      model: result.model,
      ms: result.ms,
      costUsd: result.costUsd ?? null,
      sections: result.digest?.sections ?? [],
      approxTokens: result.digest?.approxTokens ?? null,
      check: result.check ?? null,
    });
  }

  // Scanning is read-only by contract, so letting the page trigger one is not a
  // write in the sense the ground rules care about.
  if (url.pathname === '/api/scan' && req.method === 'POST') {
    const { runScan } = await import('./scan.mjs');
    return json(res, 200, await runScan(snapshotPath));
  }

  json(res, 404, { error: 'not found' });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      // Nothing legitimate posts a megabyte to this endpoint.
      if (data.length > 1_000_000) reject(new Error('body too large'));
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        resolve({});
      }
    });
    req.on('error', reject);
  });
}

function json(res, code, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

function html(res, body) {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(body);
}

// ---------------------------------------------------------------------------
