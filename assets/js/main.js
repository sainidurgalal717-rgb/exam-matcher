/* Shared behaviour: mobile nav, active link, small helpers */
(function () {
  var toggle = document.querySelector('.nav-toggle');
  var nav = document.querySelector('.nav');
  if (toggle && nav) {
    toggle.addEventListener('click', function () { nav.classList.toggle('open'); });
    nav.addEventListener('click', function (e) { if (e.target.tagName === 'A') nav.classList.remove('open'); });
  }

  var year = document.querySelector('[data-year]');
  if (year) year.textContent = new Date().getFullYear();
})();

function toast(msg, kind) {
  var box = document.getElementById('toast-box');
  if (!box) {
    box = document.createElement('div');
    box.id = 'toast-box';
    box.style.cssText = 'position:fixed;right:18px;bottom:18px;z-index:9999;display:grid;gap:8px;max-width:340px';
    document.body.appendChild(box);
  }
  var colors = { ok: '#16a34a', err: '#e02d2d', warn: '#d97706', info: '#1668f5' };
  var el = document.createElement('div');
  el.style.cssText = 'background:#fff;border-left:4px solid ' + (colors[kind] || colors.info) +
    ';box-shadow:0 10px 28px rgba(12,45,105,.2);padding:12px 15px;border-radius:10px;font-size:13px;color:#12263f';
  el.textContent = msg;
  box.appendChild(el);
  setTimeout(function () { el.style.transition = '.4s'; el.style.opacity = '0'; el.style.transform = 'translateY(8px)'; }, 3200);
  setTimeout(function () { el.remove(); }, 3800);
}
