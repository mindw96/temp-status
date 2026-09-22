import {createServer} from 'node:http';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';
import {gzip as gzipCallback} from 'node:zlib';
import worker from '../dist/server/index.js';
import {localDB} from './local-db.mjs';

const MAX_BODY = 8 * 1024 * 1024;
const gzip = promisify(gzipCallback);
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

function acceptsGzip(value = '') {
  return String(value).split(',').some(item => {
    const [coding, ...parameters] = item.trim().toLowerCase().split(';');
    if (coding.trim() !== 'gzip') return false;
    const q = parameters.find(parameter => parameter.trim().startsWith('q='));
    return !q || Number(q.trim().slice(2)) > 0;
  });
}

async function sendResponse(req, res, response) {
  const headers = new Headers(response.headers);
  let body = Buffer.from(await response.arrayBuffer());
  const compressible = /^(?:text\/|application\/(?:json|javascript))/.test(headers.get('Content-Type') || '');
  headers.delete('Content-Length');
  if (compressible) {
    headers.set('Vary', [headers.get('Vary'), 'Accept-Encoding'].filter(Boolean).join(', '));
    if (body.length >= 1024 && acceptsGzip(req.headers['accept-encoding'])) {
      body = await gzip(body);
      headers.set('Content-Encoding', 'gzip');
    }
  }
  res.writeHead(response.status, Object.fromEntries(headers));
  res.end(req.method === 'HEAD' ? undefined : body);
}

export function createRenderServer({reportToken = process.env.STATUS_REPORT_TOKEN} = {}) {
  if (typeof reportToken !== 'string' || !reportToken.trim() || reportToken.length > 1024) {
    throw new Error('STATUS_REPORT_TOKEN is required and must be at most 1024 characters.');
  }
  // Latest reports live only in this process. Collectors refill them after a restart.
  const DB = localDB(), env = {DB, STATUS_REPORT_TOKEN: reportToken.trim(), SNAPSHOT_AUTH_MODE: 'public'};
  const server = createServer({requestTimeout: 30000, headersTimeout: 15000}, async (req, res) => {
    try {
      const path = new URL(req.url, 'http://localhost').pathname;
      if (path === '/healthz' && ['GET', 'HEAD'].includes(req.method)) {
        return await sendResponse(req, res, new Response(JSON.stringify({ok: true}), {
          headers: {'Content-Type': 'application/json', 'Cache-Control': 'no-store'}
        }));
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
