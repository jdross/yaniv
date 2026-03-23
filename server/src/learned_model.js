function cloneFeatureNames(featureNames) {
  return [...featureNames];
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

function seedFromText(text) {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash >>> 0;
}

const ACTION_FEATURE_NAMES = Object.freeze([
  'threat',
  'yaniv_next_turn_prob',
  'deck_variance',
  'immediate_points',
  'future_score',
  'discard_value',
  'discard_count',
  'draw_value',
  'drew_from_deck',
  'feed_penalty',
  'belief_danger',
  'joker_discard_penalty',
  'composition_bonus',
  'reset_bonus',
  'post_discard_total',
  'hand_total_before',
  'opponent_count',
]);

const VALUE_FEATURE_NAMES = Object.freeze([
  'resulting_hand_total',
  'resulting_hand_count',
  'threat',
  'yaniv_next_turn_prob',
  'deck_variance',
  'composition_bonus',
  'reset_bonus',
  'feed_penalty',
  'belief_danger',
  'discard_value',
  'drew_from_deck',
  'opponent_count',
]);

const YANIV_FEATURE_NAMES = Object.freeze([
  'own_hand_value',
  'assaf_risk',
  'reset_penalty',
  'threat',
  'yaniv_next_turn_prob',
  'score_pressure',
  'max_low_card_bias',
  'min_opponent_hand_count',
  'known_low_cards',
  'opponent_count',
]);

function createLinearModel(featureNames, initialWeights = {}, initialBias = 0) {
  return {
    model_type: 'linear',
    feature_names: cloneFeatureNames(featureNames),
    weights: featureNames.map((name) => Number(initialWeights[name] || 0)),
    bias: Number(initialBias || 0),
  };
}

function computeFeatureMoments(samples, featureNames) {
  const mean = Object.fromEntries(featureNames.map((name) => [name, 0]));
  const std = Object.fromEntries(featureNames.map((name) => [name, 1]));

  if (!samples || samples.length === 0) {
    return { mean, std };
  }

  for (const sample of samples) {
    for (const featureName of featureNames) {
      mean[featureName] += Number(sample[featureName] || 0);
    }
  }
  for (const featureName of featureNames) {
    mean[featureName] /= samples.length;
  }

  for (const sample of samples) {
    for (const featureName of featureNames) {
      const centered = Number(sample[featureName] || 0) - mean[featureName];
      std[featureName] += centered * centered;
    }
  }
  for (const featureName of featureNames) {
    std[featureName] = Math.max(1e-3, Math.sqrt(std[featureName] / samples.length));
  }

  return { mean, std };
}

function createMlpModel(featureNames, options = {}) {
  const hiddenSize = Math.max(8, Number.parseInt(options.hidden_size || 16, 10));
  const seed = seedFromText(options.seed_text || `${featureNames.join('|')}|${hiddenSize}`);
  const rng = mulberry32(seed);
  const inputScale = Math.sqrt(2 / Math.max(1, featureNames.length));
  const hiddenScale = Math.sqrt(2 / Math.max(1, hiddenSize));
  const inputMoments = options.input_moments || { mean: {}, std: {} };

  return {
    model_type: 'mlp',
    feature_names: cloneFeatureNames(featureNames),
    hidden_size: hiddenSize,
    input_mean: featureNames.map((name) => Number((inputMoments.mean || {})[name] || 0)),
    input_std: featureNames.map((name) => Number((inputMoments.std || {})[name] || 1)),
    w1: Array.from({ length: hiddenSize }, () => (
      featureNames.map(() => ((rng() * 2) - 1) * inputScale)
    )),
    b1: new Array(hiddenSize).fill(0),
    w2: Array.from({ length: hiddenSize }, () => ((rng() * 2) - 1) * hiddenScale),
    b2: 0,
  };
}

function normalizeLinearModel(model, featureNames) {
  if (model && model.model_type === 'mlp') {
    const hiddenSize = Math.max(1, Number.parseInt(model.hidden_size || 16, 10));
    const names = cloneFeatureNames(featureNames);
    const featureIndex = new Map();
    for (let i = 0; i < (model.feature_names || []).length; i += 1) {
      featureIndex.set(model.feature_names[i], i);
    }

    const remapRow = (row = []) => names.map((name) => Number(row[featureIndex.get(name)] || 0));
    return {
      model_type: 'mlp',
      feature_names: names,
      hidden_size: hiddenSize,
      input_mean: names.map((name) => {
        const idx = featureIndex.get(name);
        return Number(Array.isArray(model.input_mean) && idx !== undefined ? model.input_mean[idx] : 0);
      }),
      input_std: names.map((name) => {
        const idx = featureIndex.get(name);
        const value = Number(Array.isArray(model.input_std) && idx !== undefined ? model.input_std[idx] : 1);
        return Math.max(1e-3, value || 1);
      }),
      w1: Array.from({ length: hiddenSize }, (_, rowIndex) => remapRow((model.w1 || [])[rowIndex] || [])),
      b1: Array.from({ length: hiddenSize }, (_, rowIndex) => Number((model.b1 || [])[rowIndex] || 0)),
      w2: Array.from({ length: hiddenSize }, (_, rowIndex) => Number((model.w2 || [])[rowIndex] || 0)),
      b2: Number(model.b2 || 0),
    };
  }

  const normalized = {
    model_type: 'linear',
    feature_names: cloneFeatureNames(featureNames),
    weights: new Array(featureNames.length).fill(0),
    bias: Number(model && model.bias ? model.bias : 0),
  };

  const names = Array.isArray(model && model.feature_names)
    ? model.feature_names
    : [];
  const weights = Array.isArray(model && model.weights)
    ? model.weights
    : [];
  const byName = new Map();

  for (let i = 0; i < names.length; i += 1) {
    byName.set(names[i], Number(weights[i] || 0));
  }

  normalized.weights = featureNames.map((name) => byName.get(name) || 0);
  return normalized;
}

function featuresToVector(featureNames, featureMap) {
  return featureNames.map((name) => Number(featureMap[name] || 0));
}

function normalizeVector(model, vector) {
  if (!model || model.model_type !== 'mlp') {
    return vector;
  }
  return vector.map((value, index) => (
    (value - Number(model.input_mean[index] || 0)) / Math.max(1e-3, Number(model.input_std[index] || 1))
  ));
}

function dotProduct(left, right) {
  let total = 0;
  const length = Math.min(left.length, right.length);
  for (let i = 0; i < length; i += 1) {
    total += left[i] * right[i];
  }
  return total;
}

function scoreLinearModel(model, featureMap) {
  if (!model) return 0;
  const normalized = normalizeLinearModel(model, model.feature_names || []);
  if (normalized.model_type === 'mlp') {
    const rawVector = featuresToVector(normalized.feature_names, featureMap);
    const vector = normalizeVector(normalized, rawVector);
    const hidden = normalized.w1.map((row, rowIndex) => Math.tanh(dotProduct(row, vector) + normalized.b1[rowIndex]));
    return normalized.b2 + dotProduct(normalized.w2, hidden);
  }
  return normalized.bias + dotProduct(normalized.weights, featuresToVector(normalized.feature_names, featureMap));
}

function sigmoid(value) {
  if (value >= 0) {
    const exp = Math.exp(-value);
    return 1 / (1 + exp);
  }
  const exp = Math.exp(value);
  return exp / (1 + exp);
}

function softmax(values) {
  if (values.length === 0) {
    return [];
  }
  const maxValue = Math.max(...values);
  const exps = values.map((value) => Math.exp(value - maxValue));
  const sum = exps.reduce((total, value) => total + value, 0);
  if (sum <= 0) {
    return values.map(() => 1 / values.length);
  }
  return exps.map((value) => value / sum);
}

function trainPolicyModel(samples, existingModel = null, options = {}) {
  const learningRate = Number(options.learning_rate || 0.03);
  const epochs = Math.max(1, Number.parseInt(options.epochs || 4, 10));
  const allCandidateFeatures = [];
  for (const sample of samples) {
    if (Array.isArray(sample.candidates)) {
      allCandidateFeatures.push(...sample.candidates);
    }
  }
  const moments = computeFeatureMoments(allCandidateFeatures, ACTION_FEATURE_NAMES);
  const model = existingModel && existingModel.model_type === 'mlp'
    ? normalizeLinearModel({
      ...existingModel,
      input_mean: ACTION_FEATURE_NAMES.map((name) => moments.mean[name]),
      input_std: ACTION_FEATURE_NAMES.map((name) => moments.std[name]),
    }, ACTION_FEATURE_NAMES)
    : createMlpModel(ACTION_FEATURE_NAMES, {
      hidden_size: options.hidden_size || 24,
      input_moments: moments,
      seed_text: 'policy-model',
    });

  for (let epoch = 0; epoch < epochs; epoch += 1) {
    for (const sample of samples) {
      if (!Array.isArray(sample.candidates) || sample.candidates.length === 0) continue;
      if (!Number.isInteger(sample.chosen_index) || sample.chosen_index < 0 || sample.chosen_index >= sample.candidates.length) {
        continue;
      }

      const weight = Number(sample.sample_weight || 1);
      const candidateVectors = sample.candidates.map((candidate) => normalizeVector(
        model,
        featuresToVector(model.feature_names, candidate),
      ));
      const hiddenVectors = candidateVectors.map((vector) => (
        model.w1.map((row, rowIndex) => Math.tanh(dotProduct(row, vector) + model.b1[rowIndex]))
      ));
      const scores = hiddenVectors.map((hidden) => model.b2 + dotProduct(model.w2, hidden));
      const probabilities = softmax(scores);
      const targetProbs = Array.isArray(sample.target_probs) && sample.target_probs.length === candidateVectors.length
        ? sample.target_probs.map((value) => Number(value || 0))
        : null;

      let biasDelta = 0;
      const w2Delta = new Array(model.hidden_size).fill(0);
      const b1Delta = new Array(model.hidden_size).fill(0);
      const w1Delta = Array.from({ length: model.hidden_size }, () => new Array(model.feature_names.length).fill(0));

      for (let i = 0; i < candidateVectors.length; i += 1) {
        const expected = targetProbs ? targetProbs[i] : (i === sample.chosen_index ? 1 : 0);
        const delta = learningRate * weight * (expected - probabilities[i]);
        const vector = candidateVectors[i];
        const hidden = hiddenVectors[i];
        biasDelta += delta;
        for (let j = 0; j < model.hidden_size; j += 1) {
          const oldW2 = model.w2[j];
          w2Delta[j] += delta * hidden[j];
          const hiddenDelta = delta * oldW2 * (1 - (hidden[j] ** 2));
          b1Delta[j] += hiddenDelta;
          for (let k = 0; k < model.feature_names.length; k += 1) {
            w1Delta[j][k] += hiddenDelta * vector[k];
          }
        }
      }

      model.b2 += biasDelta;
      for (let j = 0; j < model.hidden_size; j += 1) {
        model.w2[j] += w2Delta[j];
        model.b1[j] += b1Delta[j];
        for (let k = 0; k < model.feature_names.length; k += 1) {
          model.w1[j][k] += w1Delta[j][k];
        }
      }
    }
  }

  return model;
}

function trainValueModel(samples, existingModel = null, options = {}) {
  const learningRate = Number(options.learning_rate || 0.02);
  const epochs = Math.max(1, Number.parseInt(options.epochs || 6, 10));
  const moments = computeFeatureMoments(samples.map((sample) => sample.features).filter(Boolean), VALUE_FEATURE_NAMES);
  const model = existingModel && existingModel.model_type === 'mlp'
    ? normalizeLinearModel({
      ...existingModel,
      input_mean: VALUE_FEATURE_NAMES.map((name) => moments.mean[name]),
      input_std: VALUE_FEATURE_NAMES.map((name) => moments.std[name]),
    }, VALUE_FEATURE_NAMES)
    : createMlpModel(VALUE_FEATURE_NAMES, {
      hidden_size: options.hidden_size || 18,
      input_moments: moments,
      seed_text: 'value-model',
    });

  for (let epoch = 0; epoch < epochs; epoch += 1) {
    for (const sample of samples) {
      if (!sample.features) continue;
      const vector = normalizeVector(model, featuresToVector(model.feature_names, sample.features));
      const target = Number(sample.target || 0);
      const weight = Number(sample.sample_weight || 1);
      const hidden = model.w1.map((row, rowIndex) => Math.tanh(dotProduct(row, vector) + model.b1[rowIndex]));
      const prediction = model.b2 + dotProduct(model.w2, hidden);
      const error = target - prediction;
      const delta = learningRate * weight * error;

      model.b2 += delta;
      for (let i = 0; i < model.hidden_size; i += 1) {
        const oldW2 = model.w2[i];
        model.w2[i] += delta * hidden[i];
        const hiddenDelta = delta * oldW2 * (1 - (hidden[i] ** 2));
        model.b1[i] += hiddenDelta;
        for (let j = 0; j < model.feature_names.length; j += 1) {
          model.w1[i][j] += hiddenDelta * vector[j];
        }
      }
    }
  }

  return model;
}

function trainBinaryModel(samples, existingModel = null, options = {}) {
  const learningRate = Number(options.learning_rate || 0.02);
  const epochs = Math.max(1, Number.parseInt(options.epochs || 6, 10));
  const moments = computeFeatureMoments(samples.map((sample) => sample.features).filter(Boolean), YANIV_FEATURE_NAMES);
  const existingThreshold = Number(existingModel && existingModel.threshold !== undefined ? existingModel.threshold : 0.5);
  const model = existingModel && existingModel.model_type === 'mlp'
    ? {
      ...normalizeLinearModel({
        ...existingModel,
        input_mean: YANIV_FEATURE_NAMES.map((name) => moments.mean[name]),
        input_std: YANIV_FEATURE_NAMES.map((name) => moments.std[name]),
      }, YANIV_FEATURE_NAMES),
      threshold: existingThreshold,
    }
    : {
      ...createMlpModel(YANIV_FEATURE_NAMES, {
        hidden_size: options.hidden_size || 14,
        input_moments: moments,
        seed_text: 'yaniv-model',
      }),
      threshold: existingThreshold,
    };

  for (let epoch = 0; epoch < epochs; epoch += 1) {
    for (const sample of samples) {
      if (!sample.features) continue;
      const vector = normalizeVector(model, featuresToVector(model.feature_names, sample.features));
      const target = Number(sample.target ? 1 : 0);
      const weight = Number(sample.sample_weight || 1);
      const hidden = model.w1.map((row, rowIndex) => Math.tanh(dotProduct(row, vector) + model.b1[rowIndex]));
      const logit = model.b2 + dotProduct(model.w2, hidden);
      const probability = sigmoid(logit);
      const error = target - probability;
      const delta = learningRate * weight * error;

      model.b2 += delta;
      for (let i = 0; i < model.hidden_size; i += 1) {
        const oldW2 = model.w2[i];
        model.w2[i] += delta * hidden[i];
        const hiddenDelta = delta * oldW2 * (1 - (hidden[i] ** 2));
        model.b1[i] += hiddenDelta;
        for (let j = 0; j < model.feature_names.length; j += 1) {
          model.w1[i][j] += hiddenDelta * vector[j];
        }
      }
    }
  }

  return model;
}

function createBootstrapCheckpoint() {
  return {
    schema_version: 1,
    checkpoint_id: 'bootstrap-learned',
    training_iteration: 0,
    created_at: '2026-03-22T00:00:00.000Z',
    action_model: createLinearModel(ACTION_FEATURE_NAMES, {
      immediate_points: -0.22,
      future_score: -0.44,
      discard_value: 0.14,
      discard_count: 0.05,
      draw_value: -0.04,
      drew_from_deck: -0.02,
      feed_penalty: -0.24,
      belief_danger: -0.28,
      joker_discard_penalty: -0.16,
      composition_bonus: 0.18,
      reset_bonus: 0.24,
      post_discard_total: -0.10,
      threat: -0.07,
      yaniv_next_turn_prob: -0.09,
      opponent_count: -0.01,
    }),
    value_model: createLinearModel(VALUE_FEATURE_NAMES, {
      resulting_hand_total: -0.18,
      resulting_hand_count: -0.05,
      threat: -0.08,
      yaniv_next_turn_prob: -0.10,
      composition_bonus: 0.12,
      reset_bonus: 0.20,
      feed_penalty: -0.10,
      belief_danger: -0.10,
      discard_value: 0.05,
      drew_from_deck: -0.02,
    }, 0.04),
    yaniv_model: {
      ...createLinearModel(YANIV_FEATURE_NAMES, {
        own_hand_value: -0.82,
        assaf_risk: -2.30,
        reset_penalty: -0.45,
        threat: -0.18,
        yaniv_next_turn_prob: 0.42,
        score_pressure: 0.30,
        max_low_card_bias: -0.12,
        min_opponent_hand_count: -0.10,
        known_low_cards: -0.08,
      }, 1.45),
      threshold: 0.5,
    },
  };
}

function summarizeCheckpoint(checkpoint) {
  return {
    checkpoint_id: checkpoint.checkpoint_id,
    training_iteration: checkpoint.training_iteration,
    created_at: checkpoint.created_at,
  };
}

module.exports = {
  ACTION_FEATURE_NAMES,
  VALUE_FEATURE_NAMES,
  YANIV_FEATURE_NAMES,
  createBootstrapCheckpoint,
  createLinearModel,
  createMlpModel,
  featuresToVector,
  normalizeLinearModel,
  scoreLinearModel,
  sigmoid,
  summarizeCheckpoint,
  trainBinaryModel,
  trainPolicyModel,
  trainValueModel,
};
