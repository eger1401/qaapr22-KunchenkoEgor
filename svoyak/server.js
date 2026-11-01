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
const PACKS_DIR = path.join(ROOT, 'packs');
const MEDIA_DIR = path.join(ROOT, 'media');

let engineRef = null; // движок игры, когда уже создан

function readIndex() {
  try { return JSON.parse(fs.readFileSync(path.join(PACKS_DIR, 'index.json'), 'utf8')); } catch { return null; }
}

// пакеты, из которых собирается «Случайный микс» (в index.json помечены "mix": true)
function mixPacks() {
  return (readIndex() || []).filter((p) => p.mix).map((p) => {
    try { return JSON.parse(fs.readFileSync(path.join(PACKS_DIR, path.basename(p.file)), 'utf8')); } catch { return null; }
  }).filter(Boolean);
}

function packByFile(file) {
  const history = engineRef ? engineRef.state.themeHistory || [] : [];
  if (file === MIX_FILE) return buildMix(mixPacks(), history);
  if (file === MIX18_FILE) return buildMix(mixPacks(), history, { adult: ADULT_QUOTA });
  return JSON.parse(fs.readFileSync(path.join(PACKS_DIR, path.basename(file)), 'utf8'));
}

function listPacks() {
  const index = readIndex();
  if (index) return index.filter((p) => p.file === MIX_FILE || p.file === MIX18_FILE || fs.existsSync(path.join(PACKS_DIR, path.basename(p.file)))).map(({ file, title, hidden }) => ({ file, title, hidden }));
  let files = [];
  try { files = fs.readdirSync(PACKS_DIR).filter((f) => f.endsWith('.json') && f !== 'index.json').sort(); } catch { /* нет папки */ }
  return files.map((file) => {
    try { return { file, title: JSON.parse(fs.readFileSync(path.join(PACKS_DIR, file), 'utf8')).title || file }; }
    catch { return { file, title: file + ' (ошибка в файле)' }; }
  });
}

function defaultPackFile() {
  const files = listPacks().map((p) => p.file);
  const wanted = process.env.PACK && (process.env.PACK.endsWith('.json') ? process.env.PACK : process.env.PACK + '.json');
  if (wanted && files.includes(wanted)) return wanted;
  if (wanted === 'random.json') return MIX_FILE;
  if (!files.length) throw new Error('В папке packs нет ни одного пакета вопросов');
  return files[0];
}

// ---------- состояние ----------

const { createEngine, validatePack, buildMix, MIX_FILE, MIX18_FILE, ADULT_QUOTA } = require('./public/engine.js');

function loadPack(file) {
  return validatePack(JSON.parse(fs.readFileSync(file, 'utf8')));
}

let saved = null;
try {
  saved = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  if (!saved.pack || !saved.pin) throw new Error('bad state');
  console.log('Продолжаем сохранённую игру (data/state.json).');
} catch { saved = null; }

const engine = createEngine({
  game: saved,
  pack: saved ? null : validatePack(packByFile(defaultPackFile())),
  pin: process.env.HOST_PIN || String(crypto.randomInt(1000, 10000)),
  hooks: {
    isOnline: (pid) => isOnline(pid),
    screens: () => [...clients].filter((c) => c.role === 'screen').length,
    urls: () => lanUrls(),
    packs: () => listPacks(),
    loadPackFile: (file) => packByFile(file),
    changed: () => broadcast(),
    mixPacks: () => mixPacks(),
  },
});
engineRef = engine;
if (process.env.HOST_PIN) engine.pin = process.env.HOST_PIN;

let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(STATE_FILE, JSON.stringify(engine.state));
    } catch (e) {
      console.error('Не удалось сохранить игру:', e.message);
    }
  }, 200);
}

// ---------- SSE ----------

const clients = new Set();

function isOnline(pid) {
  for (const c of clients) if (c.role === 'player' && c.id === pid) return true;
  return false;
}

function send(c) {
  c.res.write(`data: ${JSON.stringify(engine.view(c.role, c.id))}\n\n`);
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

const ROUTES = { '/': 'index.html', '/host': 'host.html', '/play': 'play.html', '/screen': 'screen.html', '/cheat': 'cheat.html' };
const MEDIA_TYPES = {
  '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.aac': 'audio/aac',
  '.svg': 'image/svg+xml',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp',
};

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
    if (role === 'host' && url.searchParams.get('key') !== engine.pin) return json(res, 403, { error: 'Неверный PIN' });
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
    if (role === 'host') send(c); else broadcast();
    req.on('close', () => {
      clients.delete(c);
      if (role !== 'host') broadcast();
    });
    return;
  }

  // картинки, которые ведущий добавил из галереи
  if (url.pathname.startsWith('/img/')) {
    const data = engine.image(url.pathname.slice(5));
    const m = /^data:(image\/[a-z]+);base64,(.+)$/.exec(data || '');
    if (!m) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': m[1], 'Cache-Control': 'max-age=3600' });
    return res.end(Buffer.from(m[2], 'base64'));
  }

  if (url.pathname === '/cheat.json') {
    if (url.searchParams.get('key') !== engine.pin) return json(res, 403, { error: 'Неверный PIN' });
    return json(res, 200, engine.state.pack);
  }

  if (url.pathname.startsWith('/media/')) {
    const full = path.normalize(path.join(MEDIA_DIR, decodeURIComponent(url.pathname.slice(7))));
    if (!full.startsWith(MEDIA_DIR + path.sep)) { res.writeHead(403); return res.end(); }
    return fs.stat(full, (err, stat) => {
      if (err || !stat.isFile()) { res.writeHead(404); return res.end(); }
      const type = MEDIA_TYPES[path.extname(full).toLowerCase()] || 'application/octet-stream';
      const range = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
      if (range) {
        const start = range[1] ? Number(range[1]) : 0;
        const end = range[2] ? Math.min(Number(range[2]), stat.size - 1) : stat.size - 1;
        res.writeHead(206, { 'Content-Type': type, 'Content-Range': `bytes ${start}-${end}/${stat.size}`, 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1 });
        return fs.createReadStream(full, { start, end }).pipe(res);
      }
      res.writeHead(200, { 'Content-Type': type, 'Content-Length': stat.size, 'Accept-Ranges': 'bytes' });
      fs.createReadStream(full).pipe(res);
    });
  }

  if (url.pathname === '/api' && req.method === 'POST') {
    try {
      const body = JSON.parse(await readBody(req));
      if (body.role === 'host' && body.type === 'usePack' && body.key === engine.pin && !listPacks().some((p) => p.file === body.file)) {
        throw new Error('Нет такого пакета');
      }
      const result = engine.handle(body);
      broadcast();
      return json(res, 200, { ok: true, ...result });
    } catch (e) {
      return json(res, e.code === 403 ? 403 : 400, { error: e.message });
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
  console.log(`\n  PIN ведущего: ${engine.pin}`);
  console.log('\n  Большой экран (ТВ / ноутбук):');
  urls.forEach((u) => console.log(`    ${u}/screen`));
  console.log('\n  Остановить: Ctrl+C\n');
});
