const { encodeState, legalActionMask, decodeAction, ACTION_SPACE_SIZE, YANIV_ACTION_INDEX } = require('./state_encoder');
const { predict, maskedSoftmax } = require('./network');

const C_PUCT = 1.5;
const DIRICHLET_ALPHA = 0.3;
const DIRICHLET_WEIGHT = 0.25;

class MCTSNode {
  constructor(prior, parent) {
    this.prior = prior;
    this.parent = parent;
    this.visitCount = 0;
    this.totalValue = 0;
    this.children = null;
  }

  qValue() {
    return this.visitCount > 0 ? this.totalValue / this.visitCount : 0;
  }

  ucbScore(parentVisits) {
    return this.qValue() + C_PUCT * this.prior * Math.sqrt(parentVisits) / (1 + this.visitCount);
  }
}

function sampleDirichlet(alpha, size, rng) {
  const samples = new Array(size);
  let sum = 0;
  for (let i = 0; i < size; i += 1) {
    let x = 0;
    for (let j = 0; j < alpha; j += 1) {
      x -= Math.log(1 - rng());
    }
    if (alpha < 1) {
      x = -Math.log(1 - rng());
    }
    x = Math.max(x, 1e-10);
    samples[i] = x;
    sum += x;
  }
  for (let i = 0; i < size; i += 1) {
    samples[i] /= sum;
  }
  return samples;
}

function runMCTS(model, stateVector, mask, numIterations, addNoise, rng) {
  const { policyLogits, value: rootValue } = predict(model, stateVector);
  const priors = maskedSoftmax(policyLogits, mask);

  const root = new MCTSNode(0, null);
  root.children = new Map();

  const legalActions = [];
  for (let a = 0; a < ACTION_SPACE_SIZE; a += 1) {
    if (mask[a] > 0) {
      legalActions.push(a);
    }
  }

  if (legalActions.length === 0) {
    return new Map();
  }

  if (legalActions.length === 1) {
    const visits = new Map();
    visits.set(legalActions[0], numIterations);
    return visits;
  }

  let noisyPriors = priors;
  if (addNoise && rng) {
    const noise = sampleDirichlet(DIRICHLET_ALPHA, ACTION_SPACE_SIZE, rng);
    noisyPriors = priors.map((p, i) => (
      mask[i] > 0 ? (1 - DIRICHLET_WEIGHT) * p + DIRICHLET_WEIGHT * noise[i] : 0
    ));
    const sum = noisyPriors.reduce((s, p) => s + p, 0);
    if (sum > 0) {
      for (let i = 0; i < noisyPriors.length; i += 1) {
        noisyPriors[i] /= sum;
      }
    }
  }

  for (const a of legalActions) {
    root.children.set(a, new MCTSNode(noisyPriors[a], root));
  }

  for (let iter = 0; iter < numIterations; iter += 1) {
    let bestAction = -1;
    let bestScore = -Infinity;
    const parentVisits = root.visitCount;

    for (const [action, child] of root.children) {
      const score = child.ucbScore(parentVisits);
      if (score > bestScore) {
        bestScore = score;
        bestAction = action;
      }
    }

    const child = root.children.get(bestAction);
    child.visitCount += 1;
    child.totalValue += rootValue;
    root.visitCount += 1;
  }

  const visits = new Map();
  for (const [action, child] of root.children) {
    if (child.visitCount > 0) {
      visits.set(action, child.visitCount);
    }
  }

  return visits;
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

function sampleWithoutReplacement(values, count, rng) {
  const copy = [...values];
  const n = Math.min(count, copy.length);
  for (let i = 0; i < n; i += 1) {
    const j = i + Math.floor(rng() * (copy.length - i));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, n);
}

function buildDeterminization(player, rng) {
  const unseenCards = player._get_unseen_cards();
  const pool = [...unseenCards];
  const opponents = {};

  for (const [name, info] of Object.entries(player.other_players)) {
    const unknownCount = Math.max(0, info.hand_count - info.known_cards.length);
    const sampledUnknowns = sampleWithoutReplacement(pool, unknownCount, rng);

    for (const card of sampledUnknowns) {
      const idx = pool.findIndex((c) => c.id === card.id);
      if (idx !== -1) pool.splice(idx, 1);
    }

    opponents[name] = {
      hand: [...info.known_cards, ...sampledUnknowns],
      score: info.current_score ?? 0,
      handCount: info.hand_count,
    };
  }

  return { opponents, remainingDeck: pool };
}

function runDeterminizedMCTS(model, player, drawOptions, options = {}) {
  const {
    numDeterminizations = 8,
    iterationsPerDet = 50,
    addNoise = false,
    baseSeed = 42,
  } = options;

  const discardOptions = player._get_discard_options_cached(player.hand);
  const canYaniv = player.hand.reduce((s, c) => s + c.value, 0) <= 5;
  const mask = legalActionMask(player.hand, drawOptions, discardOptions, canYaniv);

  const aggregatedVisits = new Map();

  for (let d = 0; d < numDeterminizations; d += 1) {
    const detSeed = (baseSeed + Math.imul(d + 1, 0x9e3779b9)) >>> 0;
    const rng = mulberry32(detSeed);

    buildDeterminization(player, rng);

    const stateVector = encodeState(player, drawOptions);
    const mctsRng = addNoise ? mulberry32((detSeed ^ 0xdeadbeef) >>> 0) : null;
    const visits = runMCTS(model, stateVector, mask, iterationsPerDet, addNoise, mctsRng);

    for (const [action, count] of visits) {
      aggregatedVisits.set(action, (aggregatedVisits.get(action) || 0) + count);
    }
  }

  return { visits: aggregatedVisits, mask, discardOptions };
}

function selectActionFromVisits(visits, temperature = 0) {
  if (visits.size === 0) return -1;

  if (temperature <= 0.01) {
    let bestAction = -1;
    let bestCount = -1;
    for (const [action, count] of visits) {
      if (count > bestCount) {
        bestCount = count;
        bestAction = action;
      }
    }
    return bestAction;
  }

  const entries = [...visits.entries()];
  const counts = entries.map(([, c]) => Math.pow(c, 1 / temperature));
  const sum = counts.reduce((s, c) => s + c, 0);
  const probs = counts.map((c) => c / sum);

  let r = Math.random();
  for (let i = 0; i < entries.length; i += 1) {
    r -= probs[i];
    if (r <= 0) return entries[i][0];
  }
  return entries[entries.length - 1][0];
}

function visitsToPolicy(visits, temperature = 1) {
  const policy = new Float32Array(ACTION_SPACE_SIZE);

  if (visits.size === 0) return policy;

  if (temperature <= 0.01) {
    let bestAction = -1;
    let bestCount = -1;
    for (const [action, count] of visits) {
      if (count > bestCount) {
        bestCount = count;
        bestAction = action;
      }
    }
    if (bestAction >= 0) policy[bestAction] = 1;
    return policy;
  }

  let total = 0;
  const weighted = new Map();
  for (const [action, count] of visits) {
    const w = Math.pow(count, 1 / temperature);
    weighted.set(action, w);
    total += w;
  }

  if (total > 0) {
    for (const [action, w] of weighted) {
      policy[action] = w / total;
    }
  }

  return policy;
}

module.exports = {
  MCTSNode,
  runMCTS,
  runDeterminizedMCTS,
  selectActionFromVisits,
  visitsToPolicy,
  buildDeterminization,
  mulberry32,
};
