import {createServer} from 'node:http';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';
import {gzip as gzipCallback, brotliCompress as brotliCallback, constants as zlibConstants} from 'node:zlib';
import worker from '../dist/server/index.js';
import {localDB} from './local-db.mjs';

const MAX_BODY = 8 * 1024 * 1024;
const gzip = promisify(gzipCallback), brotli = promisify(brotliCallback);
const STATIC_ASSETS = new Set(['/index.html', '/styles.css', '/app.js', '/gpu-jobs.js', '/live.js']);
class PayloadTooLarge extends Error {}

function readBody(req) {
  if (Number(req.headers['content-length'] || 0) > MAX_BODY) {
    return Promise.reject(new PayloadTooLarge());
  }
  return new Promise((resolveBody, reject) => {
    const chunks = [];
    let size = 0;
    const cleanup = () => {
      req.off('data', onData); req.off('end', onEnd);
      req.off('error', onError); req.off('aborted', onAbort);
    };
    const onError = error => {cleanup(); reject(error);};
    const onAbort = () => onError(new Error('Request aborted'));
    const onEnd = () => {cleanup(); resolveBody(Buffer.concat(chunks, size));};
    const onData = chunk => {
      size += chunk.length;
      if (size > MAX_BODY) {
        cleanup(); req.pause(); reject(new PayloadTooLarge()); return;
      }
      chunks.push(chunk);
    };
    req.on('data', onData); req.once('end', onEnd);
    req.once('error', onError); req.once('aborted', onAbort);
  });
}

function selectEncoding(value, canCompress) {
  const weights = new Map();
  for (const item of String(value || '').split(',')) {
    const [coding, ...parameters] = item.trim().toLowerCase().split(';');
    if (!coding.trim()) continue;
    const q = parameters.map(p => p.trim()).find(p => p.startsWith('q='));
    const text = q ? q.slice(2).trim() : '1';
    const weight = /^(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/.test(text) ? Number(text) : 0;
    weights.set(coding.trim(), weight);
  }
  const identity = weights.get('identity') ?? (weights.get('*') === 0 ? 0 : 1);
  // Prefer Brotli on a tie. Implicit identity remains a fallback; an explicit
  // identity preference takes part in weighted negotiation.
  const choices = canCompress ? ['br', 'gzip'].map(coding => ({
    coding, weight: weights.get(coding) ?? weights.get('*') ?? 0
  })).filter(choice => choice.weight > 0).sort((a, b) => b.weight - a.weight) : [];
  const best = choices[0];
  if (best && !(weights.has('identity') && identity > best.weight)) return best.coding;
  return identity > 0 ? 'identity' : null;
}

async function prepareResponse(response, cacheable = false) {
  const headers = new Headers(response.headers);
  const body = Buffer.from(await response.arrayBuffer());
  headers.delete('Content-Length');
  const compressible = /^(?:text\/|application\/(?:json|javascript))/.test(headers.get('Content-Type') || '');
  if (compressible) {
    headers.set('Vary', [...new Set([...(headers.get('Vary') || '').split(',').map(v => v.trim()).filter(Boolean), 'Accept-Encoding'])].join(', '));
  }
  if (cacheable) headers.set('Cache-Control', 'public, max-age=0, must-revalidate');
  return {
    status: response.status, headers, body, compressible, cacheable,
    encodings: new Map(), etags: new Map()
  };
}

function compressedBody(entry, coding) {
  if (coding === 'identity') return entry.body;
  if (!entry.encodings.has(coding)) {
    const pending = coding === 'br'
      ? brotli(entry.body, {params: {[zlibConstants.BROTLI_PARAM_QUALITY]: 5}})
      : gzip(entry.body);
    entry.encodings.set(coding, pending);
    pending.catch(() => entry.encodings.delete(coding));
  }
  return entry.encodings.get(coding);
}

function matchesEtag(header, etag) {
  return typeof header === 'string' && header.split(',').some(value => {
    const candidate = value.trim();
    return candidate === '*' || candidate.replace(/^W\//, '') === etag;
  });
}

async function sendPreparedResponse(req, res, entry) {
  const headers = new Headers(entry.headers);
  const coding = selectEncoding(req.headers['accept-encoding'], entry.compressible && entry.body.length >= 1024);
  if (coding === null) {
    res.writeHead(406, {'Cache-Control': 'no-store', 'Vary': 'Accept-Encoding'});
    res.end(); return;
  }
  if (coding !== 'identity') headers.set('Content-Encoding', coding);
  const body = await compressedBody(entry, coding);
  if (entry.cacheable) {
    // Strong validators identify the selected wire representation, not just the
    // decoded source. A new build changes the digest and is downloaded normally.
    if (!entry.etags.has(coding)) entry.etags.set(coding, `"${createHash('sha256').update(body).digest('hex')}"`);
    const etag = entry.etags.get(coding);
    headers.set('ETag', etag);
    if (matchesEtag(req.headers['if-none-match'], etag)) {
      res.writeHead(304, Object.fromEntries(headers));
      res.end(); return;
    }
  }
  res.writeHead(entry.status, Object.fromEntries(headers));
  res.end(req.method === 'HEAD' ? undefined : body);
}

async function sendResponse(req, res, response) {
  return sendPreparedResponse(req, res, await prepareResponse(response));
}

export function createRenderServer({reportToken = process.env.STATUS_REPORT_TOKEN} = {}) {
  if (typeof reportToken !== 'string' || !reportToken.trim() || reportToken.length > 1024) {
    throw new Error('STATUS_REPORT_TOKEN is required and must be at most 1024 characters.');
  }
  // Latest reports live only in this process. Collectors refill them after a restart.
  const DB = localDB(), env = {DB, STATUS_REPORT_TOKEN: reportToken.trim(), SNAPSHOT_AUTH_MODE: 'public'};
  // At most five immutable built assets, each with at most Brotli and gzip.
  // API responses, report acknowledgments, and errors never enter this cache.
  const assetCache = new Map();
  const server = createServer({requestTimeout: 30000, headersTimeout: 15000}, async (req, res) => {
    try {
      const path = new URL(req.url, 'http://localhost').pathname;
      if (path === '/healthz' && ['GET', 'HEAD'].includes(req.method)) {
        return await sendResponse(req, res, new Response(JSON.stringify({ok: true}), {
          headers: {'Content-Type': 'application/json', 'Cache-Control': 'no-store'}
        }));
      }
      const assetKey = path === '/' ? '/index.html' : path;
      if (['GET', 'HEAD'].includes(req.method) && STATIC_ASSETS.has(assetKey)) {
        if (!assetCache.has(assetKey)) {
          const pending = worker.fetch(new Request('http://localhost' + assetKey), env, {})
            .then(async response => {
              const entry = await prepareResponse(response, response.status === 200);
              if (response.status !== 200) assetCache.delete(assetKey);
              return entry;
            });
          assetCache.set(assetKey, pending);
          pending.catch(() => assetCache.delete(assetKey));
        }
        return await sendPreparedResponse(req, res, await assetCache.get(assetKey));
      }
      const hasBody = !['GET', 'HEAD'].includes(req.method);
      const body = hasBody ? await readBody(req) : undefined;
      // Fetch static HEAD metadata from the same representation used for GET.
      const method = req.method === 'HEAD' && !path.startsWith('/api/') ? 'GET' : req.method;
      const request = new Request('http://localhost' + req.url, {
        method, headers: new Headers(req.headers), ...(hasBody ? {body} : {})
      });
      await sendResponse(req, res, await worker.fetch(request, env, {}));
    } catch (error) {
      if (res.destroyed) return;
      if (res.headersSent) {res.destroy(); return;}
      const oversized = error instanceof PayloadTooLarge;
      res.writeHead(oversized ? 413 : 500, {
        'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Connection': 'close'
      });
      res.end(JSON.stringify({error: oversized ? 'payload_too_large' : 'server_error'}));
    }
  });
  server.once('close', () => DB.raw.close());
  return server;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const value = process.env.PORT || '10000', port = Number(value);
    if (!/^\d+$/.test(value) || !Number.isInteger(port) || port < 0 || port > 65535) {
      throw new Error('PORT must be an integer from 0 to 65535.');
    }
    const server = createRenderServer();
    server.on('error', () => {console.error('Unable to start the HTTP server.'); process.exitCode = 1;});
    server.listen(port, '0.0.0.0', () => console.log(`Dashboard listening on port ${server.address().port}.`));
    const stop = () => {
      server.close(); server.closeIdleConnections();
      setTimeout(() => server.closeAllConnections(), 5000).unref();
    };
    process.once('SIGTERM', stop); process.once('SIGINT', stop);
  } catch (error) {
    console.error(error.message); process.exitCode = 1;
  }
}
