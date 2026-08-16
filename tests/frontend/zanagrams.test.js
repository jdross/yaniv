const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const gen = require(path.join(__dirname, '../../static/lettermelt/js/generator.js'));
const engine = require(path.join(__dirname, '../../static/lettermelt/js/engine.js'));
const input = require(path.join(__dirname, '../../static/lettermelt/js/input.js'));

/* Fixed embedded vocabulary so the suite never depends on the generated data
 * files. Lengths 4-7 for regular words, 8-11 for the single longest word. */
const WORDS = [
  'able', 'acre', 'atom', 'bake', 'bald', 'band', 'bare', 'barn', 'beam', 'bean',
  'bear', 'beat', 'bell', 'belt', 'bend', 'bird', 'blue', 'boat', 'bone', 'cake',
  'calm', 'cane', 'cart', 'cave', 'coal', 'coat', 'cold', 'cone', 'core', 'corn',
  'dare', 'dark', 'date', 'dawn', 'deal', 'dear', 'dent', 'dial', 'earn', 'east',
  'lace', 'lake', 'land', 'lane', 'late', 'lead', 'lean', 'mare', 'mast', 'mate',
  'meal', 'mean', 'meat', 'mend', 'moat', 'nail', 'name', 'near', 'neat', 'nest',
  'note', 'oral', 'oval', 'pale', 'pane', 'part', 'past', 'pear', 'plan', 'pole',
  'rail', 'rain', 'rate', 'real', 'rent', 'road', 'robe', 'role', 'rope', 'sale',
  'salt', 'same', 'sand', 'seal', 'seam', 'seat', 'sent', 'alone', 'blame', 'blast',
  'brace', 'brain', 'bread', 'clean', 'clear', 'crane', 'cream', 'dream', 'learn', 'least',
  'metal', 'ocean', 'organ', 'paint', 'panel', 'pearl', 'place', 'plane', 'plant', 'plate',
  'scale', 'score', 'shore', 'slate', 'snail', 'stale', 'stand', 'stone', 'store', 'table',
  'trace', 'train', 'anchor', 'animal', 'basket', 'candle', 'castle', 'cellar', 'dealer', 'desert',
  'garden', 'inland', 'island', 'leader', 'legend', 'listen', 'manner', 'marble', 'master', 'mental',
  'nature', 'normal', 'orange', 'parcel', 'parent', 'planet', 'reason', 'relate', 'rental', 'sailor',
  'salmon', 'sample', 'season', 'senate', 'silent', 'silver', 'sister', 'stable', 'stream', 'talent',
  'tender', 'tunnel', 'winter', 'lantern', 'mineral', 'plaster'
];

const LONG_WORDS = [
  'painters', 'creation', 'material', 'mountain', 'notebook', 'cardinal', 'sandstone',
  'planetary', 'landscape', 'celebrate', 'presented', 'strangers', 'restaurant',
  'generation', 'personally', 'reasonable', 'centimeter'
];

const EXTRA_WORDS = ['lean', 'earn', 'tale', 'teal', 'sale', 'rate', 'tear', 'tone', 'nets', 'stare'];

/* Rare words: real dictionary entries that are NOT common. These are the only
 * words allowed to surface as extras. */
const RARE_WORDS = [
  'alant', 'anear', 'anlace', 'arles', 'astern', 'baled', 'bedel', 'canst', 'carle',
  'certes', 'clart', 'dolent', 'ealder', 'entera', 'estral', 'lanate', 'leman',
  'malar', 'meatal', 'nacre', 'natter', 'oaten', 'orant', 'pareo', 'ratel',
  'reata', 'renal', 'retable', 'salep', 'sental', 'stane', 'taler', 'telamon',
  'tolane', 'trave', 'antre', 'arene', 'blare', 'crare', 'dorsal', 'elans'
];

/* The dictionary the tests validate against: every common word plus the rare
 * ones. Built once, exactly as the game does at startup. */
const DICT_WORDS = WORDS.concat(LONG_WORDS, EXTRA_WORDS, RARE_WORDS);
const LEXICON = gen.buildLexicon(DICT_WORDS, WORDS.concat(EXTRA_WORDS), LONG_WORDS);

const PUZZLE_COUNT = 160;
const SOLVE_COUNT = PUZZLE_COUNT;   // every generated puzzle is solved right through

// Structural tests care about invariants, not about how long the generator is
// willing to hunt for a high-scoring board, so they run with the quality gate
// open and a small restart budget. The quality tuning has its own tests.
const FAST = { minFunScore: 0, restarts: 20 };

function makePuzzle(seed) {
  const rng = gen.createRng(seed);
  const puzzle = gen.generatePuzzle(Object.assign({
    rng: rng, words: WORDS, longWords: LONG_WORDS, lexicon: LEXICON
  }, FAST));
  assert.ok(puzzle, 'generatePuzzle returned null for seed ' + seed);
  return { puzzle: puzzle, rng: rng };
}

/** Structural checks that must hold at every point in a puzzle's life. */
function assertBoardHealthy(puzzle, context) {
  assert.deepEqual(
    gen.checkUnionInvariant(puzzle), [],
    'union invariant broken ' + context
  );
  assert.deepEqual(
    gen.findCrossingEdgePairs(puzzle.cells, puzzle.edges), [],
    'crossing diagonal edges ' + context
  );
  for (const word of puzzle.words) {
    if (word.found) continue;
    assert.ok(
      gen.isValidTrace(puzzle.cells, puzzle.edges, word.cellIds),
      'canonical path for "' + word.text + '" not traceable ' + context
    );
    assert.equal(gen.traceToWord(puzzle.cells, word.cellIds), word.text);
  }
}

/* ------------------------------------------------------------------ *
 * Generation
 * ------------------------------------------------------------------ */

test('generates puzzles of 10-16 words with exactly one 8-11 letter base word', () => {
  let shortfall = 0;
  for (let i = 0; i < PUZZLE_COUNT; i++) {
    const { puzzle } = makePuzzle(100000 + i);
    if (puzzle.words.length < 10) shortfall++;
    assert.ok(puzzle.words.length >= 10, 'too few words: ' + puzzle.words.length);
    assert.ok(puzzle.words.length <= 16, 'too many words: ' + puzzle.words.length);

    const longs = puzzle.words.filter(w => w.isLong);
    assert.equal(longs.length, 1, 'expected exactly one longest word');
    assert.ok(longs[0].text.length >= 8 && longs[0].text.length <= 11,
      'longest word out of range: ' + longs[0].text);
    assert.equal(longs[0].text, puzzle.longWord);

    for (const word of puzzle.words) {
      if (word.isLong) continue;
      assert.ok(word.text.length >= 4 && word.text.length <= 7,
        'regular word out of range: ' + word.text);
      assert.notEqual(word.text, puzzle.longWord, 'regular word duplicates the longest word');
    }
    const texts = puzzle.words.map(w => w.text);
    assert.equal(new Set(texts).size, texts.length, 'duplicate word in puzzle');
    for (const word of puzzle.words) {
      assert.equal(word.cellIds.length, word.text.length);
      assert.equal(new Set(word.cellIds).size, word.cellIds.length, 'word path revisits a cell');
    }
  }
  // The 10-word floor is a hard requirement, never a statistical one.
  assert.equal(shortfall, 0, shortfall + '/' + PUZZLE_COUNT + ' puzzles fell below 10 words');
});

test('initial board is exactly the union of the word paths, with no crossings', () => {
  let nodeMin = Infinity;
  let nodeMax = 0;
  let fullGrids = 0;
  let gappyGrids = 0;
  for (let i = 0; i < PUZZLE_COUNT; i++) {
    const { puzzle } = makePuzzle(200000 + i);
    assertBoardHealthy(puzzle, 'at generation (seed ' + (200000 + i) + ')');
    nodeMin = Math.min(nodeMin, puzzle.cells.length);
    nodeMax = Math.max(nodeMax, puzzle.cells.length);
    // Sharing must actually happen: far fewer nodes than letters.
    const letters = puzzle.words.reduce((sum, w) => sum + w.text.length, 0);
    assert.ok(puzzle.cells.length < letters * 0.6, 'words are not sharing letters');
    // Board fits a phone-portrait lattice.
    // Everything lives inside the fixed 5 x 5 grid.
    assert.equal(gen.CONFIG.size, 5, 'the grid is 5 x 5');
    const capacity = gen.CONFIG.size * gen.CONFIG.size;
    for (const cell of puzzle.allCells) {
      assert.ok(cell.x >= 0 && cell.x < gen.CONFIG.size, 'cell x outside the grid: ' + cell.x);
      assert.ok(cell.y >= 0 && cell.y < gen.CONFIG.size, 'cell y outside the grid: ' + cell.y);
    }
    assert.ok(puzzle.allCells.length <= capacity,
      'more than ' + capacity + ' cells: ' + puzzle.allCells.length);
    assert.equal(puzzle.cellsUsed, puzzle.allCells.length);
    if (puzzle.allCells.length === capacity) fullGrids++;
    if (puzzle.allCells.length < capacity) gappyGrids++;
  }
  assert.ok(nodeMax <= 25, 'board exceeded the grid: ' + nodeMax + ' nodes');
  // Boards are NOT required to fill the 5 x 5 — each one draws a random
  // occupancy budget, so silhouettes differ from game to game. minCells is the
  // only floor: below it the board stops reading as a grid.
  assert.ok(nodeMin >= gen.CONFIG.minCells,
    'board sparser than minCells: ' + nodeMin + ' cells');
  assert.ok(gappyGrids > 0, 'no board ever left a gap in the grid');
});

test('phase-2 saturation prefilter is a correct multiset-subset test', () => {
  const grid = new Map([['a', 2], ['b', 1], ['t', 1]]);
  assert.equal(gen.multisetFits('bat', grid), true);
  assert.equal(gen.multisetFits('tab', grid), true);
  assert.equal(gen.multisetFits('abat', grid), true, 'two a\'s are available');
  assert.equal(gen.multisetFits('aaab', grid), false, 'only two a\'s exist');
  assert.equal(gen.multisetFits('bb', grid), false, 'only one b exists');
  assert.equal(gen.multisetFits('cat', grid), false, 'c is not on the grid');
  assert.equal(gen.multisetFits('', grid), true);

  // Against real boards: every word placed must pass its own grid's filter.
  for (let i = 0; i < 20; i++) {
    const { puzzle } = makePuzzle(150000 + i);
    const counts = new Map();
    for (const cell of puzzle.allCells) counts.set(cell.letter, (counts.get(cell.letter) || 0) + 1);
    for (const word of puzzle.words) {
      assert.ok(gen.multisetFits(word.text, counts),
        '"' + word.text + '" is placed but fails the multiset filter');
    }
  }
});

test('every word is findable along shown edges from the start', () => {
  for (let i = 0; i < 40; i++) {
    const { puzzle } = makePuzzle(300000 + i);
    for (const word of puzzle.words) {
      const route = gen.findRoute(puzzle.cells, puzzle.edges, word.text);
      assert.ok(route, 'no route for "' + word.text + '"');
      assert.equal(gen.traceToWord(puzzle.cells, route), word.text);
      assert.ok(gen.isValidTrace(puzzle.cells, puzzle.edges, route));
    }
  }
});

/* ------------------------------------------------------------------ *
 * Removal + compaction
 * ------------------------------------------------------------------ */

test('solving in random order keeps the invariant exact until the board empties', () => {
  for (let i = 0; i < SOLVE_COUNT; i++) {
    const { puzzle, rng } = makePuzzle(400000 + i);
    const order = gen.shuffled(puzzle.words.map((_w, idx) => idx), rng);
    for (const index of order) {
      const target = puzzle.words[index].text;
      const result = gen.removeWord(puzzle, index);
      assert.ok(result, 'removeWord failed for "' + target + '"');

      const context = 'after removing "' + target + '" (seed ' + (400000 + i) + ')';
      assertBoardHealthy(puzzle, context);

      // Nothing that another word still needs may have been removed.
      const stillNeeded = new Set();
      for (const word of puzzle.words) {
        if (word.found) continue;
        for (const id of word.cellIds) stillNeeded.add(id);
      }
      for (const id of result.removedIds) {
        assert.ok(!stillNeeded.has(id), 'removed a node another word still needs ' + context);
      }
      // Every remaining word is still findable by any route.
      for (const word of puzzle.words) {
        if (word.found) continue;
        assert.ok(gen.isTraceable(puzzle.cells, puzzle.edges, word.text),
          '"' + word.text + '" became untraceable ' + context);
      }
    }
    assert.equal(puzzle.cells.length, 0, 'board not empty after all words found');
    assert.equal(puzzle.edges.length, 0, 'edges left after all words found');
  }
});

test('shared letters survive while another word still needs them', () => {
  let sawSharedSurvivor = false;
  for (let i = 0; i < 40 && !sawSharedSurvivor; i++) {
    const { puzzle } = makePuzzle(500000 + i);
    const first = puzzle.words.findIndex(w => !w.isLong);
    const doomed = puzzle.words[first];
    const others = new Set();
    for (const word of puzzle.words) {
      if (word === doomed) continue;
      for (const id of word.cellIds) others.add(id);
    }
    const shared = doomed.cellIds.filter(id => others.has(id));
    const result = gen.removeWord(puzzle, first);
    for (const id of shared) {
      assert.ok(puzzle.cells.some(c => c.id === id),
        'a shared letter disappeared while still needed');
      assert.ok(!result.removedIds.includes(id));
    }
    // Letters used only by the solved word must be gone.
    for (const id of doomed.cellIds) {
      if (others.has(id)) continue;
      assert.ok(!puzzle.cells.some(c => c.id === id), 'orphan letter stayed on the board');
    }
    if (shared.length) sawSharedSurvivor = true;
  }
  assert.ok(sawSharedSurvivor, 'no puzzle produced a shared letter — words are not entangled');
});

test('compaction slides components without overlaps or new crossings', () => {
  for (let i = 0; i < 30; i++) {
    const { puzzle, rng } = makePuzzle(600000 + i);
    const order = gen.shuffled(puzzle.words.map((_w, idx) => idx), rng);
    for (const index of order.slice(0, Math.ceil(order.length / 2))) {
      gen.removeWord(puzzle, index);
      gen.collapse(puzzle);   // idempotent: a second pass must stay legal
      const keys = puzzle.cells.map(c => c.x + ',' + c.y);
      assert.equal(new Set(keys).size, keys.length, 'compaction overlapped cells');
      assert.ok(puzzle.cells.every(c => c.x >= 0 && c.y >= 0), 'board not recentred');
      assertBoardHealthy(puzzle, 'after an extra collapse pass');
    }
  }
});

test('clonePuzzle produces an independent board', () => {
  const { puzzle } = makePuzzle(700001);
  const clone = gen.clonePuzzle(puzzle);
  assert.equal(clone.cells.length, puzzle.cells.length);
  const before = puzzle.cells.length;
  gen.removeWord(clone, 0);
  // Solving marks the clone and leaves the original completely alone. The
  // board does not necessarily shrink: on a dense board every letter of the
  // solved word can still be needed by other words.
  assert.equal(clone.words[0].found, true);
  assert.equal(puzzle.words[0].found, false);
  assert.equal(puzzle.cells.length, before, 'removeWord mutated the original');
  assert.ok(clone.cells.length <= before);
});

/* ------------------------------------------------------------------ *
 * Stars, seeds and plurals
 * ------------------------------------------------------------------ */

test('stars are spent as the clock drains, and running out is a loss', () => {
  const m = 60 * 1000;
  const hard = engine.scheduleFor('hard');
  assert.equal(engine.starsFor(0, hard), 5);
  assert.equal(engine.starsFor(4.99 * m, hard), 5);
  assert.equal(engine.starsFor(5 * m, hard), 4, 'five minutes exactly costs the first star');
  assert.equal(engine.starsFor(5.99 * m, hard), 4);
  assert.equal(engine.starsFor(6 * m, hard), 3);
  assert.equal(engine.starsFor(7.49 * m, hard), 3);
  assert.equal(engine.starsFor(7.5 * m, hard), 2);
  assert.equal(engine.starsFor(9.99 * m, hard), 2);
  assert.equal(engine.starsFor(10 * m, hard), 0, 'the deadline is a loss, not a one-star finish');

  // Easy runs a tighter ladder over a shorter, five-minute vial.
  const easy = engine.scheduleFor('easy');
  assert.equal(engine.starsFor(2.99 * m, easy), 5);
  assert.equal(engine.starsFor(3 * m, easy), 4);
  assert.equal(engine.starsFor(3.5 * m, easy), 3);
  assert.equal(engine.starsFor(4 * m, easy), 2);
  assert.equal(engine.starsFor(4.5 * m, easy), 1);
  assert.equal(engine.starsFor(5 * m, easy), 0);

  // The last tier boundary IS the deadline, in both modes.
  assert.equal(hard.tiers[hard.tiers.length - 1].withinMs, hard.failMs);
  assert.equal(easy.tiers[easy.tiers.length - 1].withinMs, easy.failMs);

  // An unknown mode falls back to hard rather than throwing.
  assert.equal(engine.starsFor(0, 'nonsense'), 5);

  // The countdown drives the HUD, so it must track the same boundaries.
  assert.equal(engine.msToNextStarLoss(0, hard), 5 * m);
  assert.equal(engine.msToNextStarLoss(4 * m, hard), 1 * m);
  assert.equal(engine.msToNextStarLoss(10 * m, hard), null);
  assert.equal(engine.msToNextStarLoss(0, easy), 3 * m);
});

test('an extra word can buy a star back', () => {
  const { puzzle } = makePuzzle(910001);
  const game = engine.createGame({ puzzle: puzzle, dict: LEXICON.words });
  engine.tick(game, 5 * 60 * 1000 + 2000);       // just past the first threshold
  assert.equal(engine.starsFor(game.elapsedMs, game.schedule), 4);
  engine.creditTime(game, 10 * 1000);            // an extra word pays out
  assert.equal(engine.starsFor(game.elapsedMs, game.schedule), 5, 'time credit did not restore the star');
});

test('the mode picks the schedule the game is played on', () => {
  const { puzzle } = makePuzzle(910003);
  const hard = engine.createGame({ puzzle: puzzle, dict: new Set(), mode: 'hard' });
  const easy = engine.createGame({ puzzle: puzzle, dict: new Set(), mode: 'easy' });
  assert.equal(hard.schedule.failMs, 10 * 60 * 1000);
  assert.equal(easy.schedule.failMs, 5 * 60 * 1000);
  // No mode at all is hard, so an old-style call still behaves.
  assert.equal(engine.createGame({ puzzle: puzzle, dict: new Set() }).schedule.failMs, 10 * 60 * 1000);
});

test('a plural is reported as a plural, not as gibberish', () => {
  const { puzzle } = makePuzzle(910002);
  const dict = new Set(['reel', 'box', 'city', 'glass']);
  const game = engine.createGame({ puzzle: puzzle, dict: dict });
  assert.equal(engine.submitWord(game, 'reels').type, 'plural');
  assert.equal(engine.submitWord(game, 'boxes').type, 'plural');
  assert.equal(engine.submitWord(game, 'cities').type, 'plural');
  // Words that merely end in s are not plurals of anything: "glass" is in the
  // dictionary and pays out as an extra, "qwxzs" is simply not a word.
  assert.equal(engine.submitWord(game, 'glass').type, 'extra');
  assert.equal(engine.submitWord(game, 'qwxzs').type, 'unknown');
});

test('a seed rebuilds the identical board', () => {
  for (const seed of [1, 42, 987654321]) {
    const a = gen.generatePuzzle(Object.assign({
      seed: seed, words: WORDS, longWords: LONG_WORDS, lexicon: LEXICON
    }, FAST));
    const b = gen.generatePuzzle(Object.assign({
      seed: seed, words: WORDS, longWords: LONG_WORDS, lexicon: LEXICON
    }, FAST));
    assert.ok(a && b, 'generation failed for seed ' + seed);
    assert.equal(a.seed, seed, 'puzzle did not record its seed');
    assert.deepEqual(
      a.words.map(w => w.text).sort(), b.words.map(w => w.text).sort(),
      'seed ' + seed + ' produced two different boards'
    );
    assert.deepEqual(
      a.cells.map(c => c.letter + c.x + ',' + c.y),
      b.cells.map(c => c.letter + c.x + ',' + c.y),
      'seed ' + seed + ' produced two different layouts'
    );
  }
  // Sharing is pointless if every seed gives the same puzzle.
  const one = gen.generatePuzzle(Object.assign({ seed: 5, words: WORDS, longWords: LONG_WORDS, lexicon: LEXICON }, FAST));
  const two = gen.generatePuzzle(Object.assign({ seed: 6, words: WORDS, longWords: LONG_WORDS, lexicon: LEXICON }, FAST));
  assert.notDeepEqual(one.words.map(w => w.text), two.words.map(w => w.text));
});

/* ------------------------------------------------------------------ *
 * Performance
 * ------------------------------------------------------------------ */

test('generation is fast', () => {
  const times = [];
  for (let i = 0; i < 60; i++) {
    const start = Date.now();
    gen.generatePuzzle(Object.assign({ rng: gen.createRng(800000 + i), words: WORDS, longWords: LONG_WORDS }, FAST));
    times.push(Date.now() - start);
  }
  times.sort((a, b) => a - b);
  const median = times[Math.floor(times.length / 2)];
  assert.ok(median < 150, 'generation median too slow: ' + median + 'ms');
});

/* ------------------------------------------------------------------ *
 * Engine — stopwatch model
 * ------------------------------------------------------------------ */

function newGame(seed, dictWords) {
  const { puzzle } = makePuzzle(seed);
  const dict = engine.buildDict((dictWords || EXTRA_WORDS).join(' '));
  return { game: engine.createGame({ puzzle: puzzle, dict: dict }), puzzle: puzzle };
}

test('the clock runs the game out at the deadline', () => {
  const { game } = newGame(900001);
  assert.equal(game.elapsedMs, 0);
  assert.equal(game.status, 'playing');
  assert.equal(engine.tick(game, 1000), false);
  assert.equal(game.elapsedMs, 1000);
  assert.equal(engine.tick(game, 598999), false, 'a millisecond short is still playable');
  assert.equal(game.status, 'playing');

  // The tick that reaches the deadline reports it, exactly once.
  assert.equal(engine.tick(game, 1), true, 'the deadline tick must announce the loss');
  assert.equal(game.elapsedMs, 600000, 'the clock is pinned at the deadline, never past it');
  assert.equal(game.status, 'lost');
  assert.ok(game.finishedAt, 'a lost game records when it ended');
  assert.equal(engine.tick(game, 999999), false, 'a lost game does not keep ticking');
  assert.equal(game.elapsedMs, 600000);
  assert.equal(engine.submitWord(game, EXTRA_WORDS[0]).type, 'inactive');

  assert.equal(engine.formatTime(0), '0:00');
  assert.equal(engine.formatTime(65000), '1:05');
  assert.equal(engine.formatTime(600000), '10:00');
});

test('easy mode runs out twice as fast as hard', () => {
  const { puzzle } = makePuzzle(900011);
  const game = engine.createGame({ puzzle: puzzle, dict: new Set(), mode: 'easy' });
  assert.equal(engine.tick(game, 5 * 60 * 1000 - 1), false);
  assert.equal(game.status, 'playing');
  assert.equal(engine.tick(game, 1), true);
  assert.equal(game.status, 'lost');
  assert.equal(engine.starsFor(game.elapsedMs, game.schedule), 0);
});

test('traces shorter than four letters are always rejected', () => {
  const { game, puzzle } = newGame(900002, ['cat', 'ate'].concat(EXTRA_WORDS));
  assert.equal(engine.submitWord(game, 'cat').type, 'short');
  assert.equal(engine.submitWord(game, 'ate').type, 'short');
  assert.equal(engine.submitWord(game, 'a').type, 'short');
  assert.equal(engine.submitWord(game, 'qqqqq').type, 'unknown');
  assert.equal(game.extraWords.length, 0);
  assert.equal(puzzle.words.every(w => !w.found), true);
});

test('extra words subtract time once each, clamped at zero', () => {
  const { game, puzzle } = newGame(900003);
  const puzzleTexts = new Set(puzzle.words.map(w => w.text));
  const extra = EXTRA_WORDS.find(w => !puzzleTexts.has(w) && w.length === 5) ||
    EXTRA_WORDS.find(w => !puzzleTexts.has(w));
  assert.ok(extra, 'need an extra word outside the puzzle');

  engine.tick(game, 120000);
  const before = game.elapsedMs;
  const first = engine.submitWord(game, extra);
  assert.equal(first.type, 'extra');
  assert.equal(first.seconds, engine.extraSeconds(extra.length));
  assert.equal(game.elapsedMs, before - first.seconds * 1000);
  assert.equal(game.savedMs, first.seconds * 1000);

  const repeat = engine.submitWord(game, extra);
  assert.equal(repeat.type, 'repeat-extra');
  assert.equal(game.extraWords.length, 1);
  assert.equal(game.elapsedMs, before - first.seconds * 1000, 'repeat must not credit again');

  // Clamp at zero.
  const fresh = newGame(900004).game;
  engine.tick(fresh, 2000);
  const clamped = engine.creditTime(fresh, 30000);
  assert.equal(fresh.elapsedMs, 0);
  assert.equal(clamped, 2000, 'credit is capped by the elapsed time');

  assert.equal(engine.extraSeconds(4), 5);
  assert.equal(engine.extraSeconds(8), 15);
  assert.equal(engine.extraSeconds(11), 15);
});

test('solving every word wins the game and reports the counter', () => {
  const { game, puzzle } = newGame(900005);
  const total = puzzle.words.length;
  assert.equal(engine.totalWords(game), total);
  assert.equal(engine.solvedCount(game), 0);

  engine.tick(game, 45000);
  const texts = puzzle.words.map(w => w.text);
  let last = null;
  for (let i = 0; i < texts.length; i++) {
    last = engine.submitWord(game, texts[i]);
    assert.equal(last.type, 'required', 'failed to solve "' + texts[i] + '"');
    assert.equal(engine.solvedCount(game), i + 1);
  }
  assert.equal(last.solved, true);
  assert.equal(game.status, 'won');
  assert.equal(game.foundWords.length, total);
  assert.equal(puzzle.cells.length, 0);
  assert.equal(game.elapsedMs, 45000, 'solving words does not change the clock by default');
  // Nothing counts once the game is over.
  assert.equal(engine.submitWord(game, texts[0]).type, 'inactive');
  assert.equal(engine.tick(game, 5000), false);
  assert.equal(game.elapsedMs, 45000, 'the stopwatch stops when the puzzle is solved');
});

test('the game ends if and only if every normal word is solved and the board is empty', () => {
  for (let i = 0; i < 60; i++) {
    const { puzzle, rng } = makePuzzle(950000 + i);
    const dict = engine.buildDict(EXTRA_WORDS.join(' '));
    // The deadline is tested on its own; here it is pushed out of reach so the
    // only thing that can end the game is the board emptying.
    const endless = { failMs: Infinity, tiers: [{ stars: 5, withinMs: Infinity }] };
    const game = engine.createGame({ puzzle: puzzle, dict: dict, schedule: endless });
    const order = gen.shuffled(puzzle.words.map((_w, idx) => idx), rng);

    for (let step = 0; step < order.length; step++) {
      const word = puzzle.words[order[step]];
      const isLast = step === order.length - 1;

      // Before the last word the board must still hold letters.
      assert.ok(puzzle.cells.length > 0, 'board emptied before the last word');
      assert.equal(game.status, 'playing', 'game ended early');

      // Short of the deadline, time passing never ends the game.
      engine.tick(game, 600000);
      assert.equal(game.status, 'playing', 'the clock ended the game before the board emptied');

      // Extras never end the game either.
      const puzzleTexts = new Set(puzzle.words.map(w => w.text));
      const extra = EXTRA_WORDS.find(w => !puzzleTexts.has(w) && !game.extraWords.some(e => e.word === w));
      if (extra) {
        engine.submitWord(game, extra);
        assert.equal(game.status, 'playing', 'an extra word ended the game');
        assert.ok(puzzle.cells.length > 0, 'an extra word removed letters from the board');
      }

      const result = engine.submitWord(game, word.text);
      assert.equal(result.type, 'required');

      // THE biconditional, checked at this exact moment.
      const allSolved = puzzle.words.every(w => w.found);
      const boardEmpty = puzzle.cells.length === 0 && puzzle.edges.length === 0;
      assert.equal(allSolved, boardEmpty,
        'board emptiness must track solving every normal word (step ' + step + ')');
      assert.equal(game.status === 'won', allSolved,
        'win state must trigger exactly when the last normal word is solved');
      assert.equal(result.solved, allSolved);
      assert.equal(allSolved, isLast, 'the win must land on the final word, no earlier');
    }

    assert.equal(game.status, 'won');
    assert.equal(engine.solvedCount(game), puzzle.words.length);
    assert.equal(puzzle.cells.length, 0);
    assert.equal(puzzle.edges.length, 0);
    // There is no other end condition: nothing can be submitted afterwards.
    assert.equal(engine.submitWord(game, EXTRA_WORDS[0]).type, 'inactive');
    assert.equal(engine.tick(game, 999999), false);
  }
});

test('the longest word is reported through the result so the HUD can celebrate', () => {
  const { game, puzzle } = newGame(900006);
  const long = puzzle.words.find(w => w.isLong);
  const regular = puzzle.words.find(w => !w.isLong);
  assert.equal(engine.submitWord(game, regular.text).isLong, false);
  assert.equal(engine.submitWord(game, long.text).isLong, true);
  assert.equal(engine.submitWord(game, long.text).type, 'repeat-required');
});

test('the solved-word time credit is tunable', () => {
  const { puzzle } = makePuzzle(900007);
  const game = engine.createGame({ puzzle: puzzle, dict: new Set(), solvedCreditMs: 5000 });
  engine.tick(game, 60000);
  const result = engine.submitWord(game, puzzle.words[0].text);
  assert.equal(result.timeSaved, 5000);
  assert.equal(game.elapsedMs, 55000);
});


/* ------------------------------------------------------------------ *
 * The guarantee: every word that EXISTS in the puzzle works
 * ------------------------------------------------------------------ */

const PROPERTY_COUNT = 60;

/**
 * Submit every word the board can currently spell through the real engine.
 * Nothing traceable may ever come back 'unknown', and the normal/extra split
 * must follow commonness, not construction history.
 */
function assertEveryTraceableWordWorks(game, lexicon, context) {
  const puzzle = game.puzzle;
  const traceable = gen.enumerateWords(puzzle.cells, puzzle.edges, lexicon);
  const remaining = new Set(puzzle.words.filter(w => !w.found).map(w => w.text));
  const solved = new Set(puzzle.words.filter(w => w.found).map(w => w.text));

  for (const [word, route] of traceable) {
    // The route the enumerator found must be a legal trace.
    assert.ok(gen.isValidTrace(puzzle.cells, puzzle.edges, route),
      'enumerated route for "' + word + '" is not traceable ' + context);
    assert.equal(gen.traceToWord(puzzle.cells, route), word);

    if (lexicon.isCommon(word)) {
      // A common word is ALWAYS a normal word: solved already, or still to go.
      assert.ok(remaining.has(word) || solved.has(word),
        'traceable common word "' + word + '" is not in the normal set ' + context);
    }
    if (solved.has(word)) continue;         // already melted away, nothing to submit

    const before = game.puzzle.words.filter(w => !w.found).length;
    const result = engine.submitWord(game, word);
    assert.notEqual(result.type, 'unknown',
      'traceable word "' + word + '" was rejected as not-a-word ' + context);
    assert.notEqual(result.type, 'short', '"' + word + '" wrongly judged too short');

    if (result.type === 'required') {
      // Undo: this probe must not actually advance the game.
      assert.ok(remaining.has(word));
      assert.equal(game.puzzle.words.filter(w => !w.found).length, before - 1);
      return { probedSolve: word };
    }
    assert.ok(result.type === 'extra' || result.type === 'repeat-extra',
      'unexpected verdict "' + result.type + '" for "' + word + '" ' + context);
    // Extras are exclusively rare words.
    assert.equal(lexicon.isCommon(word), false,
      'common word "' + word + '" surfaced as an extra ' + context);
  }
  return { probedSolve: null };
}

test('every traceable common word is a normal word, and extras are only rare words', () => {
  for (let i = 0; i < PROPERTY_COUNT; i++) {
    const { puzzle } = makePuzzle(1100000 + i);
    const traceable = gen.enumerateWords(puzzle.cells, puzzle.edges, LEXICON);
    const normal = new Set(puzzle.words.map(w => w.text));

    // 1. Promotion is total: no traceable common word is left out.
    for (const word of traceable.keys()) {
      if (!LEXICON.isCommon(word)) continue;
      assert.ok(normal.has(word),
        'traceable common word "' + word + '" was left out of the normal set');
    }
    // 2. Every normal word is genuinely traceable.
    for (const word of puzzle.words) {
      assert.ok(traceable.has(word.text),
        'normal word "' + word.text + '" is not traceable on its own board');
      assert.ok(LEXICON.isCommon(word.text),
        'normal word "' + word.text + '" is not a common word');
    }
    // 3. Exactly one 8+ letter word can be traced, and it is the base word.
    const longs = Array.from(traceable.keys())
      .filter(w => w.length >= gen.CONFIG.longMin && LEXICON.isCommon(w));
    assert.deepEqual(longs, [puzzle.longWord], 'a rival long common word is traceable');
    // 4. The base word is the longest word in the normal set.
    for (const word of puzzle.words) {
      if (word.isLong) continue;
      assert.ok(word.text.length < puzzle.longWord.length,
        '"' + word.text + '" is not shorter than the base word');
    }
  }
});

test('no traceable word is ever rejected, at the start or after any solve', () => {
  for (let i = 0; i < PROPERTY_COUNT; i++) {
    const { puzzle, rng } = makePuzzle(1200000 + i);
    const game = engine.createGame({ puzzle: puzzle, dict: LEXICON.words });
    const seed = 'seed ' + (1200000 + i);

    assertEveryTraceableWordWorks(game, LEXICON, 'at the start (' + seed + ')');

    const order = gen.shuffled(puzzle.words.map((_w, idx) => idx), rng);
    let step = 0;
    for (const index of order) {
      const word = puzzle.words[index];
      if (word.found) continue;             // a probe may have solved it already
      const result = engine.submitWord(game, word.text);
      assert.equal(result.type, 'required', 'could not solve "' + word.text + '"');
      step++;
      assertBoardHealthy(puzzle, 'after solve ' + step + ' (' + seed + ')');
      assertEveryTraceableWordWorks(game, LEXICON, 'after solve ' + step + ' (' + seed + ')');
    }
    assert.equal(puzzle.cells.length, 0, 'board not empty after every word was solved');
    assert.equal(game.status, 'won');
  }
});

test('enumeration is monotone: solving never makes a new word traceable', () => {
  for (let i = 0; i < 40; i++) {
    const { puzzle, rng } = makePuzzle(1300000 + i);
    let previous = new Set(gen.enumerateWords(puzzle.cells, puzzle.edges, LEXICON).keys());
    const order = gen.shuffled(puzzle.words.map((_w, idx) => idx), rng);
    for (const index of order) {
      gen.removeWord(puzzle, index);
      const now = new Set(gen.enumerateWords(puzzle.cells, puzzle.edges, LEXICON).keys());
      for (const word of now) {
        assert.ok(previous.has(word),
          '"' + word + '" became traceable only after a removal — enumeration is not monotone');
      }
      previous = now;
    }
  }
});

test('the lexicon answers membership, commonness and prefixes', () => {
  assert.equal(LEXICON.has('stone'), true);
  assert.equal(LEXICON.has('zzzzz'), false);
  assert.equal(LEXICON.isCommon('stone'), true);
  assert.equal(LEXICON.isCommon('anlace'), false, 'rare words are not common');
  assert.equal(LEXICON.has('anlace'), true, 'rare words are still real words');
  assert.equal(LEXICON.isPrefix('sto'), true);
  assert.equal(LEXICON.isPrefix('zqx'), false);
  // Past the indexed depth the prefix test degrades to "maybe", never to "no".
  assert.equal(LEXICON.isPrefix('a'.repeat(gen.PREFIX_DEPTH + 1)), true);
  for (const word of WORDS.concat(LONG_WORDS)) {
    assert.equal(LEXICON.isCommon(word), true, word + ' should be common');
    for (let n = 1; n <= Math.min(gen.PREFIX_DEPTH, word.length); n++) {
      assert.equal(LEXICON.isPrefix(word.slice(0, n)), true);
    }
  }
});

/* ------------------------------------------------------------------ *
 * Tracing (regression: valid words were reaching the engine truncated)
 * ------------------------------------------------------------------ */

/**
 * Sample a route the way a real finger does: points spaced evenly ALONG the
 * path, at an arbitrary phase, so they land between tiles rather than
 * conveniently on top of them. `spacing` is in svg units; one tile step is
 * 100, so spacing 80 means roughly one pointer sample per tile — already a
 * brisk swipe. Browsers deliver 60-120 samples a second, i.e. far denser.
 */
function samplePath(points, spacing, phase) {
  const out = [points[0]];
  let carry = phase;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const d = Math.hypot(b.x - a.x, b.y - a.y);
    let t = carry;
    while (t < d) {
      out.push({ x: a.x + ((b.x - a.x) * t) / d, y: a.y + ((b.y - a.y) * t) / d });
      t += spacing;
    }
    carry = t - d;
  }
  out.push(points[points.length - 1]);
  return out;
}

function makeTracer(puzzle, options) {
  const positions = new Map(puzzle.cells.map(c => [c.id, { x: c.x * input.STEP, y: c.y * input.STEP }]));
  const adjacency = gen.adjacencyMap(puzzle.cells, puzzle.edges);
  const tracer = input.createTracer({
    getAdjacency: () => adjacency,
    nodeAt: (point, radius, filter) => input.nearestNode(positions, point, radius, filter)
  }, options);
  return { tracer: tracer, positions: positions, adjacency: adjacency };
}

/** Drive the pure tracer along a route with realistic pointer sampling. */
function traceRoute(puzzle, route, spacing, phase, options) {
  const rig = makeTracer(puzzle, options);
  const points = route.map(id => rig.positions.get(id));
  rig.tracer.down(points[0]);
  for (const point of samplePath(points, spacing, phase || 0).slice(1)) rig.tracer.move(point);
  return rig.tracer.end();
}

test('a traced word reaches the engine complete, however coarsely it is sampled', () => {
  // The regression: sparse pointer samples used to skip tiles, so a perfectly
  // good word arrived at the engine truncated ("surge" -> "surg") and was
  // rejected as not-a-word. The tracer now walks each pointer segment.
  for (const spacing of [15, 40, 65, 80]) {
    for (const phase of [0, 23]) {
      for (let i = 0; i < 20; i++) {
        const { puzzle } = makePuzzle(1400000 + i);
        for (const word of puzzle.words) {
          const ids = traceRoute(puzzle, word.cellIds, spacing, phase);
          assert.deepEqual(ids, word.cellIds,
            'sampling every ' + spacing + ' units mangled "' + word.text + '" -> "' +
            gen.traceToWord(puzzle.cells, ids) + '"');
        }
      }
    }
  }
});

test('walking the pointer segment beats sampling only at the reported points', () => {
  // Same routes, sampled sparsely enough to hurt. Walking the segment must be
  // strictly better than the old point-sampling behaviour.
  let walked = 0;
  let pointOnly = 0;
  let total = 0;
  for (let i = 0; i < 20; i++) {
    const { puzzle } = makePuzzle(1450000 + i);
    for (const word of puzzle.words) {
      total++;
      const a = traceRoute(puzzle, word.cellIds, 130, 11);
      const b = traceRoute(puzzle, word.cellIds, 130, 11, { walkStep: 1e9, lockRadius: 58 });
      if (gen.traceToWord(puzzle.cells, a) === word.text) walked++;
      if (gen.traceToWord(puzzle.cells, b) === word.text) pointOnly++;
    }
  }
  assert.ok(walked > pointOnly,
    'segment walking (' + walked + '/' + total + ') should beat point sampling (' +
    pointOnly + '/' + total + ')');
});

test('the tracer never locks a tile that is not connected to the trace', () => {
  const { puzzle } = makePuzzle(1500001);
  const adjacency = gen.adjacencyMap(puzzle.cells, puzzle.edges);
  for (const word of puzzle.words) {
    const ids = traceRoute(puzzle, word.cellIds, 30, 7);
    for (let i = 1; i < ids.length; i++) {
      assert.ok(adjacency.get(ids[i - 1]).has(ids[i]),
        'tracer locked a tile with no connecting lane');
    }
    assert.equal(new Set(ids).size, ids.length, 'tracer reused a tile');
  }
});

test('backtracking over the previous tile undoes a step', () => {
  const { puzzle } = makePuzzle(1500002);
  const rig = makeTracer(puzzle);
  const tracer = rig.tracer;
  const positions = rig.positions;
  const route = puzzle.words[0].cellIds;
  tracer.down(positions.get(route[0]));
  tracer.move(positions.get(route[1]));
  tracer.move(positions.get(route[2]));
  assert.equal(tracer.current().length, 3);
  tracer.move(positions.get(route[1]));   // drift back
  assert.deepEqual(tracer.current(), [route[0], route[1]]);
});

/* ------------------------------------------------------------------ *
 * Feedback split
 * ------------------------------------------------------------------ */

test('repeats, short traces and non-words are three distinct verdicts', () => {
  const { puzzle } = makePuzzle(1600001);
  const game = engine.createGame({ puzzle: puzzle, dict: LEXICON.words });
  const normal = puzzle.words.find(w => !w.isLong).text;

  assert.equal(engine.submitWord(game, 'ate').type, 'short');
  assert.equal(engine.submitWord(game, 'qwxzj').type, 'unknown');

  assert.equal(engine.submitWord(game, normal).type, 'required');
  assert.equal(engine.submitWord(game, normal).type, 'repeat-required',
    'a solved word must read as already-found, not as a non-word');

  const traceable = gen.enumerateWords(puzzle.cells, puzzle.edges, LEXICON);
  const rare = Array.from(traceable.keys()).find(w => !LEXICON.isCommon(w));
  if (rare) {
    assert.equal(engine.submitWord(game, rare).type, 'extra');
    assert.equal(engine.submitWord(game, rare).type, 'repeat-extra',
      'a found extra must read as already-found, not as a non-word');
  }
});

/* ------------------------------------------------------------------ *
 * Real data files (only when they match the current contract)
 * ------------------------------------------------------------------ */

const realData = (() => {
  const sandbox = {};
  try {
    const previous = global.window;
    global.window = sandbox;
    require(path.join(__dirname, '../../static/lettermelt/data/common.js'));
    global.window = previous;
  } catch (_e) {
    return null;
  }
  if (!Array.isArray(sandbox.ZAN_COMMON_LONG) || !sandbox.ZAN_COMMON_LONG.length) return null;
  if (!Array.isArray(sandbox.ZAN_COMMON) || !sandbox.ZAN_COMMON.length) return null;
  try {
    const previous = global.window;
    global.window = sandbox;
    require(path.join(__dirname, '../../static/lettermelt/data/dict.js'));
    global.window = previous;
  } catch (_e) {
    return null;
  }
  if (typeof sandbox.ZAN_DICT_RAW !== 'string' || !sandbox.ZAN_DICT_RAW.length) return null;
  // Mirror the game: every long word counts as common, but base words are
  // drawn from the stricter ZAN_BASE subset.
  sandbox.ZAN_BASE = Array.isArray(sandbox.ZAN_BASE) && sandbox.ZAN_BASE.length
    ? sandbox.ZAN_BASE
    : sandbox.ZAN_COMMON_LONG;
  sandbox.lexicon = gen.buildLexicon(
    sandbox.ZAN_DICT_RAW, sandbox.ZAN_COMMON, sandbox.ZAN_COMMON_LONG, sandbox.ZAN_BASE
  );
  return sandbox;
})();

test('real boards are dense, fresh, and score as fun', { skip: !realData ? 'no real data' : false }, () => {
  const density = [];
  const subwords = [];
  const scores = [];
  for (let i = 0; i < 25; i++) {
    const puzzle = gen.generatePuzzle({
      rng: gen.createRng(7000000 + i),
      words: realData.ZAN_COMMON,
      longWords: realData.ZAN_BASE,
      lexicon: realData.lexicon
    });
    assert.ok(puzzle, 'generation failed');
    assert.ok(puzzle.quality, 'puzzle carries no quality report');
    density.push(puzzle.quality.parts.lettersPerCell);
    subwords.push(puzzle.quality.parts.subwordPairs);
    scores.push(puzzle.quality.score);
  }
  const avg = a => a.reduce((x, y) => x + y, 0) / a.length;
  // Letters must be pulling their weight in several words each.
  assert.ok(avg(density) >= 3.5, 'boards not dense enough: ' + avg(density).toFixed(2) + ' letters/cell');
  // print/printer pairs pad the word count without being separate finds.
  // (race/trace and cell/cellar are fine — different words, real discoveries.)
  assert.ok(avg(subwords) <= 0.4, 'too many same-root pairs: ' + avg(subwords).toFixed(2) + ' per board');
  assert.ok(Math.min(...scores) >= 45, 'a board scored far below the quality bar: ' + Math.min(...scores));
});

test('the quality score reacts to the things it claims to measure', () => {
  const { puzzle } = makePuzzle(880011);
  const baseline = gen.scorePuzzle(puzzle, LEXICON, 20);
  assert.ok(baseline.score >= 0 && baseline.score <= 100, 'score out of range: ' + baseline.score);

  // Planting the SAME WORD in another form must cost freshness.
  const withDerived = JSON.parse(JSON.stringify(puzzle));
  const host = withDerived.words.find(w => !w.isLong) || withDerived.words[0];
  withDerived.words.push({
    text: host.text + (host.text.endsWith('e') ? 'r' : 'er'),
    cellIds: host.cellIds.slice(),
    found: false,
    isLong: false
  });
  const dirty = gen.scorePuzzle(withDerived, LEXICON, 20);
  assert.ok(dirty.parts.subwordPairs > baseline.parts.subwordPairs, 'same-root pair went uncounted');
  assert.ok(dirty.parts.freshness < baseline.parts.freshness, 'freshness ignored the same-root pair');

  // But a different word that merely overlaps must NOT be penalised: finding
  // "race" after "trace" is a real second discovery.
  const withOverlap = JSON.parse(JSON.stringify(puzzle));
  withOverlap.words.push({
    text: 'race', cellIds: host.cellIds.slice(0, 4), found: false, isLong: false
  });
  withOverlap.words.push({
    text: 'trace', cellIds: host.cellIds.slice(0, 5), found: false, isLong: false
  });
  const overlapped = gen.scorePuzzle(withOverlap, LEXICON, 20);
  assert.equal(overlapped.parts.subwordPairs, baseline.parts.subwordPairs,
    'race/trace was wrongly counted as the same word');

  // More rare words to stumble on is worth more.
  const richer = gen.scorePuzzle(puzzle, LEXICON, 60);
  assert.ok(richer.parts.extras >= baseline.parts.extras, 'extras component ignored the rare-word count');
});

test('easy mode is a friendlier subset of the hard vocabulary', { skip: !realData ? 'no real data' : false }, () => {
  const hard = new Set(realData.ZAN_COMMON);
  const hardLong = new Set(realData.ZAN_COMMON_LONG);
  assert.ok(realData.ZAN_COMMON_EASY.length > 500, 'easy vocabulary too small to build boards');
  assert.ok(realData.ZAN_COMMON_EASY.length < realData.ZAN_COMMON.length,
    'easy vocabulary is not narrower than hard');
  for (const word of realData.ZAN_COMMON_EASY) {
    assert.ok(hard.has(word), 'easy word "' + word + '" is not a hard word');
  }
  for (const word of realData.ZAN_LONG_EASY) {
    assert.ok(hardLong.has(word), 'easy long word "' + word + '" is not a hard long word');
  }
});

test('base words are the recognisable subset of the long words', { skip: !realData ? 'no real data' : false }, () => {
  const long = new Set(realData.ZAN_COMMON_LONG);
  for (const word of realData.ZAN_BASE) {
    assert.ok(long.has(word), 'base word "' + word + '" is not in the common long list');
    assert.ok(word.length >= 8 && word.length <= 11, 'base word out of range: ' + word);
  }
  // Being common and being fit to headline a puzzle are different bars, so the
  // base pool must be a genuine subset rather than a copy of the long list.
  assert.ok(realData.ZAN_BASE.length < realData.ZAN_COMMON_LONG.length,
    'base pool is not narrower than the long list');
  assert.ok(realData.ZAN_BASE.length >= 400,
    'base pool too small for variety: ' + realData.ZAN_BASE.length);
});

test('real word lists carry no plural or past-tense forms', { skip: !realData ? 'no real data' : false }, () => {
  // Required words are the ones the counter tallies, so "metal" AND "metals"
  // both counting would inflate the target without adding anything to solve.
  // Stems are checked against the shipped dictionary; it starts at 4 letters,
  // so only stems that long are verifiable here (dogs/dog is caught at build
  // time against the full word list).
  const dict = new Set(String(realData.ZAN_DICT_RAW).split(/\s+/));
  // Nouns whose normal form ends in -s are deliberately kept: "binoculars" is
  // not "binocular" plus an s the way "reels" is "reel" plus an s.
  const pluralOnly = new Set([
    'scissors', 'trousers', 'pliers', 'tweezers', 'binoculars', 'pajamas',
    'jeans', 'goggles', 'shears', 'suds', 'dregs', 'alms', 'series', 'species',
    'news', 'shorts', 'tongs', 'bellows', 'premises', 'measles', 'mumps'
  ]);
  const offenders = [];
  for (const word of realData.ZAN_COMMON.concat(realData.ZAN_COMMON_LONG)) {
    if (pluralOnly.has(word)) continue;
    const plural = word.endsWith('s') && !word.endsWith('ss') && dict.has(word.slice(0, -1));
    const past = word.endsWith('ed') && !word.endsWith('eed') &&
      (dict.has(word.slice(0, -1)) || dict.has(word.slice(0, -2)));
    if (plural || past) offenders.push(word);
  }
  assert.deepStrictEqual(offenders, [], 'inflected forms leaked into the required-word lists');
});

test('real word lists build healthy puzzles', { skip: !realData ? 'data/common.js predates the ZAN_COMMON_LONG contract' : false }, () => {
  for (let i = 0; i < 30; i++) {
    const rng = gen.createRng(1000000 + i);
    const puzzle = gen.generatePuzzle({
      rng: rng,
      words: realData.ZAN_COMMON,
      longWords: realData.ZAN_BASE,
      lexicon: realData.lexicon,
      minFunScore: 0, restarts: 20
    });
    assert.ok(puzzle, 'generatePuzzle returned null on real data');
    assert.ok(puzzle.words.length >= 10 && puzzle.words.length <= 16,
      'real-data puzzle has ' + puzzle.words.length + ' words');
    assert.ok(puzzle.allCells.length <= 25, 'real-data puzzle exceeded the 5 x 5 grid');
    assert.equal(puzzle.words.filter(w => w.isLong).length, 1);
    assertBoardHealthy(puzzle, 'on real data');

    const order = gen.shuffled(puzzle.words.map((_w, idx) => idx), rng);
    for (const index of order) {
      gen.removeWord(puzzle, index);
      assertBoardHealthy(puzzle, 'on real data mid-solve');
    }
    assert.equal(puzzle.cells.length, 0);
  }
});

test('real word lists: every word that exists in the puzzle works', { skip: !realData ? 'no real data' : false }, () => {
  const lexicon = realData.lexicon;
  for (let i = 0; i < 20; i++) {
    const rng = gen.createRng(2000000 + i);
    const puzzle = gen.generatePuzzle({
      rng: rng,
      words: realData.ZAN_COMMON,
      longWords: realData.ZAN_BASE,
      lexicon: lexicon,
      minFunScore: 0, restarts: 20
    });
    assert.ok(puzzle, 'generatePuzzle returned null on real data');
    const game = engine.createGame({ puzzle: puzzle, dict: lexicon.words });
    const seed = 'real seed ' + (2000000 + i);

    // No traceable common word may be missing from the normal set, and the
    // base word is the only long one.
    const traceable = gen.enumerateWords(puzzle.cells, puzzle.edges, lexicon);
    const normal = new Set(puzzle.words.map(w => w.text));
    for (const word of traceable.keys()) {
      if (!lexicon.isCommon(word)) continue;
      assert.ok(normal.has(word), 'common word "' + word + '" left as an extra (' + seed + ')');
      if (word !== puzzle.longWord) {
        assert.ok(word.length < gen.CONFIG.longMin, 'rival long word "' + word + '" (' + seed + ')');
      }
    }
    assertEveryTraceableWordWorks(game, lexicon, 'at the start (' + seed + ')');

    const order = gen.shuffled(puzzle.words.map((_w, idx) => idx), rng);
    for (const index of order) {
      const word = puzzle.words[index];
      if (word.found) continue;
      assert.equal(engine.submitWord(game, word.text).type, 'required');
      assertBoardHealthy(puzzle, 'mid-solve (' + seed + ')');
      assertEveryTraceableWordWorks(game, lexicon, 'mid-solve (' + seed + ')');
    }
    assert.equal(puzzle.cells.length, 0);
    assert.equal(game.status, 'won');
  }
});

test('a shared seed rebuilds the same real puzzle', { skip: !realData ? 'no real data' : false }, () => {
  // The seed in a share link is the whole payload: whatever the recipient's
  // device does, it has to land on the identical board. This is the full
  // production path — real vocabulary, real restart count, no FAST shortcuts —
  // because that is where a wall-clock budget used to cut the search short at
  // a different point on every load.
  for (const seed of [3977333653, 42, 1]) {
    const build = () => gen.generatePuzzle({
      seed: seed,
      words: realData.ZAN_COMMON,
      longWords: realData.ZAN_BASE,
      lexicon: realData.lexicon
    });
    const a = build();
    const b = build();
    assert.ok(a && b, 'generation failed for seed ' + seed);
    assert.equal(a.seed, seed);
    assert.deepEqual(a.words.map(w => w.text), b.words.map(w => w.text),
      'seed ' + seed + ' built two different word sets');
    assert.deepEqual(
      a.cells.map(c => c.letter + '@' + c.x + ',' + c.y),
      b.cells.map(c => c.letter + '@' + c.x + ',' + c.y),
      'seed ' + seed + ' built two different layouts');
    assert.deepEqual(a.edges.map(e => e.a + '-' + e.b), b.edges.map(e => e.a + '-' + e.b),
      'seed ' + seed + ' built two different connection sets');
  }
});

test('real-data generation stays inside the time budget', { skip: !realData ? 'no real data' : false }, () => {
  const times = [];
  const counts = [];
  const cells = [];
  for (let i = 0; i < 50; i++) {
    const start = Date.now();
    const puzzle = gen.generatePuzzle({
      rng: gen.createRng(3000000 + i),
      words: realData.ZAN_COMMON,
      longWords: realData.ZAN_BASE,
      lexicon: realData.lexicon
    });
    times.push(Date.now() - start);
    assert.ok(puzzle, 'generation failed');
    counts.push(puzzle.words.length);
    cells.push(puzzle.cells.length);
  }
  times.sort((a, b) => a - b);
  const median = times[Math.floor(times.length / 2)];
  // Generation has no wall-clock governor — the restart count is the budget —
  // so this guards the cost of a full run rather than enforcing it.
  assert.ok(median < 400, 'median generation ' + median + 'ms is too slow to feel instant');
  // ...and the reason it has no governor: a deadline makes the board depend on
  // how fast the device happened to be, which breaks shared links.
  assert.equal(gen.CONFIG.timeBudgetMs, undefined, 'the generator must not be wall-clock bounded');
  assert.ok(Math.min(...counts) >= 10 && Math.max(...counts) <= 16,
    'word counts outside 10-16: ' + Math.min(...counts) + '-' + Math.max(...counts));
  assert.ok(Math.min(...cells) >= gen.CONFIG.minCells,
    'board sparser than minCells: ' + Math.min(...cells));
  assert.ok(Math.max(...cells) <= 25, 'board exceeded the grid: ' + Math.max(...cells));
  // Gaps are the point of relaxing the fill rule: real boards must actually
  // vary in silhouette rather than all arriving as a solid 5 x 5.
  assert.ok(new Set(cells).size >= 4,
    'cell counts barely varied: ' + Array.from(new Set(cells)).sort((a, b) => a - b).join(','));
});
