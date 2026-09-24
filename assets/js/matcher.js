/* ============================================================
   I LOVE EXAM MATCHER — matching engine
   1) Read text from PDF / image (OCR)
   2) Parse question paper -> {no, text, options}
   3) Parse answer key       -> {no, answer, text?}
   4) Match by QUESTION CONTENT, not by number
   5) Score + verdict
   ============================================================ */
(function (global) {
  'use strict';

  var PDFJS_CDN = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
  var PDFJS_WORKER = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
  var TESS_CDN = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';

  var loaded = {};
  function loadScript(src, key) {
    if (loaded[key]) return loaded[key];
    loaded[key] = new Promise(function (res, rej) {
      var s = document.createElement('script');
      s.src = src;
      s.async = true;
      s.onload = function () { res(true); };
      s.onerror = function () { loaded[key] = null; rej(new Error('Could not load ' + key)); };
      document.head.appendChild(s);
    });
    return loaded[key];
  }

  /* ---------- 1. Text extraction ---------- */

  /* OCR is the slow part of the whole app: every Tesseract worker costs a model
     download + wasm init. Keep workers alive in a pool and warm them up early.
     One worker eats ~80 MB of RAM, so scale with the device instead of maxing it out. */
  var CORES = (global.navigator && global.navigator.hardwareConcurrency) || 4;
  var OCR_POOL_SIZE = Math.max(2, Math.min(3, CORES - 1));
  var pools = {};

  function tesseractReady() { return loadScript(TESS_CDN, 'tess'); }

  function freeSlot(slot) {
    slot.busy = false;
    var q = slot.waiters.shift();
    if (q) { slot.busy = true; q(slot); }
  }

  function acquireWorker(lang) {
    var list = pools[lang] || (pools[lang] = []);
    for (var i = 0; i < list.length; i++) {
      if (!list[i].busy) { list[i].busy = true; return Promise.resolve(list[i]); }
    }
    if (list.length < OCR_POOL_SIZE) {
      var slot = { busy: true, w: null, waiters: [], onProgress: null };
      list.push(slot);
      return tesseractReady().then(function () {
        return global.Tesseract.createWorker(lang, 1, {
          logger: function (m) {
            if (slot.onProgress && m.status === 'recognizing text') slot.onProgress(m.progress);
          }
        });
      }).then(function (w) { slot.w = w; return slot; },
        function (e) { list.splice(list.indexOf(slot), 1); throw e; });
    }
    return new Promise(function (res) { list[0].waiters.push(res); });
  }

  /* Load the OCR script (cheap) + optionally its worker and language model (heavy). */
  function prewarm(lang, heavy) {
    loadScript(PDFJS_CDN, 'pdfjs');
    if (!heavy) return tesseractReady().then(function () { return true; }, function () { return false; });
    return acquireWorker(lang || 'eng').then(function (slot) { freeSlot(slot); return true; },
      function () { return false; });
  }

  function readFileAsDataURL(file) {
    return new Promise(function (res, rej) {
      var fr = new FileReader();
      fr.onload = function () { res(fr.result); };
      fr.onerror = function () { rej(new Error('File read failed')); };
      fr.readAsDataURL(file);
    });
  }

  function ocrImageSource(src, lang, onProgress) {
    return acquireWorker(lang || 'eng').then(function (slot) {
      slot.onProgress = onProgress || null;
      function done(out) { slot.onProgress = null; freeSlot(slot); return (out && out.data && out.data.text) || ''; }
      function fail(e) { slot.onProgress = null; freeSlot(slot); throw e; }
      return slot.w.recognize(src).then(done, fail);
    });
  }

  function extractFromPdf(file, opts) {
    opts = opts || {};
    var pageCount = 0;
    return loadScript(PDFJS_CDN, 'pdfjs').then(function () {
      global.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
      return file.arrayBuffer();
    }).then(function (buf) {
      /* pdf.js detaches the buffer it is handed, so keep a private copy for the JPEG fast path */
      opts.buf = buf.slice ? buf.slice(0) : buf;
      return global.pdfjsLib.getDocument({ data: buf }).promise;
    }).then(function (doc) {
      pageCount = doc.numPages;
      var pages = [], i;
      for (i = 1; i <= pageCount; i++) pages.push(i);
      return mapLimit(pages, 4, function (pn) {
        return doc.getPage(pn).then(function (page) {
          return page.getTextContent().then(function (tc) { return itemsToLines(tc.items); });
        });
      }).then(function (parts) { return '\n' + parts.join('\n'); });
    }).then(function (text) {
      // Scanned PDF — or a PDF whose built-in text layer is broken/garbled. Render and OCR instead.
      var clean = text.replace(/\s/g, '');
      var hq = hindiQuality(text);
      /* Mangled Devanagari only needs the slow page-OCR when there is no clean English copy of the
         same question to match against — bilingual papers keep their English half readable. */
      var broken = /[\uFFFD]/.test(text) || (clean.length && !/[\u0020-\u007E\u0900-\u097F]/.test(text))
        || (hq !== null && hq > HINDI_BAD && latinShare(text) < 0.3);
      if (opts.forceOcr || clean.length < Math.max(150, file.size / 800) || broken) {
        /* a Hindi text layer tells us which OCR models the pages actually need */
        if (/[\u0900-\u097F]/.test(text) && opts.lang === 'eng') opts.lang = 'eng+hin';
        opts.pageCount = pageCount;
        return ocrPdfPages(file, opts);
      }
      return tidyLines(text);
    });
  }

  /* pdf.js hands back positioned fragments; rebuild real lines from them */
  function itemsToLines(items) {
    var out = '', lastY = null, lastEnd = null;
    items.forEach(function (it) {
      if (typeof it.str !== 'string') return;
      var tr = it.transform || [1, 0, 0, 1, 0, 0];
      var y = tr[5], x = tr[4];
      if (lastY === null) { out += it.str; }
      else if (Math.abs(y - lastY) > 2.5) { out += '\n' + it.str; }
      else { out += (lastEnd !== null && x - lastEnd > 1.2 ? ' ' : '') + it.str; }
      lastY = y;
      lastEnd = x + (it.width || 0);
    });
    return out;
  }

  /* OCR of a scanned page is cheap; pdf.js *decoding* the scan is what costs 30 s a page.
     Scanner PDFs store each page as one plain JPEG stream, so pulling those bytes out and letting
     the browser decode them natively makes a 45-page key readable in minutes instead of an hour. */
  function jpegPagesFromPdf(buf, expectedPages) {
    if (!buf) return null;
    var bytes = new Uint8Array(buf), text = '', i, chunk = 0x8000;
    for (i = 0; i < bytes.length; i += chunk) {
      text += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + chunk, bytes.length)));
    }
    var out = [], m;
    /* anchored on the filter so the match does not depend on key order inside the object dictionary.
       Hoisted out of the loop: a fresh /g/ literal each round would restart exec() at 0 forever. */
    var dct = /\/Filter\s*\/DCTDecode/g;
    while ((m = dct.exec(text))) {
      var head = text.indexOf('stream', m.index);
      if (head < 0) continue;
      var start = head + 6;
      if (text.charCodeAt(start) === 13) start++;
      if (text.charCodeAt(start) === 10) start++;
      var end = text.indexOf('endstream', start);
      if (end < 0) continue;
      if (bytes[start] !== 0xFF || bytes[start + 1] !== 0xD8) continue;
      var tail = bytes.lastIndexOf(0xD9, Math.min(end, bytes.length - 1));
      if (tail < 0 || bytes[tail - 1] !== 0xFF) continue;
      out.push(bytes.subarray(start, tail + 1));
    }
    if (!out.length || (expectedPages && out.length !== expectedPages)) return null;
    /* page thumbnails and logos are small; a scan page is always thousands of pixels tall */
    var big = out.filter(function (j) { return j.length > 40000; });
    if (big.length !== out.length) return null;
    return out;
  }

  function blobUrl(blob) {
    return new Promise(function (res, rej) {
      var fr = new FileReader();
      fr.onload = function () { res(fr.result); };
      fr.onerror = function () { rej(new Error('image read failed')); };
      fr.readAsDataURL(blob);
    });
  }

  function loadBitmap(blob) {
    function viaElement() {
      return blobUrl(blob).then(function (url) {
        return new Promise(function (res, rej) {
          var im = new Image();
          im.onload = function () { res(im); };
          im.onerror = function () { rej(new Error('image decode failed')); };
          im.src = url;
        });
      });
    }
    return global.createImageBitmap ? global.createImageBitmap(blob).then(null, viaElement) : viaElement();
  }

  /* Hand OCR a page-sized JPEG: 1200 px on the long edge reads cleanly and stays fast.
     With `enhance` the page also gets the cleanup below, and the finished page is reported to
     `onPage` so the caller can rebuild a fresh PDF out of exactly what OCR saw. */
  function jpegToOcrSource(slice, maxEdge, enhance, onPage) {
    var blob = new Blob([slice], { type: 'image/jpeg' });
    function fromBitmap(bmp) {
      var w = bmp.width || bmp.naturalWidth, h = bmp.height || bmp.naturalHeight;
      if (!enhance && Math.max(w, h) <= maxEdge) return blobUrl(blob);
      return pageSource(bmp, maxEdge, enhance, onPage);
    }
    return loadBitmap(blob).then(fromBitmap, function () { return blobUrl(blob); });
  }

  function pageSource(bmp, maxEdge, enhance, onPage) {
    var w = bmp.width || bmp.naturalWidth, h = bmp.height || bmp.naturalHeight;
    var s = Math.min(1, maxEdge / Math.max(w, h));
    var c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w * s));
    c.height = Math.max(1, Math.round(h * s));
    var ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bmp, 0, 0, c.width, c.height);
    if (bmp.close) bmp.close();
    if (enhance) enhanceForOcr(ctx, c.width, c.height);
    var url = c.toDataURL('image/jpeg', 0.92);
    if (onPage) onPage({ w: c.width, h: c.height, bytes: base64Bytes(url) });
    return url;
  }

  /* Phone photos of answer papers come in grey, soft and low-contrast, and Tesseract reads that
     far worse than a flat black-on-white page. Levels + unsharp on luminance only — the model
     binarises the page itself, so colour is just noise to it. */
  function enhanceForOcr(ctx, w, h) {
    var img = ctx.getImageData(0, 0, w, h), d = img.data, total = w * h;
    var gray = new Uint8ClampedArray(total), hist = new Uint32Array(256), i, p, g;
    for (i = 0, p = 0; i < d.length; i += 4, p++) {
      g = (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000 | 0;
      gray[p] = g;
      hist[g]++;
    }
    /* stretch the middle 96% of the histogram over the full range: shadows become paper, ink black */
    var lo = 0, hi = 255, acc = 0, cut = total * 0.02;
    for (i = 0; i < 256; i++) { acc += hist[i]; if (acc > cut) { lo = i; break; } }
    acc = 0;
    for (i = 255; i >= 0; i--) { acc += hist[i]; if (acc > cut) { hi = i; break; } }
    if (hi - lo < 40) hi = Math.min(255, lo + 40);
    var k = 255 / (hi - lo);
    for (p = 0; p < total; p++) gray[p] = (gray[p] - lo) * k;
    unsharp(gray, w, h);
    for (i = 0, p = 0; i < d.length; i += 4, p++) { d[i] = d[i + 1] = d[i + 2] = gray[p]; }
    ctx.putImageData(img, 0, 0);
  }

  function unsharp(gray, w, h) {
    var total = w * h, blur = new Uint8ClampedArray(total), x, y, i, sum, cnt;
    for (y = 0; y < h; y++) {
      var row = y * w;
      for (x = 0; x < w; x++) {
        i = row + x;
        sum = gray[i] * 4; cnt = 4;
        if (x > 0) { sum += gray[i - 1] * 2; cnt += 2; }
        if (x + 1 < w) { sum += gray[i + 1] * 2; cnt += 2; }
        if (y > 0) { sum += gray[i - w] * 2; cnt += 2; }
        if (y + 1 < h) { sum += gray[i + w] * 2; cnt += 2; }
        blur[i] = sum / cnt;
      }
    }
    for (i = 0; i < total; i++) gray[i] += (gray[i] - blur[i]) * 0.8;
  }

  function base64Bytes(dataUrl) {
    var b = atob(dataUrl.slice(dataUrl.indexOf(',') + 1)), u = new Uint8Array(b.length), i;
    for (i = 0; i < b.length; i++) u[i] = b.charCodeAt(i);
    return u;
  }

  function ocrPdfPages(file, opts) {
    opts = opts || {};
    var jpegs = jpegPagesFromPdf(opts.buf, opts.pageCount || 0);
    if (jpegs) {
      var maxEdge = opts.ocrEdge || (jpegs.length > 30 ? 1200 : 1600);
      return runOcrJobs(jpegs.length, opts, function (pn) {
        return jpegToOcrSource(jpegs[pn - 1], maxEdge, opts.enhance, function (pg) {
          pg.no = pn;
          if (opts.onPage) opts.onPage(pg);
        });
      });
    }
    return renderPdfPagesToOcr(file, opts);
  }

  /* Fallback for PDFs that keep their scans in an exotic codec: render through pdf.js. */
  function renderPdfPagesToOcr(file, opts) {
    var pdf = null;
    return loadScript(PDFJS_CDN, 'pdfjs').then(function () {
      global.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
      return file.arrayBuffer();
    }).then(function (buf) {
      return global.pdfjsLib.getDocument({ data: buf }).promise;
    }).then(function (doc) {
      pdf = doc;
      var n = doc.numPages;
      /* measured by long edge, not by a scale factor: a page box is either points or pixels */
      return runOcrJobs(n, opts, function (pn) {
        return pdf.getPage(pn).then(function (p) {
          var vp0 = p.getViewport({ scale: 1 });
          var s = (opts.ocrEdge || 1000) / Math.max(vp0.width, vp0.height);
          return renderPageToDataURL(pdf, pn, s, opts);
        });
      });
    });
  }

  /* OCR page 1..n with the worker pool, but never past the shared deadline: whatever was read by
     then becomes the (partial) answer, so a huge scan cannot hold a student waiting. */
  function runOcrJobs(n, opts, srcFn) {
    var last = n, i, jobs = [];
    if (opts.maxPages && last > opts.maxPages) last = opts.maxPages;
    for (i = 1; i <= last; i++) jobs.push(i);
    var got = {}, done = 0, settled = false, timer = null;
    function report(pr) {
      if (opts.onProgress) opts.onProgress(Math.min(0.99, (done + (pr || 0)) / jobs.length));
    }
    return new Promise(function (resolve) {
      function finish() {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        var out = [];
        jobs.forEach(function (pn) { if (got[pn] !== undefined) out.push(got[pn]); });
        var skipped = jobs.length - out.length;
        if (skipped && opts.onSkipped) opts.onSkipped(skipped);
        resolve(tidyLines(out.join('\n')));
      }
      mapLimit(jobs, OCR_POOL_SIZE, function (pn) {
        if (opts.deadline && Date.now() > opts.deadline) return '';
        return Promise.resolve(srcFn(pn)).then(function (src) {
          return ocrImageSource(src, opts.lang, report);
        }).then(function (txt) {
          got[pn] = txt;
          done++;
          report(0);
        }, function () { got[pn] = ''; done++; report(0); });
      }).then(finish, finish);
      if (opts.deadline) timer = setTimeout(finish, Math.max(1500, opts.deadline - Date.now()));
    });
  }

  /* run up to `limit` async tasks at a time, keep results tagged by input */
  function mapLimit(items, limit, fn) {
    var out = [], next = 0, running = 0;
    return new Promise(function (res, rej) {
      function pump() {
        while (running < limit && next < items.length) {
          (function (idx) {
            next++; running++;
            fn(items[idx], idx).then(function (v) {
              out[idx] = v; running--; pump();
            }, rej);
          })(next);
        }
        if (!running && next >= items.length) res(out);
      }
      pump();
    });
  }

  function renderPageToDataURL(pdf, pn, scale, opts) {
    opts = opts || {};
    return pdf.getPage(pn).then(function (p) {
      var vp = p.getViewport({ scale: scale });
      var canvas = document.createElement('canvas');
      canvas.width = vp.width; canvas.height = vp.height;
      var ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
      return p.render({ canvasContext: ctx, viewport: vp }).promise.then(function () {
        if (opts.enhance) enhanceForOcr(ctx, canvas.width, canvas.height);
        var url = opts.enhance ? canvas.toDataURL('image/jpeg', 0.92) : canvas.toDataURL('image/png');
        if (opts.onPage) opts.onPage({ no: pn, w: canvas.width, h: canvas.height, bytes: base64Bytes(url) });
        return url;
      });
    });
  }

  function extractText(file, opts) {
    opts = opts || {};
    var name = (file.name || '').toLowerCase();
    if (name.slice(-4) === '.pdf' || file.type === 'application/pdf') {
      return extractFromPdf(file, opts);
    }
    if (/^image\//.test(file.type) || /\.(png|jpe?g|webp|bmp|gif|tif?f)$/.test(name)) {
      /* a phone photo gets the same cleanup as a scanned page before the model sees it */
      if (opts.enhance) {
        return loadBitmap(file).then(function (bmp) {
          return pageSource(bmp, opts.ocrEdge || 1600, true, opts.onPage);
        }).then(function (src) {
          return ocrImageSource(src, opts.lang, opts.onProgress);
        });
      }
      return readFileAsDataURL(file).then(function (url) {
        return ocrImageSource(url, opts.lang, opts.onProgress);
      });
    }
    if (/\.(txt|md|csv)$/.test(name)) {
      return file.text().then(tidyLines);
    }
    return file.text().then(tidyLines).catch(function () {
      throw new Error('Unsupported file type: ' + (file.name || file.type));
    });
  }

  function tidyLines(text) {
    return String(text || '')
      .replace(/\r/g, '')
      .replace(/[‘’‛]/g, "'")
      .replace(/[“”]/g, '"')
      .replace(/[٠-٩]/g, function (d) { return String(d.charCodeAt(0) - 1632); })
      .replace(/[۰-۹]/g, function (d) { return String(d.charCodeAt(0) - 1776); })
      .replace(/[०-९]/g, function (d) { return String(d.charCodeAt(0) - 2406); })
      .split('\n')
      .map(function (l) { return l.replace(/\t/g, ' ').replace(/ {2,}/g, ' ').trim(); })
      .join('\n');
  }

  /* ---------- 2. Question paper parser ---------- */

  var OPT_PAIR = /\(\s*\d{1,3}\s*\)|\b\d{1,3}\s*[)]/g;
  var Q_START = /^\s*(?:Q(?:uestion)?[\s.:#-]*)?(\d{1,3})\s*[).:\-॰°]\s*(.*)$/i;
  var HINDI_Q = /^\s*(?:प्रश्न|प्रश्न\s?क्रमांक|प्रेक्ष|प्र)\s*[.:\s-]*(\d{1,3})\s*[).:\-\s]\s*(.*)$/;

  function looksLikeOptionsLine(line) {
    var hits = line.match(OPT_PAIR);
    if (!hits) return false;
    return hits.length >= 2 || /^\s*[\(\[]?\d{1,3}[\)\]]?\s+\S/.test(line) && hits.length >= 1 && line.length < 90;
  }

  /* Two-column bilingual papers glue the Hindi and English copies onto one line, so the options
     end up inside the question text instead of on their own lines: "(A) केंद्र (A) Centre (B) ...". */
  var INLINE_OPT = /\(\s*([A-H])\s*\)/g;
  function splitInlineOptions(q) {
    if (q.options.length) return;
    var text = q.text || '', hits = [], mm;
    INLINE_OPT.lastIndex = 0;
    while ((mm = INLINE_OPT.exec(text))) hits.push({ letter: mm[1], at: mm.index });
    if (hits.length < 3) return;

    var first = hits[0].letter, seq = [], want = first.charCodeAt(0);
    hits.forEach(function (h) {
      if (!seq.length && h.letter !== first) return;
      if (seq.length && h.letter.charCodeAt(0) !== want + 1) return;
      seq.push(h); want = h.letter.charCodeAt(0);
    });
    if (seq.length < 3 || seq[seq.length - 1].letter.charCodeAt(0) - first.charCodeAt(0) < 2) return;

    var stem = text.slice(0, seq[0].at).trim();
    if (stem.replace(/\s/g, '').length < 6) return;
    var seen = {};
    for (var i = 0; i < seq.length; i++) {
      var end = i + 1 < seq.length ? seq[i + 1].at : text.length;
      var body = text.slice(seq[i].at + 1, end).replace(/^\s*[)\]]\s*/, '').replace(/^[A-H]\s*[).\]]\s*/, '').trim();
      if (!body) continue;
      q.options.push('(' + seq[i].letter + ') ' + dedupeTranslation(body, seq[i].letter));
      seen[seq[i].letter] = 1;
    }
    q.text = stem;
  }

  /* Each option is printed twice on one line — "(A) हिंदी (A) English" — so fold the repeat back
     into one option; when both halves are identical (matching-list questions) keep just one. */
  function dedupeTranslation(body, letter) {
    var re = new RegExp('\\(\\s*' + letter + '\\s*\\)\\s*');
    var at = body.search(re);
    if (at < 0) return body;
    var hi = body.slice(0, at).trim();
    var en = body.slice(at).replace(re, ' ').trim();
    if (!en || normalize(hi) === normalize(en)) return hi;
    return (hi + ' ' + en).replace(/\s+/g, ' ');
  }

  function parseQuestions(text) {
    var lines = tidyLines(text).split('\n');
    var out = [], cur = null, expected = 1, i;

    function push() {
      if (!cur || !(cur.text || cur.options.length)) return;
      splitBilingualColumns(cur);
      splitInlineOptions(cur);
      if (cur.alt) {                       // run the same option split over the Hindi half
        var alt = { no: cur.no, text: cur.alt, options: [] };
        splitInlineOptions(alt);
        cur.alt = alt.text;
        cur.altOptions = alt.options;
      }
      var sig = cur.no + '|' + normalize(cur.text).slice(0, 60);
      if (out.length && out[out.length - 1].sig === sig) return;   // same block read twice by OCR
      cur.sig = sig;
      out.push(cur);
    }

    for (i = 0; i < lines.length; i++) {
      var line = lines[i].trim();
      if (!line) continue;

      var m = line.match(HINDI_Q) || line.match(Q_START);
      var num = m ? parseInt(m[1], 10) : null;
      var restLen = m ? m[2].replace(/\s/g, '').length : 0;
      /* A numbered line carrying real words is a question — even when OCR skipped numbers
         or the paper restarts its numbering in a second section. */
      var isStart = num !== null && num > 0 && num <= 999 && !looksLikeOptionsLine(line) &&
        (restLen >= 12 || (restLen >= 2 && Math.abs(num - expected) <= 12));

      if (isStart) {
        push();
        cur = { no: num, text: m[2].trim(), options: [], raw: line };
        expected = num + 1;
        continue;
      }

      if (!cur) {
        // preamble before first detected number — treat long lines as question 1
        if (line.length > 18 && !/^(instructions|निर्देश|note)/i.test(line)) {
          cur = { no: expected, text: line, options: [], raw: line };
          expected++;
        }
        continue;
      }

      if (looksLikeOptionsLine(line)) {
        cur.options.push(line);
      } else if (/^[A-Ha-h][\).:\-\s]/.test(line) && line.length < 60) {
        cur.options.push(line);
      } else if (cur.text.length < 1200) {
        cur.text = (cur.text + ' ' + line).trim();
      } else {
        cur.options.push(line);
      }
    }
    push();

    // drop instruction-only stubs and keep the first of an exactly repeated number
    var seen = {}, clean = [];
    out.forEach(function (q) {
      var sig = q.no + '|' + normalize(q.text).slice(0, 40);
      if (seen[sig]) return;
      seen[sig] = 1;
      clean.push(q);
    });
    return mergeTranslations(clean);
  }

  /* Devanagari-dominant vs Latin-dominant text */
  function scriptProfile(s) {
    var str = String(s || '');
    var dev = (str.match(/[\u0900-\u097F]/g) || []).length;
    var lat = (str.match(/[a-zA-Z]/g) || []).length;
    return dev > lat ? 'hi' : 'en';
  }

  /* Side-by-side columns glue both copies of a question onto one line, so the English copy's own
     number appears a second time inside the text. Splitting there restores two clean variants. */
  function splitBilingualColumns(q) {
    var text = q.text || '';
    var re = new RegExp('(?:^|[^0-9.])' + q.no + '\\s*[).:]\\s', 'g');
    var m = re.exec(text);
    if (!m) return;
    var at = m.index + m[0].lastIndexOf(String(q.no));
    if (at < 10) return;
    var left = text.slice(0, at).trim();
    var right = text.slice(at).replace(/^\d+\s*[).:]\s*/, '').trim();
    if (left.replace(/\s/g, '').length < 6 || right.replace(/\s/g, '').length < 6) return;
    var lp = scriptProfile(left), rp = scriptProfile(right);
    if (lp === rp) return;
    q.alt = lp === 'hi' ? left : right;
    q.text = lp === 'en' ? left : right;
  }

  /* Bilingual papers print every question twice — Hindi then English — under the SAME number.
     Fold those pairs into one question carrying both texts, so counts and matching stay correct. */  function mergeTranslations(list) {
    var groups = {}, out = [];
    list.forEach(function (q) {
      var g = groups[q.no];
      if (!g) { groups[q.no] = [q]; out.push(q); return; }
      var prof = scriptProfile(q.text);
      var mate = null;
      for (var i = 0; i < g.length; i++) {
        if (g[i].merged) continue;
        if (scriptProfile(g[i].text) !== prof) { mate = g[i]; break; }
      }
      g.push(q);
      if (!mate) { out.push(q); return; }
      var en = prof === 'en' ? q : mate, hi = prof === 'hi' ? q : mate;
      en.alt = hi.text;
      en.altOptions = hi.options;
      if (!en.options || !en.options.length) en.options = hi.options;
      en.raw = (en.raw || '') + ' ' + (hi.raw || '');
      hi.merged = true;
      var at = out.indexOf(hi);
      if (out.indexOf(en) === -1) { if (at > -1) out.splice(at, 1, en); else out.push(en); }
    });
    return out.filter(function (q) { return !q.merged; });
  }

  /* ---------- 3. Answer key parser ---------- */

  var KEY_PAIR = /(\d{1,3})\s*(?:[-–—–:.)=]|\s{1,3})\s*\(?\s*([A-Ha-h])\b(?![a-z])\s*\)?/g;
  var KEY_LINE = /^\s*(?:Q(?:uestion)?[\s.:#-]*)?(\d{1,3})\s*[-–—:.)=]\s*\(\s*([A-Ha-h])\s*\)\s*(.*)$/;
  var KEY_LINE2 = /^\s*(?:Q(?:uestion)?[\s.:#-]*)?(\d{1,3})\s*[-–—:.)=]\s*([A-Ha-h])(?![A-Za-z])\s*(.*)$/;
  var ANS_ONLY = /^\s*(?:ans(?:wer)?|उत्तर|सही\s?उत्तर)\s*[:.\-–]?\s*\(?\s*([A-Ha-h])\s*\)?\s*$/i;
  var PAIR_COUNT = /\d{1,3}\s*[-:.)=]?\s*\(?[A-Ha-h]\)?(?![A-Za-z])/g;
  var Q_TEXT_LINE = /^\s*(?:Q(?:uestion)?[\s.:#-]*)?(\d{1,3})\s*[).:]\s*(.+)$/;

  function parseAnswerKey(text) {
    var lines = tidyLines(text).split('\n');
    var map = {}, order = [], lastNo = null, i;

    function add(no, ans, extra) {
      if (!no || no > 500) return;
      if (map[no]) {
        if (ans && !map[no].answer) map[no].answer = ans;
        if (extra && !map[no].text) map[no].text = String(extra).trim();
        return;
      }
      map[no] = { no: no, answer: ans, text: (extra || '').trim() };
      order.push(no);
    }

    for (i = 0; i < lines.length; i++) {
      var line = lines[i].trim();
      if (!line) continue;

      var ao = line.match(ANS_ONLY);
      if (ao && lastNo) { add(lastNo, ao[1].toUpperCase(), ''); continue; }

      // several pairs on one line: "1-A 2-B 3-C" — must be checked before the single-pair form
      PAIR_COUNT.lastIndex = 0;
      var pairHits = line.match(PAIR_COUNT) || [];
      if (pairHits.length >= 2) {
        KEY_PAIR.lastIndex = 0;
        var g2, f2 = 0;
        while ((g2 = KEY_PAIR.exec(line)) !== null) {
          add(parseInt(g2[1], 10), g2[2].toUpperCase(), '');
          f2++;
          if (f2 > 80) break;
        }
        if (f2) continue;
      }

      var m = line.match(KEY_LINE) || line.match(KEY_LINE2);
      if (m) { add(parseInt(m[1], 10), m[2].toUpperCase(), m[3]); lastNo = parseInt(m[1], 10); continue; }

      // multiple pairs on one line: "1-A 2-B 3-C" or "1. A  2. B  3. C"
      if (/^\s*(?:Q[\s.:#-]*)?\d{1,3}\s*[-:.)=]?\s*\(?[A-Ha-h]\)?(?![A-Za-z])/.test(line)) {
        KEY_PAIR.lastIndex = 0;
        var g, found = 0;
        while ((g = KEY_PAIR.exec(line)) !== null) {
          add(parseInt(g[1], 10), g[2].toUpperCase(), '');
          found++;
          if (found > 80) break;
        }
        if (found) continue;
      }

      // numeric answer key: "1 - 3" (option index)
      var mn = line.match(/^\s*(\d{1,3})\s*[-–—:.)=]\s*(\d{1,2})\s*$/);
      if (mn) { add(parseInt(mn[1], 10), mn[2], ''); continue; }

      // question text line: "7. Which planet is known as the Red Planet?"
      var qt = line.match(Q_TEXT_LINE);
      if (qt && qt[2].replace(/\s/g, '').length > 4 && !/^\s*(?:ans|answer|उत्तर)\b/i.test(qt[2])) {
        var no = parseInt(qt[1], 10);
        if (!map[no]) { add(no, '', qt[2]); }
        else if (!map[no].text) { map[no].text = qt[2].trim(); }
        lastNo = no;
      }
    }

    return enrichWithQuestions(mergeTranslations(order.sort(function (a, b) { return a - b; }).map(function (n) { return map[n]; })
      .filter(function (k) { return k.answer || k.text; })), text);
  }

  /* Many official "answer keys" are the whole question booklet with the answers marked inside.
     The compact `1 - B` rules then catch only a few lines and the rest is thrown away, which leaves
     content matching with nothing to compare — so re-read the same text as questions and attach it. */
  function enrichWithQuestions(list, text) {
    var withText = 0;
    list.forEach(function (k) { if (k.text && k.text.replace(/\s/g, '').length > 20) withText++; });
    var qs = parseQuestions(text);
    /* only a real booklet has a run of question-length lines — a compact "1-B 2-C" key must stay as is */
    if (qs.length < Math.max(8, list.length * 0.5) || qs.length <= withText) return list;
    var byNo = {};
    list.forEach(function (k) { byNo[k.no] = k; });
    qs.forEach(function (q) {
      if (!q.text || q.text.replace(/\s/g, '').length < 12) return;
      if (byNo[q.no]) {
        if (!byNo[q.no].text) byNo[q.no].text = q.text;
        return;
      }
      var e = { no: q.no, answer: '', text: q.text };
      list.push(e); byNo[q.no] = e;
    });
    return list.sort(function (a, b) { return a.no - b.no; });
  }

  /* A different-series paper is usually a poor scan, too noisy for token-overlap scoring — but the
     question's own wording still turns up verbatim in the OCR output. Find that wording and take the
     nearest question number printed before it; that gives a number mapping the scan alone cannot. */
  function matchByStem(paper, text) {
    var keep = /[^a-z0-9\u0900-\u097F ).:]/g;
    function strip(s) {
      return String(s).toLowerCase().replace(keep, ' ').replace(/\s+/g, ' ').trim();
    }
    var hay = strip(text);
    if (!hay) return {};
    var anchors = [], re = /(?:^|[^0-9])(\d{1,3})\s*[).]/g, m;
    while ((m = re.exec(hay))) {
      var rest = hay.slice(m.index + m[0].length, m.index + m[0].length + 45);
      if ((rest.match(/[a-z]{3,}|[\u0900-\u097F]{2,}/g) || []).length >= 2) {
        anchors.push({ at: m.index, no: parseInt(m[1], 10) });
      }
      if (anchors.length > 4000) break;
    }
    if (!anchors.length) return {};
    function anchorBefore(at) {
      var lo = 0, hi = anchors.length - 1, best = null;
      while (lo <= hi) {
        var mid = (lo + hi) >> 1;
        if (anchors[mid].at <= at) { best = anchors[mid]; lo = mid + 1; } else hi = mid - 1;
      }
      return best;
    }
    var taken = {}, out = {};
    /* longest stems first: a longer exact phrase is far stronger evidence than a short one */
    var jobs = [];
    paper.forEach(function (q, i) { jobs.push({ i: i, ph: stemsOf(strip(q.text || ''), 3) }); });
    jobs.sort(function (a, b) { return (b.ph[0] || '').length - (a.ph[0] || '').length; });
    jobs.forEach(function (j) {
      for (var p = 0; p < j.ph.length; p++) {
        var at = hay.indexOf(j.ph[p]);
        if (at < 0) continue;
        var a = anchorBefore(at);
        if (!a || a.no < 1 || a.no > 500 || taken[a.no]) continue;
        taken[a.no] = 1;
        out[j.i] = { keyNo: a.no, confidence: 0.55, method: 'stem' };
        return;
      }
    });
    return out;
  }

  var STEM_SKIP = {};
  ('a an the of and or to in on for with is are was were be been being which who what when where how that this these those it as at by from not no can will should may must have has had do does about into between within each other than then there here they their you we i me my he her us s t'
    + ' उत्तर प्रश्न कौन क्या में से है हैं का की के').split(' ').forEach(function (w) { STEM_SKIP[w] = 1; });

  function stemsOf(normText, len) {
    var w = [], out = [], i;
    normText.split(' ').forEach(function (t) {
      if (t.length > 2 && !STEM_SKIP[t] && !/^\d+$/.test(t)) w.push(t);
    });
    for (i = 0; i + len <= w.length && out.length < 10; i++) out.push(w.slice(i, i + len).join(' '));
    return out;
  }

  /* On a bad scan most question numbers are printed as junk ("m6.", "th137."), so a line-based parser
     loses the document. The numbers themselves still run 1,2,3… though, so pick the longest chain of
     number marks that climb one at a time and cut the text at those points: each piece is one question. */
  function chainSegments(text) {
    var keep = /[^a-z0-9\u0900-\u097F ).:]/g;
    var hay = String(text || '').toLowerCase().replace(keep, ' ').replace(/\s+/g, ' ').trim();
    if (hay.length < 200) return [];
    var marks = [], re = /(?:^|[^0-9])(\d{1,3})\s*[).:]/g, m;
    while ((m = re.exec(hay))) {
      var no = parseInt(m[1], 10);
      if (no < 1 || no > 500) continue;
      var rest = hay.slice(m.index + m[0].length, m.index + m[0].length + 45);
      if ((rest.match(/[a-z]{3,}|[\u0900-\u097F]{2,}/g) || []).length < 2) continue;
      marks.push({ at: m.index, no: no });
      if (marks.length > 6000) break;
    }
    if (marks.length < 5) return [];
    /* longest chain where the number climbs by 1 (2 at most, when a digit is lost) and the marks are
       a question's-length apart */
    var best = { len: 0, i: -1 }, lens = [], prev = [];
    marks.forEach(function (a, i) {
      var bl = 0, bi = -1;
      for (var j = i - 1; j >= 0 && a.at - marks[j].at < 4000; j--) {
        var d = a.no - marks[j].no;
        if (d < 1 || d > 2) continue;
        if (a.at - marks[j].at < 60) continue;
        if (lens[j] + 1 > bl) { bl = lens[j] + 1; bi = j; }
      }
      lens[i] = bl + 1; prev[i] = bi;
      if (lens[i] > best.len) best = { len: lens[i], i: i };
    });
    var chain = [];
    for (var p = best.i; p >= 0; p = prev[p]) chain.push(marks[p]);
    chain.reverse();
    if (chain.length < 5) return [];
    var out = [];
    chain.forEach(function (c, i) {
      var end = i + 1 < chain.length ? chain[i + 1].at : Math.min(hay.length, c.at + 1500);
      var body = hay.slice(c.at + String(c.no).length + 1, end).replace(/^[).:\s]+/, '');
      if (body.replace(/\s/g, '').length < 25) return;
      out.push({ no: c.no, answer: '', text: body.trim(), options: [] });
    });
    return out;
  }

  /* ---------- 4. Similarity + matching ---------- */

  var STOP = ('a an the of and or to in on for with is are was were be been being which who whom whose what when where why how that this these those it its as at by from not no yes can will would should could may might must have has had do does did about into over under between within both each other than then there here them they their you your we our i me my he him his her hers us if so such only also more most least less very just than too again further once because while during before after above below up down out off s t')
    .split(' ');
  var STOP_HI = ('और का की के में पर से को है हैं हो एक यह यह वह इसके उनकी उसके लिए साथ तक भी नहीं बहुत सबसे कौन सा कौन कि जो तो या को').split(' ');
  var stopSet = {};
  STOP.concat(STOP_HI).forEach(function (w) { stopSet[w] = 1; });

  /* Many exam PDFs embed a broken Devanagari text layer: matras get detached and land at the
     wrong side of the consonant ("सूची" -> "सचू ी", "किताब" -> "िबकता"). Real Hindi text almost
     never starts a word with a dependent sign, so the share of such tokens measures the damage.
     Returns badness 0..1, or null when the text isn't Hindi enough to judge. */
  var MATRA_FIRST = /^[\u0901-\u0903\u093C\u093D\u093E-\u094F\u0951-\u0957]/;
  var INDEPENDENT_VOWEL = /^[\u0904-\u0914\u0950\u0966-\u096F]/;
  function hindiQuality(text) {
    var str = String(text || '');
    if ((str.match(/[\u0900-\u097F]/g) || []).length < 40) return null;
    var tokens = str.split(/[^ऀ-ॿ]+/).filter(function (t) { return t.length; });
    if (tokens.length < 20) return null;
    var bad = 0;
    tokens.forEach(function (t) {
      if (MATRA_FIRST.test(t) || (t.length === 1 && !INDEPENDENT_VOWEL.test(t))) bad++;
    });
    return bad / tokens.length;
  }
  /* Above this the text layer is unusable — the page has to be OCR'd as an image. */
  var HINDI_BAD = 0.06;

  /* Share of Latin letters in the text. Bilingual papers whose Hindi layer is mangled still carry
     a clean English copy, which matching can use — those are not worth a slow full-page OCR for. */
  function latinShare(text) {
    var str = String(text || '');
    var dev = (str.match(/[\u0900-\u097F]/g) || []).length;
    var lat = (str.match(/[a-zA-Z]/g) || []).length;
    return (dev + lat) ? lat / (dev + lat) : 0;
  }

  function normalize(s) {
    return String(s || '')
      .toLowerCase()
      .replace(/\(?\s*\d{1,3}\s*[\).:]\s*/g, ' ')
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function tokens(s) {
    var n = normalize(s), parts = n.split(' '), out = [], i;
    for (i = 0; i < parts.length; i++) {
      var w = parts[i];
      if (w.length < 2 || stopSet[w]) continue;
      out.push(w);
    }
    return out;
  }

  function bagOf(list) {
    var m = {}, n = 0, i, k;
    for (i = 0; i < list.length; i++) {
      k = list[i];
      if (!m[k]) { m[k] = 1; n++; }
    }
    return { m: m, n: n };
  }

  function overlapCoef(a, b) {
    if (!a.n || !b.n) return 0;
    var small = a.n < b.n ? a : b, big = a.n < b.n ? b : a, hit = 0, k;
    for (k in small.m) if (big.m[k]) hit++;
    return hit / Math.min(a.n, b.n);
  }

  function dice(ba, bb) {
    if (!ba.n || !bb.n) return 0;
    var small = ba.n < bb.n ? ba : bb, big = ba.n < bb.n ? bb : ba, hit = 0, k;
    for (k in small.m) if (big.m[k]) hit++;
    return (2 * hit) / (ba.n + bb.n);
  }

  /* One signature per language variant, so a Hindi paper line still matches an English key line. */
  function signature(q) {
    var list = [q];
    if (q.alt) list.push({ text: q.alt, options: q.altOptions });
    return list.map(function (v) {
      var t = tokens(v.text);
      var withOpts = t.concat(v.options && v.options.length ? tokens(v.options.join(' ')) : []);
      return {
        tok: bagOf(t),
        tokWide: bagOf(withOpts),
        bg: bagOf(bigrams(normalize(v.text).replace(/ /g, ''))),
        len: t.length
      };
    });
  }

  function bigrams(s) {
    var out = [], i;
    for (i = 0; i < s.length - 1; i++) out.push(s.substr(i, 2));
    return out;
  }

  /* Full score — cheap token overlap first, expensive bigram compare only when it can still win. */
  function scorePair(a, b, threshold) {
    var lp = Math.min(a.len, b.len) / Math.max(a.len, b.len, 1);
    var cap = 0.72 + 0.28 * lp;
    if (a.len < 3 || b.len < 3) cap *= 0.82;
    if (threshold && 1 * cap < threshold) return 0;

    var tok = overlapCoef(a.tok, b.tok);
    var wide = overlapCoef(a.tokWide, b.tokWide);
    if (threshold && (0.46 * tok + 0.24 * wide + 0.3) * cap < threshold) {
      return { tok: tok, wide: wide, bg: 0, s: 0 };
    }
    var bg = dice(a.bg, b.bg);
    var s = (0.46 * tok + 0.24 * wide + 0.3 * bg) * cap;
    return { tok: tok, wide: wide, bg: bg, s: s };
  }

  /* key indices sharing at least one token with this paper question (deduped via stamp) */
  function collectCandidates(sigs, index, stamp, out, seenAt) {
    sigs.forEach(function (sig) {
      eachKey(sig.tok, function (k) { pushHits(index[k], stamp, out, seenAt); });
      eachKey(sig.tokWide, function (k) { pushHits(index[k], stamp, out, seenAt); });
    });
  }

  function pushHits(list, stamp, out, seenAt) {
    if (!list) return;
    for (var i = 0; i < list.length; i++) {
      var j = list[i];
      if (seenAt[j] === stamp) continue;
      seenAt[j] = stamp;
      out.push(j);
    }
  }

  /* best score across the Hindi / English variants of both sides */
  function scoreVariants(aSigs, bSigs, threshold) {
    var best = 0, x, y;
    for (x = 0; x < aSigs.length; x++) {
      for (y = 0; y < bSigs.length; y++) {
        var r = scorePair(aSigs[x], bSigs[y], threshold);
        if (r && r.s > best) best = r.s;
        if (best >= 0.99) return best;
      }
    }
    return best;
  }

  function eachKey(bag, fn) {
    var m = bag.m, k;
    for (k in m) fn(k);
  }

  /* Match paper questions to key questions by CONTENT (numbers may differ). */
  function matchByContent(paper, key, opts) {
    opts = opts || {};
    var threshold = opts.threshold || 0.42;
    var ps = paper.map(signature), ks = key.map(signature);
    var pairs = [], i, j;

    /* A pair with zero shared tokens can only score 0.3 * cap (< 0.3 overall), so when the
       threshold is above that we can score just the token-sharing candidates instead of every pair. */
    var index = null, seenAt = [];
    if (threshold > 0.3) {
      index = {};
      for (j = 0; j < ks.length; j++) {
        seenAt[j] = 0;
        ks[j].forEach(function (sig) {
          eachKey(sig.tok, function (k) { (index[k] || (index[k] = [])).push(j); });
          eachKey(sig.tokWide, function (k) { (index[k] || (index[k] = [])).push(j); });
        });
      }
    }

    for (i = 0; i < ps.length; i++) {
      var cands = null;
      if (index) {
        cands = [];
        collectCandidates(ps[i], index, i + 1, cands, seenAt);
      }
      var n = cands ? cands.length : ks.length;
      for (j = 0; j < n; j++) {
        var kj = cands ? cands[j] : j;
        var s = scoreVariants(ps[i], ks[kj], threshold);
        if (s >= threshold) pairs.push({ p: i, k: kj, s: s });
      }
    }
    pairs.sort(function (a, b) { return b.s - a.s; });

    var usedP = {}, usedK = {}, assign = {};
    pairs.forEach(function (pr) {
      if (usedP[pr.p] || usedK[pr.k]) return;
      usedP[pr.p] = usedK[pr.k] = 1;
      assign[pr.p] = { keyIndex: pr.k, confidence: pr.s, method: 'content' };
    });

    // fallback: unmatched questions by position when both lists are same length
    var unmatchedP = [], unmatchedK = [], usedKCount = {};
    Object.keys(usedK).forEach(function (k) { usedKCount[key[k].no] = 1; });
    for (i = 0; i < paper.length; i++) if (!assign[i]) unmatchedP.push(i);
    for (j = 0; j < key.length; j++) if (!usedK[j]) unmatchedK.push(j);

    if (opts.positionFallback !== false && unmatchedP.length === unmatchedK.length && unmatchedP.length <= Math.max(3, paper.length * 0.25)) {
      unmatchedP.forEach(function (pi, idx) {
        assign[pi] = { keyIndex: unmatchedK[idx], confidence: 0.3, method: 'position' };
      });
    }
    return assign;
  }

  /* Offset mapping: key number = paper number + offset (used when the key has no question text) */
  function matchByOffset(paper, key, offset) {
    var byNo = {}, assign = {};
    key.forEach(function (k, idx) { byNo[k.no] = idx; });
    paper.forEach(function (q, i) {
      var want = q.no + offset;
      if (byNo[want] !== undefined) assign[i] = { keyIndex: byNo[want], confidence: 0.5, method: 'offset' };
    });
    return assign;
  }

  function matchByIdentity(paper, key) {
    var byNo = {}, assign = {};
    key.forEach(function (k, idx) { byNo[k.no] = idx; });
    paper.forEach(function (q, i) {
      if (byNo[q.no] !== undefined) assign[i] = { keyIndex: byNo[q.no], confidence: 1, method: 'same-number' };
    });
    return assign;
  }

  /* ---------- 5. Student answer detection + scoring ---------- */

  var MARKS = { '✓': 1, '✔': 1, '✅': 1, '√': 1, '●': 1, '⦿': 1, '⬤': 1, '✗': 1, '✘': 1 };

  function detectMarkedAnswer(q) {
    var blob = (q.raw + ' ' + q.text + ' ' + (q.options || []).join(' '));
    if (!/[✓✔✅√●⦿⬤]/.test(blob)) return '';
    var m = blob.match(/[A-Ha-h]\s*[\).:]\s*[✓✔✅√●⦿⬤]/);
    if (m) return m[0][0].toUpperCase();
    var n = blob.match(/\(\s*(\d{1,2})\s*\)\s*[✓✔✅√●⦿⬤]/);
    if (n) return n[1];
    return '';
  }

  function buildResult(paper, key, assign, studentAnswers, scheme) {
    scheme = scheme || { correct: 1, wrong: 0, total: null };
    var rows = [], correct = 0, wrong = 0, unanswered = 0;

    paper.forEach(function (q, i) {
      var a = assign[i];
      var k = a ? key[a.keyIndex] : null;
      var mine = (studentAnswers[i] || '').toString().trim().toUpperCase();
      var right = k ? String(k.answer).toUpperCase() : '';
      var state;
      if (!k) state = 'unmatched';
      else if (!mine) state = 'blank';
      else if (mine === right) { state = 'correct'; correct++; }
      else { state = 'wrong'; wrong++; }
      rows.push({
        idx: i,
        paperNo: q.no,
        keyNo: k ? k.no : null,
        question: q.text,
        questionAlt: q.alt || '',
        options: q.options,
        correct: right,
        mine: mine,
        state: state,
        confidence: a ? a.confidence : 0,
        method: a ? a.method : null
      });
    });

    unanswered = rows.filter(function (r) { return r.state === 'blank'; }).length;
    var matched = rows.filter(function (r) { return r.state !== 'unmatched'; }).length;
    var score = correct * (scheme.correct || 1) - wrong * Math.abs(scheme.wrong || 0);
    var max = scheme.total != null ? scheme.total : paper.length * (scheme.correct || 1);

    return {
      rows: rows,
      stats: {
        total: paper.length,
        matched: matched,
        correct: correct,
        wrong: wrong,
        blank: unanswered,
        score: Math.round(score * 100) / 100,
        max: max,
        percent: max > 0 ? Math.round((score / max) * 1000) / 10 : 0
      },
      createdAt: new Date().toISOString()
    };
  }

  /* ---------- 6. Persistence ---------- */
  var LS_KEY = 'iLoveExamMatcherResultV1';
  function saveResult(r) { try { localStorage.setItem(LS_KEY, JSON.stringify(r)); } catch (e) {} }
  function loadResult() {
    try {
      var raw = localStorage.getItem(LS_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }
  function clearResult() { try { localStorage.removeItem(LS_KEY); } catch (e) {} }

  /* Rebuild a real PDF from the exact page images OCR used, so a cleaned scan can be saved and
     re-uploaded later without paying for OCR twice. */
  function pdfFromPages(pages) {
    pages = (pages || []).filter(function (p) { return p && p.bytes && p.bytes.length; })
      .sort(function (a, b) { return (a.no || 0) - (b.no || 0); });
    var enc = new TextEncoder(), chunks = [], size = 0, offsets = [], kids = [], i;
    function put(x) { var u = typeof x === 'string' ? enc.encode(x) : x; chunks.push(u); size += u.length; }
    function mark() { offsets.push(size); }
    for (i = 0; i < pages.length; i++) kids.push((3 + i * 3) + ' 0 R');
    put('%PDF-1.4\n');
    mark(); put('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');
    mark(); put('2 0 obj\n<< /Type /Pages /Kids [' + kids.join(' ') + '] /Count ' + pages.length + ' >>\nendobj\n');
    pages.forEach(function (pg, i) {
      var page = 3 + i * 3, cont = page + 1, im = page + 2;
      /* page boxes in points, normalised so the long edge is 1000 — viewers scale it to the paper */
      var k = 1000 / Math.max(pg.w, pg.h);
      var W = Math.max(1, Math.round(pg.w * k)), H = Math.max(1, Math.round(pg.h * k));
      var stream = 'q ' + W + ' 0 0 ' + H + ' 0 0 cm /Im0 Do Q\n';
      mark(); put(page + ' 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ' + W + ' ' + H +
        '] /Resources << /XObject << /Im0 ' + im + ' 0 R >> >> /Contents ' + cont + ' 0 R >>\nendobj\n');
      mark(); put(cont + ' 0 obj\n<< /Length ' + stream.length + ' >>\nstream\n' + stream + 'endstream\nendobj\n');
      mark(); put(im + ' 0 obj\n<< /Type /XObject /Subtype /Image /Width ' + pg.w + ' /Height ' + pg.h +
        ' /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ' + pg.bytes.length +
        ' >>\nstream\n');
      put(pg.bytes);
      put('\nendstream\nendobj\n');
    });
    var xref = size;
    put('xref\n0 ' + (offsets.length + 1) + '\n0000000000 65535 f \n');
    offsets.forEach(function (o) { put(('0000000000' + o).slice(-10) + ' 00000 n \n'); });
    put('trailer\n<< /Size ' + (offsets.length + 1) + ' /Root 1 0 R >>\nstartxref\n' + xref + '\n%%EOF\n');
    return new Blob(chunks, { type: 'application/pdf' });
  }

  /* The upload box's second option: turn the student's own scan into a cleaned PDF right here,
     with no OCR and no network — it can be saved, or fed straight back in as the file to match. */
  function buildCleanPdf(file, opts) {
    opts = opts || {};
    var maxEdge = opts.ocrEdge || 1200;
    var pages = [], copy = null;
    function collect(pg) { pages.push(pg); }
    function tagged(pn) {
      return function (pg) { pg.no = pn; collect(pg); };
    }
    var name = (file.name || '').toLowerCase();
    if (/^image\//.test(file.type) || /\.(png|jpe?g|webp|bmp|gif|tif?f)$/.test(name)) {
      return loadBitmap(file).then(function (bmp) {
        pageSource(bmp, maxEdge, true, tagged(1));
        return pdfFromPages(pages);
      });
    }
    return loadScript(PDFJS_CDN, 'pdfjs').then(function () {
      global.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
      return file.arrayBuffer();
    }).then(function (buf) {
      copy = buf.slice ? buf.slice(0) : buf;
      return global.pdfjsLib.getDocument({ data: buf }).promise;
    }).then(function (doc) {
      var idx = [], i, jpegs = jpegPagesFromPdf(copy, doc.numPages);
      for (i = 1; i <= doc.numPages; i++) idx.push(i);
      return mapLimit(idx, 2, function (pn) {
        if (jpegs) return jpegToOcrSource(jpegs[pn - 1], maxEdge, true, tagged(pn));
        return doc.getPage(pn).then(function (p) {
          var vp0 = p.getViewport({ scale: 1 });
          return renderPageToDataURL(doc, pn, maxEdge / Math.max(vp0.width, vp0.height),
            { enhance: true, onPage: tagged(pn) });
        });
      }).then(function () { return pdfFromPages(pages); });
    });
  }

  global.ExamMatcher = {
    extractText: extractText,
    prewarm: prewarm,
    parseQuestions: parseQuestions,
    parseAnswerKey: parseAnswerKey,
    matchByContent: matchByContent,
    matchByStem: matchByStem,
    chainSegments: chainSegments,
    matchByOffset: matchByOffset,
    matchByIdentity: matchByIdentity,
    detectMarkedAnswer: detectMarkedAnswer,
    buildResult: buildResult,
    normalize: normalize,
    hindiQuality: hindiQuality,
    latinShare: latinShare,
    jpegPagesFromPdf: jpegPagesFromPdf,
    pdfFromPages: pdfFromPages,
    buildCleanPdf: buildCleanPdf,
    saveResult: saveResult,
    loadResult: loadResult,
    clearResult: clearResult
  };
})(window);
