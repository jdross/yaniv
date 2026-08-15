const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const gen = require(path.join(__dirname, '../../static/zanagrams/js/generator.js'));
const engine = require(path.join(__dirname, '../../static/zanagrams/js/engine.js'));

// Fixed embedded list so the suite never depends on the generated data files.
const WORDS = [
  'cat', 'dog', 'sun', 'hat', 'run', 'cup', 'pen', 'map', 'bed', 'jar',
  'tree', 'blue', 'fire', 'moon', 'rain', 'star', 'lamp', 'ship', 'gold', 'wind',
  'apple', 'bread', 'chair', 'dance', 'eagle', 'grape', 'house', 'light', 'music', 'ocean',
  'candle', 'forest', 'garden', 'island', 'orange', 'planet', 'silver', 'winter',
  'diamond', 'journey', 'kitchen', 'morning'
];

const PUZZLE_COUNT = 200;

function buildPuzzles(seedBase) {
  const puzzles = [];
  for (let i = 0; i < PUZZLE_COUNT; i++) {
    const rng = gen.createRng(seedBase + i);
    const puzzle = gen.generatePuzzle({ rng: rng, words: WORDS });
    assert.ok(puzzle, 'generatePuzzle returned null for seed ' + (seedBase + i));
    puzzles.push({ puzzle: puzzle, rng: rng });
  }
  return puzzles;
}

test('generates 200 puzzles with 4-6 distinct required words', () => {
  for (const { puzzle } of buildPuzzles(10000)) {
    assert.ok(puzzle.words.length >= 4 && puzzle.words.length <= 6);
    const texts = puzzle.words.map(w => w.text);
    assert.equal(new Set(texts).size, texts.length, 'duplicate required word');
    for (const word of puzzle.words) {
      assert.equal(word.cellIds.length, word.text.length);
      for (const id of word.cellIds) {
        assert.ok(puzzle.cells.some(c => c.id === id));
      }
    }
    // The cluster is one connected blob.
    assert.equal(gen.connectedComponents(puzzle.cells).length, 1);
    // No two letters share a lattice cell.
    const keys = puzzle.cells.map(c => c.x + ',' + c.y);
    assert.equal(new Set(keys).size, keys.length, 'overlapping cells');
  }
});

test('every required word has a traceable route in the adjacency graph', () => {
  for (const { puzzle } of buildPuzzles(20000)) {
    for (const word of puzzle.words) {
      const route = gen.findRoute(puzzle.cells, puzzle.edges, word.text);
      assert.ok(route, 'no route for "' + word.text + '"');
      assert.equal(gen.traceToWord(puzzle.cells, route), word.text);
      assert.ok(gen.isValidTrace(puzzle.cells, puzzle.edges, route));
    }
    // The canonical placement route is itself always legal.
    for (const word of puzzle.words) {
      assert.ok(
        gen.isValidTrace(puzzle.cells, puzzle.edges, word.cellIds),
        'canonical route broken for "' + word.text + '"'
      );
    }
  }
});

test('generated boards contain no crossing diagonal edge pairs', () => {
  for (const { puzzle } of buildPuzzles(30000)) {
    assert.deepEqual(gen.findCrossingEdgePairs(puzzle.cells, puzzle.edges), []);
  }
});

test('remaining words stay traceable after every collapse, in random order', () => {
  for (const { puzzle, rng } of buildPuzzles(40000)) {
    const order = gen.shuffled(puzzle.words.map((_w, i) => i), rng);
    for (const index of order) {
      const target = puzzle.words[index].text;
      const result = gen.removeWord(puzzle, index);
      assert.ok(result, 'removeWord failed for "' + target + '"');
      assert.equal(result.removedIds.length, target.length);

      for (const word of puzzle.words) {
        if (word.found) continue;
        assert.ok(
          gen.isTraceable(puzzle.cells, puzzle.edges, word.text),
          'word "' + word.text + '" untraceable after removing "' + target + '"'
        );
        assert.ok(
          gen.isValidTrace(puzzle.cells, puzzle.edges, word.cellIds),
          'canonical route for "' + word.text + '" broken by collapse'
        );
      }
      assert.deepEqual(
        gen.findCrossingEdgePairs(puzzle.cells, puzzle.edges), [],
        'collapse introduced a crossing diagonal'
      );
      const keys = puzzle.cells.map(c => c.x + ',' + c.y);
      assert.equal(new Set(keys).size, keys.length, 'collapse overlapped cells');
    }
    assert.equal(puzzle.cells.length, 0, 'board not empty after all words found');
  }
});

test('generation is fast', () => {
  const start = Date.now();
  for (let i = 0; i < 50; i++) {
    gen.generatePuzzle({ rng: gen.createRng(90000 + i), words: WORDS });
  }
  const perPuzzle = (Date.now() - start) / 50;
  assert.ok(perPuzzle < 100, 'generation too slow: ' + perPuzzle + 'ms per puzzle');
});

test('engine awards required words, bonus time and detects a win', () => {
  const puzzle = gen.generatePuzzle({ rng: gen.createRng(4242), words: WORDS });
  const dict = engine.buildDict(WORDS.join(' ') + ' era ate net ten');
  const game = engine.createGame({ puzzle: puzzle, dict: dict });
  const total = game.totalMs;
  assert.equal(game.status, 'playing');

  const words = puzzle.words.map(w => w.text);
  let last = null;
  for (const word of words) {
    last = engine.submitWord(game, word);
    assert.equal(last.type, 'required');
  }
  assert.equal(last.solved, true);
  assert.equal(game.status, 'won');
  assert.equal(game.foundWords.length, words.length);
  assert.ok(game.timeLeftMs > total - 1, 'required words should add time');
  // Nothing counts once the game is over.
  assert.equal(engine.submitWord(game, words[0]).type, 'inactive');
});

test('engine rejects short/unknown traces and rewards bonus words once', () => {
  const puzzle = gen.generatePuzzle({ rng: gen.createRng(777), words: WORDS });
  const dict = engine.buildDict('zzzbonus ' + WORDS.join(' '));
  const game = engine.createGame({ puzzle: puzzle, dict: dict });

  assert.equal(engine.submitWord(game, 'ab').type, 'short');
  assert.equal(engine.submitWord(game, 'qqqqq').type, 'unknown');

  const bonus = WORDS.find(w => !puzzle.words.some(p => p.text === w) && w.length === 5);
  const before = game.timeLeftMs;
  const first = engine.submitWord(game, bonus);
  assert.equal(first.type, 'bonus');
  assert.equal(first.seconds, engine.bonusSeconds(bonus.length));
  assert.ok(game.timeLeftMs > before);

  const repeat = engine.submitWord(game, bonus);
  assert.equal(repeat.type, 'repeat-bonus');
  assert.equal(game.bonusWords.length, 1);
});

test('engine countdown ends the game at zero', () => {
  const puzzle = gen.generatePuzzle({ rng: gen.createRng(31337), words: WORDS });
  const game = engine.createGame({ puzzle: puzzle, dict: new Set() });
  assert.equal(engine.tick(game, 1000), false);
  assert.equal(engine.tick(game, game.totalMs), true);
  assert.equal(game.status, 'lost');
  assert.equal(game.timeLeftMs, 0);
  assert.equal(engine.formatTime(0), '0:00');
  assert.equal(engine.formatTime(65000), '1:05');
  assert.equal(engine.blanksFor('cat'), '_ _ _');
});
