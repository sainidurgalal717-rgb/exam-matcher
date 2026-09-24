/* Renders the saved result (from upload.html) or the built-in sample. */
(function () {
  'use strict';
  var M = window.ExamMatcher;

  var SAMPLE = {
    rows: [
      { paperNo: 1, keyNo: 3, question: 'Which planet is known as the Red Planet?', options: ['(1) (2) (3) (4)'], correct: 'C', mine: 'C', state: 'correct', confidence: 1, method: 'content' },
      { paperNo: 2, keyNo: 7, question: 'What is the largest ocean on Earth?', options: ['(1) (2) (3) (4)'], correct: 'A', mine: 'B', state: 'wrong', confidence: 1, method: 'content' },
      { paperNo: 3, keyNo: 12, question: 'Who wrote the Indian Constitution?', options: ['(1) (2) (3) (4)'], correct: 'D', mine: 'D', state: 'correct', confidence: 1, method: 'content' },
      { paperNo: 4, keyNo: 15, question: '2 + 3 x 4 = ?', options: ['(1) (2) (3) (4)'], correct: 'B', mine: 'B', state: 'correct', confidence: 1, method: 'content' },
      { paperNo: 5, keyNo: 20, question: 'Which vitamin is known as "Sunshine Vitamin"?', options: ['(1) (2) (3) (4)'], correct: 'C', mine: 'A', state: 'wrong', confidence: 1, method: 'content' },
      { paperNo: 6, keyNo: 24, question: 'Capital of Australia is?', options: ['(1) (2) (3) (4)'], correct: 'B', mine: 'B', state: 'correct', confidence: 1, method: 'content' },
      { paperNo: 7, keyNo: 29, question: 'Which gas is most abundant in Earth atmosphere?', options: ['(1) (2) (3) (4)'], correct: 'A', mine: 'A', state: 'correct', confidence: 1, method: 'content' },
      { paperNo: 8, keyNo: 33, question: 'Who is known as the Missile Man of India?', options: ['(1) (2) (3) (4)'], correct: 'C', mine: 'C', state: 'correct', confidence: 1, method: 'content' },
      { paperNo: 9, keyNo: 38, question: 'HCF of 12 and 18 is?', options: ['(1) (2) (3) (4)'], correct: 'D', mine: 'D', state: 'correct', confidence: 1, method: 'content' },
      { paperNo: 10, keyNo: 41, question: 'Which river is called the Sorrow of Bihar?', options: ['(1) (2) (3) (4)'], correct: 'B', mine: 'B', state: 'correct', confidence: 1, method: 'content' }
    ],
    stats: { total: 50, matched: 50, correct: 42, wrong: 8, blank: 0, score: 84, max: 100, percent: 84 },
    createdAt: null,
    sample: true
  };

  window.ResultData = {
    get: function () {
      var saved = M && M.loadResult();
      if (saved && saved.rows && saved.rows.length) {
        saved.sample = false;
        return saved;
      }
      return SAMPLE;
    },
    esc: function (s) {
      return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
      });
    },
    verdict: function (st) {
      if (st === 'correct') return '<span class="chip ok">✔ Correct</span>';
      if (st === 'wrong') return '<span class="chip no">✖ Wrong</span>';
      if (st === 'blank') return '<span class="chip na">Blank</span>';
      return '<span class="chip na">No key</span>';
    }
  };
})();
