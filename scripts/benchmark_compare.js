#!/usr/bin/env node
// Benchmark: New AI ("modern") vs Legacy AI ("legacy") head-to-head comparison.
// Runs many games with deterministic seeding and reports win rates, score
// differentials, assaf counts, reset counts, and decision latency.

const fs = require('node:fs');
const path = require('node:path');
const { performance } = require('node:perf_hooks');

const { YanivGame } = require('../server/src/yaniv');
const { AIPlayer } = require('../server/src/aiplayer');
const { LegacyAIPlayer } = require('../server/src/aiplayer_legacy');

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

class TimedModernAI extends AIPlayer {
  constructor(name, rolloutSamples) {
    super(name, rolloutSamples);
    this.decisionTimesMs = [];
  }

  decideAction() {
    const start = performance.now();
    const action = super.decideAction();
    this.decisionTimesMs.push(performance.now() - start);
    return action;
  }
}

class TimedLegacyAI extends LegacyAIPlayer {
  constructor(name, rolloutSamples) {
    super(name, rolloutSamples);
    this.decisionTimesMs = [];
  }

  decideAction() {
    const start = performance.now();
    const action = super.decideAction();
    this.decisionTimesMs.push(performance.now() - start);
    return action;
  }
}

// ---------------------------------------------------------------------------
// Single game
// ---------------------------------------------------------------------------

function runSingleGame({ seed, maxTurns, rolloutSamples }) {
  const gameRng = makeRng(seed);

  // Alternate who goes first to remove positional bias
  const modernFirst = (seed % 2) === 0;
  const modern = new TimedModernAI('AI-Modern', rolloutSamples);
  const legacy = new TimedLegacyAI('AI-Legacy', rolloutSamples);
  const players = modernFirst ? [modern, legacy] : [legacy, modern];
  const labelByName = { [modern.name]: 'modern', [legacy.name]: 'legacy' };

  const game = new YanivGame(players, gameRng);

  try {
    game.startGame();
  } catch (err) {
    return { winnerLabel: null, turns: 0, rounds: 0, assafs: {}, resets: {}, scores: {}, error: err.message, decisionMs: {} };
  }

  let turns = 0;
  let rounds = 0;
  let winner = null;
  let error = null;
  const assafs = { modern: 0, legacy: 0 };
  const resets = { modern: 0, legacy: 0 };

  while (turns < maxTurns) {
    if (game.players.length <= 1) {
      winner = game.players.length > 0 ? game.players[0] : null;
      break;
    }

    turns += 1;

    try {
      const [currentPlayer] = game.startTurn();

      if (game.canDeclareYaniv(currentPlayer)) {
        if (currentPlayer.shouldDeclareYaniv()) {
          const [info, , declaredWinner] = game.declareYaniv(currentPlayer);
          rounds += 1;

          // Track assafs
          if (info.assaf) {
            const assafedLabel = labelByName[info.assaf.assafed.name];
            if (assafedLabel) assafs[assafedLabel] += 1;
          }

          // Track resets
          if (info.resetPlayers) {
            for (const rp of info.resetPlayers) {
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
  for (const p of [modern, legacy]) {
    scores[labelByName[p.name]] = p.score;
  }

  const decisionMs = {};
  for (const p of [modern, legacy]) {
    decisionMs[labelByName[p.name]] = p.decisionTimesMs;
  }

  return {
    winnerLabel: winner ? labelByName[winner.name] : null,
    turns,
    rounds,
    assafs,
    resets,
    scores,
    error,
    decisionMs,
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
  const wins = { modern: 0, legacy: 0, draw: 0 };
  const totalAssafs = { modern: 0, legacy: 0 };
  const totalResets = { modern: 0, legacy: 0 };
  const allTurns = [];
  const allRounds = [];
  const finalScores = { modern: [], legacy: [] };
  const latency = { modern: [], legacy: [] };
  let errors = 0;

  for (const r of results) {
    allTurns.push(r.turns);
    allRounds.push(r.rounds);

    if (r.winnerLabel) {
      wins[r.winnerLabel] += 1;
    } else {
      wins.draw += 1;
    }

    if (r.error) errors += 1;

    for (const label of ['modern', 'legacy']) {
      totalAssafs[label] += r.assafs[label] || 0;
      totalResets[label] += r.resets[label] || 0;
      if (r.scores[label] !== undefined) finalScores[label].push(r.scores[label]);
      if (r.decisionMs[label]) latency[label].push(...r.decisionMs[label]);
    }
  }

  const avg = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0);

  const latencySummary = {};
  for (const label of ['modern', 'legacy']) {
    const v = latency[label];
    latencySummary[label] = {
      decisions: v.length,
      avgMs: +avg(v).toFixed(4),
      p95Ms: +percentile(v, 0.95).toFixed(4),
      maxMs: v.length ? +Math.max(...v).toFixed(4) : 0,
    };
  }

  return {
    games: gameCount,
    wins,
    winRates: {
      modern: +(wins.modern / gameCount).toFixed(4),
      legacy: +(wins.legacy / gameCount).toFixed(4),
    },
    assafsReceived: totalAssafs,
    resetsEarned: totalResets,
    avgFinalScore: {
      modern: +avg(finalScores.modern).toFixed(2),
      legacy: +avg(finalScores.legacy).toFixed(2),
    },
    roundsPerGame: {
      avg: +avg(allRounds).toFixed(1),
      p95: +percentile(allRounds, 0.95),
    },
    turnsPerGame: {
      avg: +avg(allTurns).toFixed(1),
      p95: +percentile(allTurns, 0.95),
    },
    errors,
    decisionLatencyMs: latencySummary,
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const out = { games: 200, maxTurns: 1000, seed: 42, rolloutSamples: 24, output: '' };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    const value = argv[i + 1];
    if (token === '--games') out.games = Number.parseInt(value, 10);
    if (token === '--max-turns') out.maxTurns = Number.parseInt(value, 10);
    if (token === '--seed') out.seed = Number.parseInt(value, 10);
    if (token === '--rollout-samples') out.rolloutSamples = Number.parseInt(value, 10);
    if (token === '--output') out.output = String(value);
    if (token.startsWith('--')) i += 1;
  }

  out.games = Math.max(1, out.games);
  out.maxTurns = Math.max(100, out.maxTurns);
  out.rolloutSamples = Math.max(4, out.rolloutSamples);
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const started = performance.now();

  console.log(`Running ${args.games} games: AI-Modern (new) vs AI-Legacy (old) ...`);

  const raw = [];
  for (let i = 0; i < args.games; i += 1) {
    raw.push(runSingleGame({
      seed: args.seed + i,
      maxTurns: args.maxTurns,
      rolloutSamples: args.rolloutSamples,
    }));

    // Progress indicator
    if ((i + 1) % 50 === 0 || i + 1 === args.games) {
      process.stdout.write(`  ${i + 1}/${args.games} games complete\r`);
    }
  }
  console.log();

  const summary = summarize(raw);
  const elapsed = ((performance.now() - started) / 1000).toFixed(3);

  const payload = {
    createdAt: new Date().toISOString(),
    config: { ...args },
    runtimeSeconds: +elapsed,
    results: summary,
  };

  // Print results
  console.log('\n=== BENCHMARK: Modern AI vs Legacy AI ===\n');
  console.log(`Games played:   ${summary.games}`);
  console.log(`Runtime:        ${elapsed}s\n`);

  console.log('Win rates:');
  console.log(`  Modern (new):  ${summary.wins.modern} wins (${(summary.winRates.modern * 100).toFixed(1)}%)`);
  console.log(`  Legacy (old):  ${summary.wins.legacy} wins (${(summary.winRates.legacy * 100).toFixed(1)}%)`);
  if (summary.wins.draw) console.log(`  Draws:         ${summary.wins.draw}`);

  console.log('\nAssafs received (got caught calling Yaniv):');
  console.log(`  Modern: ${summary.assafsReceived.modern}`);
  console.log(`  Legacy: ${summary.assafsReceived.legacy}`);

  console.log('\nScore resets earned (hit 50/100 exactly):');
  console.log(`  Modern: ${summary.resetsEarned.modern}`);
  console.log(`  Legacy: ${summary.resetsEarned.legacy}`);

  console.log('\nAvg final score (lower = better):');
  console.log(`  Modern: ${summary.avgFinalScore.modern}`);
  console.log(`  Legacy: ${summary.avgFinalScore.legacy}`);

  console.log('\nAvg rounds/game: ' + summary.roundsPerGame.avg);
  console.log('Avg turns/game:  ' + summary.turnsPerGame.avg);

  console.log('\nDecision latency:');
  for (const label of ['modern', 'legacy']) {
    const l = summary.decisionLatencyMs[label];
    console.log(`  ${label}: avg=${l.avgMs.toFixed(3)}ms  p95=${l.p95Ms.toFixed(3)}ms  max=${l.maxMs.toFixed(3)}ms  (${l.decisions} decisions)`);
  }

  if (summary.errors) {
    console.log(`\nErrors: ${summary.errors}`);
  }

  // Save
  const outPath = args.output
    || path.join('metrics', `compare_modern_vs_legacy_${new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '_')}.json`);
  const outDir = path.dirname(outPath);
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  console.log(`\nResults saved to ${outPath}`);
}

main();
