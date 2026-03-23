#!/usr/bin/env node

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { Worker, isMainThread, parentPort, workerData } = require('node:worker_threads');

const { YanivGame } = require('../server/src/yaniv');
const { Player } = require('../server/src/player');
const { AIPlayer: ProductionAIPlayer } = require('../server/src/aiplayer');
const { AIPlayer: V1AIPlayer } = require('../server/src/aiplayer_v1');
const { AIPlayerV2 } = require('../server/src/aiplayer_v2');
const { LegacyAIPlayer } = require('../server/src/aiplayer_legacy');
const { AIPlayerLearned } = require('../server/src/aiplayer_learned');

function containsCard(cards, target) {
  return cards.some((card) => card._card === target._card);
}

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

function percentile(values, p) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.max(0, Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1));
  return sorted[idx];
}

function average(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function rotate(values, shift) {
  if (values.length === 0) return [];
  const normalized = ((shift % values.length) + values.length) % values.length;
  return values.slice(normalized).concat(values.slice(0, normalized));
}

function uniquePolicyIds(playerIds) {
  return [...new Set(playerIds)];
}

function zeroCounter(policyIds) {
  return Object.fromEntries(uniquePolicyIds(policyIds).map((policyId) => [policyId, 0]));
}

class RandomPolicyPlayer extends Player {
  constructor(name) {
    super(name);
    this.policy_id = 'random';
    this.is_ai = false;
    this.decision_times_ms = [];
  }
}

function makeTimedPolicyClass(BaseClass, policyId) {
  return class TimedPolicy extends BaseClass {
    constructor(name, rolloutSamples) {
      super(name, rolloutSamples);
      this.policy_id = policyId;
      this.decision_times_ms = [];
      this.is_ai = true;
    }

    decide_action() {
      const start = performance.now();
      const action = super.decide_action();
      this.decision_times_ms.push(performance.now() - start);
      return action;
    }
  };
}

const TimedProductionAI = makeTimedPolicyClass(ProductionAIPlayer, 'v3');
const TimedV1AI = makeTimedPolicyClass(V1AIPlayer, 'v1');
const TimedV2AI = makeTimedPolicyClass(AIPlayerV2, 'v2');
const TimedLegacyAI = makeTimedPolicyClass(LegacyAIPlayer, 'legacy');
const TimedLearnedAI = makeTimedPolicyClass(AIPlayerLearned, 'learned');

const HELPER_AI = new V1AIPlayer('benchmark-helper');

const POLICY_REGISTRY = {
  v3: {
    label: 'Production V3',
    create(name, rolloutSamples) {
      return new TimedProductionAI(name, rolloutSamples);
    },
  },
  v1: {
    label: 'V1 Baseline',
    create(name, rolloutSamples) {
      return new TimedV1AI(name, rolloutSamples);
    },
  },
  v2: {
    label: 'V2',
    create(name, rolloutSamples) {
      return new TimedV2AI(name, rolloutSamples);
    },
  },
  legacy: {
    label: 'Legacy',
    create(name, rolloutSamples) {
      return new TimedLegacyAI(name, rolloutSamples);
    },
  },
  learned: {
    label: 'Learned',
    create(name, rolloutSamples) {
      return new TimedLearnedAI(name, rolloutSamples);
    },
  },
  random: {
    label: 'Random',
    create(name) {
      return new RandomPolicyPlayer(name);
    },
  },
};

function registerPolicy(policyId, policy) {
  POLICY_REGISTRY[policyId] = policy;
}

function unregisterPolicy(policyId) {
  delete POLICY_REGISTRY[policyId];
}

function listPolicies() {
  return Object.entries(POLICY_REGISTRY).map(([policyId, policy]) => `${policyId}: ${policy.label}`);
}

function parsePlayerIds(rawPlayers) {
  const ids = String(rawPlayers || '')
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);

  if (ids.length < 2 || ids.length > 4) {
    throw new Error('`--players` must specify between 2 and 4 policy ids, e.g. --players v3,v1');
  }

  for (const policyId of ids) {
    if (!POLICY_REGISTRY[policyId]) {
      throw new Error(`Unknown policy '${policyId}'. Use --list-policies to see valid ids.`);
    }
  }

  return ids;
}

function buildPlayers(playerIds, rolloutSamples, seed) {
  const rotatedPolicyIds = rotate(playerIds, seed % playerIds.length);
  const instanceCounts = {};
  const players = [];
  const policyByName = {};

  for (const policyId of rotatedPolicyIds) {
    instanceCounts[policyId] = (instanceCounts[policyId] || 0) + 1;
    const name = `${policyId}-${instanceCounts[policyId]}`;
    const player = POLICY_REGISTRY[policyId].create(name, rolloutSamples);
    player.policy_id = policyId;
    players.push(player);
    policyByName[player.name] = policyId;
  }

  return { players, policyByName };
}

function randomDiscardOptions(hand) {
  return HELPER_AI._get_discard_options(hand);
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

function isAiPlayer(player) {
  return Boolean(player && player.is_ai === true);
}

function runSingleGame({ player_ids, max_turns, seed, rollout_samples }) {
  const rng = makeRng(seed);
  const gameRng = makeRng(seed + 1);
  const { players, policyByName } = buildPlayers(player_ids, rollout_samples, seed);
  const game = new YanivGame(players, gameRng);

  try {
    game.startGame();
  } catch (err) {
    return {
      winner_policy: null,
      turns: 0,
      rounds: 0,
      assafs: zeroCounter(player_ids),
      resets: zeroCounter(player_ids),
      yaniv_calls: zeroCounter(player_ids),
      successful_yaniv_calls: zeroCounter(player_ids),
      estimated_feed_punishes: zeroCounter(player_ids),
      player_metrics: players.map((player) => ({
        policy_id: policyByName[player.name],
        score: player.score,
        decision_ms: [...(player.decision_times_ms || [])],
      })),
      error: `${err.name}: ${err.message}`,
    };
  }

  let turns = 0;
  let rounds = 0;
  let winner = null;
  let error = null;
  const assafs = zeroCounter(player_ids);
  const resets = zeroCounter(player_ids);
  const yanivCalls = zeroCounter(player_ids);
  const successfulYanivCalls = zeroCounter(player_ids);
  const estimatedFeedPunishes = zeroCounter(player_ids);
  let previousTurn = null;

  while (turns < max_turns) {
    if (game.players.length <= 1) {
      winner = game.players.length > 0 ? game.players[0] : null;
      break;
    }

    turns += 1;

    try {
      const [currentPlayer, drawOptions] = game.startTurn();
      const currentPolicyId = policyByName[currentPlayer.name];

      if (game.canDeclareYaniv(currentPlayer)) {
        const shouldDeclare = isAiPlayer(currentPlayer)
          ? currentPlayer.should_declare_yaniv()
          : randomShouldDeclare(currentPlayer, rng);

        if (shouldDeclare) {
          yanivCalls[currentPolicyId] += 1;
          const [info, , declaredWinner] = game.declareYaniv(currentPlayer);
          rounds += 1;
          previousTurn = null;

          if (info.assaf) {
            const assafedPolicy = policyByName[info.assaf.assafed.name];
            if (assafedPolicy) assafs[assafedPolicy] += 1;
          } else {
            successfulYanivCalls[currentPolicyId] += 1;
          }

          if (info.reset_players) {
            for (const player of info.reset_players) {
              const resetPolicy = policyByName[player.name];
              if (resetPolicy) resets[resetPolicy] += 1;
            }
          }

          if (declaredWinner) {
            winner = declaredWinner;
            break;
          }
          continue;
        }
      }

      let action;
      if (isAiPlayer(currentPlayer)) {
        action = game.playTurn(currentPlayer);
      } else {
        const start = performance.now();
        action = randomAction(currentPlayer, drawOptions, rng);
        currentPlayer.decision_times_ms.push(performance.now() - start);
        game.playTurn(currentPlayer, action);
      }

      if (
        previousTurn
        && action.draw !== 'deck'
        && drawOptions[action.draw]
        && containsCard(previousTurn.discarded_cards, drawOptions[action.draw])
      ) {
        estimatedFeedPunishes[previousTurn.policy_id] += 1;
      }

      previousTurn = {
        policy_id: currentPolicyId,
        discarded_cards: [...action.discard],
      };
    } catch (err2) {
      error = `${err2.name}: ${err2.message}`;
      break;
    }
  }

  if (winner === null && error === null && game.players.length === 1) {
    winner = game.players[0];
  }

  return {
    winner_policy: winner ? policyByName[winner.name] : null,
    turns,
    rounds,
    assafs,
    resets,
    yaniv_calls: yanivCalls,
    successful_yaniv_calls: successfulYanivCalls,
    estimated_feed_punishes: estimatedFeedPunishes,
    player_metrics: players.map((player) => ({
      policy_id: policyByName[player.name],
      score: player.score,
      decision_ms: [...(player.decision_times_ms || [])],
    })),
    error,
  };
}

function summarizeResults(rawGames, playerIds) {
  const policyIds = uniquePolicyIds(playerIds);
  const wins = zeroCounter(policyIds);
  const appearances = zeroCounter(policyIds);
  const assafs = zeroCounter(policyIds);
  const resets = zeroCounter(policyIds);
  const yanivCalls = zeroCounter(policyIds);
  const successfulYanivCalls = zeroCounter(policyIds);
  const feedPunishes = zeroCounter(policyIds);
  const scores = Object.fromEntries(policyIds.map((policyId) => [policyId, []]));
  const latency = Object.fromEntries(policyIds.map((policyId) => [policyId, []]));
  const turns = [];
  const rounds = [];
  let draws = 0;
  let errors = 0;

  for (const policyId of playerIds) {
    appearances[policyId] += rawGames.length;
  }

  for (const result of rawGames) {
    turns.push(result.turns);
    rounds.push(result.rounds);

    if (result.winner_policy) wins[result.winner_policy] += 1;
    else draws += 1;

    if (result.error) errors += 1;

    for (const policyId of policyIds) {
      assafs[policyId] += result.assafs[policyId] || 0;
      resets[policyId] += result.resets[policyId] || 0;
      yanivCalls[policyId] += result.yaniv_calls[policyId] || 0;
      successfulYanivCalls[policyId] += result.successful_yaniv_calls[policyId] || 0;
      feedPunishes[policyId] += result.estimated_feed_punishes[policyId] || 0;
    }

    for (const metric of result.player_metrics) {
      scores[metric.policy_id].push(metric.score);
      latency[metric.policy_id].push(...metric.decision_ms);
    }
  }

  const winRatesByGame = {};
  const winRatesByAppearance = {};
  const avgFinalScore = {};
  const decisionLatencyMs = {};
  const assafRatePerYanivCall = {};

  for (const policyId of policyIds) {
    winRatesByGame[policyId] = +(wins[policyId] / rawGames.length).toFixed(4);
    winRatesByAppearance[policyId] = appearances[policyId] > 0
      ? +(wins[policyId] / appearances[policyId]).toFixed(4)
      : 0;
    avgFinalScore[policyId] = +average(scores[policyId]).toFixed(2);
    assafRatePerYanivCall[policyId] = yanivCalls[policyId] > 0
      ? +(assafs[policyId] / yanivCalls[policyId]).toFixed(4)
      : 0;

    decisionLatencyMs[policyId] = {
      decisions: latency[policyId].length,
      avg_ms: +average(latency[policyId]).toFixed(4),
      p95_ms: +percentile(latency[policyId], 0.95).toFixed(4),
      max_ms: latency[policyId].length ? +Math.max(...latency[policyId]).toFixed(4) : 0,
    };
  }

  return {
    games: rawGames.length,
    players: playerIds,
    policy_labels: Object.fromEntries(
      policyIds.map((policyId) => [policyId, POLICY_REGISTRY[policyId] ? POLICY_REGISTRY[policyId].label : policyId]),
    ),
    wins,
    draws,
    appearances,
    win_rates_by_game: winRatesByGame,
    win_rates_by_appearance: winRatesByAppearance,
    assafs_received: assafs,
    resets_earned: resets,
    yaniv_calls: yanivCalls,
    successful_yaniv_calls: successfulYanivCalls,
    assaf_rate_per_yaniv_call: assafRatePerYanivCall,
    estimated_feed_punishes: feedPunishes,
    avg_final_score: avgFinalScore,
    rounds_per_game: {
      avg: +average(rounds).toFixed(1),
      p95: +percentile(rounds, 0.95),
    },
    turns_per_game: {
      avg: +average(turns).toFixed(1),
      p95: +percentile(turns, 0.95),
    },
    errors,
    decision_latency_ms: decisionLatencyMs,
  };
}

function parseArgs(argv) {
  const out = {
    players: ['v3', 'v1'],
    games: 200,
    max_turns: 1000,
    seed: 42,
    rollout_samples: 24,
    jobs: 1,
    output: '',
    list_policies: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    const value = argv[i + 1];

    if (token === '--players') out.players = parsePlayerIds(value);
    if (token === '--games') out.games = Number.parseInt(value, 10);
    if (token === '--max-turns') out.max_turns = Number.parseInt(value, 10);
    if (token === '--seed') out.seed = Number.parseInt(value, 10);
    if (token === '--rollout-samples') out.rollout_samples = Number.parseInt(value, 10);
    if (token === '--jobs') out.jobs = Number.parseInt(value, 10);
    if (token === '--output') out.output = String(value);
    if (token === '--list-policies') out.list_policies = true;

    if (token === '--list-policies') continue;
    if (token.startsWith('--')) i += 1;
  }

  out.games = Math.max(1, out.games);
  out.max_turns = Math.max(100, out.max_turns);
  out.rollout_samples = Math.max(4, out.rollout_samples);
  out.jobs = Math.max(1, out.jobs);
  return out;
}

function chunkRequests(requests, chunkCount) {
  const out = Array.from({ length: chunkCount }, () => []);
  for (let i = 0; i < requests.length; i += 1) {
    out[i % chunkCount].push(requests[i]);
  }
  return out.filter((chunk) => chunk.length > 0);
}

function runWorker(requests) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(__filename, { workerData: { requests } });
    worker.once('message', resolve);
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
      player_ids: config.players,
      max_turns: config.max_turns,
      seed: config.seed + i,
      rollout_samples: config.rollout_samples,
    });
  }

  if (config.jobs <= 1) {
    return requests.map((request) => runSingleGame(request));
  }

  const maxWorkers = Math.min(config.jobs, requests.length, os.cpus().length);
  const chunks = chunkRequests(requests, maxWorkers);
  const chunkResults = await Promise.all(chunks.map((chunk) => runWorker(chunk)));
  return chunkResults.flat();
}

function printSummary(results) {
  const policyIds = uniquePolicyIds(results.players);

  console.log('\n=== BENCHMARK RESULTS ===\n');
  console.log(`Players:        ${results.players.join(', ')}`);
  console.log(`Games played:   ${results.games}`);
  console.log(`Draws:          ${results.draws}`);
  console.log(`Avg rounds:     ${results.rounds_per_game.avg}`);
  console.log(`Avg turns:      ${results.turns_per_game.avg}\n`);

  console.log('Per-policy summary:');
  for (const policyId of policyIds) {
    console.log(
      `  ${policyId} (${results.policy_labels[policyId]}): `
      + `wins=${results.wins[policyId]} `
      + `win/game=${(results.win_rates_by_game[policyId] * 100).toFixed(1)}% `
      + `win/seat=${(results.win_rates_by_appearance[policyId] * 100).toFixed(1)}% `
      + `avg_score=${results.avg_final_score[policyId]} `
      + `assafs=${results.assafs_received[policyId]} `
      + `resets=${results.resets_earned[policyId]}`,
    );
  }

  console.log('\nYaniv calling:');
  for (const policyId of policyIds) {
    console.log(
      `  ${policyId}: calls=${results.yaniv_calls[policyId]} `
      + `successful=${results.successful_yaniv_calls[policyId]} `
      + `assaf_rate=${(results.assaf_rate_per_yaniv_call[policyId] * 100).toFixed(1)}%`,
    );
  }

  console.log('\nEstimated immediate feed punish events:');
  for (const policyId of policyIds) {
    console.log(`  ${policyId}: ${results.estimated_feed_punishes[policyId]}`);
  }

  console.log('\nDecision latency:');
  for (const policyId of policyIds) {
    const latency = results.decision_latency_ms[policyId];
    console.log(
      `  ${policyId}: avg=${latency.avg_ms.toFixed(3)}ms `
      + `p95=${latency.p95_ms.toFixed(3)}ms `
      + `max=${latency.max_ms.toFixed(3)}ms `
      + `(${latency.decisions} decisions)`,
    );
  }

  if (results.errors) {
    console.log(`\nErrors: ${results.errors}`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.list_policies) {
    console.log(listPolicies().join('\n'));
    return;
  }

  const started = performance.now();
  console.log(`Running ${args.games} games with players: ${args.players.join(', ')} ...`);

  const rawResults = await runBenchmarks(args);
  const summary = summarizeResults(rawResults, args.players);
  const elapsed = Number(((performance.now() - started) / 1000).toFixed(3));

  const payload = {
    created_at: new Date().toISOString(),
    config: {
      players: args.players,
      games: args.games,
      max_turns: args.max_turns,
      seed: args.seed,
      rollout_samples: args.rollout_samples,
      jobs: args.jobs,
    },
    runtime_seconds: elapsed,
    results: summary,
  };

  printSummary(summary);

  const outPath = args.output
    || path.join(
      'metrics',
      `benchmark_${args.players.join('-')}_${new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '_')}.json`,
    );
  const outDir = path.dirname(outPath);
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');

  console.log(`\nSaved benchmark results to ${outPath}`);
}

if (isMainThread) {
  if (require.main === module) {
    main().catch((err) => {
      console.error(err.stack || err.message || String(err));
      process.exit(1);
    });
  }
} else {
  const requests = workerData.requests || [];
  const raw = requests.map((request) => runSingleGame(request));
  parentPort.postMessage(raw);
}

module.exports = {
  POLICY_REGISTRY,
  listPolicies,
  parsePlayerIds,
  registerPolicy,
  runBenchmarks,
  runSingleGame,
  summarizeResults,
  unregisterPolicy,
};
