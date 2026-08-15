/* Zanagrams — wiring. */
(function () {
  'use strict';

  const Generator = window.ZanGenerator;
  const Engine = window.ZanEngine;

  const $ = id => document.getElementById(id);
  const els = {
    board: $('board'),
    timerValue: $('timerValue'),
    timer: $('timer'),
    timerFill: $('timerFill'),
    timerToasts: $('timerToasts'),
    bonusCount: $('bonusCount'),
    newGame: $('newGame'),
    current: $('currentText'),
    targets: $('targets'),
    overlay: $('overlay'),
    sheetEmoji: $('sheetEmoji'),
    sheetTitle: $('sheetTitle'),
    sheetSub: $('sheetSub'),
    sheetWords: $('sheetWords'),
    playAgain: $('playAgain')
  };

  const commonWords = (Array.isArray(window.ZAN_COMMON) && window.ZAN_COMMON.length)
    ? window.ZAN_COMMON
    : Generator.FALLBACK_COMMON;

  const dict = Engine.buildDict(
    window.ZAN_DICT_RAW || '',
    commonWords.concat(Generator.FALLBACK_COMMON, Generator.FALLBACK_EXTRA)
  );

  const renderer = window.ZanRender.create(els.board);

  let game = null;
  let adjacency = new Map();
  let busy = false;
  let lastTick = 0;
  let rafId = null;

  /* ------------------------------ helpers ------------------------------ */

  function rebuildAdjacency() {
    adjacency = Generator.adjacencyMap(game.puzzle.cells, game.puzzle.edges);
  }

  function renderTargets(revealMissed) {
    els.targets.innerHTML = '';
    for (const word of game.puzzle.words) {
      const div = document.createElement('div');
      div.className = 'target' + (word.found ? ' found' : (revealMissed ? ' missed' : ''));
      div.textContent = (word.found || revealMissed)
        ? word.text.toUpperCase().split('').join(' ')
        : Engine.blanksFor(word.text);
      els.targets.appendChild(div);
    }
  }

  function renderHud() {
    els.timerValue.textContent = Engine.formatTime(game.timeLeftMs);
    const ratio = Math.max(0, Math.min(1, game.timeLeftMs / game.totalMs));
    els.timerFill.style.width = (ratio * 100) + '%';
    const urgent = game.timeLeftMs <= 15000 && game.status === 'playing';
    els.timer.classList.toggle('urgent', urgent);
    els.timerFill.classList.toggle('urgent', urgent);
    els.bonusCount.textContent = String(game.bonusWords.length);
  }

  function toast(text) {
    const node = document.createElement('div');
    node.className = 'toast';
    node.textContent = text;
    els.timerToasts.appendChild(node);
    window.setTimeout(() => node.remove(), 1200);
  }

  function setCurrent(text, mood) {
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
    if (dt > 0 && dt < 2000) {
      if (Engine.tick(game, dt)) {
        finish(false);
      }
    }
    renderHud();
  }

  /* ------------------------------ endgame ------------------------------ */

  function finish(won) {
    busy = true;
    renderTargets(!won);
    renderHud();
    const bonusList = game.bonusWords;
    els.sheetEmoji.textContent = won ? '🎉' : '⏳';
    els.sheetTitle.textContent = won ? 'Solved!' : "Time's up";
    els.sheetSub.textContent = won
      ? Engine.formatTime(game.timeLeftMs) + ' left · ' + bonusList.length + ' bonus word' + (bonusList.length === 1 ? '' : 's')
      : 'You found ' + game.foundWords.length + ' of ' + game.puzzle.words.length + ' words.';

    els.sheetWords.innerHTML = '';
    const missed = game.puzzle.words.filter(w => !w.found);
    for (const word of missed) {
      const li = document.createElement('li');
      li.className = 'missed';
      li.textContent = word.text;
      els.sheetWords.appendChild(li);
    }
    for (const bonus of bonusList.slice(0, 12)) {
      const li = document.createElement('li');
      li.className = 'bonus';
      li.textContent = bonus.word;
      els.sheetWords.appendChild(li);
    }
    els.overlay.hidden = false;
  }

  /* ------------------------------ submit ------------------------------- */

  function handleSubmit(ids) {
    if (!game || game.status !== 'playing' || busy) {
      setCurrent('');
      return;
    }
    if (!ids.length) {
      setCurrent('');
      return;
    }
    const word = Generator.traceToWord(game.puzzle.cells, ids);
    const result = Engine.submitWord(game, word);

    if (result.type === 'required') {
      busy = true;
      setCurrent(word, 'good');
      if (result.timeAdded) toast('+' + Math.round(result.timeAdded / 1000) + 's');
      renderTargets(false);
      renderer.playFound(result.removedIds, () => {
        rebuildAdjacency();
        busy = false;
        setCurrent('');
        if (result.solved) finish(true);
      });
      renderHud();
      return;
    }

    if (result.type === 'bonus') {
      renderer.pulse(ids, 'bonus', 620);
      toast('+' + result.seconds + 's');
      flashCurrent(word, 'good', 800);
      renderHud();
      return;
    }

    renderer.flashTrace(ids, 'wrong');
    flashCurrent(word || '·', 'bad', 620);
  }

  /* ------------------------------ new game ----------------------------- */

  function newGame() {
    const puzzle = Generator.generatePuzzle({ words: commonWords })
      || Generator.generatePuzzle({ words: Generator.FALLBACK_COMMON });
    if (!puzzle) {
      els.sheetEmoji.textContent = '😵';
      els.sheetTitle.textContent = 'Could not build a puzzle';
      els.sheetSub.textContent = 'Try again.';
      els.overlay.hidden = false;
      return;
    }
    game = Engine.createGame({ puzzle: puzzle, dict: dict });
    rebuildAdjacency();
    renderer.setPuzzle(puzzle);
    renderTargets(false);
    renderHud();
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
        if (!els.current.classList.contains('bad') && !els.current.classList.contains('good')) setCurrent('');
        return;
      }
      setCurrent(Generator.traceToWord(game.puzzle.cells, ids));
    },
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
  window.ZAN = { newGame: newGame, getGame: () => game, renderer: renderer };
})();
