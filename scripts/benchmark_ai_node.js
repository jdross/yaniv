#!/usr/bin/env node
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { Worker, isMainThread, parentPort, workerData } = require('node:worker_threads');

const { YanivGame } = require('../server/src/yaniv');
const { Player } = require('../server/src/player');
const { AIPlayer } = require('../server/src/aiplayer');

class RandomPolicyPlayer extends Player {}

class TimedAIPlayer extends AIPlayer {
  constructor(name, rolloutSamples = 24) {
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

const HELPER_AI = new AIPlayer('helper');

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
    random() {
      return rand();
    },
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

function percentile(values, p) {
  if (values.length === 0) return 0.0;
  if (values.length === 1) return Number(values[0]);
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.max(0, Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1));
  return Number(sorted[idx]);
}

function randomDiscardOptions(hand) {
  return HELPER_AI._getDiscardOptions(hand);
}

function randomAction(player, drawOptions, rng) {
  const discardOptions = randomDiscardOptions(player.hand);
  const discard = discardOptions[rng.randint(0, discardOptions.length - 1)];

  let draw = 'deck';
  if (drawOptions.length > 0 && rng.random() < 0.45) {
    draw = rng.randint(0, drawOptions.length - 1);
  }

  return { discard, draw };
}

function randomShouldDeclare(player, rng) {
  const handValue = player.hand.reduce((sum, card) => sum + card.value, 0);
  if (handValue <= 2) return true;
  if (handValue >= 5) return false;
  return rng.random() < 0.25;
}

function buildPlayers(scenario, totalPlayers, rolloutSamples) {
  const players = [];
  const labelByName = {};

  if (scenario === 'modernVsRandom') {
    const ai = new TimedAIPlayer('AI-Modern', rolloutSamples);
    players.push(ai);
    labelByName[ai.name] = 'modern';
  } else {
    throw new Error(`Unsupported scenario: ${scenario}`);
  }

  while (players.length < totalPlayers) {
    const idx = players.length;
    const rp = new RandomPolicyPlayer(`R${idx}`);
    players.push(rp);
    labelByName[rp.name] = 'random';
  }

  return [players, labelByName];
}

function runSingleGame({ scenario, totalPlayers, maxTurns, seed, rolloutSamples }) {
  const rng = makeRng(seed);
  const gameRng = makeRng(seed + 1);

  const [players, labelByName] = buildPlayers(scenario, totalPlayers, rolloutSamples);
  const game = new YanivGame(players, gameRng);

  try {
    game.startGame();
  } catch (err) {
    return {
      winner: null,
      winnerLabel: null,
      turns: 0,
      error: `${err.name}: ${err.message}`,
      aiDecisionMs: Object.fromEntries(
        players
          .filter((p) => p instanceof TimedAIPlayer)
          .map((p) => [p.name, [...p.decisionTimesMs]]),
      ),
    };
  }

  let turns = 0;
  let winner = null;
  let error = null;

  while (turns < maxTurns) {
    if (game.players.length <= 1) {
      winner = game.players.length > 0 ? game.players[0] : null;
      break;
    }

    turns += 1;

    try {
      const [currentPlayer, drawOptions] = game.startTurn();

      if (game.canDeclareYaniv(currentPlayer)) {
        let shouldDeclare = false;
        if (currentPlayer instanceof AIPlayer) {
          shouldDeclare = currentPlayer.shouldDeclareYaniv();
        } else {
          shouldDeclare = randomShouldDeclare(currentPlayer, rng);
        }

        if (shouldDeclare) {
          const [, , declaredWinner] = game.declareYaniv(currentPlayer);
          if (declaredWinner !== null && declaredWinner !== undefined) {
            winner = declaredWinner;
            break;
          }
          continue;
        }
      }

      if (currentPlayer instanceof AIPlayer) {
        game.playTurn(currentPlayer);
      } else {
        const action = randomAction(currentPlayer, drawOptions, rng);
        game.playTurn(currentPlayer, action);
      }
    } catch (err) {
      error = `${err.name}: ${err.message}`;
      break;
    }
  }

  if (winner === null && error === null && game.players.length === 1) {
    winner = game.players[0];
  }

  const aiDecisionMs = Object.fromEntries(
    players
      .filter((p) => p instanceof TimedAIPlayer)
      .map((p) => [p.name, [...p.decisionTimesMs]]),
  );

  return {
    winner: winner ? winner.name : null,
    winnerLabel: winner ? labelByName[winner.name] : null,
    turns,
    error,
    aiDecisionMs: aiDecisionMs,
  };
}

function summarizeResults(rawGames) {
  const wins = {};
  const errors = {};
  const turns = [];
  const aiLatency = {};

  for (const result of rawGames) {
    turns.push(result.turns);

    if (result.winnerLabel !== null) {
      wins[result.winnerLabel] = (wins[result.winnerLabel] || 0) + 1;
    }

    if (result.error) {
      errors[result.error] = (errors[result.error] || 0) + 1;
    }

    for (const values of Object.values(result.aiDecisionMs)) {
      if (!aiLatency.modern) aiLatency.modern = [];
      aiLatency.modern.push(...values);
    }
  }

  const latencySummary = {};
  for (const [key, values] of Object.entries(aiLatency)) {
    latencySummary[key] = {
      count: values.length,
      avgMs: values.length ? Number((values.reduce((a, b) => a + b, 0) / values.length).toFixed(4)) : 0.0,
      p95Ms: Number(percentile(values, 0.95).toFixed(4)),
      maxMs: values.length ? Number(Math.max(...values).toFixed(4)) : 0.0,
    };
  }

  const gameCount = rawGames.length;
  const winRates = {};
  for (const label of Object.keys(wins).sort()) {
    winRates[label] = Number((wins[label] / gameCount).toFixed(4));
  }

  return {
    games: gameCount,
    wins: Object.fromEntries(Object.entries(wins).sort(([a], [b]) => a.localeCompare(b))),
    winRates,
    turns: {
      avg: turns.length ? Number((turns.reduce((a, b) => a + b, 0) / turns.length).toFixed(3)) : 0.0,
      p95: Number(percentile(turns, 0.95).toFixed(3)),
      max: turns.length ? Math.max(...turns) : 0,
    },
    errors: Object.fromEntries(Object.entries(errors).sort(([a], [b]) => a.localeCompare(b))),
    aiDecisionLatencyMs: latencySummary,
  };
}

function parseArgs(argv) {
  const out = {
    games: 250,
    players: 3,
    maxTurns: 1000,
    seed: 7,
    rolloutSamples: 24,
    scenario: 'modernVsRandom',
    jobs: 1,
    output: '',
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    const value = argv[i + 1];

    if (token === '--games') out.games = Number.parseInt(value, 10);
    if (token === '--players') out.players = Number.parseInt(value, 10);
    if (token === '--max-turns') out.maxTurns = Number.parseInt(value, 10);
    if (token === '--seed') out.seed = Number.parseInt(value, 10);
    if (token === '--rollout-samples') out.rolloutSamples = Number.parseInt(value, 10);
    if (token === '--scenario') out.scenario = String(value);
    if (token === '--jobs') out.jobs = Number.parseInt(value, 10);
    if (token === '--output') out.output = String(value);

    if (token.startsWith('--')) {
      i += 1;
    }
  }

  if (out.scenario !== 'modernVsRandom') {
    throw new Error(`Unsupported scenario '${out.scenario}'. Supported: modernVsRandom`);
  }

  out.games = Math.max(1, out.games);
  out.players = Math.max(2, Math.min(4, out.players));
  out.maxTurns = Math.max(100, out.maxTurns);
  out.rolloutSamples = Math.max(4, out.rolloutSamples);
  out.jobs = Math.max(1, out.jobs);
  return out;
}

function chunkRequests(requests, chunks) {
  const out = Array.from({ length: chunks }, () => []);
  for (let i = 0; i < requests.length; i += 1) {
    out[i % chunks].push(requests[i]);
  }
  return out.filter((group) => group.length > 0);
}

function runWorker(requests) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(__filename, { workerData: { requests } });
    worker.once('message', (msg) => resolve(msg));
    worker.once('error', reject);
    worker.once('exit', (code) => {
      if (code !== 0) {
        reject(new Error(`Worker exited with code ${code}`));
      }
    });
  });
}

async function runBenchmarks(config) {
  const requests = [];
  for (let i = 0; i < config.games; i += 1) {
    requests.push({
      scenario: config.scenario,
      totalPlayers: config.players,
      maxTurns: config.maxTurns,
      seed: config.seed + i,
      rolloutSamples: config.rolloutSamples,
    });
  }

  let raw = [];
  if (config.jobs > 1) {
    const maxWorkers = Math.min(config.jobs, requests.length, os.cpus().length);
    const chunks = chunkRequests(requests, maxWorkers);
    const chunkResults = await Promise.all(chunks.map((chunk) => runWorker(chunk)));
    raw = chunkResults.flat();
  } else {
    raw = requests.map((request) => runSingleGame(request));
  }

  return {
    [config.scenario]: summarizeResults(raw),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const started = performance.now();
  const results = await runBenchmarks(args);

  const payload = {
    createdAt: new Date().toISOString(),
    config: {
      gamesPerScenario: args.games,
      players: args.players,
      maxTurns: args.maxTurns,
      seed: args.seed,
      rolloutSamples: args.rolloutSamples,
      scenario: args.scenario,
      jobs: args.jobs,
    },
    runtimeSeconds: Number(((performance.now() - started) / 1000).toFixed(3)),
    results,
  };

  const outPath = args.output
    ? args.output
    : path.join(
        'metrics',
        `ai_benchmark_node_${new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '_')}.json`,
      );

  const outDir = path.dirname(outPath);
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');

  console.log(JSON.stringify(payload, null, 2));
  console.log(`\nSaved benchmark results to ${outPath}`);
}

if (isMainThread) {
  main().catch((err) => {
    console.error(err.stack || err.message || String(err));
    process.exit(1);
  });
} else {
  const requests = workerData.requests || [];
  const raw = requests.map((request) => runSingleGame(request));
  parentPort.postMessage(raw);
}
