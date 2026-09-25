/* Upload OMR Set page */
(function () {
  'use strict';
  var M = window.ExamMatcher;
  var $ = function (id) { return document.getElementById(id); };

  var st = { sFile: null, kFile: null, sText: '', kText: '', key: [], answers: {}, optCount: 4, result: null };

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function status(kind, title, body) {
    $('statusBox').innerHTML = '<div class="alert ' + kind + ' mt14"><div class="a-ic">' +
      (kind === 'ok' ? '✓' : kind === 'err' ? '!' : kind === 'warn' ? '!' : 'i') + '</div><div><b>' + esc(title) + '</b>' + body + '</div></div>';
  }
  function progress(p) { $('progWrap').classList.remove('hide'); $('progBar').style.width = Math.max(2, Math.round(p * 100)) + '%'; }

  function wireDrop(dropId, inputId, which) {
    var drop = $(dropId), input = $(inputId);
    drop.addEventListener('click', function () { input.click(); });
    drop.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } });
    input.addEventListener('change', function () { handle(input.files[0], which); });
    ['dragenter', 'dragover'].forEach(function (ev) { drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.add('drag'); }); });
    ['dragleave', 'drop'].forEach(function (ev) { drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.remove('drag'); }); });
    drop.addEventListener('drop', function (e) {
      var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) handle(f, which);
    });
    function handle(f, w) {
      if (!f) return;
      if (w === 's') { st.sFile = f; $('fileS').textContent = '✓ ' + f.name; $('dropS').classList.add('done'); }
      else { st.kFile = f; $('fileK').textContent = '✓ ' + f.name; $('dropK').classList.add('done'); }
    }
  }
  wireDrop('dropS', 'inputS', 's');
  wireDrop('dropK', 'inputK', 'k');

  function read(file, pFrom, pTo) {
    if (!file) return Promise.resolve('');
    return M.extractText(file, {
      lang: 'eng',
      onProgress: function (p) { progress(pFrom + p * (pTo - pFrom)); }
    });
  }

  $('btnStart').addEventListener('click', function () {
    if (!st.kFile && !st.sFile) {
      status('err', 'File चुनें', 'कम से कम Official Answer Key upload करें। student की answers grid में खुद भी भर सकते हैं।');
      return;
    }
    this.disabled = true;
    progress(0.03);
    status('info', 'Reading OMR files…', 'OCR चल रहा है — scanned sheet पर 15–60 सेकंड लग सकते हैं।');

    Promise.all([read(st.sFile, 0.03, 0.5), read(st.kFile, 0.5, 0.9)]).then(function (res) {
      st.sText = res[0] || ''; st.kText = res[1] || '';
      st.key = M.parseAnswerKey(st.kText);
      var n = Math.max(1, Math.min(300, parseInt($('qCount').value, 10) || 50));
      st.optCount = parseInt($('optCount').value, 10) || 4;

      // best-effort: read "1 A" style pairs from the student sheet OCR text
      var auto = M.parseAnswerKey(st.sText);
      var autoMap = {};
      auto.forEach(function (a) { if (parseInt(a.answer, 10) > 0 && parseInt(a.answer, 10) <= st.optCount) a.answer = String.fromCharCode(64 + parseInt(a.answer, 10)); st.answers[a.no] = a.answer; autoMap[a.no] = 1; });

      /* the key OCR lands in the paste box either way: parsed cleanly it just shows what was read,
         parsed badly the student can fix the text in place and press "Key लगाएँ" */
      if ($('keyText')) $('keyText').value = st.kText;
      showKeyPill();

      if (!st.key.length) {
        status('warn', 'Answer Key से number → answer नहीं मिले',
          'Key की photo साफ list की तरह नहीं पढ़ी। नीचे box में key की list "1 - A", "2. B" जैसे <b>लिखकर</b> (या OCR text ठीक करके) <b>Key लगाएँ</b> दबाएँ।');
      }
      progress(1);
      setTimeout(function () { $('progWrap').classList.add('hide'); }, 400);
      $('btnStart').disabled = false;
      buildGrid(n, Object.keys(autoMap).length);
    }).catch(function (err) {
      $('btnStart').disabled = false;
      $('progWrap').classList.add('hide');
      status('err', 'Read failed', esc(err.message || err));
    });
  });

  function showKeyPill() {
    if (!st.key.length) { $('keyPill').classList.add('hide'); return; }
    $('keyPill').classList.remove('hide');
    $('keyPillTxt').textContent = 'Key: ' + st.key.length + ' answers';
  }

  $('btnApplyKey').addEventListener('click', function () {
    var k = M.parseAnswerKey($('keyText').value || '');
    if (!k.length) { toast('Key में number → answer pairs नहीं मिले — "1 - A" जैसी lines लिखें', 'err'); return; }
    st.key = k;
    st.kText = $('keyText').value;
    showKeyPill();
    toast('Answer Key लग गई (' + k.length + ' answers)', 'ok');
    status('ok', 'Answer Key तैयार', '<b>' + k.length + '</b> answers मिले — अब circles confirm करके <b>Confirm &amp; Get Score</b> दबाएँ।');
  });

  function buildGrid(n, autoCount) {
    $('readPill').innerHTML = '<span class="ck">' + (autoCount ? '✓' : 'i') + '</span> OCR: ' + autoCount + ' auto-read';
    $('gridCard').classList.remove('hide');
    var letters = [];
    for (var i = 0; i < st.optCount; i++) letters.push(String.fromCharCode(65 + i));

    var html = '';
    for (var q = 1; q <= n; q++) {
      html += '<div class="omr-row" style="border:1px solid #e6ddfa;border-radius:9px;padding:6px 9px">' +
        '<span class="qn">' + q + '.</span><span class="bubs">' +
        letters.map(function (L) {
          var on = st.answers[q] === L;
          return '<button class="bub' + (on ? ' on' : '') + '" data-q="' + q + '" data-l="' + L + '" ' +
            'style="cursor:pointer;border:0;background:' + (on ? '#7c3aed' : '') + ';' +
            (on ? 'color:#fff' : 'background:#f1eafe;color:#6b5a8c') + ';width:22px;height:22px">' + L + '</button>';
        }).join('') + '</span></div>';
    }
    $('bubbleGrid').innerHTML = html;
    $('bubbleGrid').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  $('bubbleGrid').addEventListener('click', function (e) {
    var b = e.target.closest('button[data-q]'); if (!b) return;
    var q = b.dataset.q, L = b.dataset.l;
    st.answers[q] = st.answers[q] === L ? '' : L;
    var box = b.parentNode;
    [].forEach.call(box.querySelectorAll('button'), function (x) {
      var on = st.answers[q] && x.dataset.l === st.answers[q];
      x.style.background = on ? '#7c3aed' : '#f1eafe';
      x.style.color = on ? '#fff' : '#6b5a8c';
    });
  });

  $('btnClearGrid').addEventListener('click', function () {
    st.answers = {};
    var n = Math.max(1, Math.min(300, parseInt($('qCount').value, 10) || 50));
    buildGrid(n, 0);
    toast('Grid clear हो गई', 'info');
  });

  $('btnScore').addEventListener('click', function () {
    if (!st.key.length) { toast('पहले answer key upload करें', 'err'); return; }
    var n = Math.max(1, Math.min(300, parseInt($('qCount').value, 10) || 50));
    var paper = [];
    for (var q = 1; q <= n; q++) paper.push({ no: q, text: 'Question ' + q, options: [], raw: '' });

    var assign = M.matchByIdentity(paper, st.key);
    var scheme = { correct: parseFloat($('marksCorrect').value) || 1, wrong: parseFloat($('marksWrong').value) || 0 };
    var byIndex = {};
    paper.forEach(function (q, i) { if (st.answers[q.no]) byIndex[i] = st.answers[q.no]; });
    st.result = M.buildResult(paper, st.key, assign, byIndex, scheme);
    M.saveResult(st.result);

    var s = st.result.stats;
    $('statRow').innerHTML = [
      stat('blue', '📄', 'Total Questions', s.total),
      stat('green', '✔', 'Correct Answers', s.correct),
      stat('red', '✖', 'Wrong Answers', s.wrong),
      stat('purple', '🏆', 'Total Score', s.score + ' / ' + s.max)
    ].join('');

    $('omrRows').innerHTML = st.result.rows.map(function (r) {
      return '<tr><td class="center"><b>' + r.paperNo + '</b></td><td class="center">' +
        (r.keyNo == null ? '—' : '<span class="ans-badge">' + r.keyNo + '</span>') + '</td>' +
        '<td class="center"><span class="ans-badge">' + (r.correct || '—') + '</span></td>' +
        '<td class="center"><span class="ans-badge' + (r.state === 'wrong' ? ' bad' : '') + '">' + (r.mine || '—') + '</span></td>' +
        '<td class="center">' + (r.state === 'correct' ? '<span class="chip ok">✔ Correct</span>'
          : r.state === 'wrong' ? '<span class="chip no">✖ Wrong</span>' : '<span class="chip na">Blank</span>') + '</td></tr>';
    }).join('');

    $('resultCard').classList.remove('hide');
    status('ok', 'OMR Result तैयार है',
      'Total <b>' + s.total + '</b> प्रश्न, <b>' + s.correct + '</b> सही, <b>' + s.wrong + '</b> गलत, <b>' + s.blank + '</b> खाली — Score <b>' + s.score + ' / ' + s.max + '</b>।');
    $('resultCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
  });

  function stat(cls, ic, lbl, val) {
    return '<div class="stat ' + cls + '"><div class="sic">' + ic + '</div><div><div class="lbl">' + lbl + '</div><div class="val">' + val + '</div></div></div>';
  }
})();
