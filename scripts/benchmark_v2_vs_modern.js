#!/usr/bin/env node
// Benchmark: AIPlayerV2 (strategic) vs AIPlayer (modern) head-to-head comparison.
// Based on benchmark_compare.js — same structure, swaps Legacy for V2.

const fs = require('node:fs');
const path = require('node:path');
const { performance } = require('node:perf_hooks');

const { YanivGame } = require('../server/src/yaniv');
const { AIPlayer } = require('../server/src/aiplayer');
const { AIPlayerV2 } = require('../server/src/aiplayer_v2');

// ---------------------------------------------------------------------------
// Deterministic RNG
// ---------------------------------------------------------------------------

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
    random: () => rand(),
    randint(min, maxInclusive) {
      return min + Math.floor(rand() * (maxInclusive - min + 1));
    },
    shuffle(values) {
      for (let i = values.length - 1; i > 0; i -= 1) {
        const j = Math.floor(rand() * (i + 1));
        [values[i], values[j]] = [values[j], values[i]];
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Timed wrappers
// ---------------------------------------------------------------------------

class TimedV2AI extends AIPlayerV2 {
  constructor(name, rollout_samples) {
    super(name, rollout_samples);
    this.decision_times_ms = [];
  }

  decide_action() {
    const start = performance.now();
    const action = super.decide_action();
    this.decision_times_ms.push(performance.now() - start);
    return action;
  }
}

class TimedModernAI extends AIPlayer {
  constructor(name, rollout_samples) {
    super(name, rollout_samples);
    this.decision_times_ms = [];
  }

  decide_action() {
    const start = performance.now();
    const action = super.decide_action();
    this.decision_times_ms.push(performance.now() - start);
    return action;
  }
}

// ---------------------------------------------------------------------------
// Single game
// ---------------------------------------------------------------------------

function runSingleGame({ seed, max_turns, rollout_samples }) {
  const gameRng = makeRng(seed);

  // Alternate who goes first to remove positional bias
  const v2First = (seed % 2) === 0;
  const v2 = new TimedV2AI('AI-V2', rollout_samples);
  const modern = new TimedModernAI('AI-Modern', rollout_samples);
  const players = v2First ? [v2, modern] : [modern, v2];
  const labelByName = { [v2.name]: 'v2', [modern.name]: 'modern' };

  const game = new YanivGame(players, gameRng);

  try {
    game.startGame();
  } catch (err) {
    return { winner_label: null, turns: 0, rounds: 0, assafs: {}, resets: {}, scores: {}, error: err.message, decision_ms: {} };
  }

  let turns = 0;
  let rounds = 0;
  let winner = null;
  let error = null;
  const assafs = { v2: 0, modern: 0 };
  const resets = { v2: 0, modern: 0 };

  while (turns < max_turns) {
    if (game.players.length <= 1) {
      winner = game.players.length > 0 ? game.players[0] : null;
      break;
    }

    turns += 1;

    try {
      const [currentPlayer] = game.startTurn();

      if (game.canDeclareYaniv(currentPlayer)) {
        if (currentPlayer.should_declare_yaniv()) {
          const [info, , declaredWinner] = game.declareYaniv(currentPlayer);
          rounds += 1;

          if (info.assaf) {
            const assafedLabel = labelByName[info.assaf.assafed.name];
            if (assafedLabel) assafs[assafedLabel] += 1;
          }

          if (info.reset_players) {
            for (const rp of info.reset_players) {
              const rpLabel = labelByName[rp.name];
              if (rpLabel) resets[rpLabel] += 1;
            }
          }

          if (declaredWinner) {
            winner = declaredWinner;
            break;
          }
          continue;
        }
      }

      game.playTurn(currentPlayer);
    } catch (err2) {
      error = err2.message;
      break;
    }
  }

  if (!winner && !error && game.players.length === 1) {
    winner = game.players[0];
  }

  const scores = {};
  for (const p of [v2, modern]) {
    scores[labelByName[p.name]] = p.score;
  }

  const decision_ms = {};
  for (const p of [v2, modern]) {
    decision_ms[labelByName[p.name]] = p.decision_times_ms;
  }

  return {
    winner_label: winner ? labelByName[winner.name] : null,
    turns,
    rounds,
    assafs,
    resets,
    scores,
    error,
    decision_ms,
  };
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

function percentile(values, p) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.max(0, Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1));
  return sorted[idx];
}

function summarize(results) {
  const gameCount = results.length;
  const wins = { v2: 0, modern: 0, draw: 0 };
  const totalAssafs = { v2: 0, modern: 0 };
  const totalResets = { v2: 0, modern: 0 };
  const allTurns = [];
  const allRounds = [];
  const finalScores = { v2: [], modern: [] };
  const latency = { v2: [], modern: [] };
  let errors = 0;

  for (const r of results) {
    allTurns.push(r.turns);
    allRounds.push(r.rounds);

    if (r.winner_label) {
      wins[r.winner_label] += 1;
    } else {
      wins.draw += 1;
    }

    if (r.error) errors += 1;

    for (const label of ['v2', 'modern']) {
      totalAssafs[label] += r.assafs[label] || 0;
      totalResets[label] += r.resets[label] || 0;
      if (r.scores[label] !== undefined) finalScores[label].push(r.scores[label]);
      if (r.decision_ms[label]) latency[label].push(...r.decision_ms[label]);
    }
  }

  const avg = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0);

  const latencySummary = {};
  for (const label of ['v2', 'modern']) {
    const v = latency[label];
    latencySummary[label] = {
      decisions: v.length,
      avg_ms: +avg(v).toFixed(4),
      p95_ms: +percentile(v, 0.95).toFixed(4),
      max_ms: v.length ? +v.reduce((a, b) => Math.max(a, b), 0).toFixed(4) : 0,
    };
  }

  return {
    games: gameCount,
    wins,
    win_rates: {
      v2: +(wins.v2 / gameCount).toFixed(4),
      modern: +(wins.modern / gameCount).toFixed(4),
    },
    assafs_received: totalAssafs,
    resets_earned: totalResets,
    avg_final_score: {
      v2: +avg(finalScores.v2).toFixed(2),
      modern: +avg(finalScores.modern).toFixed(2),
    },
    rounds_per_game: {
      avg: +avg(allRounds).toFixed(1),
      p95: +percentile(allRounds, 0.95),
    },
    turns_per_game: {
      avg: +avg(allTurns).toFixed(1),
      p95: +percentile(allTurns, 0.95),
    },
    errors,
    decision_latency_ms: latencySummary,
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const out = { games: 200, max_turns: 1000, seed: 42, rollout_samples: 24, output: '' };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    const value = argv[i + 1];
    if (token === '--games') out.games = Number.parseInt(value, 10);
    if (token === '--max-turns') out.max_turns = Number.parseInt(value, 10);
    if (token === '--seed') out.seed = Number.parseInt(value, 10);
    if (token === '--rollout-samples') out.rollout_samples = Number.parseInt(value, 10);
    if (token === '--output') out.output = String(value);
    if (token.startsWith('--')) i += 1;
  }

  out.games = Math.max(1, out.games);
  out.max_turns = Math.max(100, out.max_turns);
  out.rollout_samples = Math.max(4, out.rollout_samples);
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const started = performance.now();

  console.log(`Running ${args.games} games: AI-V2 (strategic) vs AI-Modern (baseline) ...`);

  const raw = [];
  for (let i = 0; i < args.games; i += 1) {
    raw.push(runSingleGame({
      seed: args.seed + i,
      max_turns: args.max_turns,
      rollout_samples: args.rollout_samples,
    }));

    if ((i + 1) % 50 === 0 || i + 1 === args.games) {
      process.stdout.write(`  ${i + 1}/${args.games} games complete\r`);
    }
  }
  console.log();

  const summary = summarize(raw);
  const elapsed = ((performance.now() - started) / 1000).toFixed(3);

  const payload = {
    created_at: new Date().toISOString(),
    config: { ...args },
    runtime_seconds: +elapsed,
    results: summary,
  };

  // Print results
  console.log('\n=== BENCHMARK: V2 (Strategic) vs Modern (Baseline) ===\n');
  console.log(`Games played:   ${summary.games}`);
  console.log(`Runtime:        ${elapsed}s\n`);

  console.log('Win rates:');
  console.log(`  V2 (new):      ${summary.wins.v2} wins (${(summary.win_rates.v2 * 100).toFixed(1)}%)`);
  console.log(`  Modern (old):  ${summary.wins.modern} wins (${(summary.win_rates.modern * 100).toFixed(1)}%)`);
  if (summary.wins.draw) console.log(`  Draws:         ${summary.wins.draw}`);

  console.log('\nAssafs received (got caught calling Yaniv):');
  console.log(`  V2:      ${summary.assafs_received.v2}`);
  console.log(`  Modern:  ${summary.assafs_received.modern}`);

  console.log('\nScore resets earned (hit 50/100 exactly):');
  console.log(`  V2:      ${summary.resets_earned.v2}`);
  console.log(`  Modern:  ${summary.resets_earned.modern}`);

  console.log('\nAvg final score (lower = better):');
  console.log(`  V2:      ${summary.avg_final_score.v2}`);
  console.log(`  Modern:  ${summary.avg_final_score.modern}`);

  console.log('\nAvg rounds/game: ' + summary.rounds_per_game.avg);
  console.log('Avg turns/game:  ' + summary.turns_per_game.avg);

  console.log('\nDecision latency:');
  for (const label of ['v2', 'modern']) {
    const l = summary.decision_latency_ms[label];
    console.log(`  ${label}: avg=${l.avg_ms.toFixed(3)}ms  p95=${l.p95_ms.toFixed(3)}ms  max=${l.max_ms.toFixed(3)}ms  (${l.decisions} decisions)`);
  }

  if (summary.errors) {
    console.log(`\nErrors: ${summary.errors}`);
  }

  // Save
  const outPath = args.output
    || path.join('metrics', `compare_v2_vs_modern_${new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '_')}.json`);
  const outDir = path.dirname(outPath);
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  console.log(`\nResults saved to ${outPath}`);
}

main();
