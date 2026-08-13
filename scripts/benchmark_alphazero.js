#!/usr/bin/env node
const path = require('node:path');
const fs = require('node:fs');
const { performance } = require('node:perf_hooks');

const { YanivGame } = require('../server/src/yaniv');
const { Player } = require('../server/src/player');
const { createAIPlayer } = require('../server/src/aiplayer');
const { AlphaZeroPlayer } = require('../server/src/alphazero/alphazero_player');
const { loadModel, createModel } = require('../server/src/alphazero/network');

function mulberry32(seed) {
  let t = seed >>> 0;
  return () => {
    t += 0x6d2b79f5;
    let x = Math.imul(t ^ (t >>> 15), 1 | t);
    x ^= x + Math.imul(x ^ (x >>> 7), 61 | x);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

function makeRng(seed) {
  const rand = mulberry32(seed >>> 0);
  return {
    random() { return rand(); },
    randint(min, maxInclusive) { return min + Math.floor(rand() * (maxInclusive - min + 1)); },
    shuffle(values) {
      for (let i = values.length - 1; i > 0; i -= 1) {
        const j = Math.floor(rand() * (i + 1));
        [values[i], values[j]] = [values[j], values[i]];
      }
    },
  };
}

function percentile(values, p) {
  if (values.length === 0) return 0;
  if (values.length === 1) return values[0];
  const sorted = [...values].sort((a, b) => a - b);
  const idx = (p / 100) * (sorted.length - 1);
  const lower = Math.floor(idx);
  const upper = Math.ceil(idx);
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (idx - lower);
}

function runGame(players, rng) {
  const game = new YanivGame(players, rng);
  game.startGame();

  let moves = 0;
  while (game.players.length > 1 && moves < 500) {
    const [currentPlayer] = game.startTurn();

    const handValue = currentPlayer.hand.reduce((s, c) => s + c.value, 0);
    if (handValue <= 5) {
      const shouldCall = typeof currentPlayer.should_declare_yaniv === 'function'
        ? currentPlayer.should_declare_yaniv()
        : handValue <= 2;

      if (shouldCall) {
        const [, , winner] = game.declareYaniv(currentPlayer);
        if (winner) break;
        moves += 1;
        continue;
      }
    }

    let action;
    if (typeof currentPlayer.decide_action === 'function') {
      action = currentPlayer.decide_action();
    } else {
      const discard = [currentPlayer.hand[0]];
      action = { discard, draw: 'deck' };
    }

    game.playTurn(currentPlayer, action);
    moves += 1;
  }

  const sorted = [...game.players].sort((a, b) => a.score - b.score);
  return {
    winner: sorted.length > 0 ? sorted[0].name : null,
    finalScores: Object.fromEntries(game.players.map((p) => [p.name, p.score])),
    moves,
  };
}

async function benchmark(scenario, model, numGames, seed) {
  const wins = {};
  const decisionTimes = [];

  for (let g = 0; g < numGames; g += 1) {
    const rng = makeRng(seed + g);
    let players;

    if (scenario === 'az-vs-random') {
      players = [
        new AlphaZeroPlayer('AlphaZero', model, { numDeterminizations: 8, iterationsPerDet: 50 }),
        new Player('Random1'),
        new Player('Random2'),
      ];
    } else if (scenario === 'az-vs-heuristic') {
      players = [
        new AlphaZeroPlayer('AlphaZero', model, { numDeterminizations: 8, iterationsPerDet: 50 }),
        createAIPlayer('Heuristic1'),
        createAIPlayer('Heuristic2'),
      ];
    } else if (scenario === 'az-vs-mixed') {
      players = [
        new AlphaZeroPlayer('AlphaZero', model, { numDeterminizations: 8, iterationsPerDet: 50 }),
        createAIPlayer('Heuristic'),
        new Player('Random'),
      ];
    } else {
      throw new Error(`Unknown scenario: ${scenario}`);
    }

    const start = performance.now();
    const result = runGame(players, rng);
    const elapsed = performance.now() - start;
    decisionTimes.push(elapsed);

    const winner = result.winner || 'draw';
    wins[winner] = (wins[winner] || 0) + 1;

    if ((g + 1) % 50 === 0) {
      console.log(`  ${g + 1}/${numGames} games complete`);
    }
  }

  return { wins, decisionTimes };
}

async function main() {
  const numGames = parseInt(process.argv[2] || '200', 10);
  const modelDir = process.argv[3] || path.resolve(__dirname, '..', 'server', 'src', 'alphazero', 'models', 'best');
  const seed = parseInt(process.argv[4] || '12345', 10);

  let model;
  if (fs.existsSync(path.join(modelDir, 'model.json'))) {
    console.log(`Loading model from ${modelDir}...`);
    model = await loadModel(modelDir);
  } else {
    console.log('No trained model found, using random-weight model for smoke test.');
    model = createModel();
  }

  console.log(`Running ${numGames} games per scenario (seed=${seed})\n`);

  const scenarios = ['az-vs-random', 'az-vs-heuristic', 'az-vs-mixed'];

  for (const scenario of scenarios) {
    console.log(`=== ${scenario} ===`);
    const start = performance.now();
    const result = await benchmark(scenario, model, numGames, seed);
    const elapsed = ((performance.now() - start) / 1000).toFixed(1);

    console.log(`  Results (${elapsed}s):`);
    for (const [name, count] of Object.entries(result.wins).sort((a, b) => b[1] - a[1])) {
      console.log(`    ${name}: ${count} wins (${(count / numGames * 100).toFixed(1)}%)`);
    }

    const azWins = result.wins['AlphaZero'] || 0;
    console.log(`  AlphaZero win rate: ${(azWins / numGames * 100).toFixed(1)}%`);
    console.log(`  Latency: p50=${percentile(result.decisionTimes, 50).toFixed(1)}ms, p95=${percentile(result.decisionTimes, 95).toFixed(1)}ms, p99=${percentile(result.decisionTimes, 99).toFixed(1)}ms`);
    console.log();
  }

  model.dispose();
}

main().catch((err) => {
  console.error('Benchmark failed:', err);
  process.exit(1);
});
