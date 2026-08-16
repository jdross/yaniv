/* Lettermelt — wiring. */
(function () {
  'use strict';

  const Generator = window.ZanGenerator;
  const Engine = window.ZanEngine;

  const $ = id => document.getElementById(id);
  const els = {
    board: $('board'),
    timer: $('timer'),
    timerValue: $('timerValue'),
    timerToasts: $('timerToasts'),
    solvedCount: $('solvedCount'),
    totalCount: $('totalCount'),
    newGame: $('newGame'),
    current: $('currentText'),
    currentHint: $('currentHint'),
    overlay: $('overlay'),
    sheetEmoji: $('sheetEmoji'),
    sheetTitle: $('sheetTitle'),
    sheetTime: $('sheetTime'),
    sheetBurst: $('sheetBurst'),
    sheetSub: $('sheetSub'),
    sheetWords: $('sheetWords'),
    playAgain: $('playAgain'),
    stars: $('stars'),
    tube: $('tube'),
    tubeFill: $('tubeFill'),
    tubeTicks: $('tubeTicks'),
    modeToggle: $('modeToggle'),
    sheetStars: $('sheetStars'),
    shareBtn: $('shareBtn')
  };

  /* ----------------------------- vocabulary -----------------------------
   * Two difficulties over one dictionary. Hard uses the full common-word
   * vocabulary; easy uses a friendlier subset, so a board spells fewer
   * required words and every one of them is instantly recognisable. Bonus
   * words are shared: the dictionary does not change with difficulty.
   */
  const MODES = {
    hard: {
      label: 'Hard',
      common: window.ZAN_COMMON,
      long: window.ZAN_COMMON_LONG,
      base: window.ZAN_BASE
    },
    easy: {
      label: 'Easy',
      common: window.ZAN_COMMON_EASY,
      long: window.ZAN_LONG_EASY,
      base: window.ZAN_BASE_EASY
    }
  };

  const dictSource = (typeof window.ZAN_DICT_RAW === 'string' && window.ZAN_DICT_RAW.length)
    ? window.ZAN_DICT_RAW
    : Generator.FALLBACK_COMMON.concat(Generator.FALLBACK_EXTRA, Generator.FALLBACK_LONG);

  const usable = list => (Array.isArray(list) && list.length ? list : null);

  /**
   * Word pools for a difficulty, falling back to hard (then to the embedded
   * lists) when the data files predate a contract.
   *
   * The embedded fallbacks substitute for missing data, never supplement it:
   * folding them into a real word list would smuggle their sample plurals
   * ("tones", "metals") into the required set.
   */
  function poolsFor(mode) {
    const m = MODES[mode] || MODES.hard;
    const common = usable(m.common) || usable(MODES.hard.common) || Generator.FALLBACK_COMMON;
    const long = usable(m.long) || usable(MODES.hard.long) || Generator.FALLBACK_LONG;
    // Every long word counts as required; only base words headline a puzzle.
    const base = usable(m.base) || usable(MODES.hard.base) || long;
    return { common: common, long: long, base: base };
  }

  // Lexicons are ~300ms to build, so each difficulty builds one on first use.
  const lexicons = {};
  function lexiconFor(mode) {
    if (!lexicons[mode]) {
      const p = poolsFor(mode);
      lexicons[mode] = Generator.buildLexicon(dictSource, p.common, p.long, p.base);
    }
    return lexicons[mode];
  }

  let mode = 'hard';
  let lexicon = lexiconFor(mode);
  let dict = lexicon.words;
  let currentSeed = null;
  let shownStars = Engine.MAX_STARS;

  const renderer = window.ZanRender.create(els.board);

  let game = null;
  let adjacency = new Map();
  let busy = false;
  let lastTick = 0;
  let rafId = null;
  let hintTimer = null;

  /* ------------------------------ helpers ------------------------------ */

  function rebuildAdjacency() {
    adjacency = Generator.adjacencyMap(game.puzzle.cells, game.puzzle.edges);
  }

  /** Letters of the just-solved word that other words still need. */
  function keptLetters(result) {
    const word = game.puzzle.words[result.wordIndex];
    if (!word) return [];
    const gone = new Set(result.removedIds);
    return word.cellIds.filter(id => !gone.has(id));
  }

  /* --------------------------- the clock ---------------------------- *
   * The clock is a tube of liquid draining away, not a number ticking up.
   * It starts full at TIME_LIMIT and empties to the right; the notches mark
   * where each star goes. Run past the limit and the tube sits empty while a
   * red overtime counter climbs.
   */
  const TIME_LIMIT_MS = 10 * 60 * 1000;

  /** Fraction of the tube still full when `elapsedMs` has passed. */
  function fillFraction(elapsedMs) {
    return Math.max(0, Math.min(1, 1 - elapsedMs / TIME_LIMIT_MS));
  }

  /** Notches sit where the draining edge will be as each star is lost. */
  function buildTicks() {
    els.tubeTicks.innerHTML = '';
    for (const tier of Engine.STAR_THRESHOLDS) {
      const at = fillFraction(tier.withinMs);
      if (at <= 0 || at >= 1) continue;   // the last notch is the tube's end
      const tick = document.createElement('i');
      tick.style.left = (at * 100).toFixed(2) + '%';
      tick.dataset.at = String(tier.withinMs);
      els.tubeTicks.appendChild(tick);
    }
  }

  function renderStars(force) {
    const stars = Engine.starsFor(game.elapsedMs);
    const next = Engine.msToNextStarLoss(game.elapsedMs);
    if (stars !== shownStars || force) {
      const losing = stars < shownStars ? shownStars : 0;
      els.stars.innerHTML = '';
      for (let i = 1; i <= Engine.MAX_STARS; i++) {
        const star = document.createElement('i');
        star.textContent = '★';
        if (i > stars) star.classList.add('spent');
        if (i === losing && !renderer.prefersReducedMotion()) star.classList.add('losing');
        els.stars.appendChild(star);
      }
      shownStars = stars;
    }
    // The star about to go beats faster the nearer it gets, from a slow pulse
    // a minute out down to a flutter in the last seconds.
    const atRisk = els.stars.children[stars - 1];
    for (const star of els.stars.children) star.classList.remove('atrisk');
    if (atRisk && next !== null && next < 60000 && !renderer.prefersReducedMotion()) {
      atRisk.classList.add('atrisk');
      atRisk.style.setProperty('--beat', (0.3 + (next / 60000) * 1.1).toFixed(2) + 's');
    }
  }

  function renderClock() {
    const elapsed = game.elapsedMs;
    const remaining = TIME_LIMIT_MS - elapsed;
    const fill = fillFraction(elapsed);
    els.tubeFill.style.width = (fill * 100).toFixed(2) + '%';

    const overtime = remaining <= 0;
    els.tube.classList.toggle('overtime', overtime);
    els.tube.classList.toggle('empty', fill <= 0);
    els.timerValue.textContent = overtime
      ? '+' + Engine.formatTime(-remaining)
      : Engine.formatTime(remaining);

    const next = Engine.msToNextStarLoss(elapsed);
    els.tube.classList.toggle('warn', !overtime && next !== null && next < 30000);

    for (const tick of els.tubeTicks.children) {
      tick.classList.toggle('passed', elapsed >= Number(tick.dataset.at));
    }
  }

  function renderHud(tick) {
    renderClock();
    renderStars();
    const solved = String(Engine.solvedCount(game));
    if (tick && els.solvedCount.textContent !== solved) {
      els.solvedCount.classList.remove('tick');
      void els.solvedCount.offsetWidth;   // restart the spring
      els.solvedCount.classList.add('tick');
      window.setTimeout(() => els.solvedCount.classList.remove('tick'), 560);
    }
    els.solvedCount.textContent = solved;
    els.totalCount.textContent = String(Engine.totalWords(game));
  }

  function toast(text, tone) {
    const node = document.createElement('div');
    node.className = tone ? 'toast toast-' + tone : 'toast';
    node.textContent = text;
    els.timerToasts.appendChild(node);
    window.setTimeout(() => node.remove(), 1300);
  }

  /** An extra word buys time back: the tube flashes blue as it refills. */
  function flashTimer(tone) {
    const cls = tone === 'extra' ? 'credited-extra' : 'credited';
    els.tube.classList.remove('credited', 'credited-extra');
    void els.tube.offsetWidth;   // restart the flash on rapid extras
    els.tube.classList.add(cls);
    window.setTimeout(() => els.tube.classList.remove(cls), 900);
  }

  /** Small one-line explanation under the traced word. */
  function setHint(text) {
    if (!els.currentHint) return;
    els.currentHint.textContent = text || '';
    els.currentHint.classList.toggle('visible', !!text);
    if (hintTimer) window.clearTimeout(hintTimer);
    if (text) hintTimer = window.setTimeout(() => setHint(''), 1100);
  }

  function setCurrent(text, mood) {
    if (!mood) setHint('');
    els.current.className = 'current-text' + (mood ? ' ' + mood : '');
    els.current.textContent = text ? text.toUpperCase() : '';
  }

  function flashCurrent(text, mood, holdMs) {
    setCurrent(text, mood);
    window.setTimeout(() => {
      if (els.current.textContent === text.toUpperCase()) setCurrent('');
    }, holdMs || 700);
  }

  /* ------------------------------- loop -------------------------------- */

  function loop(now) {
    rafId = requestAnimationFrame(loop);
    if (!game || game.status !== 'playing') return;
    const dt = lastTick ? now - lastTick : 0;
    lastTick = now;
    if (dt > 0 && dt < 2000) Engine.tick(game, dt);
    renderHud();
  }

  /* ------------------------------ endgame ------------------------------ */

  /** Count the final time up from zero, then settle on the real value. */
  function countUpTime(target) {
    if (renderer.prefersReducedMotion()) {
      els.sheetTime.textContent = Engine.formatTime(target);
      return;
    }
    const duration = 900;
    const start = performance.now();
    function frame(now) {
      const t = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - t, 3);
      els.sheetTime.textContent = Engine.formatTime(target * eased);
      if (t < 1) requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  }

  /** Celebratory particle burst behind the win copy. */
  function burst() {
    els.sheetBurst.innerHTML = '';
    if (renderer.prefersReducedMotion()) return;
    const colors = ['#ffd166', '#ffb04d', '#ff6b5a', '#fff3e6'];
    for (let i = 0; i < 18; i++) {
      const dot = document.createElement('i');
      const angle = (Math.PI * 2 * i) / 18 + Math.random() * 0.3;
      const dist = 90 + Math.random() * 90;
      dot.style.setProperty('--dx', (Math.cos(angle) * dist).toFixed(1) + 'px');
      dot.style.setProperty('--dy', (Math.sin(angle) * dist).toFixed(1) + 'px');
      dot.style.setProperty('--delay', (Math.random() * 0.25).toFixed(2) + 's');
      dot.style.setProperty('--spark', colors[i % colors.length]);
      els.sheetBurst.appendChild(dot);
    }
  }

  function finish() {
    busy = true;
    renderHud();
    const extras = game.extraWords;
    const saved = Math.round(game.savedMs / 1000);
    els.sheetEmoji.textContent = '🎉';
    els.sheetTitle.textContent = 'Solved!';
    countUpTime(game.elapsedMs);
    els.sheetSub.textContent = extras.length
      ? extras.length + ' extra word' + (extras.length === 1 ? '' : 's') + ' saved you ' + saved + 's'
      : 'No extra words found — try hunting for bonus words next time.';

    const stars = Engine.starsFor(game.elapsedMs);
    els.sheetStars.innerHTML = '';
    for (let i = 1; i <= Engine.MAX_STARS; i++) {
      const star = document.createElement('i');
      star.textContent = '★';
      if (i > stars) star.classList.add('spent');
      star.style.setProperty('--delay', (0.1 * i).toFixed(2) + 's');
      els.sheetStars.appendChild(star);
    }

    els.sheetWords.innerHTML = '';
    for (const extra of extras.slice(0, 18)) {
      const li = document.createElement('li');
      li.className = 'extra';
      li.textContent = extra.word;
      els.sheetWords.appendChild(li);
    }
    resetShareButton();
    els.overlay.hidden = false;
    burst();
  }

  /* ------------------------------ sharing ------------------------------ *
   * A puzzle is just a seed plus a difficulty, so a link is enough to hand
   * someone the exact board you played.
   */

  function puzzleLink() {
    const url = new URL(window.location.href);
    url.hash = '';
    url.searchParams.set('s', String(currentSeed));
    url.searchParams.set('m', mode);
    return url.toString();
  }

  function shareMessage() {
    const stars = Engine.starsFor(game.elapsedMs);
    const plural = stars === 1 ? 'star' : 'stars';
    return 'I got ' + stars + ' ' + plural + ' on ' + MODES[mode].label.toLowerCase() +
      ' mode, done in ' + Engine.formatTime(game.elapsedMs) + '! Here\'s the puzzle: ' +
      puzzleLink();
  }

  function resetShareButton() {
    els.shareBtn.classList.remove('copied');
    els.shareBtn.textContent = 'Share this puzzle';
  }

  function share() {
    const text = shareMessage();
    // The share sheet is the natural route on a phone; clipboard is the
    // fallback, and a selectable prompt the fallback's fallback.
    if (navigator.share) {
      navigator.share({ text: text }).catch(() => {});
      return;
    }
    const done = () => {
      els.shareBtn.classList.add('copied');
      els.shareBtn.textContent = 'Copied!';
      window.setTimeout(resetShareButton, 2200);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, () => window.prompt('Copy this:', text));
    } else {
      window.prompt('Copy this:', text);
    }
  }

  /* ------------------------------ submit ------------------------------- */

  function handleSubmit(ids) {
    if (!game || game.status !== 'playing' || busy || !ids.length) {
      renderer.clearTrace();
      renderer.setTone(null);
      setCurrent('');
      return;
    }
    const word = Generator.traceToWord(game.puzzle.cells, ids);
    const result = Engine.submitWord(game, word);

    if (result.type === 'required') {
      busy = true;
      setCurrent(word, 'good');
      renderHud(true);
      // The base word no longer sits on a pill waiting to be found; solving it
      // just says so, and the message fades like every other.
      if (result.isLong) setHint('longest word!');
      // Green: a word off the board. The fill holds for the same beat a grey
      // repeat gets, then drains — letters shared with other words keep their
      // connections, so leaving the trace up would strand them filled. The
      // tone rides through the melt and is cleared in onDone below.
      renderer.drainTrace('good', 380, true);
      renderer.playFound({
        removedIds: result.removedIds,
        removedEdgeKeys: result.removedEdgeKeys,
        keptIds: keptLetters(result),
        onDone: function () {
          rebuildAdjacency();
          busy = false;
          setCurrent('');
          renderer.setTone(null);
          if (result.solved) finish();
        }
      });
      return;
    }

    if (result.type === 'extra') {
      // Blue: a rare word, worth time back rather than a place on the board.
      renderer.drainTrace('extra', 520);
      renderer.sparkAt(ids[ids.length - 1]);
      toast('-' + result.seconds + 's', 'extra');
      flashTimer('extra');
      flashCurrent(word, 'extra', 800);
      renderHud();
      return;
    }

    // Feedback is split by MEANING, not lumped into one rejection:
    //   already found -> neutral acknowledgement, no red shake
    //   too short     -> a quiet nudge about the 4-letter minimum
    //   not a word    -> the red shake
    if (result.type === 'repeat-required' || result.type === 'repeat-extra') {
      // Grey: you already have this one, nothing more to win from it.
      renderer.drainTrace('dim', 380);
      flashCurrent(word, 'again', 900);
      setHint('already found');
      return;
    }

    // Plurals are deliberately not in the dictionary, so say that outright
    // rather than letting the red shake imply the letters spell nothing.
    if (result.type === 'plural') {
      renderer.drainTrace('dim', 380);
      flashCurrent(word, 'again', 900);
      setHint('no plurals');
      return;
    }

    if (result.type === 'short') {
      // Grey too: nothing is wrong with the letters, the word is just short.
      renderer.drainTrace('dim', 320);
      flashCurrent(word || '·', 'short', 700);
      setHint('4 letters or more');
      return;
    }

    renderer.drainTrace('bad', 320);
    renderer.flashTrace(ids, 'wrong');
    flashCurrent(word || '·', 'bad', 620);
  }

  /* ------------------------------ new game ----------------------------- */

  function newGame(seed) {
    const pools = poolsFor(mode);
    const wanted = (seed === undefined || seed === null) ? undefined : (seed >>> 0);
    const puzzle =
      Generator.generatePuzzle({
        words: pools.common, longWords: pools.base, lexicon: lexicon, seed: wanted
      }) ||
      Generator.generatePuzzle({
        words: Generator.FALLBACK_COMMON,
        longWords: Generator.FALLBACK_LONG,
        lexicon: lexicon
      });
    if (!puzzle) {
      els.sheetEmoji.textContent = '😵';
      els.sheetTitle.textContent = 'Could not build a puzzle';
      els.sheetTime.textContent = '';
      els.sheetSub.textContent = 'Try again.';
      els.overlay.hidden = false;
      return;
    }
    currentSeed = puzzle.seed;
    game = Engine.createGame({ puzzle: puzzle, dict: dict });
    shownStars = Engine.MAX_STARS;
    rebuildAdjacency();
    renderer.setPuzzle(puzzle);
    buildTicks();
    renderHud();
    renderStars(true);
    setCurrent('');
    els.overlay.hidden = true;
    busy = false;
    lastTick = 0;
    if (!rafId) rafId = requestAnimationFrame(loop);
  }

  /* ------------------------------- input ------------------------------- */

  window.ZanInput.attach(els.board, renderer, {
    getAdjacency: () => adjacency,
    isActive: () => !!game && game.status === 'playing' && !busy,
    onTraceChange: ids => {
      if (busy) return;
      if (!ids.length) {
        // Releasing the finger clears the live trace text, but never the
        // verdict a submit just put there (good / again / short / bad) —
        // flashCurrent owns clearing that.
        if (els.current.className === 'current-text') setCurrent('');
        return;
      }
      setCurrent(Generator.traceToWord(game.puzzle.cells, ids));
    },
    onLock: id => renderer.lockPulse(id),
    onStart: id => renderer.lockPulse(id),
    onSubmit: handleSubmit,
    onCancel: () => setCurrent('')
  });

  els.newGame.addEventListener('click', () => newGame());
  els.playAgain.addEventListener('click', () => newGame());
  els.shareBtn.addEventListener('click', share);

  function renderMode() {
    els.modeToggle.textContent = MODES[mode].label;
    els.modeToggle.classList.toggle('easy', mode === 'easy');
  }

  els.modeToggle.addEventListener('click', () => {
    mode = mode === 'hard' ? 'easy' : 'hard';
    lexicon = lexiconFor(mode);
    dict = lexicon.words;
    renderMode();
    newGame();
  });

  // Kill double-tap zoom and rubber-band scrolling on iOS.
  document.addEventListener('gesturestart', ev => ev.preventDefault());
  document.addEventListener('dblclick', ev => ev.preventDefault());
  document.addEventListener('touchmove', ev => {
    if (ev.cancelable) ev.preventDefault();
  }, { passive: false });

  window.addEventListener('resize', () => {
    if (game) renderer.refresh();
  });

  /**
   * A shared link carries the seed and difficulty, so opening it rebuilds the
   * exact board the sender played. Anything unparseable just starts a normal
   * game rather than failing.
   */
  function startFromLocation() {
    let seed = null;
    try {
      const params = new URLSearchParams(window.location.search);
      const hash = window.location.hash.replace(/^#/, '');
      const fromHash = hash ? new URLSearchParams(hash) : null;
      const rawMode = params.get('m') || (fromHash && fromHash.get('m'));
      const rawSeed = params.get('s') || (fromHash && fromHash.get('s'));
      if (rawMode && MODES[rawMode]) {
        mode = rawMode;
        lexicon = lexiconFor(mode);
        dict = lexicon.words;
      }
      if (rawSeed && /^\d+$/.test(rawSeed)) seed = Number(rawSeed) >>> 0;
    } catch (_e) { /* malformed URL: just play a fresh board */ }
    renderMode();
    newGame(seed);
  }

  startFromLocation();

  // Test/debug hook.
  window.ZAN = {
    newGame: newGame,
    getGame: () => game,
    getSeed: () => currentSeed,
    getMode: () => mode,
    setMode: function (next) {
      if (!MODES[next]) return false;
      mode = next;
      lexicon = lexiconFor(mode);
      dict = lexicon.words;
      renderMode();
      return true;
    },
    shareMessage: () => shareMessage(),
    renderer: renderer,
    lexicon: lexicon,
    enumerate: function () {
      const g = game.puzzle;
      return Array.from(Generator.enumerateWords(g.cells, g.edges, lexicon).keys());
    },
    solve: function (text) {
      const result = Engine.submitWord(game, text);
      if (result.type === 'required') {
        renderHud();
        renderer.playFound({
          removedIds: result.removedIds,
          removedEdgeKeys: result.removedEdgeKeys,
          keptIds: keptLetters(result),
          onDone: function () {
            rebuildAdjacency();
            if (result.solved) finish();
          }
        });
      }
      return result;
    }
  };
})();
