/* Optional AI reading pass: one page picture per call, Gemini Flash first, Groq's vision model if
   Gemini refuses. This runs only when the browser's own reading came back thin — a clean PDF with a
   text layer never reaches this file.

   Every call goes through the small proxy service in proxy/server.js (free Render web service).
   That proxy is the only place the provider keys exist, so no key ever ships inside this file. */
(function (global) {
  'use strict';

  var M = global.ExamMatcher;

  /* The proxy address. Overridable from the console for local testing:
     EXAMAI_PROXY = 'http://localhost:8899' */
  var PROXY = global.EXAMAI_PROXY || 'https://exam-matcher-ai.onrender.com';
  var GEMINI_HOST = PROXY + '/gemini/v1beta';
  var GROQ_HOST = PROXY + '/groq/v1';
  var CONC = global.EXAMAI_CONC || 5;   /* pages in flight at once — the proxy rotates a pool of
                                           keys, so pages can go side by side without one key
                                           hitting its limit */
  var PAGE_MS = 75000;     /* one page may take this long before it counts as failed */
  var MAX_PAGES = 60;      /* a single paper is never longer than this */

  var PROMPT = [
    'You are an exact OCR engine reading one scanned page of an Indian exam paper.',
    'Transcribe every printed character on this page.',
    '',
    '- Copy the text exactly as printed: same language, same script, same numbers, same order.',
    '- Never answer a question, translate, summarise, explain, correct or renumber anything.',
    '- Keep the original question numbers and option markers exactly as printed,',
    '  for example "1.", "2.", "(A)", "(B)", "(1)", "(2)", "प्रश्न 3".',
    '- If the page carries two columns of text, transcribe the whole left column first (top to',
    '  bottom), then the whole right column (top to bottom).',
    '- Keep the original line breaks.',
    '- Write every digit in ASCII: 0 1 2 3 4 5 6 7 8 9.',
    '- If a character is genuinely unreadable, write [?] for it instead of guessing.',
    '- Output the transcription only: no heading, no commentary, no markdown, no code fence.'
  ].join('\n');

  /* ---------- transport ---------- */

  function fetchJson(url, opts, ms) {
    opts = opts || {};
    var ctl = global.AbortController ? new global.AbortController() : null;
    var timer = ctl ? setTimeout(function () { ctl.abort(); }, ms || PAGE_MS) : null;
    return global.fetch(url, {
      method: opts.method || 'GET',
      headers: opts.headers || {},
      body: opts.body,
      signal: ctl ? ctl.signal : undefined
    }).then(function (r) {
      return r.text().then(function (raw) {
        var j = null;
        try { j = JSON.parse(raw); } catch (e) { /* not json — the message below still says something */ }
        if (!r.ok) {
          var m = (j && j.error && (j.error.message || j.error.type)) || (j && j.message) ||
                  String(raw || '').slice(0, 180) || ('HTTP ' + r.status);
          var err = new Error(String(m));
          err.status = r.status;
          throw err;
        }
        if (!j) { var e2 = new Error('AI ने समझ न आने वाला reply भेजा'); e2.skip = true; throw e2; }
        return j;
      });
    }).then(function (v) {
      if (timer) clearTimeout(timer);
      return v;
    }, function (e) {
      if (timer) clearTimeout(timer);
      if (e && e.name === 'AbortError') {
        var t = new Error('AI से reply नहीं आया (time out)');
        t.status = 408;
        throw t;
      }
      throw e;
    });
  }

  function b64(dataUrl) {
    var s = String(dataUrl || '');
    var i = s.indexOf(',');
    return i < 0 ? s : s.slice(i + 1);
  }

  function sleep(ms) {
    return new Promise(function (r) { setTimeout(r, ms); });
  }

  /* A free Render instance sleeps after ~15 idle minutes and takes ~30–50 s to wake. This ping is
     fired the moment the page loads (long before any scan is ready) so the proxy is usually already
     awake; if it is still waking, waitWarm gives it a 20 s head start and never blocks past that. */
  var warmP = null;
  function warm() {
    if (warmP) return warmP;
    warmP = PROXY
      ? global.fetch(PROXY + '/ping', { mode: 'cors' }).catch(function () {}).then(function () {})
      : Promise.resolve();
    return warmP;
  }

  function waitWarm() { return Promise.race([warm(), sleep(20000)]); }

  /* A printed answer-key table sometimes comes back as a markdown table even though the prompt
     forbids it ("| 1 | C |"). Put those rows back into "1 - C" so the key reader can count them. */
  function untable(t) {
    return String(t || '').split('\n').map(function (line) {
      var m = /^\s*\|(.+)\|\s*$/.exec(line);
      if (!m) return line;
      var cells = m[1].split('|').map(function (c) { return c.trim(); });
      if (cells.length < 2) return line;
      var sep = true;
      cells.forEach(function (c) { if (!/^:?-{2,}:?$/.test(c)) sep = false; });
      if (sep) return '';
      if (!/^\d{1,3}$/.test(cells[0])) return line;
      return cells[0] + ' - ' + cells.slice(1).join(' ');
    }).join('\n');
  }

  /* ---------- model discovery ----------
     Model names change every few months, so nothing is hard-coded: ask each provider what it has and
     take the newest plain flash / the best-known vision model. */

  function versionOf(id) {
    var m = /gemini-(\d+)(?:[.\-](\d+))?/.exec(id);
    if (!m) return [0, 0];
    return [parseInt(m[1], 10), parseInt(m[2] || '0', 10)];
  }

  function geminiFind() {
    return waitWarm().then(function () {
      return fetchJson(GEMINI_HOST + '/models?pageSize=200', {}, 45000);
    }).then(function (j) {
      var out = [];
      ((j && j.models) || []).forEach(function (m) {
        var name = String(m.name || '').replace(/^models\//, '');
        var methods = m.supportedGenerationMethods || [];
        if (methods.indexOf('generateContent') < 0) return;
        if (name.indexOf('gemini-') !== 0 || name.indexOf('flash') < 0) return;
        if (/image|tts|audio|embedding|live|thinking/.test(name)) return;
        var v = versionOf(name);
        /* newest version first; among equals prefer a plain flash, then stable over preview,
           and only then the cheaper lite model */
        out.push({ name: name, rank: [v[0], v[1],
          name.indexOf('-lite') < 0 ? 1 : 0,
          /preview|exp/.test(name) ? 0 : 1] });
      });
      out.sort(function (a, b) { return -cmp(a.rank, b.rank); });
      /* every candidate is kept: a model that is overloaded (503) gets skipped, not the provider */
      return out.map(function (o) { return o.name; });
    });
  }

  function cmp(a, b) {
    for (var i = 0; i < a.length; i++) { if (a[i] !== b[i]) return a[i] - b[i]; }
    return 0;
  }

  /* The best-known vision models, newest first. Groq has renamed its vision line before
     (llama-4 scout/maverick → qwen3.8), so anything whose name says vision is taken as well. */
  var GROQ_PREFER = [
    'qwen/qwen3.8-27b',
    'qwen/qwen3-vl-32b-instruct',
    'meta-llama/llama-4-scout-17b-16e-instruct',
    'meta-llama/llama-4-maverick-17b-128e-instruct'
  ];

  function groqFind() {
    return waitWarm().then(function () {
      return fetchJson(GROQ_HOST + '/models', {}, 45000);
    }).then(function (j) {
      var ids = ((j && j.data) || []).map(function (m) { return m.id; }).filter(Boolean);
      var out = [];
      GROQ_PREFER.forEach(function (p) { if (ids.indexOf(p) >= 0) out.push(p); });
      ids.forEach(function (id) {
        if (out.indexOf(id) < 0 && /vision|-vl-|scout|maverick/i.test(id)) out.push(id);
      });
      return out;
    });
  }

  /* ---------- providers ---------- */

  var PROVIDERS = {
    gemini: {
      label: 'Gemini',
      find: geminiFind,
      call: function (model, dataUrl) {
        var cfg = { temperature: 0, maxOutputTokens: 8192 };
        if (!this.noThink) cfg.thinkingConfig = { thinkingBudget: 0 };
        return geminiPost(model, cfg, [
          { text: PROMPT },
          { inline_data: { mime_type: 'image/jpeg', data: b64(dataUrl) } }
        ], this);
      },
      ping: function (model) {
        /* a thinking model eats the whole budget before it writes anything — 256 tokens plus the
           no-think switch keeps the ping from coming back empty */
        var cfg = { temperature: 0, maxOutputTokens: 256 };
        if (!this.noThink) cfg.thinkingConfig = { thinkingBudget: 0 };
        return geminiPost(model, cfg, [{ text: 'Reply with exactly: OK' }], this)
          .then(function (t) { return /ok/i.test(t); });
      }
    },
    groq: {
      label: 'Groq',
      find: groqFind,
      call: function (model, dataUrl) {
        return fetchJson(GROQ_HOST + '/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: model,
            temperature: 0,
            max_tokens: 8192,
            messages: [{
              role: 'user',
              content: [
                { type: 'text', text: PROMPT },
                { type: 'image_url', image_url: { url: dataUrl } }
              ]
            }]
          })
        }).then(function (j) {
          var c = j && j.choices && j.choices[0];
          var t = (c && c.message && c.message.content) || '';
          if (!String(t).trim()) { var e = new Error('Groq ने खाली reply भेजा'); e.skip = true; throw e; }
          return String(t);
        });
      },
      ping: function (model) {
        return fetchJson(GROQ_HOST + '/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: model, temperature: 0, max_tokens: 16,
            messages: [{ role: 'user', content: 'Reply with exactly: OK' }]
          })
        }).then(function (j) {
          return /ok/i.test((j.choices && j.choices[0] && j.choices[0].message.content) || '');
        });
      }
    }
  };

  function geminiPost(model, cfg, parts, prov) {
    return fetchJson(GEMINI_HOST + '/models/' + model + ':generateContent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: parts }], generationConfig: cfg })
    }).then(function (j) {
      var c = j && j.candidates && j.candidates[0];
      if (!c) {
        var b = j && j.promptFeedback && (j.promptFeedback.blockReason || j.promptFeedback.blockReasonMessage);
        var eb = new Error(b ? ('Gemini ने page block कर दिया (' + b + ')') : 'Gemini ने खाली reply भेजा');
        eb.skip = true;
        throw eb;
      }
      var t = '';
      ((c.content && c.content.parts) || []).forEach(function (p) { if (p.text) t += p.text; });
      if (!String(t).trim()) {
        var ee = new Error(c.finishReason === 'MAX_TOKENS' ? 'page बहुत लंबा था' : 'Gemini ने खाली reply भेजा');
        ee.skip = true;
        throw ee;
      }
      return String(t);
    }, function (e) {
      /* Some models reject thinkingConfig with a bare 400 "invalid argument" (measured on
         flash-lite); drop it once and keep going. */
      if (prov && !prov.noThink && e && e.status === 400) {
        prov.noThink = true;
        return geminiPost(model, { temperature: cfg.temperature, maxOutputTokens: cfg.maxOutputTokens },
          parts, prov);
      }
      throw e;
    });
  }

  /* ---------- provider chain ---------- */

  /* Gemini first, Groq as the backup — measured both ways on the same 45-page scan:
     Gemini first read it in 298 s with 1 page lost, Groq first in 494 s with 10 pages lost, because
     Groq's free tier collapses after ~18 pictures even though a single Groq page answers in 2-4 s
     against Gemini's 5-26 s. The fast per-page answer is not the fast whole paper. */
  var ORDER = ['gemini', 'groq'];
  var ready = {};      /* id -> ranked model list, false once it proved unusable, undefined = not asked yet */
  var current = null;  /* the provider that is working, reused for every later page */

  function configured() {
    return PROXY ? ORDER.slice() : [];
  }

  function available() { return configured().length > 0; }

  function pick() {
    if (current && ready[current] && ready[current].length) {
      return Promise.resolve({ id: current, p: PROVIDERS[current], model: ready[current][0] });
    }
    var list = configured(), i = 0;
    function next() {
      while (i < list.length && ready[list[i]] === false) i++;
      if (i >= list.length) return Promise.reject(new Error('कोई AI provider काम नहीं कर रहा'));
      var id = list[i], p = PROVIDERS[id];
      if (ready[id] && ready[id].length) return Promise.resolve({ id: id, p: p, model: ready[id][0] });
      return p.find().then(function (models) {
        if (!models || !models.length) {
          ready[id] = false;
          i++;
          return next();
        }
        ready[id] = models;
        return { id: id, p: p, model: models[0] };
      }, function () {
        ready[id] = false;
        i++;
        return next();
      });
    }
    return next();
  }

  /* Put the model that just failed at the BACK of the list instead of deleting it: the next page
     gets a different model, and a model that is only occasionally unable is still there later.
     Deleting (advance) is what used to happen on every odd page — with several pages in flight a
     45-page scan emptied the candidate list that way, and the run then reported "no provider works"
     while every provider was fine. */
  function rotate(c) {
    var lst = ready[c.id];
    if (!lst || lst.length < 2) return;
    var k = lst.indexOf(c.model);
    if (k >= 0) lst.push(lst.splice(k, 1)[0]);
  }

  /* take one model out of the list for good — used only when the model itself is unusable */
  function retire(c) {
    var lst = ready[c.id];
    if (!lst) return;
    var k = lst.indexOf(c.model);
    if (k >= 0) lst.splice(k, 1);
    if (!lst.length) { ready[c.id] = false; current = null; }
  }

  /* One page. A rate-limited provider is waited out before it is given up on — a free Gemini or Groq
     key allows only a handful of pages per minute, and a 45-page scan will meet that limit. */
  var ATTEMPTS = 5;    /* models one page walks through before it counts as failed */
  var strikes = {};    /* model -> recent failures; the third one retires that model */

  function punished(c, e) {
    if (e && e.status === 429 && /limit:\s*0\b/.test(e.message || '')) { retire(c); return; }
    strikes[c.model] = (strikes[c.model] || 0) + 1;
    if (strikes[c.model] >= 3) retire(c); else rotate(c);
  }

  function readPage(dataUrl, tries) {
    tries = tries || 0;
    return pick().then(function (c) {
      current = c.id;
      return c.p.call(c.model, dataUrl).then(function (t) {
        /* the model that just worked leads the list from now on: page one may walk past overloaded
           models, every later page goes straight to the one that answered */
        var lst = ready[c.id], k = lst ? lst.indexOf(c.model) : -1;
        if (k > 0) { lst.splice(k, 1); lst.unshift(c.model); }
        strikes[c.model] = 0;
        return t;
      }, function (e) {
        if (tries >= ATTEMPTS) throw e;
        if (e && e.status === 429 && tries < 2 && !/limit:\s*0\b/.test(e.message || '')) {
          /* a rate limit is usually a full minute of the shared key pool, not a dead model:
             wait it out on this one before looking elsewhere */
          return sleep(4000 * (tries + 1)).then(function () { return readPage(dataUrl, tries + 1); });
        }
        var auth = e && (e.status === 401 || e.status === 403 || /api key|permission/i.test(e.message || ''));
        if (auth) {
          /* the provider's keys are refused — no point handing the page to its next model */
          ready[c.id] = false;
          current = null;
          return readPage(dataUrl, tries + 1);
        }
        punished(c, e);
        return readPage(dataUrl, tries + 1);
      });
    });
  }

  /* ---------- public API ---------- */

  /* Every page of the file as one JPEG, each page read by the AI. Pages come back in order; a page
     that no provider could read is reported in `failed` instead of silently disappearing. */
  function readFile(file, opts) {
    opts = opts || {};
    var t0 = Date.now();
    if (!available()) return Promise.reject(new Error('कोई AI service सेट नहीं है'));
    if (!M || !M.pageImages) return Promise.reject(new Error('page renderer उपलब्ध नहीं'));
    var done = 0, failed = [], texts = [];
    return M.pageImages(file, {
      maxEdge: opts.maxEdge || 1536,
      onPage: function (pg, total) { if (opts.onPage) opts.onPage(pg, total); }
    }).then(function (res) {
      var pages = res.pages.slice(0, MAX_PAGES);
      var i = 0;
      function chunk() {
        if (i >= pages.length) return Promise.resolve();
        if (opts.deadline && Date.now() > opts.deadline) {
          for (; i < pages.length; i++) failed.push({ no: pages[i].no, err: 'समय खत्म' });
          return Promise.resolve();
        }
        var batch = pages.slice(i, i + CONC), at = i;
        i += batch.length;
        return Promise.all(batch.map(function (pg, k) {
          return readPage(pg.url).then(function (t) {
            texts[at + k] = t;
          }, function (e) {
            texts[at + k] = '';
            failed.push({ no: pg.no, err: String((e && e.message) || e) });
          }).then(function () {
            done++;
            if (opts.onProgress) opts.onProgress(done, pages.length);
          });
        })).then(chunk);
      }
      return chunk().then(function () {
        return {
          text: untable(texts.filter(function (t) { return t && t.trim(); }).join('\n\n')),
          count: pages.length,
          failed: failed,
          provider: current ? PROVIDERS[current].label : '',
          model: current && ready[current] ? ready[current][0] : '',
          ms: Date.now() - t0
        };
      });
    });
  }

  /* Is the service alive, and which model would be used? Run from the console on the live site.
     The first three candidates are tried, because the top-ranked model is often the one that is
     overloaded (503) and the run would still succeed on the next one down. */
  function selfTest() {
    var ids = configured();
    if (!ids.length) return Promise.resolve([]);
    return Promise.all(ids.map(function (id) {
      var p = PROVIDERS[id], t0 = Date.now();
      return p.find().then(function (models) {
        if (!models || !models.length) {
          return { provider: p.label, ok: false, error: 'कोई vision model नहीं मिला' };
        }
        var lastErr = null;
        function tryAt(k) {
          if (k >= 3 || k >= models.length) {
            return {
              provider: p.label, ok: false, model: models[0],
              error: lastErr ? String((lastErr && lastErr.message) || lastErr) : 'ping fail',
              candidates: models.length, ms: Date.now() - t0
            };
          }
          return p.ping(models[k]).then(function (ok) {
            if (ok) {
              return { provider: p.label, ok: true, model: models[k], candidates: models.length, ms: Date.now() - t0 };
            }
            lastErr = new Error('खाली reply');
            return tryAt(k + 1);
          }, function (e) {
            lastErr = e;
            return tryAt(k + 1);
          });
        }
        return tryAt(0);
      }, function (e) {
        return { provider: p.label, ok: false, error: String((e && e.message) || e), ms: Date.now() - t0 };
      });
    }));
  }

  function config() {
    return {
      proxy: PROXY,
      providers: configured(),
      gemini: { model: (ready.gemini && ready.gemini[0]) || null },
      groq: { model: (ready.groq && ready.groq[0]) || null },
      current: current
    };
  }

  warm();   /* wake the proxy now, not when the first scan is ready */

  global.ExamAI = {
    available: available,
    readFile: readFile,
    selfTest: selfTest,
    config: config
  };
})(window);
