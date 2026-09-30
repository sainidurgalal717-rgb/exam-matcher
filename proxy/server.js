/* Tiny origin-checked proxy for exam-matcher's AI calls.
   Provider keys live here as environment variables and never ship in the website, so nothing
   public can leak them. Each provider accepts a whole pool: GEMINI_KEYS / GROQ_KEYS are
   comma- or newline-separated lists (the single GEMINI_API_KEY / GROQ_API_KEY still work).
   When a key hits its rate limit (429) or is dead (401/403), the proxy silently switches to the
   next key in the pool and retries, so the website never sees the limit.
   A page that was already read is answered from memory instead of costing a second API call.
   The site on the allowed origins is the only caller.

   Routes:  /gemini/*  -> https://generativelanguage.googleapis.com/*
            /groq/*    -> https://api.groq.com/openai/*
            /ping      -> warm-up / health (also lets the first real call skip the cold start) */
'use strict';

const http = require('http');
const https = require('https');
const crypto = require('crypto');
const zlib = require('zlib');

const PORT = process.env.PORT || 10000;

function keyPool(listVar, singleVar) {
  const raw = [process.env[listVar], process.env[singleVar]].filter(Boolean).join(',');
  return Array.from(new Set(raw.split(/[\s,;]+/).map(function (s) { return s.trim(); }).filter(Boolean)));
}

const GEMINI_KEYS = keyPool('GEMINI_KEYS', 'GEMINI_API_KEY');
const GROQ_KEYS = keyPool('GROQ_KEYS', 'GROQ_API_KEY');
const cursor = { gemini: 0, groq: 0 };

const ORIGINS = new Set([
  'https://exam-matcher.onrender.com',
  'http://localhost:4173',
  'http://127.0.0.1:4173'
]);

const UPSTREAM_MS = 90000;
const MAX_BODY = 20 * 1024 * 1024;
const MAX_KEY_HOPS = 8;   /* rate-limited/dead keys tried before giving the client the real answer */

const ROUTES = {
  gemini: {
    base: 'https://generativelanguage.googleapis.com',
    pool: GEMINI_KEYS,
    cursor: 'gemini',
    headers: function (key) { return { 'x-goog-api-key': key }; }
  },
  groq: {
    base: 'https://api.groq.com/openai',
    pool: GROQ_KEYS,
    cursor: 'groq',
    headers: function (key) { return { authorization: 'Bearer ' + key }; }
  }
};

function nextKey(conf) {
  if (!conf.pool.length) return '';
  const key = conf.pool[cursor[conf.cursor] % conf.pool.length];
  cursor[conf.cursor]++;
  return key;
}

/* ---------- read cache ----------
   One page picture always reads to the same text, so a repeated request is answered from memory.
   `reading` collects the duplicates that arrive while a read is still in flight; they are handed
   the same answer instead of each costing a call. Memory only — a deploy or the free tier's sleep
   clears it, which simply costs one fresh read. */
const CACHE_MS = 12 * 60 * 60 * 1000;
const CACHE_MAX = 400;
const CACHE_MAX_BYTES = 4 * 1024 * 1024;
const cache = new Map();
const reading = new Map();

function cacheStore(k, entry) {
  while (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
  cache.set(k, entry);
}

function corsHeaders(origin) {
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'Content-Type',
    'access-control-expose-headers': 'Content-Encoding, X-Proxy-Cache',
    'access-control-max-age': '86400',
    vary: 'Origin'
  };
}

function json(res, status, obj, origin) {
  const body = Buffer.from(JSON.stringify(obj));
  const h = { 'content-type': 'application/json; charset=utf-8', 'content-length': body.length };
  if (origin) Object.assign(h, corsHeaders(origin));
  res.writeHead(status, h);
  res.end(body);
}

/* A buffered JSON reply, gzipped when the caller says it can read gzip. */
function sendBuf(res, origin, st, ctype, buf, hit, gzip) {
  const h = corsHeaders(origin);
  h['content-type'] = ctype;
  h['x-proxy-cache'] = hit ? 'HIT' : 'MISS';
  if (gzip && buf.length > 512) {
    const gz = zlib.gzipSync(buf);
    h['content-encoding'] = 'gzip';
    h['content-length'] = gz.length;
    res.writeHead(st, h);
    res.end(gz);
    return;
  }
  h['content-length'] = buf.length;
  res.writeHead(st, h);
  res.end(buf);
}

const server = http.createServer(function (req, res) {
  const origin = req.headers.origin || '';
  const okOrigin = ORIGINS.has(origin);
  const url = req.url || '/';
  const t0 = Date.now();

  if (url === '/' || url.split('?')[0] === '/ping') {
    return json(res, 200, { ok: true, gemini: GEMINI_KEYS.length, groq: GROQ_KEYS.length, cached: cache.size },
      okOrigin ? origin : '');
  }

  if (req.method === 'OPTIONS') {
    if (!okOrigin) return json(res, 403, { error: { message: 'origin not allowed' } });
    res.writeHead(204, corsHeaders(origin));
    return res.end();
  }

  if (!okOrigin) return json(res, 403, { error: { message: 'origin not allowed' } });

  const m = /^\/(gemini|groq)(?=\/|\?|$)/.exec(url);
  if (!m) return json(res, 404, { error: { message: 'not found' } }, origin);

  const route = m[1];
  const conf = ROUTES[route];
  const hopsLeft = Math.min(conf.pool.length, MAX_KEY_HOPS);
  if (!hopsLeft) return json(res, 500, { error: { message: route + ' key not configured on proxy' } }, origin);

  const rest = url.slice(m[0].length) || '/';
  const chunks = [];
  let size = 0;
  let over = false;

  req.on('data', function (c) {
    if (over) return;
    size += c.length;
    if (size > MAX_BODY) {
      over = true;
      json(res, 413, { error: { message: 'body too large' } }, origin);
      req.destroy();
      return;
    }
    chunks.push(c);
  });

  req.on('error', function () {});

  req.on('end', function () {
    if (over || res.headersSent) return;
    const body = Buffer.concat(chunks);
    const gzOK = /gzip/.test(req.headers['accept-encoding'] || '');
    const ck = (req.method === 'POST' && body.length)
      ? route + ' ' + rest + ' ' + crypto.createHash('sha256').update(body).digest('base64') : '';

    if (ck) {
      const c = cache.get(ck);
      if (c && Date.now() - c.at < CACHE_MS) {
        console.log('POST', url, c.st, 'cached', Date.now() - t0 + 'ms');
        return sendBuf(res, origin, c.st, c.ctype, c.buf, true, gzOK);
      }
      if (c) cache.delete(ck);
      if (reading.has(ck)) { reading.get(ck).push({ res: res, gzip: gzOK }); return; }
      reading.set(ck, []);
    }

    function handOut(st, ctype, buf) {
      if (!ck) return;
      const waiters = reading.get(ck) || [];
      reading.delete(ck);
      for (var i = 0; i < waiters.length; i++) {
        try { sendBuf(waiters[i].res, origin, st, ctype, buf, true, waiters[i].gzip); } catch (e) {}
      }
    }
    function fail(msg) {
      handOut(502, 'application/json; charset=utf-8',
        Buffer.from(JSON.stringify({ error: { message: msg } })));
      if (!res.headersSent) json(res, 502, { error: { message: msg } }, origin);
      else res.destroy();
    }

    function send(hops) {
      const key = nextKey(conf);
      if (!key) return fail(route + ' key not configured on proxy');
      let up = null;
      try {
        const target = new URL(conf.base + rest);
        const headers = Object.assign({}, conf.headers(key), { 'accept-encoding': 'identity' });
        if (body.length) {
          headers['content-type'] = req.headers['content-type'] || 'application/json';
          headers['content-length'] = body.length;
        }

        up = https.request({
          hostname: target.hostname,
          path: target.pathname + target.search,
          method: req.method,
          headers: headers,
          timeout: UPSTREAM_MS
        }, function (upRes) {
          const st = upRes.statusCode || 502;
          const ctype = upRes.headers['content-type'] || 'application/json; charset=utf-8';
          /* rate-limited or dead key: hand the request to the next key in the pool */
          if ((st === 429 || st === 401 || st === 403) && hops > 1) {
            upRes.resume();
            return send(hops - 1);
          }
          /* a provider answer that is not a good JSON read is not worth remembering */
          if (!ck || st < 200 || st >= 300 || !/json/.test(ctype)) {
            handOut(502, 'application/json; charset=utf-8',
              Buffer.from(JSON.stringify({ error: { message: 'provider refused the read' } })));
            const h = corsHeaders(origin);
            h['content-type'] = ctype;
            res.writeHead(st, h);
            upRes.pipe(res);
            upRes.on('end', function () {
              console.log(req.method, url, st, Date.now() - t0 + 'ms' +
                (hops < hopsLeft ? ' (key ' + (hopsLeft - hops + 1) + '/' + hopsLeft + ')' : ''));
            });
            return;
          }
          const out = [];
          let n = 0, tooBig = false;
          upRes.on('data', function (chunk) {
            n += chunk.length;
            if (n > CACHE_MAX_BYTES) { tooBig = true; return; }
            out.push(chunk);
          });
          upRes.on('end', function () {
            console.log(req.method, url, st, Date.now() - t0 + 'ms' +
              (hops < hopsLeft ? ' (key ' + (hopsLeft - hops + 1) + '/' + hopsLeft + ')' : ''));
            if (tooBig) return fail('reply too large to read');
            const buf = Buffer.concat(out);
            cacheStore(ck, { st: st, ctype: ctype, buf: buf, at: Date.now() });
            sendBuf(res, origin, st, ctype, buf, false, gzOK);
            handOut(st, ctype, buf);
          });
          upRes.on('error', function () { fail('provider ended the reply early'); });
        });

        up.on('timeout', function () { up.destroy(new Error('upstream timeout')); });
        up.on('error', function (e) {
          console.error(req.method, url, 'upstream error:', e.message);
          fail('upstream: ' + e.message);
        });

        res.on('close', function () {
          if (!res.writableEnded && up) up.destroy();
        });

        if (body.length) up.write(body);
        up.end();
      } catch (e) {
        console.error(req.method, url, 'proxy error:', e.message);
        fail('proxy: ' + e.message);
      }
    }

    send(hopsLeft);
  });
});

server.listen(PORT, function () {
  console.log('exam-matcher AI proxy on :' + PORT +
    ' (gemini keys: ' + GEMINI_KEYS.length + ', groq keys: ' + GROQ_KEYS.length + ')');
});
