// Общие функции для всех экранов.
const S = (() => {
  let offset = 0; // разница часов сервера и устройства

  function connect(params, onState, onStatus) {
    let es;
    let retry;
    function open() {
      es = new EventSource('/events?' + new URLSearchParams(params));
      es.onopen = () => onStatus && onStatus(true);
      es.onmessage = (e) => {
        const st = JSON.parse(e.data);
        offset = st.now - Date.now();
        onState(st);
      };
      es.onerror = () => {
        onStatus && onStatus(false);
        if (es.readyState === EventSource.CLOSED) {
          clearTimeout(retry);
          retry = setTimeout(open, 2000);
        }
      };
    }
    open();
    return { close: () => es && es.close() };
  }

  async function post(body) {
    const r = await fetch('/api', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const j = await r.json().catch(() => ({ error: 'Нет связи с сервером' }));
    if (!r.ok || j.error) throw new Error(j.error || 'Ошибка');
    return j;
  }

  const serverNow = () => Date.now() + offset;

  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function store(key, val) {
    try {
      if (val === undefined) return localStorage.getItem(key);
      if (val === null) localStorage.removeItem(key); else localStorage.setItem(key, val);
    } catch { return null; }
  }

  function playerId() {
    let id = store('svoyak.id');
    if (!id) {
      id = 'p' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
      store('svoyak.id', id);
    }
    return id;
  }

  let ctx;
  function beep(freq = 880, ms = 180, type = 'square', vol = 0.15) {
    try {
      ctx = ctx || new (window.AudioContext || window.webkitAudioContext)();
      if (ctx.state === 'suspended') ctx.resume();
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = type;
      o.frequency.value = freq;
      g.gain.value = vol;
      o.connect(g).connect(ctx.destination);
      o.start();
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + ms / 1000);
      o.stop(ctx.currentTime + ms / 1000 + 0.02);
    } catch { /* звук не обязателен */ }
  }
  // браузеры разрешают звук только после касания
  document.addEventListener('pointerdown', () => { if (!ctx) beep(1, 1, 'sine', 0.0001); }, { once: true });

  const vibrate = (p) => { try { navigator.vibrate && navigator.vibrate(p); } catch { /* нет */ } };

  let toastTimer;
  function toast(text) {
    let el = document.getElementById('toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'toast';
      el.className = 'toast';
      el.setAttribute('role', 'status');
      document.body.appendChild(el);
    }
    el.textContent = text;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, 2500);
  }

  function nameOf(st, id) {
    const p = st.players.find((x) => x.id === id);
    return p ? p.name : '—';
  }

  // табло: темы строками, цены столбцами
  function boardHtml(st, { clickable = false, cats = null } = {}) {
    const cols = Math.max(...st.board.themes.map((t) => t.cells.length), 1);
    return `<div class="board" style="--cols:${cols}">` + st.board.themes.map((t, ti) => `
      <div class="trow">
        <div class="theme">${esc(t.name)}</div>
        ${t.cells.map((c, qi) => {
          const cat = cats && cats[ti] && cats[ti][qi] === 'cat' ? ' cat' : '';
          if (clickable && !c.used) return `<button class="cell${cat}" data-pick="${ti}:${qi}" aria-label="${esc(t.name)} за ${c.price}">${c.price}</button>`;
          return `<div class="cell${c.used ? ' used' : ''}">${c.used ? '' : c.price}</div>`;
        }).join('')}
      </div>`).join('') + '</div>';
  }

  function scoresHtml(st, { me = null } = {}) {
    const sorted = [...st.players].sort((a, b) => b.score - a.score);
    return '<div class="scores">' + sorted.map((p) => `
      <div class="score-row${p.id === me ? ' me' : ''}${p.id === st.answering ? ' answering' : ''}">
        <span class="dot${p.online ? ' on' : ''}" title="${p.online ? 'в сети' : 'не в сети'}"></span>
        <span class="nm">${esc(p.name)}${p.id === me ? ' (вы)' : ''}</span>
        ${p.id === st.chooser && st.phase === 'board' ? '<span class="chip">выбирает</span>' : ''}
        <span class="sc${p.score < 0 ? ' neg' : ''}">${p.score}</span>
      </div>`).join('') + '</div>';
  }

  // полоса таймера: elapsed от start до start+ms
  const ANSWER_MS = 10000;
  function tickTimers() {
    document.querySelectorAll('[data-timer-start]').forEach((el) => {
      const start = Number(el.dataset.timerStart);
      const ms = Number(el.dataset.timerMs) || ANSWER_MS;
      const left = Math.max(0, 1 - (serverNow() - start) / ms);
      const bar = el.querySelector('i');
      if (bar) bar.style.transform = `scaleX(${left})`;
      const sec = el.parentElement && el.parentElement.querySelector('[data-timer-sec]');
      if (sec) sec.textContent = Math.ceil(left * ms / 1000);
    });
    requestAnimationFrame(tickTimers);
  }
  requestAnimationFrame(tickTimers);

  return { connect, post, serverNow, esc, store, playerId, beep, vibrate, toast, nameOf, boardHtml, scoresHtml, ANSWER_MS };
})();
