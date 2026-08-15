const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const gen = require(path.join(__dirname, '../../static/zanagrams/js/generator.js'));
const engine = require(path.join(__dirname, '../../static/zanagrams/js/engine.js'));

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

const PUZZLE_COUNT = 160;
const SOLVE_COUNT = PUZZLE_COUNT;   // every generated puzzle is solved right through

function makePuzzle(seed) {
  const rng = gen.createRng(seed);
  const puzzle = gen.generatePuzzle({ rng: rng, words: WORDS, longWords: LONG_WORDS });
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

test('generates puzzles of 15-20 words with exactly one 8-11 letter longest word', () => {
  let shortfall = 0;
  for (let i = 0; i < PUZZLE_COUNT; i++) {
    const { puzzle } = makePuzzle(100000 + i);
    if (puzzle.words.length < 15) shortfall++;
    assert.ok(puzzle.words.length >= 13, 'too few words: ' + puzzle.words.length);
    assert.ok(puzzle.words.length <= 20, 'too many words: ' + puzzle.words.length);

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
  // >= 15 words must be the overwhelmingly common case.
  assert.ok(shortfall <= PUZZLE_COUNT * 0.02,
    shortfall + '/' + PUZZLE_COUNT + ' puzzles fell below 15 words');
});

test('initial board is exactly the union of the word paths, with no crossings', () => {
  let nodeMin = Infinity;
  let nodeMax = 0;
  for (let i = 0; i < PUZZLE_COUNT; i++) {
    const { puzzle } = makePuzzle(200000 + i);
    assertBoardHealthy(puzzle, 'at generation (seed ' + (200000 + i) + ')');
    nodeMin = Math.min(nodeMin, puzzle.cells.length);
    nodeMax = Math.max(nodeMax, puzzle.cells.length);
    // Sharing must actually happen: far fewer nodes than letters.
    const letters = puzzle.words.reduce((sum, w) => sum + w.text.length, 0);
    assert.ok(puzzle.cells.length < letters * 0.8, 'words are not sharing letters');
    // Board fits a phone-portrait lattice.
    const maxX = Math.max(...puzzle.cells.map(c => c.x));
    const maxY = Math.max(...puzzle.cells.map(c => c.y));
    assert.ok(maxX < gen.CONFIG.cols && maxY < gen.CONFIG.rows,
      'board outside the lattice box: ' + (maxX + 1) + 'x' + (maxY + 1));
    assert.ok(gen.CONFIG.cols <= 10 && gen.CONFIG.rows <= 13, 'lattice must stay phone-portrait sized');
  }
  assert.ok(nodeMax <= 70, 'board unexpectedly dense: ' + nodeMax + ' nodes');
  assert.ok(nodeMin >= 20, 'board unexpectedly sparse: ' + nodeMin + ' nodes');
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
  gen.removeWord(clone, 0);
  assert.ok(clone.cells.length < puzzle.cells.length);
  assert.equal(puzzle.words[0].found, false);
});

/* ------------------------------------------------------------------ *
 * Performance
 * ------------------------------------------------------------------ */

test('generation is fast', () => {
  const times = [];
  for (let i = 0; i < 60; i++) {
    const start = Date.now();
    gen.generatePuzzle({ rng: gen.createRng(800000 + i), words: WORDS, longWords: LONG_WORDS });
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

test('the stopwatch counts up and never ends the game', () => {
  const { game } = newGame(900001);
  assert.equal(game.elapsedMs, 0);
  assert.equal(game.status, 'playing');
  assert.equal(engine.tick(game, 1000), false);
  assert.equal(game.elapsedMs, 1000);
  engine.tick(game, 599000);
  assert.equal(game.elapsedMs, 600000);
  assert.equal(game.status, 'playing', 'there is no lose state');
  assert.equal(engine.formatTime(0), '0:00');
  assert.equal(engine.formatTime(65000), '1:05');
  assert.equal(engine.formatTime(600000), '10:00');
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
 * Real data files (only when they match the current contract)
 * ------------------------------------------------------------------ */

const realData = (() => {
  const sandbox = {};
  try {
    const previous = global.window;
    global.window = sandbox;
    require(path.join(__dirname, '../../static/zanagrams/data/common.js'));
    global.window = previous;
  } catch (_e) {
    return null;
  }
  if (!Array.isArray(sandbox.ZAN_COMMON_LONG) || !sandbox.ZAN_COMMON_LONG.length) return null;
  if (!Array.isArray(sandbox.ZAN_COMMON) || !sandbox.ZAN_COMMON.length) return null;
  return sandbox;
})();

test('real word lists build healthy puzzles', { skip: !realData ? 'data/common.js predates the ZAN_COMMON_LONG contract' : false }, () => {
  for (let i = 0; i < 30; i++) {
    const rng = gen.createRng(1000000 + i);
    const puzzle = gen.generatePuzzle({
      rng: rng,
      words: realData.ZAN_COMMON,
      longWords: realData.ZAN_COMMON_LONG
    });
    assert.ok(puzzle, 'generatePuzzle returned null on real data');
    assert.ok(puzzle.words.length >= 15 && puzzle.words.length <= 20,
      'real-data puzzle has ' + puzzle.words.length + ' words');
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
