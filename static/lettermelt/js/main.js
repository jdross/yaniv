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
    longest: $('longest'),
    longestText: $('longestText'),
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
    playAgain: $('playAgain')
  };

  const commonWords = (Array.isArray(window.ZAN_COMMON) && window.ZAN_COMMON.length)
    ? window.ZAN_COMMON
    : Generator.FALLBACK_COMMON;

  // Guard: if the data files predate the ZAN_COMMON_LONG contract, keep long
  // words out of the regular pool and use the embedded long list instead.
  const longWords = (Array.isArray(window.ZAN_COMMON_LONG) && window.ZAN_COMMON_LONG.length)
    ? window.ZAN_COMMON_LONG
    : Generator.FALLBACK_LONG;

  // One lexicon for the whole session: the dictionary the engine validates
  // against, the "common" set that decides normal-vs-extra, and the prefix
  // index the generator enumerates with. Built once (~120ms) and reused.
  //
  // The embedded fallbacks are a substitute for missing data files, never a
  // supplement to them: folding them into a real word list would smuggle their
  // sample words (plurals like "tones" and "metals") into the required-word
  // set, where the curated lists deliberately exclude such forms.
  const dictSource = (typeof window.ZAN_DICT_RAW === 'string' && window.ZAN_DICT_RAW.length)
    ? window.ZAN_DICT_RAW
    : Generator.FALLBACK_COMMON.concat(Generator.FALLBACK_EXTRA, Generator.FALLBACK_LONG);
  const lexicon = Generator.buildLexicon(dictSource, commonWords, longWords);
  const dict = lexicon.words;

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

  function renderLongest() {
    const word = Generator.longestWord(game.puzzle);
    if (!word) {
      els.longest.hidden = true;
      return;
    }
    els.longest.hidden = false;
    if (word.found) {
      els.longest.classList.add('found');
      els.longestText.textContent = word.text.toUpperCase();
    } else {
      els.longest.classList.remove('found');
      els.longestText.textContent = word.text.length + ' letters';
    }
  }

  function renderHud(tick) {
    els.timerValue.textContent = Engine.formatTime(game.elapsedMs);
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

  function flashTimer(tone) {
    const cls = tone === 'extra' ? 'credited-extra' : 'credited';
    els.timer.classList.remove('credited', 'credited-extra');
    // Force a reflow so the animation restarts on rapid extras.
    void els.timer.offsetWidth;
    els.timer.classList.add(cls);
    window.setTimeout(() => els.timer.classList.remove(cls), 900);
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

    els.sheetWords.innerHTML = '';
    for (const extra of extras.slice(0, 18)) {
      const li = document.createElement('li');
      li.className = 'extra';
      li.textContent = extra.word;
      els.sheetWords.appendChild(li);
    }
    els.overlay.hidden = false;
    burst();
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
      renderLongest();
      if (result.isLong) els.longest.classList.add('celebrate');
      // Green: a word off the board. The fill drains once the verdict has
      // registered — letters shared with other words keep their connections,
      // so leaving the trace up would strand them filled. The tone itself
      // rides through the melt and is cleared in onDone below.
      renderer.drainTrace('good', 260, true);
      renderer.playFound({
        removedIds: result.removedIds,
        removedEdgeKeys: result.removedEdgeKeys,
        keptIds: keptLetters(result),
        onDone: function () {
          rebuildAdjacency();
          busy = false;
          setCurrent('');
          renderer.setTone(null);
          els.longest.classList.remove('celebrate');
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

  function newGame() {
    const puzzle =
      Generator.generatePuzzle({ words: commonWords, longWords: longWords, lexicon: lexicon }) ||
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
    game = Engine.createGame({ puzzle: puzzle, dict: dict });
    rebuildAdjacency();
    renderer.setPuzzle(puzzle);
    renderHud();
    renderLongest();
    els.longest.classList.remove('celebrate');
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

  els.newGame.addEventListener('click', newGame);
  els.playAgain.addEventListener('click', newGame);

  // Kill double-tap zoom and rubber-band scrolling on iOS.
  document.addEventListener('gesturestart', ev => ev.preventDefault());
  document.addEventListener('dblclick', ev => ev.preventDefault());
  document.addEventListener('touchmove', ev => {
    if (ev.cancelable) ev.preventDefault();
  }, { passive: false });

  window.addEventListener('resize', () => {
    if (game) renderer.refresh();
  });

  newGame();

  // Test/debug hook.
  window.ZAN = {
    newGame: newGame,
    getGame: () => game,
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
        renderLongest();
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
