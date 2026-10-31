// Свояк — игра-викторина по локальной сети.
// Запуск: node server.js   (нужен только Node.js 18+, без npm install)

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const PORT = Number(process.env.PORT) || 3000;
const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
const DATA_DIR = path.join(ROOT, 'data');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const DEFAULT_PACK = path.join(ROOT, 'questions.json');
const FALSE_START_MS = 1000;

// ---------- состояние ----------

function freshGame(pack, pin) {
  return {
    pin,
    pack,
    phase: 'lobby', // lobby | board | question | reveal | final-bets | final-question | final-reveal | end
    round: 0,
    used: {},
    players: {},
    order: [],
    chooser: null,
    q: null,
    buzzOpen: false,
    buzzOpenedAt: 0,
    answering: null,
    answeringAt: 0,
    wrong: [],
    final: { bets: {}, answers: {}, judged: {} },
    log: [],
  };
}

function loadPack(file) {
  return validatePack(JSON.parse(fs.readFileSync(file, 'utf8')));
}

function validatePack(p) {
  if (!p || !Array.isArray(p.rounds) || p.rounds.length === 0) throw new Error('В пакете нет раундов (rounds)');
  p.rounds.forEach((r, ri) => {
    if (!Array.isArray(r.themes) || !r.themes.length) throw new Error(`Раунд ${ri + 1}: нет тем`);
    r.name = r.name || `Раунд ${ri + 1}`;
    r.themes.forEach((t, ti) => {
      if (!Array.isArray(t.questions)) throw new Error(`Раунд ${ri + 1}, тема ${ti + 1}: нет вопросов`);
      t.name = t.name || `Тема ${ti + 1}`;
      t.questions.forEach((q) => {
        q.price = Number(q.price) || 0;
        q.text = String(q.text || '');
        q.answer = String(q.answer || '');
        q.type = q.type === 'cat' ? 'cat' : 'normal';
      });
    });
  });
  if (p.final && !p.final.text) delete p.final;
  p.title = p.title || 'Свояк';
  return p;
}

let game;
try {
  game = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  if (!game.pack || !game.pin) throw new Error('bad state');
  console.log('Продолжаем сохранённую игру (data/state.json).');
} catch {
  const pin = process.env.HOST_PIN || String(crypto.randomInt(1000, 10000));
  game = freshGame(loadPack(DEFAULT_PACK), pin);
}
if (process.env.HOST_PIN) game.pin = process.env.HOST_PIN;
const lockout = {}; // id -> время, до которого игрок заблокирован за фальстарт

let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(STATE_FILE, JSON.stringify(game));
    } catch (e) {
      console.error('Не удалось сохранить игру:', e.message);
    }
  }, 200);
}

function log(text) {
  game.log.unshift({ at: Date.now(), text });
  game.log.length = Math.min(game.log.length, 30);
}

const name = (id) => (game.players[id] ? game.players[id].name : '—');
const curRound = () => game.pack.rounds[game.round];
const qKey = (r, t, i) => `${r}:${t}:${i}`;

function roundLeft() {
  const r = curRound();
  let left = 0;
  r.themes.forEach((t, ti) => t.questions.forEach((_, qi) => { if (!game.used[qKey(game.round, ti, qi)]) left++; }));
  return left;
}

function lowestScorer() {
  const ids = game.order.filter((id) => game.players[id]);
  if (!ids.length) return null;
  return ids.reduce((a, b) => (game.players[b].score < game.players[a].score ? b : a));
}

function eligibleToBuzz() {
  return game.order.filter((id) => game.players[id] && !game.wrong.includes(id));
}

function finalists() {
  return game.order.filter((id) => game.players[id] && game.players[id].score > 0);
}

// ---------- действия ----------

const hostActions = {
  start() {
    if (!game.order.length) throw new Error('Пока нет ни одного игрока');
    game.phase = 'board';
    game.round = 0;
    game.chooser = game.order[crypto.randomInt(game.order.length)];
    log(`Игра началась. Первым выбирает ${name(game.chooser)}`);
  },
  pick({ t, i }) {
    if (game.phase !== 'board') throw new Error('Сейчас нельзя выбрать вопрос');
    const theme = curRound().themes[t];
    const q = theme && theme.questions[i];
    if (!q) throw new Error('Нет такого вопроса');
    if (game.used[qKey(game.round, t, i)]) throw new Error('Вопрос уже сыгран');
    game.used[qKey(game.round, t, i)] = true;
    game.q = { t, i, theme: theme.name, price: q.price, text: q.text, answer: q.answer, type: q.type };
    game.phase = 'question';
    game.buzzOpen = false;
    game.answering = null;
    game.wrong = [];
    log(`${theme.name} за ${q.price}${q.type === 'cat' ? ' — кот в мешке' : ''}`);
  },
  openBuzz() {
    if (game.phase !== 'question' || game.answering) return;
    game.buzzOpen = true;
    game.buzzOpenedAt = Date.now();
  },
  closeBuzz() {
    game.buzzOpen = false;
  },
  assign({ player }) {
    if (game.phase !== 'question') throw new Error('Сейчас нет вопроса');
    if (!game.players[player]) throw new Error('Нет такого игрока');
    game.buzzOpen = false;
    game.answering = player;
    game.answeringAt = Date.now();
    log(`Отвечает ${name(player)}`);
  },
  correct() {
    if (game.phase !== 'question' || !game.answering) return;
    const id = game.answering;
    game.players[id].score += game.q.price;
    game.chooser = id;
    log(`${name(id)} отвечает верно: +${game.q.price}`);
    game.answering = null;
    game.buzzOpen = false;
    game.phase = 'reveal';
  },
  wrong() {
    if (game.phase !== 'question' || !game.answering) return;
    const id = game.answering;
    game.players[id].score -= game.q.price;
    game.wrong.push(id);
    log(`${name(id)} ошибается: −${game.q.price}`);
    game.answering = null;
    if (game.q.type !== 'cat' && eligibleToBuzz().length) {
      game.buzzOpen = true; // остальные могут попробовать
      game.buzzOpenedAt = Date.now();
    } else {
      game.buzzOpen = false;
      game.phase = 'reveal';
    }
  },
  reveal() {
    if (game.phase !== 'question') return;
    game.buzzOpen = false;
    game.answering = null;
    game.phase = 'reveal';
    log('Никто не ответил');
  },
  toBoard() {
    if (game.phase === 'question' || game.phase === 'reveal') {
      game.phase = 'board';
      game.q = null;
      game.buzzOpen = false;
      game.answering = null;
    }
  },
  chooser({ player }) {
    if (game.players[player]) game.chooser = player;
  },
  score({ player, delta, value }) {
    const p = game.players[player];
    if (!p) throw new Error('Нет такого игрока');
    if (typeof value === 'number' && Number.isFinite(value)) p.score = Math.round(value);
    else p.score += Math.round(Number(delta) || 0);
    log(`Счёт ${p.name}: ${p.score}`);
  },
  kick({ player }) {
    if (!game.players[player]) return;
    log(`${name(player)} удалён из игры`);
    delete game.players[player];
    game.order = game.order.filter((id) => id !== player);
    if (game.answering === player) game.answering = null;
    if (game.chooser === player) game.chooser = lowestScorer();
  },
  goRound({ round }) {
    if (!game.pack.rounds[round]) throw new Error('Нет такого раунда');
    game.round = round;
    game.phase = 'board';
    game.q = null;
    game.buzzOpen = false;
    game.answering = null;
    game.chooser = lowestScorer();
    log(`${curRound().name}. Выбирает ${name(game.chooser)}`);
  },
  finalStart() {
    if (!game.pack.final) throw new Error('В пакете нет финала');
    game.final = { bets: {}, answers: {}, judged: {} };
    game.q = null;
    game.buzzOpen = false;
    game.answering = null;
    if (!finalists().length) {
      game.phase = 'end';
      log('В финал никто не прошёл: у всех счёт 0 или меньше');
      return;
    }
    game.phase = 'final-bets';
    log(`Финал: ${game.pack.final.theme || ''}`);
  },
  finalQuestion() {
    if (game.phase !== 'final-bets') return;
    game.phase = 'final-question';
  },
  finalReveal() {
    if (game.phase !== 'final-question') return;
    game.phase = 'final-reveal';
  },
  finalJudge({ player, ok }) {
    if (game.phase !== 'final-reveal' || !game.players[player]) return;
    if (player in game.final.judged) return;
    const bet = game.final.bets[player] || 0;
    game.final.judged[player] = !!ok;
    game.players[player].score += ok ? bet : -bet;
    log(`Финал: ${name(player)} ${ok ? '+' : '−'}${bet}`);
  },
  end() {
    game.phase = 'end';
    game.buzzOpen = false;
    game.answering = null;
  },
  newGame() {
    const keepPlayers = game.order.map((id) => ({ id, name: game.players[id].name }));
    game = freshGame(game.pack, game.pin);
    keepPlayers.forEach(({ id, name: n }) => { game.players[id] = { name: n, score: 0 }; game.order.push(id); });
    log('Новая игра');
  },
  loadPack({ pack }) {
    const p = validatePack(pack);
    const keepPlayers = game.order.map((id) => ({ id, name: game.players[id].name }));
    game = freshGame(p, game.pin);
    keepPlayers.forEach(({ id, name: n }) => { game.players[id] = { name: n, score: 0 }; game.order.push(id); });
    log(`Загружен пакет «${p.title}»`);
  },
};

const playerActions = {
  join(id, { name: n }) {
    const clean = String(n || '').replace(/\s+/g, ' ').trim().slice(0, 20);
    if (!clean) throw new Error('Введите имя');
    if (game.players[id]) {
      game.players[id].name = clean;
    } else {
      game.players[id] = { name: clean, score: 0 };
      game.order.push(id);
      log(`${clean} в игре`);
    }
  },
  buzz(id) {
    if (!game.players[id]) throw new Error('Сначала войдите в игру');
    if (game.phase !== 'question' || game.answering || game.q.type === 'cat') return { ignored: true };
    if (game.wrong.includes(id)) return { ignored: true };
    const now = Date.now();
    if (!game.buzzOpen) {
      lockout[id] = now + FALSE_START_MS;
      return { early: true, lockMs: FALSE_START_MS };
    }
    if ((lockout[id] || 0) > now) return { locked: true, lockMs: lockout[id] - now };
    game.buzzOpen = false;
    game.answering = id;
    game.answeringAt = now;
    log(`Первым нажал ${name(id)}`);
    return { first: true };
  },
  bet(id, { amount }) {
    if (game.phase !== 'final-bets') throw new Error('Ставки сейчас не принимаются');
    const p = game.players[id];
    if (!p || p.score <= 0) throw new Error('Вы не участвуете в финале');
    const a = Math.round(Number(amount));
    if (!(a >= 1 && a <= p.score)) throw new Error(`Ставка от 1 до ${p.score}`);
    game.final.bets[id] = a;
  },
  answer(id, { text }) {
    if (game.phase !== 'final-question') throw new Error('Ответы сейчас не принимаются');
    if (!(id in game.final.bets)) throw new Error('Вы не сделали ставку');
    game.final.answers[id] = String(text || '').trim().slice(0, 200);
  },
};

// ---------- что видит каждый ----------

function publicBoard() {
  const r = curRound();
  return {
    name: r.name,
    index: game.round,
    total: game.pack.rounds.length,
    themes: r.themes.map((t, ti) => ({
      name: t.name,
      cells: t.questions.map((q, qi) => ({ price: q.price, used: !!game.used[qKey(game.round, ti, qi)] })),
    })),
  };
}

function view(role, id) {
  const isHost = role === 'host';
  const players = game.order
    .filter((pid) => game.players[pid])
    .map((pid) => ({ id: pid, name: game.players[pid].name, score: game.players[pid].score, online: isOnline(pid) }));

  const v = {
    now: Date.now(),
    title: game.pack.title,
    phase: game.phase,
    players,
    chooser: game.chooser,
    board: publicBoard(),
    rounds: game.pack.rounds.map((r) => r.name),
    hasFinal: !!game.pack.final,
    roundLeft: roundLeft(),
    buzzOpen: game.buzzOpen,
    buzzOpenedAt: game.buzzOpenedAt,
    answering: game.answering,
    answeringAt: game.answeringAt,
    wrong: game.wrong,
  };

  if (game.q) {
    v.q = { t: game.q.t, i: game.q.i, theme: game.q.theme, price: game.q.price, type: game.q.type, text: game.q.text };
    if (isHost || game.phase === 'reveal') v.q.answer = game.q.answer;
  }

  if (game.phase.startsWith('final') && game.pack.final) {
    const f = game.pack.final;
    const fin = finalists();
    v.final = {
      theme: f.theme || 'Финал',
      players: fin.map((pid) => {
        const row = {
          id: pid,
          hasBet: pid in game.final.bets,
          hasAnswer: pid in game.final.answers,
        };
        const judged = pid in game.final.judged;
        if (isHost || pid === id || judged) {
          row.bet = game.final.bets[pid];
          row.answer = game.final.answers[pid];
        }
        if (judged) row.ok = game.final.judged[pid];
        return row;
      }),
    };
    if (game.phase !== 'final-bets') v.final.text = f.text;
    if (isHost || Object.keys(game.final.judged).length === fin.length) v.final.answer = f.answer;
  }

  if (isHost) {
    v.pin = game.pin;
    v.log = game.log.slice(0, 12);
    v.urls = lanUrls();
    v.answersPreview = curRound().themes.map((t) => t.questions.map((q) => (q.type === 'cat' ? 'cat' : '')));
  }
  if (role === 'player') v.me = id;
  return v;
}

// ---------- SSE ----------

const clients = new Set();

function isOnline(pid) {
  for (const c of clients) if (c.role === 'player' && c.id === pid) return true;
  return false;
}

function send(c) {
  c.res.write(`data: ${JSON.stringify(view(c.role, c.id))}\n\n`);
}

function broadcast() {
  for (const c of clients) {
    try { send(c); } catch { /* клиент отвалился */ }
  }
  save();
}

setInterval(() => {
  for (const c of clients) {
    try { c.res.write(': ping\n\n'); } catch { /* ignore */ }
  }
}, 15000);

// ---------- HTTP ----------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const ROUTES = { '/': 'index.html', '/host': 'host.html', '/play': 'play.html', '/screen': 'screen.html' };

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 2_000_000) { reject(new Error('Слишком большой запрос')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');

  if (url.pathname === '/events') {
    const role = url.searchParams.get('role');
    const id = url.searchParams.get('id') || '';
    if (role === 'host' && url.searchParams.get('key') !== game.pin) return json(res, 403, { error: 'Неверный PIN' });
    if (!['host', 'player', 'screen'].includes(role)) return json(res, 400, { error: 'role?' });
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 1500\n\n');
    const c = { res, role, id };
    clients.add(c);
    if (role === 'player') broadcast(); else send(c);
    req.on('close', () => {
      clients.delete(c);
      if (role === 'player') broadcast();
    });
    return;
  }

  if (url.pathname === '/api' && req.method === 'POST') {
    try {
      const body = JSON.parse(await readBody(req));
      let result = {};
      if (body.role === 'host') {
        if (body.key !== game.pin) return json(res, 403, { error: 'Неверный PIN' });
        if (body.type === 'check') return json(res, 200, { ok: true });
        const fn = hostActions[body.type];
        if (!fn) throw new Error('Неизвестное действие');
        result = fn(body) || {};
      } else {
        const id = String(body.id || '');
        if (!/^[a-zA-Z0-9_-]{6,40}$/.test(id)) throw new Error('Неверный id игрока');
        const fn = playerActions[body.type];
        if (!fn) throw new Error('Неизвестное действие');
        result = fn(id, body) || {};
      }
      broadcast();
      return json(res, 200, { ok: true, ...result });
    } catch (e) {
      return json(res, 400, { error: e.message });
    }
  }

  // статика
  let file = ROUTES[url.pathname] || url.pathname.slice(1);
  const full = path.normalize(path.join(PUBLIC, file));
  if (!full.startsWith(PUBLIC + path.sep)) { res.writeHead(403); return res.end(); }
  fs.readFile(full, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Не найдено'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
});

function lanUrls() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family === 'IPv4' && !a.internal) out.push(`http://${a.address}:${PORT}`);
    }
  }
  return out.length ? out : [`http://localhost:${PORT}`];
}

server.listen(PORT, '0.0.0.0', () => {
  const urls = lanUrls();
  console.log('\n  СВОЯК запущен!\n');
  console.log('  Игроки открывают на телефонах:');
  urls.forEach((u) => console.log(`    ${u}/play`));
  console.log('\n  Ведущий:');
  urls.forEach((u) => console.log(`    ${u}/host`));
  console.log(`\n  PIN ведущего: ${game.pin}`);
  console.log('\n  Большой экран (ТВ / ноутбук):');
  urls.forEach((u) => console.log(`    ${u}/screen`));
  console.log('\n  Остановить: Ctrl+C\n');
});
