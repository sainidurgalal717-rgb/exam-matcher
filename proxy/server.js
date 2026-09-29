/* Tiny origin-checked proxy for exam-matcher's AI calls.
   The provider keys live here as environment variables (GEMINI_KEY or GEMINI_API_KEY,
   GROQ_KEY or GROQ_API_KEY) and never ship in the website, so nothing public can leak them.
   The site on the allowed origins is the only caller.

   Routes:  /gemini/*  -> https://generativelanguage.googleapis.com/*
            /groq/*    -> https://api.groq.com/openai/*
            /ping      -> warm-up / health (also lets the first real call skip the cold start) */
'use strict';

const http = require('http');
const https = require('https');

const PORT = process.env.PORT || 10000;
const GEMINI_KEY = process.env.GEMINI_KEY || process.env.GEMINI_API_KEY || '';
const GROQ_KEY = process.env.GROQ_KEY || process.env.GROQ_API_KEY || '';

const ORIGINS = new Set([
  'https://exam-matcher.onrender.com',
  'http://localhost:4173',
  'http://127.0.0.1:4173'
]);

const UPSTREAM_MS = 90000;
const MAX_BODY = 20 * 1024 * 1024;

const ROUTES = {
  gemini: {
    base: 'https://generativelanguage.googleapis.com',
    key: function () { return GEMINI_KEY; },
    headers: function (key) { return { 'x-goog-api-key': key }; }
  },
  groq: {
    base: 'https://api.groq.com/openai',
    key: function () { return GROQ_KEY; },
    headers: function (key) { return { authorization: 'Bearer ' + key }; }
  }
};

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
    return json(res, 200, { ok: true }, okOrigin ? origin : '');
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
  const key = conf.key();
  if (!key) return json(res, 500, { error: { message: route + ' key not configured on proxy' } }, origin);

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
      const h = corsHeaders(origin);
      if (upRes.headers['content-type']) h['content-type'] = upRes.headers['content-type'];
      if (upRes.headers['content-encoding']) h['content-encoding'] = upRes.headers['content-encoding'];
      res.writeHead(upRes.statusCode || 502, h);
      upRes.pipe(res);
      upRes.on('end', function () {
        console.log(req.method, url, upRes.statusCode, Date.now() - t0 + 'ms');
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
  });
});

server.listen(PORT, function () {
  console.log('exam-matcher AI proxy on :' + PORT +
    ' (gemini key: ' + (GEMINI_KEY ? 'set' : 'MISSING') +
    ', groq key: ' + (GROQ_KEY ? 'set' : 'MISSING') + ')');
});
