// Онлайн-режим: игра живёт в браузере ведущего, остальные подключаются к нему
// через интернет по коду комнаты (PeerJS: бесплатный сервер связи + прямое WebRTC-соединение).
const SvoyakOnline = (() => {
  const PREFIX = 'svoyak-v1-';
  const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const query = new URLSearchParams(location.search);

  function peerOptions() {
    const o = { debug: 1 };
    const custom = query.get('peer'); // только для проверки со своим сервером: ?peer=localhost:9000
    if (custom) {
      const [host, port] = custom.split(':');
      Object.assign(o, { host, port: Number(port) || 9000, path: '/', secure: false });
    }
    return o;
  }

  const newCode = () => Array.from({ length: 4 }, () => ALPHABET[Math.floor(Math.random() * ALPHABET.length)]).join('');
  const normCode = (c) => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);

  function link(page, code) {
    const u = new URL(page, location.href);
    u.search = '';
    u.hash = '';
    if (code) u.searchParams.set('room', code);
    if (query.get('peer')) u.searchParams.set('peer', query.get('peer'));
    if (query.has('online')) u.searchParams.set('online', '');
    return u.href;
  }

  async function fetchJson(url) {
    const r = await fetch(url, { cache: 'no-cache' });
    if (!r.ok) throw new Error('Не удалось загрузить ' + url);
    return r.json();
  }

  // ---------- ведущий: держит игру ----------
  function startHost({ onState, onStatus, store }) {
    let saved = null;
    try { saved = JSON.parse(store('svoyak.online.game') || 'null'); } catch { saved = null; }
    let code = normCode(store('svoyak.online.code')) || newCode();
    store('svoyak.online.code', code);

    const conns = new Map(); // соединение -> { role, id }
    let packs = [{ file: 'svoi.json', title: 'Для своих' }, { file: 'classic.json', title: 'Свояк' }];
    let engine = null;
    let peer = null;
    let ready = false;
    let idTries = 0;

    const hooks = {
      isOnline: (pid) => [...conns.values()].some((c) => c.role === 'player' && c.id === pid),
      screens: () => [...conns.values()].filter((c) => c.role === 'screen').length,
      urls: () => [],
      packs: () => packs,
      loadPackFile: () => { throw new Error('Пакет ещё не загружен'); },
    };

    function hostView() {
      const v = engine.view('host');
      v.online = { code, play: link('play.html', code), screen: link('screen.html', code), host: link('host.html', code), cheat: link('cheat.html', code), connected: ready };
      return v;
    }

    function broadcast() {
      if (!engine) return;
      for (const [conn, c] of conns) {
        try { conn.send({ t: 'state', v: c.role === 'host' ? hostView() : engine.view(c.role, c.id) }); } catch { /* отвалился */ }
      }
      onState(hostView());
      try { store('svoyak.online.game', JSON.stringify(engine.state)); } catch { /* память переполнена */ }
    }

    async function run(body) {
      if (body.role === 'host' && body.type === 'usePack') {
        if (!packs.some((p) => p.file === body.file)) throw new Error('Нет такого пакета');
        body = { role: 'host', key: engine.pin, type: 'loadPack', pack: await fetchJson('../packs/' + encodeURIComponent(body.file)) };
      }
      const r = engine.handle(body);
      broadcast();
      return r;
    }

    function onMsg(conn, msg) {
      if (!msg || typeof msg !== 'object' || !engine) return;
      if (msg.t === 'hello') {
        const role = msg.role;
        if (!['player', 'screen', 'host'].includes(role)) return;
        if (role === 'host' && msg.key !== engine.pin) { conn.send({ t: 'denied', error: 'Неверный PIN' }); return; }
        conns.set(conn, { role, id: role === 'player' ? String(msg.id || '') : '' });
        broadcast();
        return;
      }
      if (msg.t === 'cheat') {
        conn.send(msg.key === engine.pin ? { t: 'cheat', pack: engine.state.pack } : { t: 'denied', error: 'Неверный PIN' });
        return;
      }
      if (msg.t === 'act') {
        const c = conns.get(conn);
        if (!c || c.role === 'screen') return;
        const body = { ...(msg.body || {}) };
        if (c.role === 'player') { body.role = 'player'; body.id = c.id; } else { body.role = 'host'; body.key = engine.pin; }
        run(body)
          .then((res) => conn.send({ t: 'res', rid: msg.rid, ok: true, ...res }))
          .catch((e) => conn.send({ t: 'res', rid: msg.rid, error: e.message }));
      }
    }

    function openPeer() {
      peer = new Peer(PREFIX + code, peerOptions());
      peer.on('open', () => { ready = true; idTries = 0; onStatus(true); broadcast(); });
      peer.on('connection', (conn) => {
        conn.on('data', (msg) => onMsg(conn, msg));
        const drop = () => { if (conns.delete(conn)) broadcast(); };
        conn.on('close', drop);
        conn.on('error', drop);
      });
      peer.on('disconnected', () => {
        ready = false;
        onStatus(false);
        broadcast();
        setTimeout(() => { try { if (!peer.destroyed && peer.disconnected) peer.reconnect(); } catch { /* попробуем позже */ } }, 1500);
      });
      peer.on('error', (err) => {
        if (err.type === 'unavailable-id') {
          // после перезагрузки страницы старое подключение держится ещё несколько секунд
          ready = false;
          onStatus(false);
          peer.destroy();
          if (++idTries > 10) { code = newCode(); store('svoyak.online.code', code); idTries = 0; }
          setTimeout(openPeer, 3000);
          broadcast();
          return;
        }
        if (['network', 'server-error', 'socket-error', 'socket-closed'].includes(err.type)) {
          ready = false;
          onStatus(false);
          broadcast();
          setTimeout(() => {
            if (peer.destroyed) openPeer();
            else if (peer.disconnected) { try { peer.reconnect(); } catch { /* ещё раз позже */ } }
          }, 3000);
        }
      });
    }

    // iPhone усыпляет вкладку в фоне: вернувшись, переподключаемся сразу
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible' || !peer) return;
      if (peer.destroyed) openPeer();
      else if (peer.disconnected) { try { peer.reconnect(); } catch { /* событие disconnected повторит */ } }
    });

    (async () => {
      try { packs = await fetchJson('../packs/index.json'); } catch { /* остаётся список по умолчанию */ }
      let pack = null;
      if (!saved) pack = await fetchJson('../packs/' + encodeURIComponent(packs[0].file));
      engine = SvoyakEngine.createEngine({ game: saved, pack, pin: saved ? saved.pin : String(1000 + Math.floor(Math.random() * 9000)), hooks });
      broadcast();
      openPeer();
    })().catch((e) => onStatus(false, e.message));

    return {
      post(body) {
        if (!engine) return Promise.reject(new Error('Игра ещё загружается'));
        return run({ ...body, role: 'host', key: engine.pin });
      },
      newRoom() {
        code = newCode();
        store('svoyak.online.code', code);
        if (peer) peer.destroy();
        conns.clear();
        ready = false;
        openPeer();
        broadcast();
      },
      close() { if (peer) peer.destroy(); },
    };
  }

  // ---------- игрок, большой экран, второй пульт: подключаются к ведущему ----------
  function connectRemote({ code, hello, onState, onStatus, onMessage }) {
    let peer = null;
    let conn = null;
    let rid = 0;
    let retryTimer = null;
    const pending = new Map();

    function schedule(ms) {
      clearTimeout(retryTimer);
      retryTimer = setTimeout(connectConn, ms);
    }

    function startPeer() {
      peer = new Peer(peerOptions());
      peer.on('open', () => connectConn());
      peer.on('disconnected', () => {
        setTimeout(() => { try { if (!peer.destroyed && peer.disconnected) peer.reconnect(); } catch { /* позже */ } }, 1500);
      });
      peer.on('error', (err) => {
        if (err.type === 'peer-unavailable') {
          onStatus(false, `Комната ${code} не найдена. Проверьте код и что у ведущего открыта игра.`);
          schedule(3000);
          return;
        }
        onStatus(false, 'Нет связи, переподключаемся…');
        if (peer.destroyed) setTimeout(startPeer, 3000);
        else schedule(3000);
      });
    }

    function connectConn() {
      if (!peer || peer.destroyed) { startPeer(); return; }
      if (peer.disconnected) { try { peer.reconnect(); } catch { /* ждём */ } schedule(2000); return; }
      if (!peer.open) { schedule(1000); return; }
      if (conn) { try { conn.close(); } catch { /* уже закрыто */ } }
      const c = peer.connect(PREFIX + code, { reliable: true });
      conn = c;
      let opened = false;
      const guard = setTimeout(() => { if (!opened && conn === c) schedule(0); }, 12000);
      c.on('open', () => {
        opened = true;
        clearTimeout(guard);
        c.send(hello());
        onStatus(true);
      });
      c.on('data', (msg) => {
        if (conn !== c || !msg) return;
        if (msg.t === 'state') onState(msg.v);
        else if (msg.t === 'res') {
          const p = pending.get(msg.rid);
          if (!p) return;
          pending.delete(msg.rid);
          clearTimeout(p.timer);
          if (msg.error) p.reject(new Error(msg.error)); else p.resolve(msg);
        } else if (onMessage) onMessage(msg);
      });
      const lost = () => {
        if (conn !== c) return;
        onStatus(false, 'Связь с ведущим потеряна, переподключаемся…');
        schedule(2000);
      };
      c.on('close', lost);
      c.on('error', lost);
    }

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && (!conn || !conn.open)) schedule(0);
    });

    startPeer();

    return {
      post(body) {
        return new Promise((resolve, reject) => {
          if (!conn || !conn.open) { reject(new Error('Нет связи с ведущим')); return; }
          const id = ++rid;
          const timer = setTimeout(() => { pending.delete(id); reject(new Error('Ведущий не ответил')); }, 8000);
          pending.set(id, { resolve, reject, timer });
          conn.send({ t: 'act', rid: id, body });
        });
      },
      send(msg) { if (conn && conn.open) conn.send(msg); },
      close() { clearTimeout(retryTimer); if (peer) peer.destroy(); },
    };
  }

  return { startHost, connectRemote, normCode, link };
})();
