// Онлайн-режим: игра живёт в браузере ведущего, остальные подключаются к нему через интернет
// по коду комнаты. Сообщения идут через публичные MQTT-серверы (сразу через несколько, чтобы
// сработал хоть один), поэтому прямое соединение между телефонами не нужно.
const SvoyakOnline = (() => {
  const query = new URLSearchParams(location.search);
  const NS = 'svoyak-game-v2';
  const BROKERS = query.get('mqtt')
    ? [query.get('mqtt')] // только для проверки со своим сервером: ?mqtt=ws://127.0.0.1:8888/mqtt
    : ['wss://broker.emqx.io:8084/mqtt', 'wss://broker.hivemq.com:8884/mqtt', 'wss://test.mosquitto.org:8081/mqtt'];
  const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

  const rnd = (n) => Array.from({ length: n }, () => ALPHABET[Math.floor(Math.random() * ALPHABET.length)]).join('');
  const newCode = () => rnd(4);
  const normCode = (c) => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
  const upTopic = (code) => `${NS}/${code}/up`;
  const downTopic = (code, cid) => `${NS}/${code}/d/${cid}`;

  function link(page, code) {
    const u = new URL(page, location.href);
    u.search = '';
    u.hash = '';
    if (code) u.searchParams.set('room', code);
    if (query.get('mqtt')) u.searchParams.set('mqtt', query.get('mqtt'));
    if (query.has('online')) u.searchParams.set('online', '');
    return u.href;
  }

  async function fetchJson(url) {
    const r = await fetch(url, { cache: 'no-cache' });
    if (!r.ok) throw new Error('Не удалось загрузить ' + url);
    return r.json();
  }

  // Одно подключение к MQTT-серверу, которое само переподключается.
  function Link(url, { onMessage, onUp, onDown, will }) {
    let client = null;
    let alive = false;
    let stopped = false;
    let timer = null;
    const subs = new Set();

    function retry(ms) {
      clearTimeout(timer);
      if (!stopped) timer = setTimeout(open, ms);
    }

    function open() {
      clearTimeout(timer);
      try { if (client) client.disconnect(); } catch { /* уже закрыт */ }
      try {
        client = new Paho.Client(url, 'sv' + rnd(12));
      } catch { retry(5000); return; }
      const c = client;
      c.onConnectionLost = () => {
        if (c !== client) return;
        alive = false;
        onDown && onDown();
        retry(2500);
      };
      c.onMessageArrived = (m) => {
        let d;
        try { d = JSON.parse(m.payloadString); } catch { return; }
        if (d && typeof d === 'object') onMessage(m.destinationName, d);
      };
      const opts = {
        useSSL: url.startsWith('wss'),
        timeout: 8,
        keepAliveInterval: 20,
        cleanSession: true,
        onSuccess: () => {
          if (c !== client) return;
          alive = true;
          subs.forEach((t) => c.subscribe(t, { qos: 0 }));
          onUp && onUp();
        },
        onFailure: () => {
          if (c !== client) return;
          alive = false;
          onDown && onDown();
          retry(3000);
        },
      };
      if (will) {
        const w = new Paho.Message(JSON.stringify(will.data));
        w.destinationName = will.topic;
        w.qos = 0;
        opts.willMessage = w;
      }
      try { c.connect(opts); } catch { retry(3000); }
    }

    open();
    return {
      get alive() { return alive; },
      url,
      sub(t) {
        subs.add(t);
        if (alive) { try { client.subscribe(t, { qos: 0 }); } catch { /* после переподключения */ } }
      },
      pub(t, data) {
        if (!alive) return false;
        try {
          const m = new Paho.Message(JSON.stringify(data));
          m.destinationName = t;
          m.qos = 0;
          client.send(m);
          return true;
        } catch { return false; }
      },
      kick() { if (!alive && !stopped) open(); },
      close() {
        stopped = true;
        clearTimeout(timer);
        try { client.disconnect(); } catch { /* уже закрыт */ }
      },
    };
  }

  // ---------- ведущий: держит игру ----------
  function startHost({ onState, onStatus, store }) {
    let saved = null;
    try { saved = JSON.parse(store('svoyak.online.game') || 'null'); } catch { saved = null; }
    let code = normCode(store('svoyak.online.code')) || newCode();
    store('svoyak.online.code', code);

    const conns = new Map(); // "сервер|cid" -> { bi, cid, role, id, seen }
    let packs = [{ file: 'svoi.json', title: 'Для своих' }, { file: 'classic.json', title: 'Свояк' }];
    let engine = null;
    let links = [];

    let mixPacks = [];
    const packByFile = async (file) => (file === SvoyakEngine.MIX_FILE
      ? SvoyakEngine.buildMix(mixPacks)
      : fetchJson('../packs/' + encodeURIComponent(file)));

    const hooks = {
      mixPacks: () => mixPacks,
      isOnline: (pid) => [...conns.values()].some((c) => c.role === 'player' && c.id === pid),
      screens: () => new Set([...conns.values()].filter((c) => c.role === 'screen').map((c) => c.cid)).size,
      urls: () => [],
      packs: () => packs,
      loadPackFile: () => { throw new Error('Пакет ещё не загружен'); },
    };

    const aliveCount = () => links.filter((l) => l.alive).length;

    function hostView() {
      const v = engine.view('host');
      v.online = {
        code,
        play: link('play.html', code),
        screen: link('screen.html', code),
        host: link('host.html', code),
        cheat: link('cheat.html', code),
        connected: aliveCount() > 0,
        servers: `${aliveCount()} из ${links.length}`,
      };
      return v;
    }

    function sendTo(c, msg) {
      const l = links[c.bi];
      if (l) l.pub(downTopic(code, c.cid), msg);
    }

    function broadcast() {
      if (!engine) return;
      for (const c of conns.values()) sendTo(c, { t: 'state', v: c.role === 'host' ? hostView() : engine.view(c.role, c.id) });
      onState(hostView());
      try { store('svoyak.online.game', JSON.stringify(engine.state)); } catch { /* память переполнена */ }
    }

    async function run(body) {
      if (body.role === 'host' && body.type === 'usePack') {
        if (!packs.some((p) => p.file === body.file)) throw new Error('Нет такого пакета');
        body = { role: 'host', key: engine.pin, type: 'loadPack', pack: await packByFile(body.file) };
      }
      const r = engine.handle(body);
      broadcast();
      return r;
    }

    function onMsg(bi, d) {
      if (!engine) return;
      const cid = String(d.cid || '');
      if (!/^[A-Za-z0-9_-]{4,40}$/.test(cid)) return;
      const k = bi + '|' + cid;
      const reply = (msg) => links[bi].pub(downTopic(code, cid), msg);

      if (d.t === 'hello') {
        if (!['player', 'screen', 'host'].includes(d.role)) return;
        if (d.role === 'host' && d.key !== engine.pin) { reply({ t: 'denied', error: 'Неверный PIN' }); return; }
        const id = d.role === 'player' ? String(d.id || '') : '';
        if (d.role === 'player' && !/^[A-Za-z0-9_-]{6,40}$/.test(id)) return;
        conns.set(k, { bi, cid, role: d.role, id, seen: Date.now() });
        broadcast();
        return;
      }
      if (d.t === 'cheat') {
        reply(d.key === engine.pin ? { t: 'cheat', pack: engine.state.pack } : { t: 'denied', error: 'Неверный PIN' });
        return;
      }
      const c = conns.get(k);
      if (d.t === 'bye') { if (conns.delete(k)) broadcast(); return; }
      if (!c) { if (d.t === 'ping' || d.t === 'act') reply({ t: 'rehello' }); return; }
      c.seen = Date.now();
      if (d.t === 'act') {
        if (c.role === 'screen') return;
        const body = { ...(d.body || {}) };
        if (c.role === 'player') { body.role = 'player'; body.id = c.id; } else { body.role = 'host'; body.key = engine.pin; }
        run(body)
          .then((res) => reply({ t: 'res', rid: d.rid, ok: true, ...res }))
          .catch((e) => reply({ t: 'res', rid: d.rid, error: e.message }));
      }
    }

    function openLinks() {
      links.forEach((l) => l.close());
      conns.clear();
      links = BROKERS.map((url, bi) => {
        const l = Link(url, {
          onMessage: (t, d) => onMsg(bi, d),
          onUp: () => { onStatus(true); broadcast(); },
          onDown: () => { if (!aliveCount()) onStatus(false); broadcast(); },
        });
        l.sub(upTopic(code));
        return l;
      });
    }

    // раз в несколько секунд: убираем пропавших и повторяем состояние (сообщения могут теряться)
    setInterval(() => {
      if (!engine) return;
      const now = Date.now();
      for (const [k, c] of conns) if (now - c.seen > 16000) conns.delete(k);
      broadcast();
    }, 6000);

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') links.forEach((l) => l.kick());
    });

    (async () => {
      try { packs = await fetchJson('../packs/index.json'); } catch { /* остаётся список по умолчанию */ }
      mixPacks = (await Promise.all(packs.filter((p) => p.mix).map((p) => fetchJson('../packs/' + encodeURIComponent(p.file)).catch(() => null)))).filter(Boolean);
      let pack = null;
      if (!saved) pack = await packByFile(packs[0].file);
      engine = SvoyakEngine.createEngine({ game: saved, pack, pin: saved ? saved.pin : String(1000 + Math.floor(Math.random() * 9000)), hooks });
      openLinks();
      broadcast();
    })().catch((e) => onStatus(false, e.message));

    return {
      post(body) {
        if (!engine) return Promise.reject(new Error('Игра ещё загружается'));
        return run({ ...body, role: 'host', key: engine.pin });
      },
      newRoom() {
        code = newCode();
        store('svoyak.online.code', code);
        openLinks();
        broadcast();
      },
      close() { links.forEach((l) => l.close()); },
    };
  }

  // ---------- игрок, большой экран, второй пульт, шпаргалка ----------
  function connectRemote({ code, hello, onState, onStatus, onMessage }) {
    const h0 = hello();
    const cid = h0.role === 'player' && h0.id ? String(h0.id).slice(0, 40) : 'c' + rnd(12);
    let chosen = -1; // номер сервера, через который отвечает ведущий
    let lastFromHost = 0;
    let rid = 0;
    const pending = new Map();
    const started = Date.now();

    const sayHello = (l) => l.pub(upTopic(code), { cid, ...hello() });

    const links = BROKERS.map((url, bi) => {
      const l = Link(url, {
        will: { topic: upTopic(code), data: { cid, t: 'bye' } },
        onUp: () => { if (chosen < 0 || chosen === bi) sayHello(l); },
        onDown: () => {
          if (chosen === bi) { chosen = -1; onStatus(false, 'Связь прервалась, переподключаемся…'); }
        },
        onMessage: (t, msg) => {
          if (chosen >= 0 && chosen !== bi) return;
          if (msg.t === 'state') {
            if (chosen < 0) chosen = bi;
            lastFromHost = Date.now();
            onStatus(true);
            onState(msg.v);
          } else if (msg.t === 'rehello') {
            sayHello(l);
          } else if (msg.t === 'res') {
            lastFromHost = Date.now();
            const p = pending.get(msg.rid);
            if (!p) return;
            pending.delete(msg.rid);
            clearTimeout(p.timer);
            if (msg.error) p.reject(new Error(msg.error)); else p.resolve(msg);
          } else if (onMessage) onMessage(msg);
        },
      });
      l.sub(downTopic(code, cid));
      return l;
    });

    // пока ведущий не ответил — повторяем приветствие; потом — пинг, чтобы он видел нас в сети
    const tick = setInterval(() => {
      const now = Date.now();
      if (chosen >= 0 && links[chosen].alive) {
        links[chosen].pub(upTopic(code), { cid, t: 'ping' });
        if (now - lastFromHost > 20000) {
          chosen = -1;
          onStatus(false, 'Ведущий пропал из сети. Ждём, когда он вернётся…');
        }
        return;
      }
      const alive = links.filter((l) => l.alive);
      alive.forEach(sayHello);
      if (now - started < 6000) return;
      if (!alive.length) onStatus(false, 'Не удаётся связаться с сервером связи. Попробуйте другой интернет (мобильный или Wi‑Fi) или VPN.');
      else onStatus(false, `Ищем ведущего комнаты ${code}… Проверьте код и что пульт ведущего открыт.`);
    }, 3000);

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible') return;
      links.forEach((l) => l.kick());
      links.filter((l) => l.alive).forEach(sayHello);
    });

    onStatus(false, 'Подключаемся к серверу связи…');

    return {
      post(body) {
        return new Promise((resolve, reject) => {
          const l = links[chosen];
          if (!l || !l.alive) { reject(new Error('Нет связи с ведущим')); return; }
          const id = ++rid;
          const timer = setTimeout(() => { pending.delete(id); reject(new Error('Ведущий не ответил, попробуйте ещё раз')); }, 8000);
          pending.set(id, { resolve, reject, timer });
          l.pub(upTopic(code), { cid, t: 'act', rid: id, body });
        });
      },
      send(msg) {
        const targets = chosen >= 0 ? [links[chosen]] : links;
        targets.forEach((l) => l.pub(upTopic(code), { cid, ...msg }));
      },
      close() {
        clearInterval(tick);
        links.forEach((l) => { l.pub(upTopic(code), { cid, t: 'bye' }); l.close(); });
      },
    };
  }

  return { startHost, connectRemote, normCode, link };
})();
