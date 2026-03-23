#!/usr/bin/env node

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { performance } = require('node:perf_hooks');

const { YanivGame } = require('../server/src/yaniv');
const { Player } = require('../server/src/player');
const { Card } = require('../server/src/card');
const { AIPlayer: ProductionAIPlayer } = require('../server/src/aiplayer');
const { AIPlayer: V1AIPlayer } = require('../server/src/aiplayer_v1');
const { AIPlayerV2 } = require('../server/src/aiplayer_v2');
const { LegacyAIPlayer } = require('../server/src/aiplayer_legacy');
const { AIPlayerV3 } = require('../server/src/aiplayer_v3');
const {
  AIPlayerLearned,
  actionSignature,
  buildLearnedActionCandidates,
  buildYanivFeatureMap,
} = require('../server/src/aiplayer_learned');
const {
  createBootstrapCheckpoint,
  trainBinaryModel,
  trainPolicyModel,
  trainValueModel,
} = require('../server/src/learned_model');
const {
  updateHeadToHeadRatings,
  updatePairwiseMultiplayerRatings,
} = require('../server/src/learned_ratings');
const benchmark = require('./benchmark');

class RandomPolicyPlayer extends Player {
  constructor(name) {
    super(name);
    this.policy_id = 'random';
    this.is_ai = false;
  }
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
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
  };
}

function softmax(values, temperature = 1) {
  if (values.length === 0) {
    return [];
  }
  const safeTemperature = Math.max(0.05, temperature);
  const scaled = values.map((value) => value / safeTemperature);
  const maxValue = Math.max(...scaled);
  const exps = scaled.map((value) => Math.exp(value - maxValue));
  const total = exps.reduce((sum, value) => sum + value, 0);
  if (total <= 0) {
    return values.map(() => 1 / values.length);
  }
  return exps.map((value) => value / total);
}

function sampleIndex(probabilities, rng) {
  const draw = rng.random();
  let cumulative = 0;
  for (let i = 0; i < probabilities.length; i += 1) {
    cumulative += probabilities[i];
    if (draw <= cumulative) {
      return i;
    }
  }
  return Math.max(0, probabilities.length - 1);
}

function actionCostMapFromSearch(player, context) {
  if (typeof player._iter_candidate_actions !== 'function') {
    return new Map();
  }

  const actionCosts = new Map();
  for (const [action, actionScore] of player._iter_candidate_actions(context)) {
    actionCosts.set(actionSignature(action), Number(actionScore));
  }
  return actionCosts;
}

function targetDistributionFromCosts(candidates, actionCosts, fallbackSignature = '') {
  if (candidates.length === 0) {
    return [];
  }

  const knownCosts = candidates
    .map((candidate) => actionCosts.get(candidate.action_signature))
    .filter((value) => Number.isFinite(value));
  const fallbackCost = knownCosts.length > 0 ? Math.max(...knownCosts) + 4 : 0;

  const searchLogits = candidates.map((candidate, index) => {
    const cost = actionCosts.has(candidate.action_signature)
      ? actionCosts.get(candidate.action_signature)
      : fallbackCost;
    const modelBonus = 0.12 * Number(candidate.combined_score || 0);
    const diversityBonus = index < 3 ? 0.04 * (3 - index) : 0;
    return -cost + modelBonus + diversityBonus;
  });

  const target = softmax(searchLogits, 0.55);
  const targetSum = target.reduce((sum, value) => sum + value, 0);
  if (targetSum > 0) {
    return target.map((value) => value / targetSum);
  }

  const oneHot = new Array(candidates.length).fill(0);
  const chosenIndex = candidates.findIndex((candidate) => candidate.action_signature === fallbackSignature);
  oneHot[chosenIndex >= 0 ? chosenIndex : 0] = 1;
  return oneHot;
}

function oneHotTarget(candidates, chosenSignature) {
  const target = new Array(candidates.length).fill(0);
  const chosenIndex = candidates.findIndex((candidate) => candidate.action_signature === chosenSignature);
  target[chosenIndex >= 0 ? chosenIndex : 0] = 1;
  return target;
}

function cloneDeepWithPrototype(value, cache = new Map()) {
  if (value === null || value === undefined) {
    return value;
  }
  if (typeof value === 'function') {
    return value;
  }
  if (typeof value !== 'object') {
    return value;
  }
  if (cache.has(value)) {
    return cache.get(value);
  }
  if (value instanceof Card) {
    return new Card(value.id);
  }
  if (Array.isArray(value)) {
    const out = [];
    cache.set(value, out);
    for (const entry of value) {
      out.push(cloneDeepWithPrototype(entry, cache));
    }
    return out;
  }
  if (value instanceof Map) {
    const out = new Map();
    cache.set(value, out);
    for (const [key, entry] of value.entries()) {
      out.set(cloneDeepWithPrototype(key, cache), cloneDeepWithPrototype(entry, cache));
    }
    return out;
  }
  if (value instanceof Set) {
    const out = new Set();
    cache.set(value, out);
    for (const entry of value.values()) {
      out.add(cloneDeepWithPrototype(entry, cache));
    }
    return out;
  }

  const out = Object.create(Object.getPrototypeOf(value));
  cache.set(value, out);
  for (const key of Object.keys(value)) {
    out[key] = cloneDeepWithPrototype(value[key], cache);
  }
  return out;
}

function cloneTrainingGame(game, seed) {
  const cloned = cloneDeepWithPrototype(game);
  cloned._rng = makeRng(seed);
  return cloned;
}

function cloneActionForPlayer(action, player) {
  const discard = [];
  for (const card of action.discard || []) {
    const match = player.hand.find((candidate) => candidate.id === card.id);
    if (!match) {
      return null;
    }
    discard.push(match);
  }

  return {
    draw: action.draw,
    discard,
  };
}

function effectivePlayerMetrics(players) {
  return players.map((player) => ({
    name: player.name,
    policy_id: player.policy_id,
    score: Number((player.score + player.hand.reduce((sum, card) => sum + card.value, 0)).toFixed(4)),
  }));
}

function chooseRolloutAction(player, rng) {
  if (player.policy_id === 'learned') {
    return chooseLearnedAction(player, rng, 'self-play');
  }
  if (typeof player.decide_action === 'function') {
    return player.decide_action();
  }

  const context = typeof player._build_action_context === 'function' ? player._build_action_context() : null;
  const candidates = context ? buildLearnedActionCandidates(player, context, null) : [];
  if (candidates.length === 0) {
    throw new Error(`No legal rollout action available for player '${player.name}'`);
  }
  return candidates[rng.randint(0, candidates.length - 1)].action;
}

function simulateCandidateRollout(game, actingPlayerName, candidateAction, config, seed) {
  const rolloutGame = cloneTrainingGame(game, seed);
  const rolloutRng = makeRng(seed + 19_981);
  const rolloutPlayer = rolloutGame.players.find((player) => player.name === actingPlayerName);
  if (!rolloutPlayer) {
    return null;
  }

  const clonedAction = cloneActionForPlayer(candidateAction, rolloutPlayer);
  if (!clonedAction) {
    return null;
  }

  try {
    rolloutGame.playTurn(rolloutPlayer, clonedAction);
  } catch (err) {
    return null;
  }

  let turns = 0;
  while (turns < config.rollout_target_turns && rolloutGame.players.length > 1) {
    turns += 1;
    try {
      const [currentPlayer] = rolloutGame.startTurn();
      if (rolloutGame.canDeclareYaniv(currentPlayer) && typeof currentPlayer.should_declare_yaniv === 'function') {
        if (currentPlayer.should_declare_yaniv()) {
          rolloutGame.declareYaniv(currentPlayer);
          continue;
        }
      }

      const action = chooseRolloutAction(currentPlayer, rolloutRng);
      rolloutGame.playTurn(currentPlayer, action);
    } catch (err) {
      return null;
    }
  }

  const metrics = effectivePlayerMetrics(rolloutGame.players);
  return normalizeResultScore(metrics, actingPlayerName);
}

function buildRolloutTargetDistribution(game, player, candidates, heuristicTarget, chosenSignature, config, seedBase) {
  if (candidates.length === 0) {
    return [];
  }

  const rankedIndices = candidates
    .map((candidate, index) => ({
      index,
      heuristic: Number(heuristicTarget[index] || 0),
      combined: Number(candidate.combined_score || 0),
    }))
    .sort((left, right) => {
      if (right.heuristic !== left.heuristic) {
        return right.heuristic - left.heuristic;
      }
      return right.combined - left.combined;
    });

  const chosenIndex = candidates.findIndex((candidate) => candidate.action_signature === chosenSignature);
  const selectedIndices = rankedIndices
    .slice(0, Math.min(config.rollout_target_candidates, candidates.length))
    .map((entry) => entry.index);
  if (chosenIndex >= 0 && !selectedIndices.includes(chosenIndex)) {
    selectedIndices.push(chosenIndex);
  }

  const rolloutScores = new Array(candidates.length).fill(null);
  for (const index of selectedIndices) {
    let total = 0;
    let count = 0;
    for (let sampleIndex = 0; sampleIndex < config.rollout_target_samples; sampleIndex += 1) {
      const score = simulateCandidateRollout(
        game,
        player.name,
        candidates[index].action,
        config,
        seedBase + (index * 4099) + (sampleIndex * 65_537),
      );
      if (Number.isFinite(score)) {
        total += score;
        count += 1;
      }
    }
    if (count > 0) {
      rolloutScores[index] = total / count;
    }
  }

  const observedScores = rolloutScores.filter((value) => Number.isFinite(value));
  if (observedScores.length === 0) {
    return heuristicTarget;
  }

  const floorScore = Math.min(...observedScores) - 0.08;
  const rolloutLogits = candidates.map((candidate, index) => {
    const rolloutScore = Number.isFinite(rolloutScores[index]) ? rolloutScores[index] : floorScore;
    const rolloutTerm = 5.5 * (rolloutScore - 0.5);
    const priorTerm = 0.16 * Number(heuristicTarget[index] || 0);
    const modelTerm = 0.05 * Number(candidate.combined_score || 0);
    return rolloutTerm + priorTerm + modelTerm;
  });
  const rolloutTarget = softmax(rolloutLogits, 0.35);
  const blendWeight = clamp(Number(config.rollout_target_weight || 0.7), 0, 1);
  const blended = rolloutTarget.map((value, index) => (
    (blendWeight * value) + ((1 - blendWeight) * Number(heuristicTarget[index] || 0))
  ));
  const sum = blended.reduce((acc, value) => acc + value, 0);
  if (sum <= 0) {
    return heuristicTarget;
  }
  return blended.map((value) => value / sum);
}

function defaultOutputRoot() {
  return path.resolve(process.cwd(), 'metrics', 'learned-ai');
}

function runtimeManifestPath() {
  return path.resolve(__dirname, '..', 'server', 'learned_ai', 'current_champion.json');
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function readJson(jsonPath) {
  return JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
}

function writeJson(jsonPath, payload) {
  ensureDir(path.dirname(jsonPath));
  fs.writeFileSync(jsonPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function appendJsonl(jsonlPath, payload) {
  ensureDir(path.dirname(jsonlPath));
  fs.appendFileSync(jsonlPath, `${JSON.stringify(payload)}\n`, 'utf8');
}

function maybeDeleteReplay(replayPath, shouldDelete) {
  if (!shouldDelete || !replayPath) {
    return;
  }
  if (fs.existsSync(replayPath)) {
    fs.unlinkSync(replayPath);
  }
}

function timestampTag() {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '_');
}

function parseArgs(argv) {
  const out = {
    command: argv[0] || 'run',
    seconds: 60,
    games: 24,
    eval_games_2p: 24,
    eval_games_3p: 24,
    max_turns: 1000,
    seed: 42,
    rollout_samples: 24,
    output_root: defaultOutputRoot(),
    replay_path: '',
    candidate_manifest_path: '',
    manifest_path: runtimeManifestPath(),
    mode: '',
    jobs: Math.max(1, Math.min(os.cpus().length, 4)),
    learning_rate: 0.03,
    epochs: 6,
    keep_replay: false,
    rollout_target_candidates: 4,
    rollout_target_samples: 2,
    rollout_target_turns: 18,
    rollout_target_weight: 0.7,
  };

  for (let i = 1; i < argv.length; i += 1) {
    const token = argv[i];
    const value = argv[i + 1];

    if (token === '--games') out.games = Number.parseInt(value, 10);
    if (token === '--seconds') out.seconds = Number.parseInt(value, 10);
    if (token === '--eval-games-2p') out.eval_games_2p = Number.parseInt(value, 10);
    if (token === '--eval-games-3p') out.eval_games_3p = Number.parseInt(value, 10);
    if (token === '--max-turns') out.max_turns = Number.parseInt(value, 10);
    if (token === '--seed') out.seed = Number.parseInt(value, 10);
    if (token === '--rollout-samples') out.rollout_samples = Number.parseInt(value, 10);
    if (token === '--output-root') out.output_root = path.resolve(process.cwd(), value);
    if (token === '--replay-path') out.replay_path = path.resolve(process.cwd(), value);
    if (token === '--manifest-path') out.manifest_path = path.resolve(process.cwd(), value);
    if (token === '--mode') out.mode = String(value || '');
    if (token === '--jobs') out.jobs = Number.parseInt(value, 10);
    if (token === '--learning-rate') out.learning_rate = Number(value);
    if (token === '--epochs') out.epochs = Number.parseInt(value, 10);
    if (token === '--candidate-manifest-path') out.candidate_manifest_path = path.resolve(process.cwd(), value);
    if (token === '--keep-replay') {
      out.keep_replay = true;
      continue;
    }
    if (token === '--rollout-target-candidates') out.rollout_target_candidates = Number.parseInt(value, 10);
    if (token === '--rollout-target-samples') out.rollout_target_samples = Number.parseInt(value, 10);
    if (token === '--rollout-target-turns') out.rollout_target_turns = Number.parseInt(value, 10);
    if (token === '--rollout-target-weight') out.rollout_target_weight = Number(value);

    if (token.startsWith('--')) i += 1;
  }

  out.games = Math.max(2, out.games);
  out.seconds = Math.max(1, out.seconds);
  out.eval_games_2p = Math.max(2, out.eval_games_2p);
  out.eval_games_3p = Math.max(2, out.eval_games_3p);
  out.max_turns = Math.max(100, out.max_turns);
  out.rollout_samples = Math.max(4, out.rollout_samples);
  out.jobs = Math.max(1, out.jobs);
  out.epochs = Math.max(1, out.epochs);
  out.rollout_target_candidates = Math.max(1, out.rollout_target_candidates);
  out.rollout_target_samples = Math.max(1, out.rollout_target_samples);
  out.rollout_target_turns = Math.max(2, out.rollout_target_turns);
  out.rollout_target_weight = clamp(
    Number.isFinite(out.rollout_target_weight) ? out.rollout_target_weight : 0.7,
    0,
    1,
  );
  return out;
}

function nextSeed(seed, step = 9973) {
  const next = (Number(seed) + step) >>> 0;
  return next > 0 ? next : step;
}

function loadManifest(manifestPath) {
  return readJson(manifestPath);
}

function normalizeResultScore(playerMetrics, playerName) {
  const player = playerMetrics.find((metric) => metric.name === playerName);
  if (!player) {
    return 0;
  }

  let total = 0;
  let count = 0;
  for (const other of playerMetrics) {
    if (other.name === playerName) continue;
    if (player.score < other.score) total += 1;
    else if (player.score === other.score) total += 0.5;
    count += 1;
  }

  return count > 0 ? (total / count) : 0;
}

function canRecordPolicy(player) {
  return player instanceof AIPlayerV3 || player instanceof AIPlayerLearned;
}

function chooseLearnedAction(player, rng, mode) {
  const checkpoint = player._getLearnedCheckpoint();
  const context = player._build_action_context();
  const candidates = buildLearnedActionCandidates(player, context, checkpoint);
  if (candidates.length === 0) {
    return player.decide_action();
  }

  if (mode !== 'self-play') {
    return candidates[0].action;
  }

  const topCandidates = candidates.slice(0, Math.min(5, candidates.length));
  if (rng.random() < 0.10) {
    return topCandidates[rng.randint(0, topCandidates.length - 1)].action;
  }

  const probabilities = softmax(topCandidates.map((candidate) => candidate.combined_score), 0.65);
  return topCandidates[sampleIndex(probabilities, rng)].action;
}

function instantiatePolicy(policyId, name, rolloutSamples, options = {}) {
  let player;
  switch (policyId) {
    case 'learned':
      player = new AIPlayerLearned(name, rolloutSamples, { manifestPath: options.manifestPath });
      break;
    case 'v3':
      player = new ProductionAIPlayer(name, rolloutSamples);
      break;
    case 'v2':
      player = new AIPlayerV2(name, rolloutSamples);
      break;
    case 'v1':
      player = new V1AIPlayer(name, rolloutSamples);
      break;
    case 'legacy':
      player = new LegacyAIPlayer(name, rolloutSamples);
      break;
    case 'random':
      player = new RandomPolicyPlayer(name);
      break;
    default:
      throw new Error(`Unsupported training policy '${policyId}'`);
  }

  player.policy_id = policyId;
  player.is_ai = policyId !== 'random';
  return player;
}

function buildLeaguePolicies(mode, playerCount, gameIndex) {
  const warmstart2p = [
    ['v3', 'v3'],
    ['v3', 'v2'],
    ['v3', 'v1'],
  ];
  const warmstart3p = [
    ['v3', 'v2', 'v1'],
    ['v3', 'legacy', 'v2'],
    ['v3', 'v1', 'legacy'],
  ];
  const selfPlay2p = [
    ['learned', 'v3'],
    ['learned', 'learned'],
    ['learned', 'v2'],
    ['learned', 'legacy'],
  ];
  const selfPlay3p = [
    ['learned', 'v3', 'v2'],
    ['learned', 'learned', 'v3'],
    ['learned', 'v3', 'legacy'],
    ['learned', 'v2', 'v1'],
  ];
  const v3Curriculum2p = [
    ['learned', 'v3'],
    ['learned', 'v3'],
    ['learned', 'v3'],
    ['learned', 'v2'],
  ];
  const v3Curriculum3p = [
    ['learned', 'v3', 'v3'],
    ['learned', 'v3', 'legacy'],
    ['learned', 'v3', 'v2'],
    ['learned', 'v3', 'learned'],
  ];

  let source;
  if (mode === 'warmstart') {
    source = playerCount === 2 ? warmstart2p : warmstart3p;
  } else if (mode === 'v3-curriculum') {
    source = playerCount === 2 ? v3Curriculum2p : v3Curriculum3p;
  } else {
    source = playerCount === 2 ? selfPlay2p : selfPlay3p;
  }

  return source[gameIndex % source.length];
}

function buildPlayersForGame(policyIds, rolloutSamples, manifestPath, gameIndex) {
  const rotated = policyIds.slice(gameIndex % policyIds.length).concat(policyIds.slice(0, gameIndex % policyIds.length));
  const counts = {};
  return rotated.map((policyId) => {
    counts[policyId] = (counts[policyId] || 0) + 1;
    return instantiatePolicy(policyId, `${policyId}-${counts[policyId]}`, rolloutSamples, { manifestPath });
  });
}

function scorePlayers(allPlayers) {
  return allPlayers.map((player) => ({
    name: player.name,
    policy_id: player.policy_id,
    score: player.score,
  }));
}

function maybeRecordActionSample(samples, game, player, action, sourceKind, config, seedBase) {
  if (!canRecordPolicy(player)) {
    return;
  }

  const context = player._build_action_context();
  const checkpoint = player instanceof AIPlayerLearned ? player._getLearnedCheckpoint() : null;
  const candidates = buildLearnedActionCandidates(player, context, checkpoint);
  if (candidates.length === 0) {
    return;
  }

  const signature = actionSignature(action);
  const chosenIndex = candidates.findIndex((candidate) => candidate.action_signature === signature);
  if (chosenIndex === -1) {
    return;
  }

  const actionCosts = actionCostMapFromSearch(player, context);
  const heuristicTarget = targetDistributionFromCosts(candidates, actionCosts, signature);
  const targetProbs = buildRolloutTargetDistribution(
    game,
    player,
    candidates,
    heuristicTarget,
    signature,
    config,
    seedBase,
  );
  const fallbackTarget = oneHotTarget(candidates, signature);

  samples.push({
    player_name: player.name,
    policy_id: player.policy_id,
    source_kind: sourceKind,
    chosen_index: chosenIndex,
    candidates: candidates.map((candidate) => candidate.action_features),
    chosen_value_features: candidates[chosenIndex].value_features,
    target_probs: targetProbs,
    fallback_target: fallbackTarget,
  });
}

function maybeRecordYanivSample(samples, player, decision, sourceKind) {
  if (!canRecordPolicy(player)) {
    return;
  }

  samples.push({
    player_name: player.name,
    policy_id: player.policy_id,
    source_kind: sourceKind,
    target: decision ? 1 : 0,
    features: buildYanivFeatureMap(player),
  });
}

function runTrainingGame(config, gameIndex) {
  const playerCount = (gameIndex % 2) === 0 ? 2 : 3;
  const policyIds = buildLeaguePolicies(config.mode, playerCount, gameIndex);
  const players = buildPlayersForGame(policyIds, config.rollout_samples, config.manifest_path, gameIndex);
  const game = new YanivGame(players, makeRng(config.seed + gameIndex + 1));
  const policyRng = makeRng(config.seed + 50_000 + gameIndex);
  const actionSamples = [];
  const yanivSamples = [];

  game.startGame();

  let turns = 0;
  let winner = null;
  let error = null;

  while (turns < config.max_turns) {
    if (game.players.length <= 1) {
      winner = game.players[0] || null;
      break;
    }

    turns += 1;
    try {
      const [currentPlayer] = game.startTurn();
      const sourceKind = currentPlayer.policy_id === 'learned' ? 'self_play' : 'teacher';

      if (game.canDeclareYaniv(currentPlayer)) {
        const shouldDeclare = currentPlayer.should_declare_yaniv();
        maybeRecordYanivSample(yanivSamples, currentPlayer, shouldDeclare, sourceKind);
        if (shouldDeclare) {
          const [, , declaredWinner] = game.declareYaniv(currentPlayer);
          if (declaredWinner) {
            winner = declaredWinner;
            break;
          }
          continue;
        }
      }

      const chosenAction = currentPlayer.policy_id === 'learned'
        ? chooseLearnedAction(currentPlayer, policyRng, config.mode)
        : currentPlayer.decide_action();
      maybeRecordActionSample(
        actionSamples,
        game,
        currentPlayer,
        chosenAction,
        sourceKind,
        config,
        config.seed + (gameIndex * 100_003) + (turns * 809),
      );
      const appliedAction = game.playTurn(currentPlayer, chosenAction);
      if (actionSignature(chosenAction) !== actionSignature(appliedAction)) {
        throw new Error('Learned data collection observed a non-deterministic AI action.');
      }
    } catch (err) {
      error = `${err.name}: ${err.message}`;
      break;
    }
  }

  if (!winner && !error && game.players.length === 1) {
    winner = game.players[0];
  }

  const finalMetrics = scorePlayers(players);
  const resultByName = Object.fromEntries(finalMetrics.map((metric) => [
    metric.name,
    normalizeResultScore(finalMetrics, metric.name),
  ]));

  for (const sample of actionSamples) {
    sample.result = resultByName[sample.player_name] || 0;
  }
  for (const sample of yanivSamples) {
    sample.result = resultByName[sample.player_name] || 0;
  }

  return {
    winner: winner ? winner.name : null,
    turns,
    error,
    player_metrics: finalMetrics,
    action_samples: actionSamples,
    yaniv_samples: yanivSamples,
  };
}

function generateReplay(config) {
  const actionSamples = [];
  const yanivSamples = [];
  const games = [];

  for (let i = 0; i < config.games; i += 1) {
    const result = runTrainingGame(config, i);
    games.push({
      winner: result.winner,
      turns: result.turns,
      error: result.error,
      player_metrics: result.player_metrics,
    });
    actionSamples.push(...result.action_samples);
    yanivSamples.push(...result.yaniv_samples);
  }

  const outPath = config.replay_path
    || path.join(config.output_root, 'replay', `replay_${timestampTag()}.json`);
  const payload = {
    created_at: new Date().toISOString(),
    mode: config.mode,
    config: {
      games: config.games,
      seed: config.seed,
      rollout_samples: config.rollout_samples,
      max_turns: config.max_turns,
    },
    games,
    action_samples: actionSamples,
    yaniv_samples: yanivSamples,
  };
  writeJson(outPath, payload);
  return { path: outPath, payload };
}

function sampleWeight(sample) {
  if (sample.source_kind === 'teacher') {
    return 1.0;
  }
  return clamp(0.35 + (Number(sample.result || 0) * 0.9), 0.2, 1.4);
}

function trainFromReplay(config, replayPath) {
  const replay = readJson(replayPath);
  const currentManifest = loadManifest(config.manifest_path);
  const currentCheckpointPath = path.isAbsolute(currentManifest.model_path)
    ? currentManifest.model_path
    : path.resolve(path.dirname(config.manifest_path), currentManifest.model_path);
  const existingCheckpoint = fs.existsSync(currentCheckpointPath)
    ? readJson(currentCheckpointPath)
    : createBootstrapCheckpoint();

  const actionSamples = replay.action_samples.map((sample) => ({
    ...sample,
    sample_weight: sampleWeight(sample),
  }));
  const valueSamples = replay.action_samples.map((sample) => ({
    features: sample.chosen_value_features,
    target: (2 * Number(sample.result || 0)) - 1,
    sample_weight: sampleWeight(sample),
  }));
  const yanivSamples = replay.yaniv_samples.map((sample) => ({
    ...sample,
    sample_weight: sampleWeight(sample),
  }));

  const actionModel = trainPolicyModel(actionSamples, existingCheckpoint.action_model, {
    learning_rate: config.learning_rate,
    epochs: config.epochs,
  });
  const valueModel = trainValueModel(valueSamples, existingCheckpoint.value_model, {
    learning_rate: config.learning_rate * 0.7,
    epochs: config.epochs,
  });
  const yanivModel = trainBinaryModel(yanivSamples, existingCheckpoint.yaniv_model, {
    learning_rate: config.learning_rate * 0.8,
    epochs: config.epochs,
  });
  yanivModel.threshold = 0.5;

  const checkpointId = `learned-${timestampTag()}`;
  const trainingIteration = Number(currentManifest.training_iteration || 0) + 1;
  const checkpoint = {
    schema_version: 1,
    checkpoint_id: checkpointId,
    training_iteration: trainingIteration,
    created_at: new Date().toISOString(),
    action_model: actionModel,
    value_model: valueModel,
    yaniv_model: yanivModel,
  };

  const checkpointPath = path.join(config.output_root, 'checkpoints', `${checkpointId}.json`);
  writeJson(checkpointPath, checkpoint);

  const manifest = {
    schema_version: 1,
    checkpoint_id: checkpointId,
    training_iteration: trainingIteration,
    created_at: checkpoint.created_at,
    rating_2p: Number(currentManifest.rating_2p || 1500),
    rating_3p: Number(currentManifest.rating_3p || 1500),
    win_rate_vs_v3: 0,
    latency_summary: {
      avg_ms: 0,
      p95_ms: 0,
      max_ms: 0,
    },
    model_path: checkpointPath,
  };
  const manifestPath = path.join(config.output_root, 'manifests', `${checkpointId}.json`);
  writeJson(manifestPath, manifest);

  return { manifestPath, checkpointPath, checkpoint, manifest };
}

function runEvaluationBenchmarks(candidateManifestPath, championManifestPath, config) {
  const registeredPolicyIds = [];
  const registerTempPolicy = (policyId, label, manifestPath) => {
    class TimedLearnedPolicy extends AIPlayerLearned {
      constructor(name, rolloutSamples) {
        super(name, rolloutSamples, { manifestPath });
        this.decision_times_ms = [];
        this.policy_id = policyId;
        this.is_ai = true;
      }

      decide_action() {
        const started = performance.now();
        const action = super.decide_action();
        this.decision_times_ms.push(performance.now() - started);
        return action;
      }
    }

    benchmark.registerPolicy(policyId, {
      label,
      create(name, rolloutSamples) {
        return new TimedLearnedPolicy(name, rolloutSamples);
      },
    });
    registeredPolicyIds.push(policyId);
  };

  registerTempPolicy('learned_candidate', 'Learned Candidate', candidateManifestPath);
  registerTempPolicy('learned_champion', 'Learned Champion', championManifestPath);

  const run = async () => {
    const headToHeadV3 = await benchmark.runBenchmarks({
      players: ['learned_candidate', 'v3'],
      games: config.eval_games_2p,
      max_turns: config.max_turns,
      seed: config.seed + 10_000,
      rollout_samples: config.rollout_samples,
      jobs: 1,
    });
    const headToHeadChampion = await benchmark.runBenchmarks({
      players: ['learned_candidate', 'learned_champion'],
      games: config.eval_games_2p,
      max_turns: config.max_turns,
      seed: config.seed + 20_000,
      rollout_samples: config.rollout_samples,
      jobs: 1,
    });
    const leagueA = await benchmark.runBenchmarks({
      players: ['learned_candidate', 'v3', 'v2'],
      games: Math.max(1, Math.floor(config.eval_games_3p / 2)),
      max_turns: config.max_turns,
      seed: config.seed + 30_000,
      rollout_samples: config.rollout_samples,
      jobs: 1,
    });
    const leagueB = await benchmark.runBenchmarks({
      players: ['learned_candidate', 'learned_champion', 'legacy'],
      games: Math.max(1, config.eval_games_3p - Math.floor(config.eval_games_3p / 2)),
      max_turns: config.max_turns,
      seed: config.seed + 40_000,
      rollout_samples: config.rollout_samples,
      jobs: 1,
    });

    return { headToHeadV3, headToHeadChampion, leagueA, leagueB };
  };

  return run().finally(() => {
    for (const policyId of registeredPolicyIds) {
      benchmark.unregisterPolicy(policyId);
    }
  });
}

function scoreFromWinner(result, winningPolicyId, losingPolicyId) {
  if (!result.winner_policy) return 0.5;
  if (result.winner_policy === winningPolicyId) return 1;
  if (result.winner_policy === losingPolicyId) return 0;
  return 0.5;
}

function evaluateCheckpoint(config, candidateManifestPath) {
  return runEvaluationBenchmarks(candidateManifestPath, config.manifest_path, config).then((raw) => {
    const currentManifest = loadManifest(config.manifest_path);
    const candidateManifest = readJson(candidateManifestPath);

    const v3Summary = benchmark.summarizeResults(raw.headToHeadV3, ['learned_candidate', 'v3']);
    const championSummary = benchmark.summarizeResults(raw.headToHeadChampion, ['learned_candidate', 'learned_champion']);
    const leagueASummary = benchmark.summarizeResults(raw.leagueA, ['learned_candidate', 'v3', 'v2']);
    const leagueBSummary = benchmark.summarizeResults(raw.leagueB, ['learned_candidate', 'learned_champion', 'legacy']);

    let rating2p = Number(currentManifest.rating_2p || 1500);
    let v3Rating2p = 1500;
    let championRating2p = Number(currentManifest.rating_2p || 1500);
    for (const result of raw.headToHeadV3) {
      const updated = updateHeadToHeadRatings(
        rating2p,
        v3Rating2p,
        scoreFromWinner(result, 'learned_candidate', 'v3'),
        24,
      );
      rating2p = updated.rating_a;
      v3Rating2p = updated.rating_b;
    }
    for (const result of raw.headToHeadChampion) {
      const updated = updateHeadToHeadRatings(
        rating2p,
        championRating2p,
        scoreFromWinner(result, 'learned_candidate', 'learned_champion'),
        24,
      );
      rating2p = updated.rating_a;
      championRating2p = updated.rating_b;
    }

    let ratings3p = {
      learned_candidate: Number(currentManifest.rating_3p || 1500),
      learned_champion: Number(currentManifest.rating_3p || 1500),
      v3: 1500,
      v2: 1450,
      legacy: 1350,
    };
    for (const result of [...raw.leagueA, ...raw.leagueB]) {
      ratings3p = updatePairwiseMultiplayerRatings(ratings3p, result.player_metrics, 12);
    }

    const combinedLatency = [
      v3Summary.decision_latency_ms.learned_candidate,
      championSummary.decision_latency_ms.learned_candidate,
      leagueASummary.decision_latency_ms.learned_candidate,
      leagueBSummary.decision_latency_ms.learned_candidate,
    ].filter(Boolean);

    const avgLatency = combinedLatency.length > 0
      ? combinedLatency.reduce((sum, entry) => sum + entry.avg_ms, 0) / combinedLatency.length
      : 0;
    const p95Latency = combinedLatency.length > 0
      ? Math.max(...combinedLatency.map((entry) => entry.p95_ms))
      : 0;
    const maxLatency = combinedLatency.length > 0
      ? Math.max(...combinedLatency.map((entry) => entry.max_ms))
      : 0;

    candidateManifest.rating_2p = Number(rating2p.toFixed(2));
    candidateManifest.rating_3p = Number(ratings3p.learned_candidate.toFixed(2));
    candidateManifest.win_rate_vs_v3 = Number((v3Summary.win_rates_by_game.learned_candidate || 0).toFixed(4));
    candidateManifest.latency_summary = {
      avg_ms: Number(avgLatency.toFixed(4)),
      p95_ms: Number(p95Latency.toFixed(4)),
      max_ms: Number(maxLatency.toFixed(4)),
    };
    writeJson(candidateManifestPath, candidateManifest);

    const currentComposite = (Number(currentManifest.rating_2p || 1500) + Number(currentManifest.rating_3p || 1500)) / 2;
    const candidateComposite = (candidateManifest.rating_2p + candidateManifest.rating_3p) / 2;
    const latencyOkay = avgLatency <= 30 && p95Latency <= 80;
    const promoted = latencyOkay && candidateComposite > currentComposite;

    const evaluation = {
      created_at: new Date().toISOString(),
      candidate_manifest_path: candidateManifestPath,
      runtime_manifest_path: config.manifest_path,
      promoted,
      latency_okay: latencyOkay,
      candidate: {
        checkpoint_id: candidateManifest.checkpoint_id,
        rating_2p: candidateManifest.rating_2p,
        rating_3p: candidateManifest.rating_3p,
        composite: Number(candidateComposite.toFixed(2)),
        win_rate_vs_v3: candidateManifest.win_rate_vs_v3,
        latency_summary: candidateManifest.latency_summary,
      },
      current: {
        checkpoint_id: currentManifest.checkpoint_id,
        rating_2p: Number(currentManifest.rating_2p || 1500),
        rating_3p: Number(currentManifest.rating_3p || 1500),
        composite: Number(currentComposite.toFixed(2)),
      },
      summaries: {
        candidate_vs_v3_2p: v3Summary,
        candidate_vs_champion_2p: championSummary,
        candidate_league_3p_a: leagueASummary,
        candidate_league_3p_b: leagueBSummary,
      },
    };

    if (promoted) {
      const runtimePayload = {
        ...candidateManifest,
        model_path: candidateManifest.model_path,
      };
      writeJson(config.manifest_path, runtimePayload);
    }

    const evalOutPath = path.join(config.output_root, 'evaluations', `evaluation_${candidateManifest.checkpoint_id}.json`);
    writeJson(evalOutPath, evaluation);
    appendJsonl(path.join(config.output_root, 'progress.jsonl'), evaluation);
    return { path: evalOutPath, payload: evaluation };
  });
}

function loadProgress(progressPath) {
  if (!fs.existsSync(progressPath)) {
    return [];
  }
  return fs.readFileSync(progressPath, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function plotProgress(config) {
  const progressPath = path.join(config.output_root, 'progress.jsonl');
  const rows = loadProgress(progressPath);
  const data = rows.map((row, index) => ({
    x: index + 1,
    checkpoint_id: row.candidate.checkpoint_id,
    rating_2p: row.candidate.rating_2p,
    rating_3p: row.candidate.rating_3p,
    win_rate_vs_v3: row.candidate.win_rate_vs_v3,
    avg_ms: row.candidate.latency_summary.avg_ms,
    promoted: row.promoted,
  }));

  const outPath = path.join(config.output_root, 'plots', 'progress.html');
  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Learned AI Progress</title>
  <style>
    body { font-family: Georgia, serif; margin: 24px; background: #f8f3ea; color: #1f252c; }
    h1 { margin-bottom: 8px; }
    .meta { color: #5f6a74; margin-bottom: 20px; }
    canvas { display: block; margin: 18px 0 28px; border: 1px solid #d8cdbf; background: #fffdf8; }
    table { border-collapse: collapse; width: 100%; background: #fffdf8; }
    th, td { border: 1px solid #d8cdbf; padding: 8px; text-align: left; }
    th { background: #efe4d0; }
  </style>
</head>
<body>
  <h1>Learned AI Progress</h1>
  <div class="meta">Separate 2-player and 3-player rating curves, plus win rate versus V3 and latency.</div>
  <canvas id="ratings" width="960" height="320"></canvas>
  <canvas id="winrate" width="960" height="220"></canvas>
  <canvas id="latency" width="960" height="220"></canvas>
  <table>
    <thead>
      <tr><th>Iteration</th><th>Checkpoint</th><th>2p Elo</th><th>3p Elo</th><th>Win Rate vs V3</th><th>Avg ms</th><th>Promoted</th></tr>
    </thead>
    <tbody id="rows"></tbody>
  </table>
  <script>
    const data = ${JSON.stringify(data)};
    function drawLineChart(canvasId, series, minY, maxY) {
      const canvas = document.getElementById(canvasId);
      const ctx = canvas.getContext('2d');
      const width = canvas.width;
      const height = canvas.height;
      const left = 50;
      const top = 20;
      const plotWidth = width - 70;
      const plotHeight = height - 50;
      ctx.clearRect(0, 0, width, height);
      ctx.strokeStyle = '#b8b0a1';
      ctx.strokeRect(left, top, plotWidth, plotHeight);
      if (!data.length) return;
      for (const entry of series) {
        ctx.beginPath();
        ctx.strokeStyle = entry.color;
        entry.values.forEach((value, index) => {
          const x = left + (plotWidth * index / Math.max(1, data.length - 1));
          const y = top + plotHeight - ((value - minY) / Math.max(1, maxY - minY)) * plotHeight;
          if (index === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        });
        ctx.stroke();
      }
    }
    const ratings = data.map((row) => row.rating_2p).concat(data.map((row) => row.rating_3p));
    const minRating = ratings.length ? Math.min(...ratings) - 10 : 1400;
    const maxRating = ratings.length ? Math.max(...ratings) + 10 : 1600;
    drawLineChart('ratings', [
      { color: '#2e5e4e', values: data.map((row) => row.rating_2p) },
      { color: '#a4552d', values: data.map((row) => row.rating_3p) }
    ], minRating, maxRating);
    drawLineChart('winrate', [
      { color: '#2a4f88', values: data.map((row) => row.win_rate_vs_v3 * 100) }
    ], 0, 100);
    const latencyValues = data.map((row) => row.avg_ms);
    drawLineChart('latency', [
      { color: '#7a3c58', values: latencyValues }
    ], 0, latencyValues.length ? Math.max(...latencyValues) + 2 : 10);
    const rows = document.getElementById('rows');
    data.forEach((row) => {
      const tr = document.createElement('tr');
      tr.innerHTML = '<td>' + row.x + '</td>'
        + '<td>' + row.checkpoint_id + '</td>'
        + '<td>' + row.rating_2p + '</td>'
        + '<td>' + row.rating_3p + '</td>'
        + '<td>' + (row.win_rate_vs_v3 * 100).toFixed(1) + '%</td>'
        + '<td>' + row.avg_ms.toFixed(3) + '</td>'
        + '<td>' + (row.promoted ? 'yes' : 'no') + '</td>';
      rows.appendChild(tr);
    });
  </script>
</body>
</html>`;
  writeJson(path.join(config.output_root, 'plots', 'progress.json'), data);
  ensureDir(path.dirname(outPath));
  fs.writeFileSync(outPath, html, 'utf8');
  return { path: outPath, entries: data.length };
}

async function runAll(config) {
  const currentManifest = loadManifest(config.manifest_path);
  const mode = config.mode || (Number(currentManifest.training_iteration || 0) === 0 ? 'warmstart' : 'self-play');
  const generateConfig = { ...config, mode };
  const replay = generateReplay(generateConfig);
  const shouldDeleteReplay = !config.keep_replay && !config.replay_path;
  try {
    const trained = trainFromReplay(config, replay.path);
    const evaluation = await evaluateCheckpoint(config, trained.manifestPath);
    const plot = plotProgress(config);
    return { replay, trained, evaluation, plot, mode };
  } finally {
    maybeDeleteReplay(replay.path, shouldDeleteReplay);
  }
}

async function runBurst(config) {
  const startedAt = Date.now();
  const deadline = startedAt + (config.seconds * 1000);
  let workingManifestPath = config.manifest_path;
  let workingSeed = Number(config.seed || 42);
  let iteration = 0;
  let lastEvaluation = null;
  const summaries = [];

  while (Date.now() < deadline) {
    iteration += 1;
    const currentManifest = loadManifest(workingManifestPath);
    const mode = config.mode
      || (iteration % 3 === 0 ? 'self-play' : 'v3-curriculum');
    const iterConfig = {
      ...config,
      mode,
      manifest_path: workingManifestPath,
      seed: workingSeed,
    };

    const replay = generateReplay(iterConfig);
    const shouldDeleteReplay = !iterConfig.keep_replay && !iterConfig.replay_path;
    let trained;
    let evaluation;
    try {
      trained = trainFromReplay(iterConfig, replay.path);
      evaluation = await evaluateCheckpoint(iterConfig, trained.manifestPath);
    } finally {
      maybeDeleteReplay(replay.path, shouldDeleteReplay);
    }
    lastEvaluation = evaluation;

    const payload = evaluation.payload;
    summaries.push({
      iteration,
      mode,
      seed: workingSeed,
      checkpoint_id: payload.candidate.checkpoint_id,
      promoted: payload.promoted,
      composite: payload.candidate.composite,
      win_rate_vs_v3: payload.candidate.win_rate_vs_v3,
    });

    if (payload.promoted) {
      workingManifestPath = workingManifestPath;
    }

    workingSeed = nextSeed(workingSeed);
    if ((Date.now() + 1500) >= deadline) {
      break;
    }
  }

  const plot = plotProgress({
    ...config,
    manifest_path: workingManifestPath,
  });

  const burstSummary = {
    created_at: new Date().toISOString(),
    seconds: config.seconds,
    iterations: iteration,
    final_manifest_path: workingManifestPath,
    last_evaluation_path: lastEvaluation ? lastEvaluation.path : null,
    summaries,
    plot_path: plot.path,
  };
  const outPath = path.join(config.output_root, 'burst', `burst_${timestampTag()}.json`);
  writeJson(outPath, burstSummary);

  return {
    path: outPath,
    payload: burstSummary,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  ensureDir(args.output_root);

  if (args.command === 'generate') {
    const currentManifest = loadManifest(args.manifest_path);
    const replay = generateReplay({
      ...args,
      mode: args.mode || (Number(currentManifest.training_iteration || 0) === 0 ? 'warmstart' : 'self-play'),
    });
    console.log(`Saved replay to ${replay.path}`);
    return;
  }

  if (args.command === 'train') {
    if (!args.replay_path) {
      throw new Error('`train` requires --replay-path');
    }
    const trained = trainFromReplay(args, args.replay_path);
    console.log(`Saved checkpoint manifest to ${trained.manifestPath}`);
    return;
  }

  if (args.command === 'evaluate') {
    const candidateManifestPath = args.candidate_manifest_path || args.replay_path;
    if (!candidateManifestPath) {
      throw new Error('`evaluate` requires --candidate-manifest-path (or --replay-path for compatibility)');
    }
    const evaluation = await evaluateCheckpoint(args, candidateManifestPath);
    console.log(`Saved evaluation to ${evaluation.path}`);
    return;
  }

  if (args.command === 'plot') {
    const plot = plotProgress(args);
    console.log(`Saved plot to ${plot.path}`);
    return;
  }

  if (args.command === 'burst') {
    const result = await runBurst(args);
    console.log(`Saved burst summary to ${result.path}`);
    console.log(`Plot: ${result.payload.plot_path}`);
    return;
  }

  const result = await runAll(args);
  console.log(`Mode: ${result.mode}`);
  console.log(`Replay: ${result.replay.path}`);
  console.log(`Candidate: ${result.trained.manifestPath}`);
  console.log(`Evaluation: ${result.evaluation.path}`);
  console.log(`Plot: ${result.plot.path}`);
}

main().catch((err) => {
  console.error(err.stack || err.message || String(err));
  process.exit(1);
});
