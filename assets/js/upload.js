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
    scheme: { correct: 1, wrong: 0 },
    page: 1,
    pageSize: 25,
    result: null,
    lang: 'eng',
    /* set when the student (or an auto-retry) insists that the pages themselves must be OCR'd */
    forceOcr: false,
    langForced: '',
    t0: 0,
    tickH: null
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

  /* "Auto" starts on the cheap English model; the engine switches to eng+hin by itself when the
     document turns out to be Hindi, so a plain English paper never pays for the bigger model. */
  function ocrLang(v) { return !v || v === 'auto' ? 'eng' : v; }

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
    state.slowPass = false;      // a fresh manual run always starts on the fast default
    state.forceOcr = false;
    state.langForced = '';
    run();
  });


  /* Both files are OCR'd against one shared clock, so a 50-page scan can never hold a student
     waiting forever — whatever got read in that time is still a usable (partial) result. */
  var OCR_BUDGET_MS = 4 * 60 * 1000;
  /* the opt-in high-resolution pass costs real minutes; it only runs when the student asks for it */
  var OCR_SLOW_BUDGET_MS = 10 * 60 * 1000;

  function readAll(which) {
    var file = state[which + 'File'];
    var cached = state[which + 'Text'];
    if (cached) return Promise.resolve(cached);
    if (!file) return Promise.resolve('');
    var nm = which === 'q' ? 'Question Paper' : which === 'k' ? (state.mode === 'mapkey' ? 'दूसरी Series Paper' : 'Answer Key') : 'Answer Key';
    progress(0.05, nm + ' पढ़ रहे हैं…');
    var slow = state.slowPass && which === state.slowWhich;
    return M.extractText(file, {
      lang: state.lang === 'auto' ? 'eng' : state.lang,
      /* cleanup only changes how a page looks to OCR — a PDF with a usable text layer is still read
         directly, so it never costs time on a clean file */
      forceOcr: state.forceOcr || slow,
      ocrEdge: slow ? 1600 : 0,
      enhance: slow,
      deadline: state.deadline,
      onSkipped: function (n) { state.skipped = (state.skipped || 0) + n; },
      onProgress: function (p) { progress(0.05 + p * 0.6, nm + ' — OCR ' + Math.round(p * 100) + '%'); }
    }).then(function (t) {
      state[which + 'Text'] = t;
      return t;
    });
  }

  function run() {
    var useText = !$('textMode').classList.contains('hide');
    $('btnMatch').disabled = true;
    state.t0 = Date.now();
    state.deadline = state.t0 + (state.slowPass ? OCR_SLOW_BUDGET_MS : OCR_BUDGET_MS);
    state.skipped = 0;
    state.forceTried = false;
    state.hindiBroken = false;
    state.hindiGarbledOnly = false;
    state.lang = state.langForced || 'auto';
    tick(); tickTimer();
    progress(0.02, useText ? 'Text पढ़ रहे हैं…' : 'Documents पढ़ रहे हैं…');
    status('info', 'Processing…', useText
      ? 'प्रश्न पहचानकर match किए जा रहे हैं।'
      : (state.slowPass
        ? 'Answer key दोबारा, ज़्यादा साफ़ी से पढ़ी जा रही है — इसमें 5-10 minute लग सकते हैं।'
        : 'PDF का text सीधा पढ़ा जाता है (तेज़)। Scanned PDF / photo पर OCR लगता है — language और quality अपने-आप चुनी जाती हैं।'));

    var qTextP, kTextP, k2TextP;
    if (useText) {
      qTextP = Promise.resolve($('pasteQ').value);
      kTextP = Promise.resolve($('pasteK').value);
      k2TextP = Promise.resolve($('pasteK2').value);
    } else {
      qTextP = readAll('q'); kTextP = readAll('k');
      k2TextP = state.mode === 'mapkey' ? readAll('k2') : Promise.resolve('');
    }

    Promise.all([qTextP, kTextP, k2TextP]).then(function (res) { handleTexts(res[0], res[1], res[2], useText); }).catch(fail);
  }

  function handleTexts(qTextIn, kTextIn, k2TextIn, useText) {
    progress(0.7, 'प्रश्न पहचान रहे हैं…');
    var qText = (qTextIn || '').trim();
    var kText = (kTextIn || '').trim();
    var k2Text = (k2TextIn || '').trim();
    if (!qText) throw new Error('Question Paper का text नहीं मिला। file साफ है तो दोबारा try करें, या Text paste mode इस्तेमाल करें।');
    if (!kText) throw new Error((state.mode === 'mapkey' ? 'दूसरी Series के Paper' : 'Answer Key') + ' का text नहीं मिला। key की file check करें या Text paste mode use करें।');
    if (state.mode === 'mapkey' && !k2Text) throw new Error('Answer Key का text नहीं मिला। key इस रूप में होनी चाहिए: "1 - A", "2. C" या "1) B"।');

    state.qText = qText; state.kText = kText;   // what was read — also drives the "पढ़ा गया text" panel
    if (state.mode === 'mapkey') state.k2Text = k2Text;
    state.paper = M.parseQuestions(qText);
    state.key = (state.mode === 'map' || state.mode === 'mapkey') ? mapKeyList(kText) : M.parseAnswerKey(kText);
    if (useText) { done(qText, kText); return; }

    /* English-only OCR on a Hindi document returns near-nothing — retry once with both scripts. */
    if ((state.lang === 'eng' || state.lang === 'auto') && state.paper.length < 3 && !/[\u0900-\u097F]/.test(qText)) {
      state.lang = 'eng+hin';
      state.qText = ''; state.kText = '';
      progress(0.05, 'हिंदी मिला — दोबारा OCR (English + Hindi)…');
      return Promise.all([readAll('q'), readAll('k')]).then(function (r2) {
        handleTexts(r2[0], r2[1], state.k2Text, false);
      });
    }

    /* Many govt. PDFs carry a hand-built text layer that scrambles Devanagari ("सूची" -> "सचू ी").
       Only worth the slow page-OCR when there is no clean English half to match against. */
    function badHindi(t) { var q = M.hindiQuality(t); return q !== null && q > 0.06 && M.latinShare(t) < 0.3; }
    state.hindiBroken = (M.hindiQuality(qText) !== null && M.hindiQuality(qText) > 0.06) ||
                         (M.hindiQuality(kText) !== null && M.hindiQuality(kText) > 0.06);
    var badQ = badHindi(qText), badK = badHindi(kText);
    /* a second full OCR pass only makes sense while there is time left in the budget */
    if (!state.forceTried && (badQ || badK) && Date.now() < state.deadline - 30000) {
      state.forceTried = true;
      state.lang = state.langForced = 'eng+hin';
      state.forceOcr = true;
      if (badQ) state.qText = '';
      if (badK) state.kText = '';
      progress(0.03, 'PDF की हिंदी बिगड़ी मिली — pages की तस्वीर बनाकर OCR लगा रहे हैं (थोड़ा समय लगेगा)…');
      return Promise.all([readAll('q'), readAll('k')]).then(function (r2) {
        handleTexts(r2[0], r2[1], state.k2Text, false);
      });
    }

    /* Bilingual paper whose Hindi layer is scrambled: the English half is intact, so matching uses
       it and the unreadable Hindi copy is dropped instead of being shown as broken text. */
    state.hindiGarbledOnly = state.hindiBroken && M.latinShare(qText) >= 0.3 && !state.forceTried;
    if (state.hindiGarbledOnly) {
      [state.paper, state.key].forEach(function (list) {
        list.forEach(function (q) { q.alt = ''; q.altOptions = null; });
      });
    }

    /* A key that is itself a blurry scan gives up most of its questions; say so plainly and offer the
       deliberate high-resolution pass instead of quietly returning a mostly empty table. */
    state.keyThin = !useText && !state.slowPass && state.mode === 'omr' &&
      state.paper.length >= 10 && state.key.length < state.paper.length * 0.6;
    /* which side is the poorly readable one — only that file gets the slow, accurate pass */
    state.slowWhich = (state.mode === 'map' || state.mode === 'mapkey') && state.paper.length <= state.key.length ? 'q' : 'k';

    done(qText, kText);
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
      msg += '<br><br>⚠️ बाकी प्रश्न इसलिए नहीं मिल पाए कि जिस file का number ढूँढना है, वह scan साफ़ नहीं है'
        + ' (हर page पर अक्षर टूटे हुए हैं)। दबाइए:'
        + ' <button class="btn sm mt8" id="btnSlowKey">🔍 उस file को साफ़ पढ़ें (~5-10 min)</button>'
        + ' — ज़्यादा साफ़ी से OCR होगा और बहुत ज़्यादा प्रश्न मैप होंगे।';
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
    if (state.skipped) {
      msg += '<br>⚠️ समय-सीमा (4 minute) पूरी होने से <b>' + state.skipped + ' pages</b> OCR नहीं हो पाए —'
        + ' result पढ़े गए pages तक है। बाकी प्रश्नों के लिए दोबारा चलाएँ या Text paste mode use करें।';
    }
    var ocrBtn = ' <button class="btn sm mt8" id="btnHindiOcr">🔁 हिंदी के लिए दोबारा OCR करें</button>';
    if (state.hindiGarbledOnly) {
      msg += '<br><br>⚠️ इस PDF के अंदर हिंदी अक्षर उल्टे क्रम में saved हैं ("सूची" की जगह "सचू ी") —'
        + ' यह गलती website की नहीं, PDF file की है। हर प्रश्न का <b>English हिस्सा बिल्कुल साफ़</b> है,'
        + ' इसलिए matching उसी से हुई है और बिगड़ी हुई हिंदी छिपा दी गई है।'
        + ' साफ़ हिंदी चाहिए तो button दबाएँ (PDF की pages की तस्वीर बनाकर OCR होगा, slow है):' + ocrBtn;
    } else if (state.hindiBroken && !state.forceTried) {
      msg += '<br><br>⚠️ इस PDF की हिंदी साफ़ नहीं पढ़ी जा सकी — button दबाकर OCR से दोबारा पढ़ें:' + ocrBtn;
    }
    if (state.keyThin) {
      msg += '<br><br>⚠️ Answer key की file से केवल <b>' + state.key.length + '</b> प्रश्न/उत्तर ही पढ़े जा सके'
        + ' (paper में ' + state.paper.length + ' हैं) — key की scan साफ़ नहीं है।'
        + ' दो रास्ते: <b>(1)</b> key सिर्फ़ answers की list हो ("1 - A", "2 - C"…) तो वह upload करें या'
        + ' Text paste mode में list paste कर दें (सबसे तेज़)। <b>(2)</b> वही file दोबारा, ज़्यादा साफ़ी से पढ़वाना हो:'
        + ' <button class="btn sm mt8" id="btnSlowKey">🔍 Key को साफ़ पढ़ें (~5-10 min)</button>';
    }
    status('ok', 'Matching Completed Successfully!', msg);
    var hb = $('btnHindiOcr');
    if (hb) hb.addEventListener('click', function () {
      state.langForced = 'eng+hin';
      state.forceOcr = true;
      state.qText = ''; state.kText = '';
      run();
    });
    var sb = $('btnSlowKey');
    if (sb) sb.addEventListener('click', function () {
      state.slowPass = true;
      if (state.slowWhich === 'q') state.qText = ''; else state.kText = '';
      run();
    });
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
    var table = $('resultTable');
    table.classList.toggle('mapmode', map);
    var th = table.querySelectorAll('thead th');
    if (th.length >= 6) {
      th[1].innerHTML = map ? 'सरकारी Paper का Q.No' : state.mode === 'mapkey' ? 'दूसरी Series का Q.No' : 'Matched Q.No<br><span class="small muted">(Answer Key)</span>';
      th[3].textContent = map ? '—' : 'Correct Answer';
      th[4].textContent = map ? '—' : 'Your Answer';
    }
    $('bulkAnswers').parentNode.classList.toggle('hide', map);
    $('btnConfirmAll').classList.toggle('hide', map);
    renderTable();
  }

  function stat(cls, ic, lbl, val) {
    return '<div class="stat ' + cls + '"><div class="sic">' + ic + '</div><div><div class="lbl">' + lbl + '</div><div class="val">' + val + '</div></div></div>';
  }

  function optionsFor(row) {
    if (/^\d$/.test(String(row.correct || ''))) return ['1', '2', '3', '4', '5'];
    var src = (row.options || []).join(' ');
    var nums = (src.match(/\(\s*([1-5])\s*\)/g) || []).length;
    if (state.mode === 'omr' && !/[A-Ha-h][\).:]/.test(src)) return ['1', '2', '3', '4', '5'];
    if (nums && !/[A-Ha-h]\s*[\).:]\s*\S/.test(src)) return ['A', 'B', 'C', 'D', 'E'].slice(0, Math.max(2, Math.min(5, nums)));
    return ['A', 'B', 'C', 'D', 'E'];
  }

  function questionCell(row) {
    var q = esc(row.question || '').replace(/\s+/g, ' ').trim();
    var alt = esc(row.questionAlt || '').replace(/\s+/g, ' ').trim();
    var opts = (row.options || []).filter(Boolean).map(function (o) { return esc(o).replace(/\s+/g, ' ').trim(); });
    var html = '<div class="qtext">' + (q || '<i class="muted">प्रश्न का text OCR नहीं पढ़ पाया — नीचे edited text में सुधार करें</i>') + '</div>';
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

      var correctCell = row.correct
        ? '<span class="ans-badge">' + esc(row.correct) + '</span>'
        : '<input type="text" style="width:56px;padding:5px 8px;border:1.5px solid #dbe7f7;border-radius:8px;text-align:center;font-weight:700" data-ovr="' + row.idx + '" value="' + esc(state.override[row.idx] || '') + '" placeholder="—">';

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

  /* pdf.js + tesseract.js download in the background while the student fills the form */
  setTimeout(function () {
    try { M.prewarm(ocrLang(state.lang), false); } catch (e) {}
  }, 300);

})();
