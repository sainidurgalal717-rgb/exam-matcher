/* Tiny origin-checked proxy for exam-matcher's AI calls.
   Provider keys live here as environment variables and never ship in the website, so nothing
   public can leak them. Each provider accepts a whole pool: GEMINI_KEYS / GROQ_KEYS are
   comma- or newline-separated lists (the single GEMINI_API_KEY / GROQ_API_KEY still work).
   When a key hits its rate limit (429) or is dead (401/403), the proxy silently switches to the
   next key in the pool and retries, so the website never sees the limit.
   The site on the allowed origins is the only caller.

   Routes:  /gemini/*  -> https://generativelanguage.googleapis.com/*
            /groq/*    -> https://api.groq.com/openai/*
            /ping      -> warm-up / health (also lets the first real call skip the cold start) */
'use strict';

const http = require('http');
const https = require('https');

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
    pool: GEMINI_KEYS,
    cursor: 'gemini',
    headers: function (key) { return { 'x-goog-api-key': key }; }
  },
  groq: {
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

function corsHeaders(origin) {
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'Content-Type',
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

const server = http.createServer(function (req, res) {
  const origin = req.headers.origin || '';
  const okOrigin = ORIGINS.has(origin);
  const url = req.url || '/';
  const t0 = Date.now();

  if (url === '/' || url.split('?')[0] === '/ping') {
    return json(res, 200, { ok: true, gemini: GEMINI_KEYS.length, groq: GROQ_KEYS.length }, okOrigin ? origin : '');
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

    function send(hops) {
      const key = nextKey(conf);
      if (!key) return json(res, 500, { error: { message: route + ' key not configured on proxy' } }, origin);
      const target = new URL(conf.base + rest);
      const headers = Object.assign({}, conf.headers(key), { 'accept-encoding': 'identity' });
      if (body.length) {
        headers['content-type'] = req.headers['content-type'] || 'application/json';
        headers['content-length'] = body.length;
      }

      let up = null;
      res.on('close', function () {
        if (!res.writableEnded && up) up.destroy();
      });

      up = https.request({
        hostname: target.hostname,
        path: target.pathname + target.search,
        method: req.method,
        headers: headers,
        timeout: UPSTREAM_MS
      }, function (upRes) {
        const st = upRes.statusCode || 502;
        /* rate-limited or dead key: hand the request to the next key in the pool */
        if ((st === 429 || st === 401 || st === 403) && hops > 1) {
          upRes.resume();
          return send(hops - 1);
        }
        const h = corsHeaders(origin);
        if (upRes.headers['content-type']) h['content-type'] = upRes.headers['content-type'];
        if (upRes.headers['content-encoding']) h['content-encoding'] = upRes.headers['content-encoding'];
        res.writeHead(st, h);
        upRes.pipe(res);
        upRes.on('end', function () {
          console.log(req.method, url, st, Date.now() - t0 + 'ms' +
            (hops < hopsLeft ? ' (key ' + (hopsLeft - hops + 1) + '/' + hopsLeft + ')' : ''));
        });
      });

      up.on('timeout', function () { up.destroy(new Error('upstream timeout')); });
      up.on('error', function (e) {
        console.error(req.method, url, 'upstream error:', e.message);
        if (!res.headersSent) json(res, 502, { error: { message: 'upstream: ' + e.message } }, origin);
        else res.destroy();
      });

      if (body.length) up.write(body);
      up.end();
    }

    send(hopsLeft);
  });
});

server.listen(PORT, function () {
  console.log('exam-matcher AI proxy on :' + PORT +
    ' (gemini keys: ' + GEMINI_KEYS.length + ', groq keys: ' + GROQ_KEYS.length + ')');
});
