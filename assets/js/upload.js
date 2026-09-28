/* Upload & Match page logic */
(function () {
  'use strict';

  var M = window.ExamMatcher;
  var $ = function (id) { return document.getElementById(id); };

  var state = {
    mode: 'map',
    qFile: null, kFile: null, k2File: null,
    qText: '', kText: '', k2Text: '',
    paper: [], key: [], assign: {},
    answers: {},          // paperNo -> student answer
    override: {},         // paperNo -> correct answer typed by user
    /* in OMR Set mode the score stays hidden until the student presses Confirm & Get Score */
    confirmed: false,
    scheme: { correct: 1, wrong: 0 },
    page: 1,
    pageSize: 25,
    result: null,
    lang: 'eng',
    t0: 0,
    tickH: null,
    /* the optional AI reading pass: which files it already tried, what it managed to read, and what
       went wrong — all of it shown to the student rather than hidden */
    aiTried: {}, aiUsed: '', aiError: '', aiGain: {}, aiPages: {}, aiSkipped: 0, aiDone: false
  };

  var MODE_LABELS = {
    map: { q: 'मेरा Question Paper (Series A / B / C…)', k: 'सरकारी Question Paper (दूसरी Series)', kOn: true },
    /* three files: my paper, another series' paper, and the official key numbered for that other series */
    mapkey: { q: 'मेरा Question Paper (Series A…)', k: 'दूसरी Series का Paper (B / C / D…)', k2: 'Official Answer Key (1 - A, 2 - C…)', kOn: true },
    omr: { q: 'Student OMR Sheet (PDF / JPG / PNG)', k: 'Official OMR Answer Key (PDF / JPG / PNG)', kOn: true }
  };

  /* ---------------- dropzones ---------------- */
  function wireDrop(dropId, inputId, onFile) {
    var drop = $(dropId), input = $(inputId);
    drop.addEventListener('click', function () { input.click(); });
    drop.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } });
    input.addEventListener('change', function () { if (input.files[0]) onFile(input.files[0]); });
    ['dragenter', 'dragover'].forEach(function (ev) {
      drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.add('drag'); });
    });
    ['dragleave', 'drop'].forEach(function (ev) {
      drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.remove('drag'); });
    });
    drop.addEventListener('drop', function (e) {
      var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) onFile(f);
    });
  }

  function setFile(which, f, cleaned) {
    var U = which.toUpperCase();
    if (which === 'q') { state.qFile = f; state.qText = ''; }
    else if (which === 'k') { state.kFile = f; state.kText = ''; }
    else { state.k2File = f; state.k2Text = ''; }
    $(which === 'q' ? 'fileQ' : which === 'k' ? 'fileK' : 'fileK2').textContent = '✓ ' + f.name + '  (' + Math.round(f.size / 1024) + ' KB)';
    $(which === 'q' ? 'dropQ' : which === 'k' ? 'dropK' : 'dropK2').classList.add('done');
    /* a freshly picked file invalidates whatever was cleaned from the previous one */
    if (!cleaned) {
      state['clean' + U] = null;
      $('use' + U).classList.add('hide');
      $('dl' + U).classList.add('hide');
    }
    warm();
  }

  wireDrop('dropQ', 'inputQ', function (f) {
    setFile('q', f);
    status('info', 'File चुनी गई', 'Match दबाने पर इसमें से text पढ़ा जाएगा।');
  });

  wireDrop('dropK', 'inputK', function (f) { setFile('k', f); });
  wireDrop('dropK2', 'inputK2', function (f) { setFile('k2', f); });

  /* Inside each box: rebuild the chosen scan as a cleaned PDF on this machine (no OCR, no network),
     then either keep it as a file or point this same box at it and match from there. */
  ['q', 'k', 'k2'].forEach(function (which) {
    var U = which.toUpperCase(), MK = 'यहीं साफ़ PDF बनाएँ', AGAIN = 'दोबारा साफ़ PDF बनाएँ';
    $('mk' + U).addEventListener('click', function (e) {
      e.stopPropagation();
      var file = state[which + 'File'];
      if (!file) { toast('पहले इस box में file चुनें', 'err'); return; }
      var btn = this;
      btn.disabled = true;
      btn.innerHTML = '<span>⏳</span> pages साफ़ हो रहे हैं…';
      M.buildCleanPdf(file, {}).then(function (blob) {
        var name = (file.name || 'scan').replace(/\.[a-z0-9]+$/i, '') + '-clean.pdf';
        var url = URL.createObjectURL(blob);
        state['clean' + U] = new File([blob], name, { type: 'application/pdf' });
        $('dl' + U).href = url;
        $('dl' + U).download = name;
        $('dl' + U).classList.remove('hide');
        $('use' + U).classList.remove('hide');
        btn.disabled = false;
        btn.innerHTML = '<span>🧹</span> ' + AGAIN;
        toast('साफ़ PDF तैयार है — ' + Math.round(blob.size / 1024) + ' KB', 'ok');
      }, function (err) {
        btn.disabled = false;
        btn.innerHTML = '<span>🧹</span> ' + MK;
        toast('साफ़ PDF नहीं बन पाई: ' + ((err && err.message) || err), 'err');
      });
    });
    $('use' + U).addEventListener('click', function (e) {
      e.stopPropagation();
      if (!state['clean' + U]) return;
      setFile(which, state['clean' + U], true);
      toast('अब इस box में साफ़ PDF लगी है — Match दबाएँ', 'ok');
    });
  });

  /* "Auto" probes one page to learn which models the paper needs. The download is warmed while the
     student still picks files, so the two never queue behind each other. */
  function ocrLang(v) { return !v || v === 'auto' ? (state.mode === 'omr' ? 'eng' : 'eng+hin') : v; }

  /* Download the OCR model while the student still picks files, not after Match. */
  function warm() {
    if (state.warming) return;
    state.warming = true;
    if ($('progTxt')) {
      $('progLine').classList.remove('hide');
      $('progTxt').textContent = 'OCR तैयार कर रहे हैं (सिर्फ पहली बार)…';
    }
    try {
      M.prewarm(ocrLang(state.lang), true).then(function (ok) {
        state.warming = false;
        if (ok) state.warmedLang = ocrLang(state.lang);
        if ($('progTxt') && $('progWrap').classList.contains('hide')) $('progLine').classList.add('hide');
      }, function () { state.warming = false; });
    } catch (e) { state.warming = false; }
  }
  /* ---------------- mode tabs ---------------- */
  $('modeTabs').addEventListener('click', function (e) {
    var b = e.target.closest('button'); if (!b) return;
    [].forEach.call(this.querySelectorAll('button'), function (x) { x.classList.remove('on'); });
    b.classList.add('on');
    state.mode = b.dataset.mode;
    var l = MODE_LABELS[state.mode];
    $('dropQS').textContent = l.q;
    $('dropKS').textContent = l.k;
    var mk = state.mode === 'mapkey';
    $('dropK2').classList.toggle('hide', !mk);
    $('colK2T').classList.toggle('hide', !mk);
    $('dropGrid').classList.toggle('g2', !mk);
    $('dropGrid').classList.toggle('g3', mk);
    $('textMode').classList.toggle('g2', !mk);
    $('textMode').classList.toggle('g3', mk);
  });

  $('toggleText').addEventListener('click', function () {
    var on = $('textMode').classList.toggle('hide');
    $('fileMode').classList.toggle('hide', !on);
    this.textContent = on ? '✍️ Text paste करें' : '📁 File upload करें';
  });

  /* ---------------- status helpers ---------------- */
  function status(kind, title, body) {
    $('statusBox').innerHTML =
      '<div class="alert ' + kind + ' mt14"><div class="a-ic">' + (kind === 'ok' ? '✓' : kind === 'err' ? '!' : kind === 'warn' ? '!' : 'i') +
      '</div><div><b>' + esc(title) + '</b>' + body + '</div></div>';
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function progress(p, label) {
    state.prog = p;
    $('progWrap').classList.remove('hide');
    $('progLine').classList.remove('hide');
    $('progBar').style.width = Math.max(2, Math.round(p * 100)) + '%';
    if (label) $('progTxt').textContent = label;
  }
  function tick() {
    if (!state.t0) return '';
    var el = (Date.now() - state.t0) / 1000;
    var txt = el.toFixed(1) + 's';
    var p = state.prog;
    if (p > 0.04 && p < 0.98) {                       // extrapolate only once enough has been done
      var left = el / p - el;
      if (left > 8) txt += ' · ~' + Math.round(left) + 's बाकी';
    }
    return txt;
  }
  function tickTimer() {
    clearInterval(state.tickH);
    state.tickH = setInterval(function () { $('progTime').textContent = tick(); }, 200);
  }

  /* ---------------- main flow ---------------- */
  $('btnMatch').addEventListener('click', function () {
    state.aiTried = {}; state.aiUsed = ''; state.aiError = ''; state.aiGain = {}; state.aiSkipped = 0;
    run();
  });

  function readAll(which) {
    var file = state[which + 'File'];
    var cached = state[which + 'Text'];
    if (cached) return Promise.resolve(cached);
    if (!file) return Promise.resolve('');
    var nm = which === 'q' ? 'Question Paper' : which === 'k' ? (state.mode === 'mapkey' ? 'दूसरी Series Paper' : 'Answer Key') : 'Answer Key';
    progress(0.05, nm + ' पढ़ रहे हैं…');
    /* Paper-match flow: page OCR is off here — it garbles Hindi. A PDF with a real text layer is
       read directly and fast; a scan/photo comes back empty and is handed to the AI reader next. */
    return M.extractText(file, { noOcr: true }).then(function (t) {
      state[which + 'Text'] = t;
      return t;
    });
  }

  /* An official key normally arrives as a photo of the printed table ("1 C 31 B …"), which whole-page
     OCR reads badly and the grid reader reads exactly — so the key box is tried that way first, and
     handed to the rest of the flow as the plain list it already understands. */
  function readKey2() {
    var f = state.k2File;
    if (!f) return Promise.resolve('');
    var cached = state.k2Text;
    if (cached) return Promise.resolve(cached);
    var isImg = /^image\//.test(f.type) || /\.(png|jpe?g|webp|bmp|gif|tif?f)$/i.test(f.name || '');
    if (!isImg || !M.readKeyTable) return readAll('k2');
    progress(0.12, 'Answer Key की table उसकी grid से पढ़ रहे हैं…');
    return M.readKeyTable(f).then(function (rows) {
      if (!rows.length) return readAll('k2');
      var list = rows.map(function (r) { return r.no + ' - ' + r.answer; }).join('\n');
      state.k2Text = list;
      return list;
    }, function () { return readAll('k2'); });
  }

  /* ---------------- OMR Set mode ----------------     The student's box holds a bubble sheet, which no text OCR can read, so its filled circles are
     found from pixels; the official key normally arrives as a printed table ("1 C 31 B 61 B …") and
     is read with OCR. Every box tries bubbles first and falls back to text, so a key that happens
     to be another bubble sheet — or a student who typed a list — still works with no switch to set,
     and a key box nothing could read is finally handed to the AI. */
  function runOmr() {
    if (!state.qFile || !state.kFile) {
      status('err', 'दोनों file चुनें',
        'Box 1 में <b>student की OMR sheet</b> की photo और Box 2 में <b>सरकारी answer key</b> की photo — दोनों ज़रूरी हैं। तभी Correct Answer का column अपने-आप भरेगा।');
      return;
    }
    state.t0 = Date.now();
    $('btnMatch').disabled = true;
    tick(); tickTimer();
    progress(0.02, 'Files पढ़ी जा रही हैं…');
    status('info', 'Processing…', 'गोले pixels से और answer key की table उसकी grid से पढ़ी जा रही है — कुछ तोड़ने-जोड़ने की ज़रूरत नहीं।');
    Promise.all([omrRead('q', 0.04, 0.45), omrRead('k', 0.5, 0.9)]).then(function (res) {
      return settleOptionSet(res).then(function () { buildOmrResult(res); });
    }).catch(fail);
  }

  /* the student's sheet has the option columns printed on it, so it knows how many options the exam
     offers: a key that comes back with an E on a 4-column sheet has been misread, not out of options,
     and the key table is read once more with only the letters the sheet actually has */
  function settleOptionSet(res) {
    var n = res[0].optCount || 0, key = res[1];
    state.sheetOpt = n >= 2 && n <= 8 ? n : 0;
    var allowed = n ? 'ABCDEFGH'.slice(0, n) : '';
    if (!allowed || key.via !== 'table') return Promise.resolve();
    if (!key.answers.some(function (a) { return allowed.indexOf(a.answer) < 0; })) return Promise.resolve();
    progress(0.6, 'Key दोबारा पढ़ रहे हैं (options ' + allowed.split('').join('-') + ')…');
    return M.readKeyTable(state.kFile, { letters: allowed }).then(function (rows) {
      if (rows.length >= key.answers.length) key.answers = rows;
    }, function () { });
  }

  function buildOmrResult(res) {
    if (!res[1].answers.length) {
      throw new Error('Box 2 (Answer Key) से एक भी सही उत्तर नहीं पढ़ा जा सका। key की साफ़ photo उसी box में डालें, या key की list "✍️ Text paste करें" mode में छाप दें।');
    }
    if (!res[0].answers.length) {
      throw new Error('Box 1 (Student OMR) में भरे हुए गोले नहीं मिले। photo सीधी, रोशनी वाली और साफ़ हो — धुंधली photo में गोले नहीं दिखते।');
    }
    progress(0.93, 'Result बना रहे हैं…');
    var mine = {}, key = {}, maxNo = 0, n;
    res[0].answers.forEach(function (a) { mine[a.no] = a.answer; maxNo = Math.max(maxNo, a.no); });
    res[1].answers.forEach(function (a) { key[a.no] = a.answer; maxNo = Math.max(maxNo, a.no); });
    state.paper = []; state.key = []; state.answers = {};
    for (n = 1; n <= maxNo; n++) {
      state.paper.push({ no: n, text: '', alt: '', options: [] });
      if (key[n]) state.key.push({ no: n, answer: key[n], text: '' });
      if (mine[n]) state.answers[n - 1] = mine[n];
    }
    state.assign = M.matchByIdentity(state.paper, state.key);
    state.override = {};
    state.confirmed = false;
    state.scheme = { correct: parseFloat($('marksCorrect').value) || 1, wrong: parseFloat($('marksWrong').value) || 0 };
    state.page = 1;
    recompute();
    omrDone(res, maxNo);
  }

  function omrDone(res, maxNo) {
    var secs = state.t0 ? ((Date.now() - state.t0) / 1000).toFixed(1) : '0';
    var said = { gole: 'भरे गोले पहचानकर', table: 'printed table की grid से', list: 'list OCR से', ai: 'AI (Gemini / Groq) से' };
    progress(1, 'पूरा हुआ');
    clearInterval(state.tickH);
    setTimeout(function () { $('progWrap').classList.add('hide'); $('progLine').classList.add('hide'); }, 500);
    $('btnMatch').disabled = false;
    status('ok', 'दोनों Answer Set पढ़ लिए गए!',
      'कुल <b>' + maxNo + '</b> प्रश्न — student: ' + said[res[0].via] + ', key: ' + said[res[1].via] + ' — <b>' + secs + ' sec</b>।'
      + '<br>नीचे <b>Correct Answer</b> और <b>Your Answer</b> दोनों columns अपने-आप भरे हैं। एक बार देख लें, फिर <b>✓ Confirm &amp; Get Score</b> दबाएँ।');
    $('resultSection').classList.remove('hide');
    $('resultSection').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function omrRead(which, pFrom, pTo) {
    var file = state[which + 'File'];
    if (!file) return Promise.resolve({ answers: [], via: '' });
    var isImg = /^image\//.test(file.type) || /\.(png|jpe?g|webp|bmp|gif|tif?f)$/i.test(file.name || '');
    var nm = which === 'q' ? 'Student OMR' : 'Answer Key';
    progress(pFrom, nm + ' पढ़ रहे हैं…');
    var base = (!isImg || !M.readOmrSheet) ? omrText(file, pFrom, pTo)
      /* a ruled answer-key table gives its grid away in a few ms, so checking it first costs nothing */
      : (M.readKeyTable ? M.readKeyTable(file) : Promise.resolve([])).then(function (rows) {
        if (rows.length) return { answers: rows, via: 'table' };
        return M.readOmrSheet(file, { optCount: 4 }).then(function (a) {
          if (a && a.length) return { answers: a, via: 'gole', optCount: 4 };
          /* a 5-option sheet has no 4-column lattice, so the same pass runs once more before text OCR */
          return M.readOmrSheet(file, { optCount: 5 }).then(function (b) {
            return b && b.length ? { answers: b, via: 'gole', optCount: 5 }
                                 : omrText(file, pFrom + (pTo - pFrom) * 0.25, pTo);
          });
        });
      });
    /* The key box is the one file page-OCR genuinely cannot read when it is Hindi — grid, bubbles and
       list OCR all run first, and only when every one of them came back with nothing does the AI read
       the file. The student's bubble sheet is never sent anywhere: no AI can see which circle is filled. */
    return base.then(function (res) {
      if (which !== 'k' || res.answers.length) return res;
      if (!window.ExamAI || !window.ExamAI.available()) return res;
      progress(pFrom + (pTo - pFrom) * 0.9, 'AI (Gemini / Groq) से key पढ़ी जा रही है…');
      return window.ExamAI.readFile(file, { deadline: Date.now() + AI_BUDGET_MS }).then(function (r) {
        var pairs = omrPairs(r.text);
        return pairs.length ? { answers: pairs, via: 'ai' } : res;
      }, function () { return res; });
    });
  }

  function omrText(file, pFrom, pTo) {
    var mid = pFrom + (pTo - pFrom) / 2;
    function ocr(lang, from, to) {
      return M.extractText(file, {
        lang: lang,
        onProgress: function (p) { progress(from + p * (to - from) * 0.9, 'List पढ़ रहे हैं (OCR)…'); }
      }).then(omrPairs);
    }
    return ocr('eng', pFrom, mid).then(function (pairs) {
      /* a Hindi-headed key table barely reads under the English model — only then pay for both */
      if (pairs.length >= 5) return { answers: pairs, via: 'list' };
      return ocr('eng+hin', mid, pTo).then(function (p2) {
        return { answers: p2.length > pairs.length ? p2 : pairs, via: 'list' };
      });
    });
  }

  /* parseAnswerKey also yields question-text lines with no answer, and numeric answers ("1 - 3");
     keep usable number → A/B/C/D pairs only */
  function omrPairs(text) {
    var out = [];
    M.parseAnswerKey(text || '').forEach(function (a) {
      var no = parseInt(a.no, 10), ans = String(a.answer || '').trim().toUpperCase();
      if (!no || !ans) return;
      if (/^[1-8]$/.test(ans)) ans = String.fromCharCode(64 + parseInt(ans, 10));
      if (/^[A-H]$/.test(ans)) out.push({ no: no, answer: ans });
    });
    return out;
  }

  function run() {
    var useText = !$('textMode').classList.contains('hide');
    if (state.mode === 'omr' && !useText) { runOmr(); return; }
    $('btnMatch').disabled = true;
    state.t0 = Date.now();
    state.hindiBroken = false;
    state.hindiGarbledOnly = false;
    /* every fresh run may ask the AI again — the guard only stops handleTexts calling itself */
    state.aiDone = false;
    tick(); tickTimer();
    progress(0.02, useText ? 'Text पढ़ रहे हैं…' : 'Documents पढ़ रहे हैं…');
    status('info', 'Processing…', useText
      ? 'प्रश्न पहचानकर match किए जा रहे हैं।'
      : 'PDF का text सीधा पढ़ा जाता है (तेज़)। Scanned PDF / photo की pages AI (Gemini / Groq) से पढ़ी जाती हैं।');

    var qTextP, kTextP, k2TextP;
    if (useText) {
      qTextP = Promise.resolve($('pasteQ').value);
      kTextP = Promise.resolve($('pasteK').value);
      k2TextP = Promise.resolve($('pasteK2').value);
    } else {
      qTextP = readAll('q'); kTextP = readAll('k');
      k2TextP = state.mode === 'mapkey' ? readKey2() : Promise.resolve('');
    }
    Promise.all([qTextP, kTextP, k2TextP])
      .then(function (res) { handleTexts(res[0], res[1], res[2], useText); })
      .catch(fail);
  }

  function handleTexts(qTextIn, kTextIn, k2TextIn, useText) {
    progress(0.7, 'प्रश्न पहचान रहे हैं…');
    /* a two-column bilingual paper — scanned or pasted — comes back with both languages glued onto
       every line, which no parser can follow; separating the columns is what makes it readable */
    var qText = M.splitScripts((qTextIn || '').trim());
    var kText = M.splitScripts((kTextIn || '').trim());
    var k2Text = (k2TextIn || '').trim();
    var missing = !qText || !kText || (state.mode === 'mapkey' && !k2Text);

    /* A scan has no text layer to read: the AI is the only reader left, so hand the file over
       before declaring it unreadable. */
    if (!useText && missing && window.ExamAI && window.ExamAI.available() && !state.aiDone) {
      state.qText = qText; state.kText = kText;
      if (state.mode === 'mapkey') state.k2Text = k2Text;
      state.paper = M.parseQuestions(qText);
      state.key = (state.mode === 'map' || state.mode === 'mapkey') ? mapKeyList(kText) : M.parseAnswerKey(kText);
      aiReread();
      return;
    }
    if (!qText) throw new Error('Question Paper का text नहीं मिला। यह scan सीधे पढ़ा नहीं जा सकता — नई साफ़ file upload करें, या “✍️ Text paste करें” mode use करें।');
    if (!kText) throw new Error((state.mode === 'mapkey' ? 'दूसरी Series के Paper' : 'Answer Key') + ' का text नहीं मिला। key की file check करें या Text paste mode use करें।');
    if (state.mode === 'mapkey' && !k2Text) throw new Error('Answer Key का text नहीं मिला। key इस रूप में होनी चाहिए: "1 - A", "2. C" या "1) B"।');

    state.qText = qText; state.kText = kText;   // what was read — also drives the "पढ़ा गया text" panel
    if (state.mode === 'mapkey') state.k2Text = k2Text;
    state.paper = M.parseQuestions(qText);
    state.key = (state.mode === 'map' || state.mode === 'mapkey') ? mapKeyList(kText) : M.parseAnswerKey(kText);
    if (useText) { done(qText, kText); return; }

    /* Many govt. PDFs carry a hand-built text layer that scrambles Devanagari ("सूची" -> "सचू ी").
       Page OCR cannot repair that (it garbles Hindi itself), so the AI is asked for the file —
       its reading is adopted only when it is at least as complete (see readNext). */
    state.hindiBroken = (M.hindiQuality(qText) !== null && M.hindiQuality(qText) > 0.06) ||
                         (M.hindiQuality(kText) !== null && M.hindiQuality(kText) > 0.06);
    /* Bilingual paper whose Hindi layer is scrambled: the English half is intact, so matching uses
       it and the unreadable Hindi copy is dropped instead of being shown as broken text. */
    state.hindiGarbledOnly = state.hindiBroken && M.latinShare(qText) >= 0.3;
    if (state.hindiGarbledOnly) {
      [state.paper, state.key].forEach(function (list) {
        list.forEach(function (q) { q.alt = ''; q.altOptions = null; });
      });
    }

    if (!state.aiDone && window.ExamAI && window.ExamAI.available()) { aiReread(); return; }
    done(qText, kText);
  }

  /* ---------------- AI reading pass (Gemini Flash / Groq vision) ----------------
     Page-match OCR is off because it garbles Hindi, so every scan/photo that has no usable text
     layer is read here instead: the pages are rendered in the browser and sent one by one for
     reading; only the text that comes back is kept. PDFs with a real text layer, and pasted text,
     never touch this. The AI reading replaces the browser one only when it is at least as complete
     as what the browser read — so it can never make a result worse. */
  var AI_BUDGET_MS = 10 * 60 * 1000;

  function aiFile(which) {
    return which === 'q' ? state.qFile : which === 'k' ? state.kFile : state.k2File;
  }

  function aiLabel(which) {
    if (which === 'q') return 'Question Paper';
    if (which === 'k') return state.mode === 'mapkey' ? 'दूसरी Series का Paper' : 'Answer Key';
    return 'Official Answer Key';
  }

  /* how many questions/rows a piece of text gives — the same readers the flow itself uses */
  function aiCount(which, text) {
    if (which === 'k') {
      return (state.mode === 'map' || state.mode === 'mapkey') ? mapKeyList(text).length : M.parseAnswerKey(text).length;
    }
    if (which === 'k2') return M.parseAnswerKey(text).length;
    return M.parseQuestions(text).length;
  }

  /* what the browser already managed, so the AI reading has a number to beat */
  function aiHave(which) {
    if (which === 'q') return state.paper.length;
    if (which === 'k') return state.key.length;
    return M.parseAnswerKey(state.k2Text || '').length;
  }

  function aiPagesOf(which) {
    if (state.aiPages[which] !== undefined) return Promise.resolve(state.aiPages[which]);
    return M.pdfPageCount(aiFile(which)).then(function (n) {
      state.aiPages[which] = n || 0;
      return n || 0;
    });
  }

  /* A file is worth sending when its own reading is empty or looks broken, judged against its own
     length: a 45-page scan that yielded 28 questions is broken, a 45-page paper with 150 is not. */
  function aiWeak(which) {
    var f = aiFile(which);
    if (!f || state.aiTried[which]) return false;
    var have = aiHave(which), pages = state.aiPages[which] || 0;
    var garbled = which === 'q' ? M.hindiQuality(state.qText) : which === 'k' ? M.hindiQuality(state.kText) : null;
    var brokenHindi = garbled !== null && garbled > 0.06;
    if (which === 'q') {
      if (have < 6) return true;
      if (pages >= 3 && have < pages * 1.5) return true;
      return brokenHindi;
    }
    if (which === 'k2') return have < 4 || have < state.paper.length * 0.7;
    if (state.mode === 'key') return have < 4 || (state.paper.length >= 10 && have < state.paper.length * 0.6);
    if (have < 6) return true;
    if (pages >= 3 && have < pages * 1.5) return true;
    return brokenHindi;
  }

  function aiReread() {
    state.aiDone = true;
    var want = ['q', 'k'];
    if (state.mode === 'mapkey') want.push('k2');
    want = want.filter(function (w) { return !!aiFile(w) && !state.aiTried[w]; });
    if (!want.length) { done(state.qText, state.kText); return; }
    Promise.all(want.map(aiPagesOf)).then(function () {
      var targets = want.filter(aiWeak);
      if (!targets.length) { done(state.qText, state.kText); return; }
      var deadline = Date.now() + AI_BUDGET_MS;
      state.aiNames = targets.map(aiLabel);
      status('info', 'AI से दोबारा पढ़ा जा रहा है…',
        'इन files का ब्राउज़र वाला text अधूरा रहा, इसलिए pages AI (Gemini / Groq) को भेजी जा रही हैं: <b>'
        + esc(targets.map(aiLabel).join(', ')) + '</b>');
      return readNext(0, targets, deadline);
    }).then(function () {
      try { handleTexts(state.qText, state.kText, state.k2Text, false); }
      catch (err) { fail(err); }
    }).catch(function (e) {
      /* an AI failure must never cost the student the browser reading they already have */
      state.aiError = String((e && e.message) || e);
      try { done(state.qText, state.kText); } catch (err) { fail(err); }
    });
  }

  function readNext(i, targets, deadline) {
    if (i >= targets.length) return Promise.resolve();
    var which = targets[i], nm = aiLabel(which);
    state.aiTried[which] = true;
    progress(0.74, 'AI ' + nm + ' पढ़ रहा है…');
    return window.ExamAI.readFile(aiFile(which), {
      deadline: deadline,
      onProgress: function (d, total) {
        progress(0.74 + 0.12 * ((i + d / total) / targets.length),
          'AI ' + nm + ' पढ़ रहा है… page ' + d + '/' + total);
      }
    }).then(function (r) {
      state.aiSkipped += (r.failed || []).length;
      var text = (r.text || '').trim();
      var got = aiCount(which, text), have = aiHave(which);
      if (!text) { state.aiError = 'AI ' + nm + ' को पढ़ नहीं पाया'; return; }
      /* Keep whichever reading found more — but when the browser's Hindi itself is garbled, an AI
         reading of about the same size is still better: it is clean, readable Hindi. */
      var garbled = which === 'q' ? M.hindiQuality(state.qText) : which === 'k' ? M.hindiQuality(state.kText) : null;
      var broken = garbled !== null && garbled > 0.06;
      if (!(got > have || (broken && got >= have * 0.9 && got >= 4))) return;
      state.aiUsed += (state.aiUsed ? ', ' : '') + nm;
      state.aiGain[which] = have + ' → ' + got;
      if (which === 'q') state.qText = text;
      else if (which === 'k') state.kText = text;
      else state.k2Text = text;
    }).then(function () { return readNext(i + 1, targets, deadline); });
  }

  function done(qText, kText) {
    if (!state.paper.length) throw new Error('Question Paper में numbered प्रश्न नहीं मिल सके। प्रत्येक प्रश्न "1." जैसे number से शुरू हो, या Text paste mode अपनाएँ।');
    if (!state.key.length) {
      throw new Error((state.mode === 'map' || state.mode === 'mapkey')
        ? 'दूसरे paper के प्रश्न नहीं पढ़े जा सके — file साफ scan नहीं है। नई photo upload करें या Text paste mode use करें।'
        : 'Answer Key से number → answer pairs नहीं मिले। key इस रूप में होनी चाहिए: "1 - A", "2. C" या "1) B"।');
    }
    // let the label paint before the (synchronous) matching pass
    progress(0.85, 'प्रश्नों के based पर match कर रहे हैं…');
    setTimeout(function () {
      try { finish(kText); } catch (err) { fail(err); }
    }, 40);
  }

  function fail(err) {
    $('btnMatch').disabled = false;
    clearInterval(state.tickH);
    $('progWrap').classList.add('hide');
    $('progLine').classList.add('hide');
    status('err', 'Matching नहीं हो पाई', esc(err.message || err));
  }

  function covered(assign) {
    var n = 0;
    Object.keys(assign).forEach(function (i) { if (assign[i].method === 'content') n++; });
    return n;
  }

  /* Mapping mode: the second file is another question paper (usually a scan), so take every
     question both recovery passes can find and keep the longest text for each number. */
  function mapKeyList(text) {
    var byNo = {};
    [M.chainSegments(text), M.parseQuestions(text)].forEach(function (list) {
      list.forEach(function (q) {
        var cur = byNo[q.no];
        var body = (q.text || '').trim();
        if (body.replace(/\s/g, '').length < 12) return;
        if (!cur || body.length > cur.text.length) byNo[q.no] = { no: q.no, answer: '', text: body, options: [] };
      });
    });
    return Object.keys(byNo).map(function (n) { return byNo[n]; }).sort(function (a, b) { return a.no - b.no; });
  }

  /* Mapping mode cares only about numbers, so a question the parsers lost can still be placed by
     finding its wording inside the raw scan text and reading the number printed just before it. */
  function mapAssign(kText) {
    /* OCR of a bilingual paper makes the parser emit the same number twice (Hindi half, English
       half), so collapse to one row per number and keep whichever reading has more text. */
    var seen = {}, deduped = [];
    state.paper.forEach(function (q) {
      if (seen[q.no] === undefined) { seen[q.no] = deduped.length; deduped.push(q); }
      else if ((q.text || '').length > (deduped[seen[q.no]].text || '').length) deduped[seen[q.no]] = q;
    });
    state.paper = deduped.sort(function (a, b) { return a.no - b.no; });
    state.paperParsed = state.paper.length;
    var ladder = [0.42, 0.34, 0.28], best = null, want = state.paper.length;
    for (var ti = 0; ti < ladder.length; ti++) {
      var a = M.matchByContent(state.paper, state.key, { threshold: ladder[ti] });
      var c = covered(a);
      if (!best || c > best.covered) best = { assign: a, covered: c };
      if (c >= want * 0.9) break;
    }
    var assign = best.assign, byNo = {}, usedNo = {};
    state.key.forEach(function (k, i) { byNo[k.no] = i; });
    Object.keys(assign).forEach(function (i) {
      var k = state.key[assign[i].keyIndex];
      if (k) usedNo[k.no] = 1;
    });
    var stems = M.matchByStem(state.paper, kText);
    Object.keys(stems).forEach(function (i) {
      var no = stems[i].keyNo;
      if (assign[i] || usedNo[no]) return;
      if (byNo[no] === undefined) {
        byNo[no] = state.key.length;
        state.key.push({ no: no, answer: '', text: '', options: [] });
      }
      usedNo[no] = 1;
      assign[i] = { keyIndex: byNo[no], confidence: stems[i].confidence, method: 'stem' };
    });

    /* The other direction recovers far more numbers: the second paper parses cleanly, so each of its
       questions is located inside this paper's raw OCR text by its exact wording, and the number
       printed just before that wording is this paper's number. A govt number already claimed above
       stays claimed — one row per number, otherwise the table shows the same answer twice. */
    var usedKey = {};
    Object.keys(assign).forEach(function (i) { usedKey[assign[i].keyIndex] = 1; });
    var haveNo = {};
    state.paper.forEach(function (q) { haveNo[q.no] = 1; });
    var rev = M.matchByStem(state.key, state.qText), extra = [];
    Object.keys(rev).forEach(function (i) {
      var k = state.key[i], my = rev[i].keyNo;
      if (!k || haveNo[my] || usedKey[i]) return;
      haveNo[my] = 1;
      usedKey[i] = 1;
      extra.push({ q: { no: my, text: k.text || '', options: k.options || [] }, keyIndex: +i });
    });
    state.recovered = extra.length;
    if (extra.length) {
      /* assign is keyed by paper index, so rows are sorted first and the indices rebuilt after */
      var pairs = state.paper.map(function (q, idx) { return { q: q, a: assign[idx] }; });
      extra.forEach(function (e) {
        pairs.push({ q: e.q, a: { keyIndex: e.keyIndex, confidence: 0.5, method: 'rev' } });
      });
      pairs.sort(function (x, y) { return x.q.no - y.q.no; });
      state.paper = pairs.map(function (p) { return p.q; });
      assign = {};
      pairs.forEach(function (p, idx) { if (p.a) assign[idx] = p.a; });
    }
    return assign;
  }

  function finish(kText) {
    var keyHasText = state.key.some(function (k) { return (k.text || '').replace(/\s/g, '').length > 12; });
    var method = 'content';

    if (state.mode === 'map' || state.mode === 'mapkey') {
      state.assign = mapAssign(kText);
      state.threshold = 0.34;
      if (state.mode === 'mapkey') {
        /* the key is numbered for the OTHER series, so each matched question's answer is whatever
           the key says for that other-series number */
        var ansByNo = {}, gotAns = 0;
        M.parseAnswerKey(state.k2Text || '').forEach(function (a) {
          if (ansByNo[a.no] === undefined) ansByNo[a.no] = a.answer;
        });
        state.key.forEach(function (kk) { kk.answer = ansByNo[kk.no] || ''; if (kk.answer) gotAns++; });
        state.keyAnswers = gotAns;
      }
    } else if (keyHasText) {
      state.key = state.key.filter(function (k) { return (k.text || '').replace(/\s/g, '').length > 3; });
      /* One strictness guess is a coin flip for a student, so try the ladder and keep whichever
         actually covers the paper. Each pass is a few tens of ms. */
      var ladder = [0.42, 0.34, 0.28];
      var best = null, want = state.paper.length;
      for (var ti = 0; ti < ladder.length; ti++) {
        var a = M.matchByContent(state.paper, state.key, { threshold: ladder[ti] });
        var c = covered(a);
        if (!best || c > best.covered) best = { assign: a, covered: c, th: ladder[ti] };
        if (c >= want * 0.9) break;
      }
      state.assign = best.assign;
      state.threshold = best.th;
    } else {
      state.assign = M.matchByIdentity(state.paper, state.key);
      method = 'identity';
    }

    // pre-fill answers detected from marks in the paper
    state.answers = {};
    state.paper.forEach(function (q, i) {
      var d = M.detectMarkedAnswer(q);
      if (d) state.answers[i] = d;
    });
    state.override = {};

    state.scheme = { correct: parseFloat($('marksCorrect').value) || 1, wrong: parseFloat($('marksWrong').value) || 0 };
    state.page = 1;
    recompute();
    $('btnMatch').disabled = false;
    progress(1, 'पूरा हुआ');
    clearInterval(state.tickH);
    var secs = state.t0 ? ((Date.now() - state.t0) / 1000).toFixed(1) : '0';
    setTimeout(function () { $('progWrap').classList.add('hide'); $('progLine').classList.add('hide'); }, 500);

    var matched = state.result.stats.matched;
    var withAns = state.result.rows.filter(function (r) { return !!r.correct; }).length;
    var lowConf = state.result.rows.filter(function (r) { return r.confidence > 0 && r.confidence < 0.55; }).length;
    var isMapLike = state.mode === 'map' || state.mode === 'mapkey';
    var msg = isMapLike
      ? 'आपके paper में से <b>' + (state.paperParsed || state.paper.length) + '</b> प्रश्न सीधे पढ़े गए'
        + (state.recovered ? ' और <b>' + state.recovered + '</b> और उनके text से पहचाने गए' : '')
        + ' — कुल <b>' + state.paper.length + '</b> में से <b>' + matched + '</b> का सही number दूसरे paper में मिल गया'
        + (state.mode === 'mapkey' ? ', और Answer Key से <b>' + withAns + '</b> मैप हुए प्रश्नों के सही answer भी जुड़ गए' : '')
        + ' <b>(' + secs + ' sec)</b>।'
      : 'कुल <b>' + state.paper.length + '</b> प्रश्न पढ़े गए, <b>' + matched + '</b> answer key से match हुए <b>(' + secs + ' sec)</b>।';
    if (isMapLike && matched < state.paper.length * 0.6) {
      msg += '<br><br>⚠️ बाकी प्रश्न इसलिए नहीं मिल पाए कि जिस file का number ढूँढना है, उसकी scan साफ़ नहीं है'
        + ' (हर page पर अक्षर टूटे हुए हैं)। नई, साफ़ photo खींचकर upload करें — सिर्फ वही page की photo भी चलेगी।';
    }
    if (method === 'identity') {
      msg += '<br><br>⚠️ आपकी answer key में सिर्फ number + answer है, प्रश्न का text नहीं। इसलिए matching <b>same question number</b> से हुई है। अगर दोनों documents में numbers अलग हैं तो वह key upload करें जिसमें प्रश्न लिखे हों, या नीचे खुद correct कर लें।';
    }
    /* in mapping modes every row is placed by question wording, so "low confidence" would flag
       almost the whole table and say nothing — the verdict column already carries that detail */
    if (lowConf && !isMapLike) msg += '<br>⚠️ ' + lowConf + ' matches की confidence कम है — एक बार खुद check कर लें।';
    if (isMapLike && state.result.stats.unmatched > 0) {
      msg += '<br>💡 <b>' + state.result.stats.unmatched + '</b> प्रश्न का text scan में साफ नहीं आया'
        + ' (page की photo धुंधली है) — उस page की नई photo खींचकर upload करें (सिर्फ वही page की photo भी चलेगी),'
        + ' या “✍️ Text paste करें” में वह प्रश्न type करके Match दबाएँ।';
    }
    /* Browser page-OCR is off in this flow (it cannot read Hindi). A scan is read by the AI, so when
       Hindi still looks broken the message must point at the AI, never at a retry button. */
    if (state.hindiGarbledOnly && !state.aiUsed) {
      msg += '<br><br>⚠️ इस PDF के अंदर हिंदी अक्षर उल्टे क्रम में saved हैं ("सूची" की जगह "सचू ी") —'
        + ' यह गलती website की नहीं, PDF file की है। हर प्रश्न का <b>English हिस्सा बिल्कुल साफ़</b> है,'
        + ' इसलिए matching उसी से हुई है और बिगड़ी हुई हिंदी छिपा दी गई है।'
        + ' साफ़ हिंदी चाहिए तो इस PDF की pages की photo खींचकर (या स्क्रीनशॉट बनाकर) upload करें —'
        + ' AI (Gemini / Groq) उन्हें ठीक पढ़ता है।';
    } else if (state.hindiBroken && !state.aiUsed && !state.aiError) {
      msg += '<br><br>⚠️ इस scan की हिंदी साफ़ नहीं पढ़ी जा सकी। साफ़ हिंदी के लिए page की नई photo खींचकर upload करें'
        + ' — photo AI (Gemini / Groq) से पढ़ी जाती है।';
    }
    /* The AI pass only ever runs on a file the browser could not finish, so say plainly what it did —
       including when it read more than the browser and when it could not read the file at all. */
    if (state.aiUsed) {
      var gains = Object.keys(state.aiGain).map(function (w) {
        return '<b>' + aiLabel(w) + '</b> (' + state.aiGain[w] + ' प्रश्न)';
      }).join(', ');
      msg += '<br><br>🤖 <b>AI से दोबारा पढ़ा गया:</b> ' + gains
        + ' — इन files को ब्राउज़र पूरा नहीं पढ़ पाया था। AI का पढ़ा text नीचे “पढ़ा गया text” में भी दिख रहा है'
        + ' (चाहें तो सुधारकर दोबारा Match कर सकते हैं)।'
        + (state.aiSkipped ? ' ' + state.aiSkipped + ' page AI भी नहीं पढ़ पाया।' : '');
    } else if (state.aiError) {
      msg += '<br><br>🤖 scan अधूरा पढ़ा गया था, इसलिए AI (Gemini / Groq) से दोबारा पढ़ाने की कोशिश की गई —'
        + ' वह नहीं हो सकी: ' + esc(state.aiError) + '। ऊपर का result ब्राउज़र के अपने reading से बना है।';
    } else if (Object.keys(state.aiTried).length) {
      msg += '<br><br>🤖 scan अधूरा पढ़ा गया था, इसलिए AI से भी पढ़ाया गया — पर ब्राउज़र का reading ही ज़्यादा प्रश्न दे रहा था,'
        + ' इसलिए वही रखा गया है।';
    }
    status('ok', 'Matching Completed Successfully!', msg);
    showExtractedText();
    $('resultSection').classList.remove('hide');
    $('resultSection').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  /* expose what OCR read so the student can fix it and re-match */
  function showExtractedText() {
    if (!$('extQ')) return;
    $('extQ').value = state.qText === 'DEMO' ? '' : state.qText;
    $('extK').value = state.kText === 'DEMO' ? '' : state.kText;
    $('extQCount').textContent = state.paper.length;
    $('extKCount').textContent = state.key.length;
    if (!$('extQ').value) {
      $('textPanel').querySelector('p').innerHTML =
        'अभी text panel खाली है क्योंकि यह <b>demo</b> result है या input सीधा type किया गया था। असली file upload करने पर यहाँ पढ़ा गया text आ जाएगा।';
    }
  }

  function rematch() {
    var q = $('extQ').value.trim(), k = $('extK').value.trim();
    if (!q) { toast('पहले Question Paper का text भरें', 'err'); return; }
    state.qText = q; state.kText = k;
    state.paper = M.parseQuestions(q);
    state.key = M.parseAnswerKey(k);
    state.t0 = Date.now();
    try { done(q, k); } catch (e) { fail(e); }
  }

  /* ---------------- scoring + render ---------------- */
  function recompute() {
    var keyForMatch = state.key;
    var rows = M.buildResult(state.paper, keyForMatch, state.assign, state.answers, state.scheme);
    if (state.mode === 'omr') {
      /* the sheet's printed columns are the real option count; letters seen on either set only widen it */
      state.omrLetters = state.sheetOpt || 4;
      rows.rows.forEach(function (r) {
        [r.correct, r.mine].forEach(function (v) {
          if (/^[A-H]$/.test(String(v))) state.omrLetters = Math.max(state.omrLetters, v.charCodeAt(0) - 64);
        });
      });
    }
    // apply manual correct-answer overrides
    rows.rows.forEach(function (r) {
      var ov = state.override[r.idx];
      if (ov !== undefined) {
        r.correct = ov.toUpperCase();
        if (!r.correct) r.state = 'blank';
        else r.state = !r.mine ? 'blank' : (r.mine === r.correct ? 'correct' : 'wrong');
      }
    });
    var c = 0, w = 0, b = 0, u = 0;
    rows.rows.forEach(function (r) {
      if (r.state === 'correct') c++;
      else if (r.state === 'wrong') w++;
      else if (r.state === 'blank') b++;
      else u++;
    });
    var score = c * state.scheme.correct - w * Math.abs(state.scheme.wrong);
    var max = rows.stats.max;
    rows.stats.correct = c; rows.stats.wrong = w; rows.stats.blank = b; rows.stats.unmatched = u;
    rows.stats.matched = rows.stats.total - u;
    rows.stats.score = Math.round(score * 100) / 100;
    rows.stats.percent = max > 0 ? Math.round((score / max) * 1000) / 10 : 0;
    state.result = rows;
    M.saveResult(rows);
    render();
  }

  function render() {
    var r = state.result, s = r.stats, map = state.mode === 'map';
    /* in OMR Set mode the score waits until the student has read both columns and confirmed */
    var gate = state.mode === 'omr' && !state.confirmed;
    var low = r.rows.filter(function (x) { return x.confidence > 0 && x.confidence < 0.55; }).length;
    $('statRow').innerHTML = map ? [
      stat('blue', '📄', 'मेरे प्रश्न', s.total),
      stat('green', '🔗', 'मैप हुए', s.matched),
      stat('purple', '🔀', 'दूसरे Set का No', state.key.length),
      stat('red', '❓', 'बिना मैप', s.unmatched)
    ].join('') : [
      stat('blue', '📄', 'Total Questions', s.total),
      stat('green', '✔', 'Correct Answers', s.correct),
      stat('red', '✖', 'Wrong Answers', s.wrong),
      stat('purple', '🏆', 'Total Score', s.score + ' / ' + s.max)
    ].join('');
    $('statRow').classList.toggle('hide', gate);
    var table = $('resultTable');
    table.classList.toggle('mapmode', map);
    var th = table.querySelectorAll('thead th');
    if (th.length >= 6) {
      th[1].innerHTML = map ? 'सरकारी Paper का Q.No' : state.mode === 'mapkey' ? 'दूसरी Series का Q.No' : 'Matched Q.No<br><span class="small muted">(Answer Key)</span>';
      th[3].textContent = map ? '—' : 'Correct Answer';
      th[4].textContent = map ? '—' : 'Your Answer';
    }
    /* in an OMR set the two columns already came out of the photos, so there is nothing to type */
    $('bulkAnswers').parentNode.classList.toggle('hide', map || state.mode === 'omr');
    $('btnConfirmAll').classList.toggle('hide', map || state.mode === 'omr');
    $('confirmBar').classList.toggle('hide', !gate);
    $('resultHint').textContent = gate
      ? 'नीचे दोनों columns अपने-आप भरे हैं — Correct Answer और आपका उत्तर। एक बार देख लें, फिर ऊपर का Score खोलने वाला button दबाएँ।'
      : (state.mode === 'omr'
        ? 'कोई उत्तर बदलना हो तो dropdown बदल दें — Score तुरंत update होगा।'
        : 'नीचे अपनी answers डालें या बदलें — Score तुरंत update होगा।');
    renderTable();
  }

  function stat(cls, ic, lbl, val) {
    return '<div class="stat ' + cls + '"><div class="sic">' + ic + '</div><div><div class="lbl">' + lbl + '</div><div class="val">' + val + '</div></div></div>';
  }

  function optionsFor(row) {
    if (/^\d$/.test(String(row.correct || ''))) return ['1', '2', '3', '4', '5'];
    var src = (row.options || []).join(' ');
    var nums = (src.match(/\(\s*([1-5])\s*\)/g) || []).length;
    if (state.mode === 'omr') {
      if (/^\d$/.test(String(row.mine || '')) || /^\d$/.test(String(row.correct || ''))) return ['1', '2', '3', '4', '5'];
      return ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'].slice(0, state.omrLetters || 4);
    }
    if (nums && !/[A-Ha-h]\s*[\).:]\s*\S/.test(src)) return ['A', 'B', 'C', 'D', 'E'].slice(0, Math.max(2, Math.min(5, nums)));
    return ['A', 'B', 'C', 'D', 'E'];
  }

  function questionCell(row) {
    /* results saved by older runs still carry the broken "ब् लॉक" splits — clean them on the way out */
    var clean = M.joinDevaWords || function (t) { return t; };
    var q = esc(clean(row.question || '')).replace(/\s+/g, ' ').trim();
    var alt = esc(clean(row.questionAlt || '')).replace(/\s+/g, ' ').trim();
    var opts = (row.options || []).filter(Boolean).map(function (o) { return esc(clean(o)).replace(/\s+/g, ' ').trim(); });
    var html = '<div class="qtext">' + (q || '<i class="muted">' +
      (state.mode === 'omr' ? 'OMR Set — यहाँ मिलान प्रश्न के number से हुआ है, text से नहीं'
                            : 'प्रश्न का text OCR नहीं पढ़ पाया — नीचे edited text में सुधार करें') +
      '</i>') + '</div>';
    if (alt) html += '<div class="qalt">' + alt + '</div>';
    if (opts.length) html += '<div class="qopts">' + opts.map(function (o) { return '<span>' + o + '</span>'; }).join('') + '</div>';
    if (row.method === 'rev') html += '<div class="small muted mt4">यह number आपके paper के text से पहचाना गया है — text दूसरे paper का दिखाया गया है।</div>';
    return html;
  }

  function renderTable() {
    var rows = state.result.rows;
    var size = state.pageSize || rows.length || 1;
    var pages = Math.max(1, Math.ceil(rows.length / size));
    if (state.page > pages) state.page = pages;
    var start = (state.page - 1) * size;
    var slice = rows.slice(start, start + size);

    $('resultTable').querySelector('tbody').innerHTML = slice.map(function (row) {
      var opts = optionsFor(row);
      var matched = row.keyNo != null
        ? '<span class="ans-badge">' + row.keyNo + '</span>' + confTag(row)
        : '<span class="chip na">Not matched</span>';

      var correctCell;
      if (state.mode === 'omr') {
        /* read straight off the key photo, and shown as a dropdown exactly like Your Answer —
           a typing box there reads as "nothing was found", which is not what happened */
        correctCell = '<select data-ovr="' + row.idx + '"><option value="">—</option>' +
          opts.map(function (o) { return '<option' + (row.correct === o ? ' selected' : '') + '>' + o + '</option>'; }).join('') + '</select>';
      } else {
        correctCell = row.correct
          ? '<span class="ans-badge">' + esc(row.correct) + '</span>'
          : '<input type="text" style="width:56px;padding:5px 8px;border:1.5px solid #dbe7f7;border-radius:8px;text-align:center;font-weight:700" data-ovr="' + row.idx + '" value="' + esc(state.override[row.idx] || '') + '" placeholder="—">';
      }

      var mineCell = '<select data-ans="' + row.idx + '"><option value="">—</option>' +
        opts.map(function (o) { return '<option' + (row.mine === o ? ' selected' : '') + '>' + o + '</option>'; }).join('') + '</select>';

      var verdict = row.state === 'correct' ? '<span class="chip ok">✔ Correct</span>'
        : row.state === 'wrong' ? '<span class="chip no">✖ Wrong</span>'
        : row.state === 'blank' ? '<span class="chip na">Blank</span>'
        : '<span class="chip na">No key</span>';
      if (state.mode === 'map') {
        verdict = row.keyNo != null
          ? '<span class="chip ok">' + (row.method === 'rev' ? 'text से मिला' : 'मिल गया') + '</span>'
          : '<span class="chip na">नहीं मिला</span>';
      } else if (state.mode === 'omr' && !state.confirmed) {
        verdict = '<span class="chip na">⏳ Confirm करें</span>';
      }

      return '<tr><td class="center"><b>' + row.paperNo + '</b></td><td class="center">' + matched + '</td>' +
        '<td class="qprev">' + questionCell(row) + '</td><td class="center">' + correctCell + '</td>' +
        '<td class="center answer-cell">' + mineCell + '</td><td class="center">' + verdict + '</td></tr>';
    }).join('');

    var pager = $('pager');
    pager.innerHTML = '<span class="info">Showing ' + (start + 1) + ' to ' + Math.min(start + size, rows.length) +
      ' of ' + rows.length + ' questions</span>';
    for (var p = 1; p <= pages; p++) {
      if (pages > 7 && p > 3 && p < pages - 1 && Math.abs(p - state.page) > 1) {
        if (!pager.querySelector('.dots')) {
          var d = document.createElement('span'); d.className = 'dots'; d.textContent = ' … '; pager.appendChild(d);
        }
        continue;
      }
      var b = document.createElement('button');
      b.textContent = p;
      if (p === state.page) b.className = 'active';
      b.addEventListener('click', function (n) { return function () { state.page = n; renderTable(); }; }(p));
      pager.appendChild(b);
    }
    var nx = document.createElement('button');
    nx.textContent = '›'; nx.disabled = state.page === pages;
    nx.addEventListener('click', function () { if (state.page < pages) { state.page++; renderTable(); } });
    pager.appendChild(nx);
  }

  function confTag(row) {
    if (!row.confidence || row.method === 'same-number') return '';
    if (row.confidence >= 0.72) return '';
    return '<div class="small" style="color:#d97706;margin-top:3px">check ~' + Math.round(row.confidence * 100) + '%</div>';
  }

  /* live editing */
  $('pageSizeSel').addEventListener('change', function () {
    state.pageSize = parseInt(this.value, 10) || 0;
    state.page = 1;
    renderTable();
  });

  $('btnRematch').addEventListener('click', rematch);

  $('resultTable').addEventListener('change', function (e) {
    var t = e.target;
    if (t.dataset.ans) { state.answers[t.dataset.ans] = t.value; recompute(); }
    else if (t.dataset.ovr) { state.override[t.dataset.ovr] = t.value; recompute(); }
  });

  $('bulkAnswers').addEventListener('keydown', function (e) {
    if (e.key !== 'Enter') return;
    var parts = this.value.toUpperCase().split(/[^A-Z0-9]+/).filter(Boolean);
    if (!parts.length) return;
    state.paper.forEach(function (q, i) { if (parts[i]) state.answers[i] = parts[i]; });
    toast('✓ ' + parts.length + ' answers भर दिए गए', 'ok');
    recompute();
  });

  $('btnConfirmAll').addEventListener('click', function () {
    toast('✓ Answers confirm हो गए — Full Analysis page पर जाकर पूरा report देखें', 'ok');
    M.saveResult(state.result);
  });

  /* the two-step flow: read both auto-filled columns first, then take the verdict + Score */
  $('btnGetScore').addEventListener('click', function () {
    state.confirmed = true;
    recompute();
    toast('✓ Score खोल दिया गया', 'ok');
    $('statRow').scrollIntoView({ behavior: 'smooth', block: 'center' });
  });

  /* pdf.js + tesseract.js download in the background while the student fills the form */
  setTimeout(function () {
    try { M.prewarm(ocrLang(state.lang), false); } catch (e) {}
  }, 300);

})();
