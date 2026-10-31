// Общие функции для всех экранов.
// Любая ошибка видна на экране, а не превращается в пустую страницу.
window.addEventListener('error', (e) => {
  if (e.target && e.target.tagName && e.target.tagName !== 'SCRIPT') return; // картинки не считаем
  const box = document.createElement('div');
  box.className = 'card';
  box.style.cssText = 'border-color:#ff6b78;color:#ff6b78;margin:12px 0';
  box.textContent = 'Ошибка: ' + (e.message || (e.target && e.target.src) || 'неизвестная') + '. Сделайте скриншот и пришлите.';
  (document.querySelector('.wrap') || document.body).prepend(box);
}, true);
const S = (() => {
  let offset = 0; // разница часов сервера и устройства
  const query = new URLSearchParams(location.search);
  // онлайн-режим: страница открыта не с локального сервера, а из интернета (https)
  const ONLINE = location.protocol === 'https:' || location.protocol === 'file:' || query.has('online');
  const room = () => String(query.get('room') || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
  let transport = null;

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      if (document.querySelector(`script[data-src="${src}"]`)) { resolve(); return; }
      const el = document.createElement('script');
      el.src = src;
      el.dataset.src = src;
      el.onload = resolve;
      el.onerror = () => reject(new Error('Не загрузился ' + src));
      document.head.appendChild(el);
    });
  }

  // params: { role, id?, key? }; extra: { onMessage } для онлайн-режима
  function connect(params, onState, onStatus, extra = {}) {
    if (ONLINE) return connectOnline(params, onState, onStatus, extra);
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

  function connectOnline(params, onState, onStatus, extra) {
    const st = (s) => { offset = s.now - Date.now(); onState(s); };
    const status = (on, msg) => onStatus && onStatus(on, msg);
    const local = params.role === 'host' && !room();
    const ready = loadScript('vendor/paho-mqtt-min.js')
      .then(() => loadScript('online.js'))
      .then(() => (local ? loadScript('engine.js') : null))
      .then(() => {
        transport = local
          ? SvoyakOnline.startHost({ onState: st, onStatus: status, store })
          : SvoyakOnline.connectRemote({ code: room(), hello: () => ({ t: 'hello', ...params }), onState: st, onStatus: status, onMessage: extra.onMessage });
        return transport;
      })
      .catch((e) => status(false, e.message));
    return { close: () => ready.then(() => transport && transport.close()), ready };
  }

  async function post(body) {
    if (ONLINE) {
      if (!transport) throw new Error('Подключаемся…');
      return transport.post(body);
    }
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
          const cat = cats && cats[ti] && cats[ti][qi] ? ' cat' : '';
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

  function mediaUrl(src) {
    if (!src) return '';
    if (/^(https?:)?\/\//.test(src) || src.startsWith('/')) return src;
    return (ONLINE ? '../media/' : '/media/') + src.split('/').map(encodeURIComponent).join('/');
  }
  function imageHtml(q) {
    if (!q) return '';
    return (q.big ? `<div class="q-big">${esc(q.big)}</div>` : '')
      + (q.image ? `<img class="q-img" src="${esc(mediaUrl(q.image))}" alt="">` : '');
  }

  // мелодия нотами: "E5/1 B4/.5 -/.5 …" (нота/длительность в долях, "-" — пауза)
  let melodyStop = null;
  function playMelody(str, bpm = 120) {
    stopMelody();
    try {
      ctx = ctx || new (window.AudioContext || window.webkitAudioContext)();
      if (ctx.state === 'suspended') ctx.resume();
    } catch { return; }
    const beat = 60 / (Number(bpm) || 120);
    const SEMI = { C: -9, D: -7, E: -5, F: -4, G: -2, A: 0, B: 2 };
    const master = ctx.createGain();
    master.gain.value = 0.18;
    master.connect(ctx.destination);
    let t = ctx.currentTime + 0.08;
    for (const tok of String(str).trim().split(/\s+/)) {
      const [n, d] = tok.split('/');
      const dur = (Number(d) || 1) * beat;
      const m = /^([A-G])(#|b)?(\d)$/.exec(n);
      if (m) {
        const semis = SEMI[m[1]] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0) + (Number(m[3]) - 4) * 12;
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.type = 'triangle';
        o.frequency.value = 440 * Math.pow(2, semis / 12);
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(1, t + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, t + Math.max(0.08, dur * 0.92));
        o.connect(g).connect(master);
        o.start(t);
        o.stop(t + dur);
      }
      t += dur;
    }
    melodyStop = () => { try { master.disconnect(); } catch { /* уже */ } };
  }
  function stopMelody() { if (melodyStop) { melodyStop(); melodyStop = null; } }

  // QR-код ссылки (svg), если библиотека загружена
  async function qrSvg(text, cell = 5) {
    try {
      await loadScript('vendor/qrcode.js');
      const qr = qrcode(0, 'M');
      qr.addData(text);
      qr.make();
      return qr.createSvgTag({ cellSize: cell, margin: 2, scalable: true });
    } catch { return ''; }
  }

  // особые вопросы: название и правило
  const SPECIAL = {
    cat: { label: 'Кот в мешке', rule: 'Кнопки нет: выбравший передаёт вопрос другому игроку.' },
    norisk: { label: 'Без риска', rule: 'Кто первым нажмёт — отвечает. Верно — вдвое больше, ошибка без минуса.' },
    auction: { label: 'Ставка', rule: 'Кто первым нажмёт — ставит от цены вопроса до всего счёта и отвечает.' },
    plusminus: { label: 'Плюс на минус', rule: 'Кто первым нажмёт — у того счёт меняет знак: +300 станет −300, а −300 станет +300.' },
    gift: { label: 'Попроси баллы', rule: 'Кто первым нажмёт — просит у ведущего баллы. Сколько дать, решает ведущий.' },
    approx: { label: 'Отвечай приблизительно', rule: 'Кто первым нажмёт — отвечает. Засчитывается и примерный ответ.' },
  };
  function specialHtml(q) {
    const s = q && SPECIAL[q.type];
    return s ? `<div class="special"><span class="tag">${s.label}</span><span>${s.rule}</span></div>` : '';
  }

  const VERSION = '16 · без ставки, новый «Плюс на минус»';
  return { VERSION, playMelody, stopMelody, SPECIAL, specialHtml, ONLINE, room, qrSvg, transport: () => transport, mediaUrl, imageHtml, connect, post, serverNow, esc, store, playerId, beep, vibrate, toast, nameOf, boardHtml, scoresHtml, ANSWER_MS };
})();
