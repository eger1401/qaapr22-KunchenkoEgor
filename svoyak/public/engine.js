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
  const TYPES = ['normal', 'cat', 'norisk', 'auction', 'plusminus', 'gift', 'approx'];
  const BONUS_POOL = ['gift', 'approx', 'norisk', 'plusminus', 'cat'];
  const BONUS_LABELS = { cat: 'кот в мешке', norisk: 'без риска', auction: 'ставка', plusminus: 'плюс на минус', gift: 'попроси баллы', approx: 'отвечай приблизительно' };

  // бонусы выпадают на случайные вопросы: в каждом раунде каждый вид хотя бы раз
  function makeBonuses(pack) {
    const map = {};
    pack.rounds.forEach((r, ri) => {
      const cells = [];
      r.themes.forEach((t, ti) => t.questions.forEach((_, qi) => cells.push(`${ri}:${ti}:${qi}`)));
      const shuffle = (a) => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
      shuffle(cells);
      const count = Math.min(cells.length, Math.max(BONUS_POOL.length, Math.round(cells.length / 5)));
      const pool = shuffle(BONUS_POOL.slice());
      for (let k = 0; k < count; k++) map[cells[k]] = pool[k % pool.length];
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
  // history — уже сыгранные темы (их id); пока есть несыгранные, повторов нет
  function buildMix(packs, history = []) {
    const all = [];
    packs.forEach((p) => p.rounds.forEach((r) => r.themes.forEach((t) => {
      if (t.questions.length >= 5) all.push({ id: t.name, t }); // одинаковые названия считаем одной темой
    })));
    const used = new Set(history);
    const names = new Set(); // в одной игре — без одинаковых названий тем
    const chosen = [];
    const take = (list) => {
      for (const x of list) {
        if (chosen.length >= 15) break;
        if (!names.has(x.t.name)) { names.add(x.t.name); chosen.push(x); }
      }
    };
    take(shuffled(all.filter((x) => !used.has(x.id))));
    const historyReset = chosen.length < 15; // всё сыграно — начинаем новый круг
    if (historyReset) take(shuffled(all.filter((x) => used.has(x.id))));
    const roundNames = ['Первый раунд', 'Второй раунд', 'Третий раунд'];
    const rounds = Math.max(1, Math.min(3, Math.floor(chosen.length / 5)));
    const mix = { title: 'Случайный микс', mix: true, rounds: [], ids: [], historyReset };
    for (let r = 0; r < rounds; r++) {
      const part = chosen.slice(r * 5, r * 5 + 5);
      mix.ids.push(...part.map((x) => x.id));
      mix.rounds.push({
        name: roundNames[r],
        themes: part.map(({ t }) => ({
          name: t.name,
          questions: t.questions.slice(0, 5).map((q, j) => ({ ...q, type: 'normal', price: (r + 1) * 100 * (j + 1) })),
        })),
      });
    }
    const finals = packs.map((p) => p.final).filter(Boolean);
    if (finals.length) mix.final = { ...finals[randInt(finals.length)] };
    return validatePack(JSON.parse(JSON.stringify(mix)));
  }
  const FALSE_START_MS = 1000;

  // hooks: isOnline(id), screens(), urls(), packs(), loadPackFile(file)
  function createEngine({ game: saved, pack, pin, hooks }) {
    let game = saved || freshGame(validatePack(pack), pin);
    if (!game.bonus) game.bonus = makeBonuses(game.pack); // игра, сохранённая до появления случайных бонусов
    const lockout = {}; // id -> время, до которого игрок заблокирован за фальстарт

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

    // ---------- действия ----------

    const hostActions = {
      start() {
        if (!game.order.length) throw new Error('Пока нет ни одного игрока');
        // каждая игра — новые случайные темы, которые ещё не играли (если ведущий не выбрал конкретный пакет)
        const mixPacks = hooks.mixPacks ? hooks.mixPacks() : [];
        if (!game.fixed && mixPacks.length) {
          const history = game.themeHistory || [];
          const pack = buildMix(mixPacks, history);
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
        const type = game.bonus[qKey(game.round, t, i)] || 'normal';
        game.q = { t, i, theme: theme.name, price: q.price, text: q.text, answer: q.answer, type, image: q.image, audio: q.audio, melody: q.melody, bpm: q.bpm, big: q.big };
        if (type === 'gift' || type === 'plusminus') {
          // карточка-бонус вместо вопроса
          const text = type === 'gift'
            ? 'Бонус! Жми кнопку быстрее всех.'
            : 'Бонус! Кто первым нажмёт кнопку — у того счёт поменяет знак.';
          Object.assign(game.q, { text, answer: '', image: undefined, audio: undefined, melody: undefined, big: undefined });
        }
        game.media = null;
        game.phase = 'question';
        game.answering = null;
        game.wrong = [];
        // кнопка у игроков активна сразу; бонус достаётся тому, кто нажал первым. Кот в мешке — без кнопки
        game.buzzOpen = type !== 'cat';
        game.buzzOpenedAt = Date.now();
        if (type === 'auction') { game.q.stake = null; game.q.staker = null; }
        log(`${theme.name} за ${q.price}${BONUS_LABELS[type] ? ' — ' + BONUS_LABELS[type] : ''}`);
      },
      openBuzz() {
        if (game.phase !== 'question' || game.answering) return;
        game.buzzOpen = true;
        game.buzzOpenedAt = Date.now();
      },
      playMedia() {
        if (!game.q || !(game.q.audio || game.q.melody)) return;
        game.media = { nonce: Date.now(), playing: true };
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
        // новые темы соберутся при «Начать игру»
        const keep = { fixed: game.fixed, history: game.themeHistory || [] };
        game = freshGame(game.pack, game.pin);
        game.fixed = keep.fixed;
        game.themeHistory = keep.history;
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
        game = freshGame(p, game.pin);
        game.themeHistory = history;
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
      buzz(id) {
        if (!game.players[id]) throw new Error('Сначала войдите в игру');
        if (game.phase !== 'question' || game.answering || game.q.type === 'cat') return { ignored: true };
        if (game.q.type === 'auction' && game.q.staker) return { ignored: true };
        if (game.wrong.includes(id)) return { ignored: true };
        const now = Date.now();
        if (!game.buzzOpen) {
          lockout[id] = now + FALSE_START_MS;
          return { early: true, lockMs: FALSE_START_MS };
        }
        if ((lockout[id] || 0) > now) return { locked: true, lockMs: lockout[id] - now };
        game.buzzOpen = false;
        if (game.q.type === 'auction' && !game.q.stake) {
          game.q.staker = id; // первый нажавший делает ставку, потом отвечает
          log(`Первым нажал ${name(id)} — делает ставку`);
          return { first: true };
        }
        if (game.q.type === 'plusminus') {
          // «Плюс на минус»: счёт нажавшего сразу меняет знак
          const p = game.players[id];
          const before = p.score;
          p.score = -before;
          game.q.answer = `${p.name}: ${before} → ${p.score}`;
          game.phase = 'reveal';
          log(`Плюс на минус: ${p.name} ${before} → ${p.score}`);
          return { first: true };
        }
        game.answering = id;
        game.answeringAt = now;
        log(`Первым нажал ${name(id)}`);
        return { first: true };
      },
      stake(id, { amount }) {
        if (!game.q || game.q.staker !== id) throw new Error('Ставку делает другой игрок');
        setStake(id, amount);
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
        .map((pid) => ({ id: pid, name: game.players[pid].name, score: game.players[pid].score, online: hooks.isOnline(pid) }));

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
        v.q = { t: game.q.t, i: game.q.i, theme: game.q.theme, price: game.q.price, type: game.q.type, text: game.q.text, image: game.q.image, audio: game.q.audio, melody: game.q.melody, bpm: game.q.bpm, big: game.q.big };
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
        if (!isHost && game.q.type !== 'normal' && !opened) {
          v.q.type = 'bonus';
          if (game.q.type === 'gift' || game.q.type === 'plusminus') v.q.text = 'Бонус! Жми кнопку быстрее всех.';
          delete v.q.win;
          delete v.q.lose;
        }
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
        v.packs = hooks.packs();
        v.screens = hooks.screens();
        v.log = game.log.slice(0, 12);
        v.urls = hooks.urls();
        v.answersPreview = curRound().themes.map((t, ti) => t.questions.map((q, qi) => (game.bonus[qKey(game.round, ti, qi)] || '')));
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

  const api = { createEngine, validatePack, freshGame, buildMix, MIX_FILE };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SvoyakEngine = api;
})(typeof window !== 'undefined' ? window : globalThis);
