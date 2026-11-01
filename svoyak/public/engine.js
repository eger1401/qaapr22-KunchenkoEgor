// Логика игры. Работает и на сервере (node server.js), и прямо в браузере ведущего (онлайн-режим).
(function (root) {
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
      bonus: makeBonuses(pack),
      final: { bets: {}, answers: {}, judged: {} },
      log: [],
    };
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
          q.type = TYPE_ALIASES[q.type] || (TYPES.includes(q.type) ? q.type : 'normal');
          if (q.image) q.image = String(q.image);
          if (q.audio) q.audio = String(q.audio);
          if (q.melody) q.melody = String(q.melody);
          if (q.big) q.big = String(q.big);
          if (q.video && q.video.id) q.video = { id: String(q.video.id), start: Math.max(0, Number(q.video.start) || 0), end: Number(q.video.end) || 0 };
          else delete q.video;
        });
      });
    });
    if (p.final && !p.final.text) delete p.final;
    p.title = p.title || 'Свояк';
    return p;
  }

  // особые вопросы: cat — кот в мешке (передать другому), norisk — без риска (×2, без минуса),
  // auction — ставка выбравшего, plusminus — плюс на минус (жмут все, ошибка не отнимает очки)
  // gift — «попроси баллы у ведущего», approx — «отвечай приблизительно»
  const TYPES = ['normal', 'cat', 'norisk', 'auction', 'plusminus', 'gift', 'approx', 'plus', 'luck'];
  // мелкие бонусы: plus — первый нажавший получает +N, luck — выбравший получает +N просто так
  const SMALL_POOL = ['plus', 'luck'];
  const SMALL_AMOUNTS = [50, 100, 150, 200, 300];
  const BONUS_POOL = ['gift', 'approx', 'norisk', 'plusminus', 'cat'];
  const BONUS_LABELS = { cat: 'кот в мешке', norisk: 'без риска', auction: 'ставка', plusminus: 'плюс на минус', gift: 'попроси баллы', approx: 'отвечай приблизительно', plus: 'быстрые баллы', luck: 'удача' };

  // бонусы выпадают на случайные вопросы: в каждом раунде каждый вид хотя бы раз
  // бонусы: 1–2 на раунд, виды не повторяются между раундами (пока хватает видов)
  function makeBonuses(pack) {
    const map = {};
    const shuffle = (a) => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
    let deck = [];
    const draw = (avoid) => {
      if (!deck.length) deck = shuffle(BONUS_POOL.slice());
      let k = deck.findIndex((t) => !avoid.includes(t));
      if (k < 0) k = 0;
      return deck.splice(k, 1)[0];
    };
    pack.rounds.forEach((r, ri) => {
      const cells = [];
      r.themes.forEach((t, ti) => t.questions.forEach((_, qi) => cells.push(`${ri}:${ti}:${qi}`)));
      shuffle(cells);
      const n = Math.min(cells.length, 1 + Math.floor(Math.random() * 2));
      const inRound = [];
      for (let k = 0; k < n; k++) { const t = draw(inRound); inRound.push(t); map[cells[k]] = t; }
      // плюс 1–2 мелких бонуса: «тип:сумма»
      const small = Math.min(cells.length - n, 1 + Math.floor(Math.random() * 2));
      for (let k = 0; k < small; k++) {
        const t = SMALL_POOL[Math.floor(Math.random() * SMALL_POOL.length)];
        map[cells[n + k]] = `${t}:${SMALL_AMOUNTS[Math.floor(Math.random() * SMALL_AMOUNTS.length)]}`;
      }
    });
    return map;
  }
  const TYPE_ALIASES = { stake: 'auction', bet: 'auction', 'no-risk': 'norisk' };

  // сколько получит за верный ответ и потеряет за неверный
  function points(q) {
    if (q.type === 'norisk') return { win: q.price * 2, lose: 0 };
    if (q.type === 'auction') { const s = q.stake || q.price; return { win: s, lose: s }; }
    return { win: q.price, lose: q.price };
  }

  const randInt = (n) => Math.floor(Math.random() * n);
  const shuffled = (arr) => { const a = arr.slice(); for (let i = a.length - 1; i > 0; i--) { const j = randInt(i + 1); [a[i], a[j]] = [a[j], a[i]]; } return a; };

  // «Случайный микс»: каждую игру — новые 15 тем из всех лёгких пакетов, цены по раундам
  const MIX_FILE = '@random';
  const MIX18_FILE = '@random18';
  const ADULT_QUOTA = 5;
  // history — уже сыгранные темы (их id); пока есть несыгранные, повторов нет
  // opts.adult — сколько тем брать из взрослых пакетов ("adult": true) в первую очередь
  function buildMix(packs, history = [], opts = {}) {
    const all = [];
    packs.forEach((p) => (p.rounds || []).forEach((r) => r.themes.forEach((t) => {
      if (t.questions.length >= 5) all.push({ id: t.name, t, adult: !!p.adult }); // одинаковые названия считаем одной темой
    })));
    const used = new Set(history);
    const qKeyOf = (q) => 'q:' + String(q.text).toLowerCase().replace(/[^a-zа-яёіїєґ0-9]/gi, '').slice(0, 60);
    const names = new Set(); // в одной игре — без одинаковых названий тем
    const qs = new Set(); // и без одинаковых вопросов
    const chosen = [];
    const take = (list, strict) => {
      for (const x of list) {
        if (chosen.length >= 15) break;
        if (names.has(x.t.name)) continue;
        const keys = x.t.questions.slice(0, 5).map(qKeyOf);
        if (keys.some((k) => qs.has(k) || (strict && used.has(k)))) continue; // вопрос уже был
        names.add(x.t.name);
        keys.forEach((k) => qs.add(k));
        chosen.push(x);
      }
    };
    // свои темы ведущего — в первую очередь, пока не сыграны
    if (opts.custom && opts.custom.length) {
      take(shuffled(opts.custom.filter((t) => t.questions.length && !used.has('custom:' + t.name)).map((t) => ({ id: 'custom:' + t.name, t }))), true);
    }
    if (opts.adult) {
      const adult = all.filter((x) => x.adult);
      const quota = shuffled(adult.filter((x) => !used.has(x.id))).concat(shuffled(adult.filter((x) => used.has(x.id)))).slice(0, opts.adult);
      take(quota, true);
    }
    take(shuffled(all.filter((x) => !used.has(x.id))), true);
    const historyReset = chosen.length < 15; // всё сыграно — начинаем новый круг
    if (historyReset) take(shuffled(all), false);
    chosen.splice(0, chosen.length, ...shuffled(chosen)); // взрослые темы — по разным раундам
    const roundNames = ['Первый раунд', 'Второй раунд', 'Третий раунд'];
    const rounds = Math.max(1, Math.min(3, Math.floor(chosen.length / 5)));
    const mix = { title: opts.adult ? 'Случайный микс 18+' : 'Случайный микс', mix: true, adult: !!opts.adult, rounds: [], ids: [], historyReset };
    for (let r = 0; r < rounds; r++) {
      const part = chosen.slice(r * 5, r * 5 + 5);
      mix.ids.push(...part.map((x) => x.id));
      part.forEach((x) => x.t.questions.slice(0, 5).forEach((q) => mix.ids.push(qKeyOf(q))));
      mix.rounds.push({
        name: roundNames[r],
        themes: part.map(({ t }) => ({
          name: t.name,
          questions: t.questions.slice(0, 5).map((q, j) => ({ ...q, type: 'normal', price: (r + 1) * 100 * (j + 1) })),
        })),
      });
    }
    // финал: до 20 тем на выбор, сначала те, что ещё не играли
    const seenF = new Set();
    const finals = [];
    const hasPool = packs.some((p) => p.finals && p.finals.length);
    packs.forEach((p) => (hasPool ? p.finals || [] : [p.final]).forEach((f) => { // есть пул финалов — берём только из него
      if (f && f.text && f.theme && !seenF.has(f.theme)) { seenF.add(f.theme); finals.push(f); }
    }));
    const freshF = shuffled(finals.filter((f) => !used.has('final:' + f.theme)));
    const oldF = shuffled(finals.filter((f) => used.has('final:' + f.theme)));
    mix.finals = freshF.concat(oldF).slice(0, 20).map((f) => ({ theme: f.theme, text: f.text, answer: f.answer }));
    if (mix.finals.length === 1) mix.final = mix.finals[0];
    return validatePack(JSON.parse(JSON.stringify(mix)));
  }
  const FALSE_START_MS = 1000;
  const BUZZ_WINDOW = 450; // мс: сколько ждём других нажатий после первого

  // hooks: isOnline(id), screens(), urls(), packs(), loadPackFile(file)
  function createEngine({ game: saved, pack, pin, hooks }) {
    let game = saved || freshGame(validatePack(pack), pin);
    if (!game.bonus) game.bonus = makeBonuses(game.pack); // игра, сохранённая до появления случайных бонусов
    const lockout = {}; // id -> время, до которого игрок заблокирован за фальстарт
    let pendingBuzz = null; // нажатия, которые ещё собираются
    const changed = () => { if (hooks.changed) hooks.changed(); };

    function resolveBuzz() {
      const pb = pendingBuzz;
      pendingBuzz = null;
      if (!pb || !pb.presses.length || game.phase !== 'question' || game.answering || !game.buzzOpen) return;
      const live = pb.presses.filter((p) => game.players[p.id] && !game.wrong.includes(p.id));
      if (!live.length) return;
      live.sort((a, b) => a.rt - b.rt || a.at - b.at);
      grantBuzz(live[0].id);
      changed();
    }

    function grantBuzz(id) {
      game.buzzOpen = false;
      const p = game.players[id];
      if (game.q.type === 'auction' && !game.q.stake) {
        game.q.staker = id;
        log(`Первым нажал ${p.name} — делает ставку`);
        return;
      }
      if (game.q.type === 'plusminus') {
        const before = p.score;
        p.score = -before;
        game.q.answer = `${p.name}: ${before} → ${p.score}`;
        game.phase = 'reveal';
        log(`Плюс на минус: ${p.name} ${before} → ${p.score}`);
        return;
      }
      if (game.q.type === 'plus') {
        p.score += game.q.amount || 100;
        game.q.answer = `${p.name} получает +${game.q.amount || 100}`;
        game.phase = 'reveal';
        log(`Быстрые баллы: ${p.name} +${game.q.amount || 100}`);
        return;
      }
      game.answering = id;
      game.answeringAt = Date.now();
      log(`Первым нажал ${p.name}`);
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

    // ставка на вопрос «Ставка»: от цены вопроса до всего счёта (ва-банк)
    function stakeRange(id) {
      const score = game.players[id] ? game.players[id].score : 0;
      return { min: game.q.price, max: Math.max(score, game.q.price) };
    }
    function setStake(id, amount) {
      if (game.phase !== 'question' || !game.q || game.q.type !== 'auction') throw new Error('Сейчас ставки нет');
      if (game.q.stake) throw new Error('Ставка уже сделана');
      if (!id || !game.players[id]) throw new Error('Сначала выберите, кто делает ставку');
      const { min, max } = stakeRange(id);
      const a = Math.round(Number(amount));
      if (!(a >= min && a <= max)) throw new Error(`Ставка от ${min} до ${max}`);
      game.q.stake = a;
      game.answering = id;
      game.answeringAt = Date.now();
      log(`${name(id)} ставит ${a}`);
    }

    // убрать тему финала; by — игрок (должен быть его ход) или null — ведущий
    function removeFinalTheme(index, by) {
      if (game.phase !== 'final-select') throw new Error('Сейчас не выбираем тему финала');
      const options = game.pack.finals;
      const i = Number(index);
      if (!options[i] || game.final.removed.includes(i)) throw new Error('Эта тема уже убрана');
      const order = game.final.order.filter((pid) => game.players[pid]);
      const current = order.length ? order[game.final.turn % order.length] : null;
      if (by && by !== current) throw new Error('Сейчас убирает другой игрок');
      game.final.removed.push(i);
      game.final.turn += 1;
      const left = options.map((_, k) => k).filter((k) => !game.final.removed.includes(k));
      if (left.length === 1) {
        game.pack.final = options[left[0]];
        game.themeHistory = (game.themeHistory || []).concat('final:' + game.pack.final.theme);
        game.phase = 'final-bets';
        log(`Финал: осталась тема «${game.pack.final.theme}»`);
      }
    }

    // ---------- действия ----------

    const hostActions = {
      start() {
        if (!game.order.length) throw new Error('Пока нет ни одного игрока');
        // каждая игра — новые случайные темы, которые ещё не играли (если ведущий не выбрал конкретный пакет)
        const mixPacks = hooks.mixPacks ? hooks.mixPacks() : [];
        if (!game.fixed && mixPacks.length) {
          const history = game.themeHistory || [];
          const pack = buildMix(mixPacks, history, { adult: game.pack.adult ? ADULT_QUOTA : 0, custom: game.custom || [] });
          game.pack = pack;
          game.themeHistory = pack.historyReset ? pack.ids.slice() : history.concat(pack.ids);
          game.bonus = makeBonuses(pack);
          game.used = {};
          game.final = { bets: {}, answers: {}, judged: {} };
        }
        game.phase = 'board';
        game.round = 0;
        game.chooser = game.order[randInt(game.order.length)];
        log(`Игра началась. Первым выбирает ${name(game.chooser)}`);
      },
      pick({ t, i }) {
        if (game.phase !== 'board') throw new Error('Сейчас нельзя выбрать вопрос');
        const theme = curRound().themes[t];
        const q = theme && theme.questions[i];
        if (!q) throw new Error('Нет такого вопроса');
        if (game.used[qKey(game.round, t, i)]) throw new Error('Вопрос уже сыгран');
        game.used[qKey(game.round, t, i)] = true;
        const [type, amt] = String(game.bonus[qKey(game.round, t, i)] || 'normal').split(':');
        game.q = { t, i, theme: theme.name, price: q.price, text: q.text, answer: q.answer, type, image: q.image, audio: q.audio, melody: q.melody, bpm: q.bpm, big: q.big, video: q.video };
        if (amt) game.q.amount = Number(amt);
        if (type === 'gift' || type === 'plusminus' || type === 'plus' || type === 'luck') {
          // карточка-бонус вместо вопроса
          const text = {
            gift: 'Бонус! Жми кнопку быстрее всех.',
            plusminus: 'Бонус! Кто первым нажмёт кнопку — у того счёт поменяет знак.',
            plus: `Бонус! Кто первым нажмёт кнопку — получит +${amt}.`,
            luck: 'Удача!',
          }[type];
          Object.assign(game.q, { text, answer: '', image: undefined, audio: undefined, melody: undefined, big: undefined, video: undefined });
        }
        game.media = null;
        game.phase = 'question';
        game.answering = null;
        game.wrong = [];
        // кнопка у игроков активна сразу; бонус достаётся тому, кто нажал первым. Кот в мешке — без кнопки
        game.buzzOpen = type !== 'cat' && type !== 'luck';
        game.buzzOpenedAt = Date.now();
        pendingBuzz = null;
        if (type === 'auction') { game.q.stake = null; game.q.staker = null; }
        log(`${theme.name} за ${q.price}${BONUS_LABELS[type] ? ' — ' + BONUS_LABELS[type] : ''}`);
        if (type === 'luck') {
          // «Удача»: выбравший сразу получает баллы
          const p = game.players[game.chooser];
          if (p) {
            p.score += game.q.amount || 100;
            game.q.answer = `${p.name} получает +${game.q.amount || 100} просто так`;
          } else game.q.answer = 'Удача досталась никому';
          game.phase = 'reveal';
        }
      },
      openBuzz() {
        if (game.phase !== 'question' || game.answering) return;
        pendingBuzz = null;
        game.buzzOpen = true;
        game.buzzOpenedAt = Date.now();
      },
      playMedia({ part } = {}) {
        if (!game.q || !(game.q.audio || game.q.melody || game.q.video)) return;
        game.media = { nonce: Date.now(), playing: true, part: part === 'rest' ? 'rest' : 'clip' };
      },
      stopMedia() {
        game.media = { nonce: Date.now(), playing: false };
      },
      closeBuzz() {
        game.buzzOpen = false;
      },
      assign({ player }) {
        if (game.phase !== 'question') throw new Error('Сейчас нет вопроса');
        if (!game.players[player]) throw new Error('Нет такого игрока');
        game.buzzOpen = false;
        if (game.q.type === 'auction' && !game.q.stake) {
          game.q.staker = player; // ставку делает этот игрок, отвечает он же
          log(`Ставку делает ${name(player)}`);
          return;
        }
        game.answering = player;
        game.answeringAt = Date.now();
        log(`Отвечает ${name(player)}`);
      },
      stake({ amount }) {
        setStake(game.q && game.q.staker, amount);
      },
      gift({ amount }) {
        if (game.phase !== 'question' || !game.q || game.q.type !== 'gift' || !game.answering) return;
        const a = Math.max(0, Math.round(Number(amount) || 0));
        const id = game.answering;
        game.players[id].score += a;
        game.q.gift = { to: id, amount: a };
        game.q.answer = a ? `${name(id)} получает +${a}` : `${name(id)} остаётся без подарка`;
        log(`Подарок: ${name(id)} +${a}`);
        game.answering = null;
        game.buzzOpen = false;
        game.phase = 'reveal';
      },
      correct() {
        if (game.phase !== 'question' || !game.answering || game.q.type === 'gift') return;
        const id = game.answering;
        const { win } = points(game.q);
        game.players[id].score += win;
        game.chooser = id;
        log(`${name(id)} отвечает верно: +${win}`);
        game.answering = null;
        game.buzzOpen = false;
        game.phase = 'reveal';
      },
      wrong() {
        if (game.phase !== 'question' || !game.answering || game.q.type === 'gift') return;
        const id = game.answering;
        const { lose } = points(game.q);
        game.players[id].score -= lose;
        game.wrong.push(id);
        log(`${name(id)} ошибается${lose ? ': −' + lose : ', без минуса'}`);
        game.answering = null;
        if (['normal', 'approx'].includes(game.q.type) && eligibleToBuzz().length) {
          game.buzzOpen = true; // остальные могут попробовать
          game.buzzOpenedAt = Date.now();
          pendingBuzz = null;
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
        const options = game.pack.finals && game.pack.finals.length > 1 ? game.pack.finals : null;
        if (!game.pack.final && !options) throw new Error('В пакете нет финала');
        game.final = { bets: {}, answers: {}, judged: {} };
        game.q = null;
        game.buzzOpen = false;
        game.answering = null;
        if (!finalists().length) {
          game.phase = 'end';
          log('В финал никто не прошёл: у всех счёт 0 или меньше');
          return;
        }
        if (options) {
          // финалисты по очереди убирают темы, начиная с того, у кого меньше очков
          game.pack.final = null;
          game.final.removed = [];
          game.final.order = finalists().slice().sort((a, b) => game.players[a].score - game.players[b].score);
          game.final.turn = 0;
          game.phase = 'final-select';
          log(`Финал: выбираем тему из ${options.length}`);
          return;
        }
        game.phase = 'final-bets';
        log(`Финал: ${game.pack.final.theme || ''}`);
      },
      removeFinal({ index }) {
        removeFinalTheme(index, null);
      },
      // свои темы ведущего: картинки по ссылке и клипы YouTube
      customSave({ theme }) {
        const name = String((theme && theme.name) || '').trim().slice(0, 40);
        if (!name) throw new Error('Введите название темы');
        const questions = ((theme && theme.questions) || []).map((q) => {
          const out = { text: String(q.text || '').trim().slice(0, 300), answer: String(q.answer || '').trim().slice(0, 200) };
          if (/^https?:\/\/\S+$/i.test(String(q.image || '').trim())) out.image = String(q.image).trim().slice(0, 500);
          if (q.video && /^[A-Za-z0-9_-]{11}$/.test(String(q.video.id || ''))) {
            out.video = { id: q.video.id, start: Math.max(0, Number(q.video.start) || 0), end: Math.max(0, Number(q.video.end) || 0) };
          }
          return out;
        }).filter((q) => (q.text || q.image || q.video) && q.answer).slice(0, 5);
        if (!questions.length) throw new Error('Нужен хотя бы один вопрос с ответом');
        game.custom = (game.custom || []).filter((t) => t.name !== name).concat({ name, questions });
        // заново сохранённая тема снова считается несыгранной
        game.themeHistory = (game.themeHistory || []).filter((h) => h !== 'custom:' + name);
        log(`Своя тема «${name}» сохранена`);
      },
      customDelete({ name }) {
        game.custom = (game.custom || []).filter((t) => t.name !== name);
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
        // новые темы соберутся при «Начать игру»
        const keep = { fixed: game.fixed, history: game.themeHistory || [], custom: game.custom || [] };
        game = freshGame(game.pack, game.pin);
        game.fixed = keep.fixed;
        game.themeHistory = keep.history;
        game.custom = keep.custom;
        keepPlayers.forEach(({ id, name: n }) => { game.players[id] = { name: n, score: 0 }; game.order.push(id); });
        log('Новая игра');
      },
      usePack({ file }) {
        hostActions.loadPack({ pack: hooks.loadPackFile(file) });
      },
      loadPack({ pack }) {
        const p = validatePack(pack);
        const keepPlayers = game.order.map((id) => ({ id, name: game.players[id].name }));
        const history = game.themeHistory || [];
        const custom = game.custom || [];
        game = freshGame(p, game.pin);
        game.themeHistory = history;
        game.custom = custom;
        game.fixed = !p.mix; // выбран конкретный пакет — темы не перемешиваем
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
      // нажатия собираются BUZZ_WINDOW мс, побеждает самая быстрая реакция (rt — мс с момента,
      // как кнопка загорелась у игрока), чтобы медленный интернет не мешал
      buzz(id, { rt } = {}) {
        if (!game.players[id]) throw new Error('Сначала войдите в игру');
        if (game.phase !== 'question' || game.answering || game.q.type === 'cat' || game.q.type === 'luck') return { ignored: true };
        if (game.q.type === 'auction' && game.q.staker) return { ignored: true };
        if (game.wrong.includes(id)) return { ignored: true };
        const now = Date.now();
        if (!game.buzzOpen) {
          lockout[id] = now + FALSE_START_MS;
          return { early: true, lockMs: FALSE_START_MS };
        }
        if ((lockout[id] || 0) > now) return { locked: true, lockMs: lockout[id] - now };
        const reaction = Math.min(Math.max(0, Number(rt) || 0), 60000);
        if (!pendingBuzz) {
          pendingBuzz = { presses: [] };
          setTimeout(resolveBuzz, BUZZ_WINDOW);
        }
        if (!pendingBuzz.presses.some((p) => p.id === id)) pendingBuzz.presses.push({ id, rt: reaction, at: now });
        return { pending: true };
      },
      stake(id, { amount }) {
        if (!game.q || game.q.staker !== id) throw new Error('Ставку делает другой игрок');
        setStake(id, amount);
      },
      removeFinal(id, { index }) {
        if (!game.final.order || !game.final.order.includes(id)) throw new Error('Вы не в финале');
        removeFinalTheme(index, id);
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
        if (id in game.final.answers) throw new Error('Ответ уже принят — изменить нельзя');
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
        .map((pid) => ({ id: pid, name: game.players[pid].name, score: game.players[pid].score, online: hooks.isOnline(pid) }));

      const v = {
        now: Date.now(),
        title: game.pack.title,
        phase: game.phase,
        players,
        chooser: game.chooser,
        board: publicBoard(),
        rounds: game.pack.rounds.map((r) => r.name),
        hasFinal: !!(game.pack.final || (game.pack.finals && game.pack.finals.length)),
        roundLeft: roundLeft(),
        buzzOpen: game.buzzOpen,
        buzzOpenedAt: game.buzzOpenedAt,
        answering: game.answering,
        answeringAt: game.answeringAt,
        wrong: game.wrong,
      };

      if (game.q) {
        v.q = { t: game.q.t, i: game.q.i, theme: game.q.theme, price: game.q.price, type: game.q.type, text: game.q.text, image: game.q.image, audio: game.q.audio, melody: game.q.melody, bpm: game.q.bpm, big: game.q.big, video: game.q.video, amount: game.q.amount };
        v.media = game.media || null;
        Object.assign(v.q, points(game.q));
        if (game.q.type === 'auction') {
          v.q.stake = game.q.stake || null;
          v.q.staker = game.q.staker || null;
          if (game.q.staker) v.q.stakeRange = stakeRange(game.q.staker);
        }
        if (isHost || game.phase === 'reveal') v.q.answer = game.q.answer;
        // бонус скрыт от игроков, пока кто-нибудь не нажмёт кнопку (или ведущий не передаст вопрос)
        const opened = !!game.answering || game.phase === 'reveal' || game.wrong.length > 0;
        v.q.bonusOpened = opened;
        // кот в мешке: все знают, что вопрос передают, но сам вопрос виден только после передачи
        const catHidden = game.q.type === 'cat' && !game.answering && game.phase === 'question';
        v.q.catHidden = catHidden;
        if (!isHost && catHidden) {
          v.q.text = 'Вопрос появится, когда его передадут.';
          delete v.q.image;
          delete v.q.big;
        }
        if (!isHost && game.q.type !== 'normal' && game.q.type !== 'cat' && !opened) {
          v.q.type = 'bonus';
          if (['gift', 'plusminus', 'plus'].includes(game.q.type)) v.q.text = 'Бонус! Жми кнопку быстрее всех.';
          delete v.q.amount;
          delete v.q.win;
          delete v.q.lose;
        }
      }

      if (game.phase === 'final-select' && game.pack.finals) {
        const order = game.final.order.filter((pid) => game.players[pid]);
        v.finalSelect = {
          options: game.pack.finals.map((f, i) => ({ i, theme: f.theme, removed: game.final.removed.includes(i) })),
          turn: order.length ? order[game.final.turn % order.length] : null,
          order,
        };
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
        v.custom = (game.custom || []).map((t) => ({ ...t, played: (game.themeHistory || []).includes('custom:' + t.name) }));
        v.packs = hooks.packs().filter((p) => !p.hidden);
        v.screens = hooks.screens();
        v.log = game.log.slice(0, 12);
        v.urls = hooks.urls();
        v.answersPreview = curRound().themes.map((t, ti) => t.questions.map((q, qi) => String(game.bonus[qKey(game.round, ti, qi)] || '').split(':')[0]));
      }
      if (role === 'player') v.me = id;
      return v;
    }

    // одно действие от ведущего или игрока; ошибка доступа помечается code = 403
    function handle(body) {
      if (body.role === 'host') {
        if (body.key !== game.pin) { const err = new Error('Неверный PIN'); err.code = 403; throw err; }
        if (body.type === 'check') return {};
        const fn = Object.prototype.hasOwnProperty.call(hostActions, body.type) && hostActions[body.type];
        if (!fn) throw new Error('Неизвестное действие');
        return fn(body) || {};
      }
      const id = String(body.id || '');
      if (!/^[a-zA-Z0-9_-]{6,40}$/.test(id)) throw new Error('Неверный id игрока');
      const fn = Object.prototype.hasOwnProperty.call(playerActions, body.type) && playerActions[body.type];
      if (!fn) throw new Error('Неизвестное действие');
      return fn(id, body) || {};
    }

    return {
      handle,
      view,
      get state() { return game; },
      get pin() { return game.pin; },
      set pin(p) { game.pin = p; },
    };
  }

  const api = { createEngine, validatePack, freshGame, buildMix, MIX_FILE, MIX18_FILE, ADULT_QUOTA };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SvoyakEngine = api;
})(typeof window !== 'undefined' ? window : globalThis);
