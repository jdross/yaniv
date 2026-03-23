const fs = require('node:fs');
const path = require('node:path');

const { AIPlayerV3 } = require('./aiplayer_v3');
const {
  ACTION_FEATURE_NAMES,
  VALUE_FEATURE_NAMES,
  YANIV_FEATURE_NAMES,
  createBootstrapCheckpoint,
  normalizeLinearModel,
  scoreLinearModel,
  sigmoid,
} = require('./learned_model');

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function containsCard(cards, target) {
  return cards.some((card) => card._card === target._card);
}

function sumCardValues(cards) {
  return cards.reduce((sum, card) => sum + card.value, 0);
}

function actionSignature(action) {
  const discard = [...(action.discard || [])]
    .map((card) => card._card)
    .sort((a, b) => a - b)
    .join(',');
  return `${action.draw}|${discard}`;
}

function ensureCheckpointShape(checkpoint) {
  if (!checkpoint || checkpoint.schema_version !== 1) {
    throw new Error('Learned checkpoint is missing or uses an unsupported schema version.');
  }

  return {
    ...checkpoint,
    action_model: normalizeLinearModel(checkpoint.action_model, ACTION_FEATURE_NAMES),
    value_model: normalizeLinearModel(checkpoint.value_model, VALUE_FEATURE_NAMES),
    yaniv_model: {
      ...normalizeLinearModel(checkpoint.yaniv_model, YANIV_FEATURE_NAMES),
      threshold: Number(
        checkpoint.yaniv_model && checkpoint.yaniv_model.threshold !== undefined
          ? checkpoint.yaniv_model.threshold
          : 0.5,
      ),
    },
  };
}

function maxOpponentLowCardBias(player) {
  let maxBias = 0;
  for (const playerInfo of Object.values(player.other_players || {})) {
    maxBias = Math.max(maxBias, Number(playerInfo.low_card_bias || 0));
  }
  return maxBias;
}

function knownLowCards(player) {
  let count = 0;
  for (const playerInfo of Object.values(player.other_players || {})) {
    count += (playerInfo.known_cards || []).filter((card) => card.value <= 3).length;
  }
  return count;
}

function minOpponentHandCount(player) {
  const counts = Object.values(player.other_players || {})
    .map((playerInfo) => Number(playerInfo.hand_count || 5));
  if (counts.length === 0) {
    return 5;
  }
  return Math.min(...counts);
}

function beliefDangerForDiscard(player, discardOption) {
  if (typeof player._belief_card_danger !== 'function') {
    return 0;
  }

  return discardOption.reduce((sum, card) => sum + player._belief_card_danger(card), 0);
}

function buildDeckFallbackCard(postDiscardHand) {
  const averageValue = postDiscardHand.length > 0
    ? clamp(sumCardValues(postDiscardHand) / postDiscardHand.length, 1, 10)
    : 5;
  return { value: averageValue };
}

function aggregateFeatureMaps(featureMaps, featureNames) {
  const aggregate = Object.fromEntries(featureNames.map((name) => [name, 0]));
  if (featureMaps.length === 0) {
    return aggregate;
  }

  for (const featureMap of featureMaps) {
    for (const featureName of featureNames) {
      aggregate[featureName] += Number(featureMap[featureName] || 0);
    }
  }

  for (const featureName of featureNames) {
    aggregate[featureName] /= featureMaps.length;
  }

  return aggregate;
}

function buildActionFeatureMaps(player, context, discardOption, drawCards, drewFromDeck) {
  const postDiscardHand = player.hand.filter((card) => !containsCard(discardOption, card));
  const postDiscardTotal = sumCardValues(postDiscardHand);
  const discardValue = sumCardValues(discardOption);
  const feedPenalty = player._feed_penalty(discardOption, context.known_ranks, context.known_suit_ranks);
  const jokerDiscardPenalty = 1.5 * discardOption.filter((card) => card.rank === 'Joker').length;
  const beliefDanger = beliefDangerForDiscard(player, discardOption);
  const handTotalBefore = sumCardValues(player.hand);
  const opponentCount = Object.keys(player.other_players || {}).length;

  return drawCards.map((drawCard) => {
    const drawValue = Number(drawCard && drawCard.value !== undefined ? drawCard.value : 5);
    const isRealCard = Boolean(drawCard && drawCard._card !== undefined);
    let futureScore = player._best_residual_points(postDiscardHand);
    let compositionBonus = 0;

    if (isRealCard) {
      const [simulatedFuture, bestNextDiscard] = player._simulate_action(postDiscardHand, drawCard, false);
      futureScore = simulatedFuture;
      if (bestNextDiscard) {
        const newHand = [...postDiscardHand, drawCard];
        const remaining = newHand.filter((card) => !containsCard(bestNextDiscard, card));
        compositionBonus = 0.10 * player._hand_composition_bonus(remaining);
      }
    } else {
      compositionBonus = 0.10 * player._hand_composition_bonus(postDiscardHand);
    }

    const immediatePoints = postDiscardTotal + drawValue;
    const resetBonus = player._reset_bonus(immediatePoints, context.yaniv_next_turn_prob);
    const resultingHandCount = postDiscardHand.length + 1;

    return {
      action_features: {
        threat: context.threat,
        yaniv_next_turn_prob: context.yaniv_next_turn_prob,
        deck_variance: context.deck_variance,
        immediate_points: immediatePoints,
        future_score: futureScore,
        discard_value: discardValue,
        discard_count: discardOption.length,
        draw_value: drawValue,
        drew_from_deck: drewFromDeck ? 1 : 0,
        feed_penalty: feedPenalty,
        belief_danger: beliefDanger,
        joker_discard_penalty: jokerDiscardPenalty,
        composition_bonus: compositionBonus,
        reset_bonus: resetBonus,
        post_discard_total: postDiscardTotal,
        hand_total_before: handTotalBefore,
        opponent_count: opponentCount,
      },
      value_features: {
        resulting_hand_total: immediatePoints,
        resulting_hand_count: resultingHandCount,
        threat: context.threat,
        yaniv_next_turn_prob: context.yaniv_next_turn_prob,
        deck_variance: context.deck_variance,
        composition_bonus: compositionBonus,
        reset_bonus: resetBonus,
        feed_penalty: feedPenalty,
        belief_danger: beliefDanger,
        discard_value: discardValue,
        drew_from_deck: drewFromDeck ? 1 : 0,
        opponent_count: opponentCount,
      },
    };
  });
}

function buildCandidateForAction(player, context, discardOption, draw, checkpoint = null) {
  const drawCards = draw === 'deck'
    ? (context.sampled_cards.length > 0 ? context.sampled_cards : [buildDeckFallbackCard(player.hand)])
    : [player.draw_options[draw]];
  const featureMaps = buildActionFeatureMaps(player, context, discardOption, drawCards, draw === 'deck');
  const actionFeatures = aggregateFeatureMaps(featureMaps.map((entry) => entry.action_features), ACTION_FEATURE_NAMES);
  const valueFeatures = aggregateFeatureMaps(featureMaps.map((entry) => entry.value_features), VALUE_FEATURE_NAMES);
  const policyScore = checkpoint ? scoreLinearModel(checkpoint.action_model, actionFeatures) : 0;
  const valueScore = checkpoint ? scoreLinearModel(checkpoint.value_model, valueFeatures) : 0;

  return {
    action: {
      discard: discardOption,
      draw,
    },
    action_signature: actionSignature({ discard: discardOption, draw }),
    action_features: actionFeatures,
    value_features: valueFeatures,
    policy_score: policyScore,
    value_score: valueScore,
    combined_score: policyScore + valueScore,
    discard_value: sumCardValues(discardOption),
  };
}

function buildLearnedActionCandidates(player, context = null, checkpoint = null) {
  const activeContext = context || player._build_action_context();
  const candidates = [];
  const discardOptions = player._get_discard_options_cached(player.hand);

  for (const discardOption of discardOptions) {
    for (let i = 0; i < player.draw_options.length; i += 1) {
      candidates.push(buildCandidateForAction(player, activeContext, discardOption, i, checkpoint));
    }
    candidates.push(buildCandidateForAction(player, activeContext, discardOption, 'deck', checkpoint));
  }

  candidates.sort((left, right) => {
    if (right.combined_score !== left.combined_score) {
      return right.combined_score - left.combined_score;
    }
    if (right.discard_value !== left.discard_value) {
      return right.discard_value - left.discard_value;
    }
    return left.action_signature.localeCompare(right.action_signature);
  });

  return candidates;
}

function buildYanivFeatureMap(player) {
  const ownHandValue = sumCardValues(player.hand);
  const assafRisk = typeof player._estimate_assaf_probability_mc === 'function'
    ? player._estimate_assaf_probability_mc(ownHandValue)
    : 0;
  const resetPenalty = typeof player._evaluate_yaniv_reset_impact_mc === 'function'
    ? player._evaluate_yaniv_reset_impact_mc()
    : player._evaluate_yaniv_reset_impact();

  return {
    own_hand_value: ownHandValue,
    assaf_risk: assafRisk,
    reset_penalty: resetPenalty,
    threat: player._opponent_threat_score(),
    yaniv_next_turn_prob: player._opponent_yaniv_next_turn_probability(),
    score_pressure: clamp(player.score / 100, 0, 1),
    max_low_card_bias: maxOpponentLowCardBias(player),
    min_opponent_hand_count: minOpponentHandCount(player),
    known_low_cards: knownLowCards(player),
    opponent_count: Object.keys(player.other_players || {}).length,
  };
}

class AIPlayerLearned extends AIPlayerV3 {
  static _cache = new Map();

  static defaultManifestPath() {
    if (process.env.YANIV_LEARNED_MANIFEST) {
      return path.resolve(process.cwd(), process.env.YANIV_LEARNED_MANIFEST);
    }
    return path.resolve(__dirname, '..', 'learned_ai', 'current_champion.json');
  }

  static _readJsonFile(filePath) {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  }

  static _resolveModelPath(manifestPath, manifest) {
    const modelPath = manifest.model_path || manifest.checkpoint_path;
    if (!modelPath) {
      throw new Error('Learned champion manifest is missing `model_path`.');
    }
    if (path.isAbsolute(modelPath)) {
      return modelPath;
    }
    return path.resolve(path.dirname(manifestPath), modelPath);
  }

  static loadCheckpoint(manifestPath = null) {
    const resolvedManifestPath = path.resolve(manifestPath || AIPlayerLearned.defaultManifestPath());
    if (!fs.existsSync(resolvedManifestPath)) {
      throw new Error(`Learned champion manifest not found at ${resolvedManifestPath}`);
    }

    const manifestStat = fs.statSync(resolvedManifestPath);
    const cached = AIPlayerLearned._cache.get(resolvedManifestPath);
    if (cached && cached.manifest_mtime_ms === manifestStat.mtimeMs) {
      const checkpointStat = fs.existsSync(cached.checkpoint_path)
        ? fs.statSync(cached.checkpoint_path)
        : null;
      if (checkpointStat && checkpointStat.mtimeMs === cached.checkpoint_mtime_ms) {
        return cached;
      }
    }

    const manifest = AIPlayerLearned._readJsonFile(resolvedManifestPath);
    if (manifest.schema_version !== 1) {
      throw new Error(`Unsupported learned champion manifest schema: ${manifest.schema_version}`);
    }

    const checkpointPath = AIPlayerLearned._resolveModelPath(resolvedManifestPath, manifest);
    if (!fs.existsSync(checkpointPath)) {
      throw new Error(`Learned checkpoint file not found at ${checkpointPath}`);
    }

    const checkpointStat = fs.statSync(checkpointPath);
    const checkpoint = ensureCheckpointShape(AIPlayerLearned._readJsonFile(checkpointPath));
    const out = {
      manifest_path: resolvedManifestPath,
      manifest_mtime_ms: manifestStat.mtimeMs,
      manifest,
      checkpoint_path: checkpointPath,
      checkpoint_mtime_ms: checkpointStat.mtimeMs,
      checkpoint,
    };

    AIPlayerLearned._cache.set(resolvedManifestPath, out);
    return out;
  }

  static bootstrapCheckpoint() {
    return ensureCheckpointShape(createBootstrapCheckpoint());
  }

  constructor(name, rollout_samples = 24, options = null) {
    let rolloutSamples = rollout_samples;
    let resolvedOptions = options || {};

    if (rollout_samples && typeof rollout_samples === 'object') {
      resolvedOptions = rollout_samples;
      rolloutSamples = 24;
    }

    super(name, rolloutSamples);
    this.policy_id = 'learned';
    this.is_ai = true;
    this.learned_options = resolvedOptions;
    this.learned_checkpoint = AIPlayerLearned.loadCheckpoint(resolvedOptions.manifestPath || null);
  }

  _getLearnedCheckpoint() {
    const manifestPath = this.learned_options && this.learned_options.manifestPath
      ? this.learned_options.manifestPath
      : null;
    this.learned_checkpoint = AIPlayerLearned.loadCheckpoint(manifestPath);
    return this.learned_checkpoint.checkpoint;
  }

  decide_action() {
    const checkpoint = this._getLearnedCheckpoint();
    const context = this._build_action_context();
    const candidates = buildLearnedActionCandidates(this, context, checkpoint);
    if (candidates.length === 0) {
      return super.decide_action();
    }
    return candidates[0].action;
  }

  should_declare_yaniv() {
    if (sumCardValues(this.hand) > 5) {
      return false;
    }

    const checkpoint = this._getLearnedCheckpoint();
    const features = buildYanivFeatureMap(this);
    const logit = scoreLinearModel(checkpoint.yaniv_model, features);
    const probability = sigmoid(logit);
    return probability >= checkpoint.yaniv_model.threshold;
  }
}

module.exports = {
  AIPlayerLearned,
  actionSignature,
  buildLearnedActionCandidates,
  buildYanivFeatureMap,
};
