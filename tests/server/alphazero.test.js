const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { Card } = require('../../server/src/card');
const { Player } = require('../../server/src/player');
const { YanivGame } = require('../../server/src/yaniv');
const { createAIPlayer } = require('../../server/src/aiplayer');

const {
  STATE_SIZE,
  ACTION_SPACE_SIZE,
  YANIV_ACTION_INDEX,
  encodeState,
  discardToActionIndex,
  decodeAction,
  legalActionMask,
} = require('../../server/src/alphazero/state_encoder');

const {
  createModel,
  predict,
  predictBatch,
  maskedSoftmax,
} = require('../../server/src/alphazero/network');

const {
  MCTSNode,
  runMCTS,
  runDeterminizedMCTS,
  selectActionFromVisits,
  visitsToPolicy,
  mulberry32,
} = require('../../server/src/alphazero/mcts');

const {
  AlphaZeroPlayer,
} = require('../../server/src/alphazero/alphazero_player');

const { ReplayBuffer } = require('../../server/src/alphazero/training/replay_buffer');

function makeHand(ids) {
  return ids.map((id) => new Card(id));
}

function makeAzPlayerWithHand(model, handIds, opponentInfo) {
  const player = new AlphaZeroPlayer('TestAZ', model, {
    numDeterminizations: 2,
    iterationsPerDet: 10,
  });
  player.hand = makeHand(handIds);
  player.draw_options = [new Card(50)];
  player.public_discard_pile = [new Card(48)];
  player.other_players = opponentInfo || {
    Opp1: {
      current_score: 0,
      hand_count: 5,
      known_cards: [],
      estimated_score: 25,
      pickup_history: [],
      discard_history: [],
      collected_ranks: {},
      collected_suit_ranks: {},
    },
    Opp2: {
      current_score: 10,
      hand_count: 4,
      known_cards: [],
      estimated_score: 20,
      pickup_history: [],
      discard_history: [],
      collected_ranks: {},
      collected_suit_ranks: {},
    },
  };
  return player;
}

describe('state_encoder', () => {
  it('encodeState returns correct size vector', () => {
    const player = new AlphaZeroPlayer('Test', null);
    player.hand = makeHand([2, 6, 10, 14, 18]);
    player.draw_options = [new Card(20)];
    player.public_discard_pile = [new Card(22)];
    player.other_players = {
      Opp1: { current_score: 30, hand_count: 4, known_cards: [new Card(24)], estimated_score: 15 },
    };

    const state = encodeState(player, player.draw_options);
    assert.equal(state.length, STATE_SIZE);
    assert.ok(state instanceof Float32Array);

    assert.equal(state[2], 1);
    assert.equal(state[6], 1);
    assert.equal(state[3], 0);
  });

  it('encodeState normalizes scores', () => {
    const player = new AlphaZeroPlayer('Test', null);
    player.hand = makeHand([2]);
    player.score = 50;
    player.draw_options = [];
    player.public_discard_pile = [];
    player.other_players = {};

    const state = encodeState(player, []);
    const scoreOffset = 54 * 4;
    assert.equal(state[scoreOffset], 0.5);
  });

  it('discardToActionIndex encodes single cards correctly', () => {
    const card = new Card(10);
    const idx = discardToActionIndex([card], 'deck');
    assert.ok(idx >= 0 && idx < ACTION_SPACE_SIZE);

    const idx2 = discardToActionIndex([card], 0);
    assert.notEqual(idx, idx2);
  });

  it('discardToActionIndex encodes sets by rank', () => {
    const cards = [new Card(2), new Card(3)];
    const idx = discardToActionIndex(cards, 'deck');
    assert.ok(idx >= 0 && idx < ACTION_SPACE_SIZE);
  });

  it('discardToActionIndex encodes runs by suit', () => {
    const cards = [new Card(2), new Card(6), new Card(10)];
    const idx = discardToActionIndex(cards, 'deck');
    assert.ok(idx >= 0 && idx < ACTION_SPACE_SIZE);
  });

  it('legalActionMask has correct size and at least one legal action', () => {
    const hand = makeHand([2, 6, 10, 14, 18]);
    const drawOptions = [new Card(20)];

    const player = new AlphaZeroPlayer('Test', null);
    player.hand = hand;
    const discardOptions = player._get_discard_options(hand);

    const mask = legalActionMask(hand, drawOptions, discardOptions, false);
    assert.equal(mask.length, ACTION_SPACE_SIZE);

    const legalCount = Array.from(mask).filter((v) => v > 0).length;
    assert.ok(legalCount > 0, 'Must have at least one legal action');
  });

  it('legalActionMask includes yaniv action when canDeclareYaniv is true', () => {
    const hand = makeHand([0, 1]);
    const drawOptions = [];
    const player = new AlphaZeroPlayer('Test', null);
    player.hand = hand;
    const discardOptions = player._get_discard_options(hand);

    const maskWithYaniv = legalActionMask(hand, drawOptions, discardOptions, true);
    assert.equal(maskWithYaniv[YANIV_ACTION_INDEX], 1);

    const maskWithoutYaniv = legalActionMask(hand, drawOptions, discardOptions, false);
    assert.equal(maskWithoutYaniv[YANIV_ACTION_INDEX], 0);
  });

  it('decodeAction round-trips single card discards', () => {
    const hand = makeHand([2, 6, 10, 14, 18]);
    const drawOptions = [new Card(20)];
    const player = new AlphaZeroPlayer('Test', null);
    player.hand = hand;
    const discardOptions = player._get_discard_options(hand);

    const originalAction = { discard: [hand[0]], draw: 'deck' };
    const actionIdx = discardToActionIndex(originalAction.discard, originalAction.draw);
    const decoded = decodeAction(actionIdx, hand, drawOptions, discardOptions);

    assert.ok(decoded);
    assert.equal(decoded.discard.length, 1);
    assert.equal(decoded.discard[0].id, hand[0].id);
    assert.equal(decoded.draw, 'deck');
  });
});

describe('network', () => {
  let model;

  beforeEach(() => {
    model = createModel();
  });

  it('createModel returns a model with correct input/output shapes', () => {
    assert.ok(model);
    const inputShape = model.inputs[0].shape;
    assert.equal(inputShape[1], STATE_SIZE);
    assert.equal(model.outputs.length, 2);
  });

  it('predict returns policy logits and value', () => {
    const state = new Float32Array(STATE_SIZE);
    state[2] = 1;
    state[6] = 1;

    const result = predict(model, state);
    assert.ok(result.policyLogits);
    assert.equal(result.policyLogits.length, ACTION_SPACE_SIZE);
    assert.equal(typeof result.value, 'number');
    assert.ok(result.value >= -1 && result.value <= 1, 'Value should be in [-1, 1]');
  });

  it('predictBatch returns results for all inputs', () => {
    const states = [
      new Float32Array(STATE_SIZE),
      new Float32Array(STATE_SIZE),
    ];
    states[0][2] = 1;
    states[1][6] = 1;

    const results = predictBatch(model, states);
    assert.equal(results.length, 2);
    assert.equal(results[0].policyLogits.length, ACTION_SPACE_SIZE);
    assert.equal(results[1].policyLogits.length, ACTION_SPACE_SIZE);
  });

  it('maskedSoftmax zeroes out illegal actions', () => {
    const logits = [1, 2, 3, 4, 5];
    const mask = [1, 0, 1, 0, 1];
    const probs = maskedSoftmax(logits, mask);

    assert.ok(probs[1] < 0.001);
    assert.ok(probs[3] < 0.001);
    assert.ok(probs[0] > 0);
    assert.ok(probs[2] > 0);
    assert.ok(probs[4] > 0);

    const sum = probs.reduce((s, p) => s + p, 0);
    assert.ok(Math.abs(sum - 1) < 0.01, `Probabilities should sum to ~1, got ${sum}`);
  });
});

describe('mcts', () => {
  let model;

  beforeEach(() => {
    model = createModel();
  });

  it('MCTSNode tracks visits and values', () => {
    const node = new MCTSNode(0.5, null);
    assert.equal(node.visitCount, 0);
    assert.equal(node.qValue(), 0);

    node.visitCount = 10;
    node.totalValue = 5;
    assert.equal(node.qValue(), 0.5);
  });

  it('runMCTS returns visit counts for legal actions', () => {
    const state = new Float32Array(STATE_SIZE);
    state[2] = 1;

    const mask = new Float32Array(ACTION_SPACE_SIZE);
    mask[0] = 1;
    mask[3] = 1;
    mask[6] = 1;

    const visits = runMCTS(model, state, mask, 20, false, null);
    assert.ok(visits.size > 0);

    let totalVisits = 0;
    for (const count of visits.values()) {
      totalVisits += count;
    }
    assert.equal(totalVisits, 20);
  });

  it('runMCTS with single legal action gives all visits to it', () => {
    const state = new Float32Array(STATE_SIZE);
    const mask = new Float32Array(ACTION_SPACE_SIZE);
    mask[5] = 1;

    const visits = runMCTS(model, state, mask, 10, false, null);
    assert.equal(visits.get(5), 10);
  });

  it('selectActionFromVisits returns action with most visits at temperature 0', () => {
    const visits = new Map();
    visits.set(1, 10);
    visits.set(2, 50);
    visits.set(3, 5);

    const action = selectActionFromVisits(visits, 0);
    assert.equal(action, 2);
  });

  it('visitsToPolicy returns valid probability distribution', () => {
    const visits = new Map();
    visits.set(0, 10);
    visits.set(5, 20);
    visits.set(10, 30);

    const policy = visitsToPolicy(visits, 1);
    assert.equal(policy.length, ACTION_SPACE_SIZE);

    const sum = Array.from(policy).reduce((s, p) => s + p, 0);
    assert.ok(Math.abs(sum - 1) < 0.01, `Policy should sum to ~1, got ${sum}`);
    assert.ok(policy[10] > policy[5]);
    assert.ok(policy[5] > policy[0]);
  });

  it('runDeterminizedMCTS returns aggregated visits', () => {
    const player = makeAzPlayerWithHand(model, [2, 6, 10, 14, 18]);
    const drawOptions = [...player.draw_options];

    const result = runDeterminizedMCTS(model, player, drawOptions, {
      numDeterminizations: 2,
      iterationsPerDet: 10,
      addNoise: false,
      baseSeed: 42,
    });

    assert.ok(result.visits.size > 0);
    assert.ok(result.mask.length === ACTION_SPACE_SIZE);
    assert.ok(result.discardOptions.length > 0);
  });
});

describe('AlphaZeroPlayer', () => {
  let model;

  beforeEach(() => {
    model = createModel();
  });

  it('extends base AIPlayer and has is_ai = true', () => {
    const player = new AlphaZeroPlayer('TestAZ', model);
    assert.equal(player.is_ai, true);
    assert.equal(player.policy_id, 'alphazero');
    assert.equal(player.name, 'TestAZ');
  });

  it('decide_action returns a valid action', () => {
    const player = makeAzPlayerWithHand(model, [2, 6, 10, 14, 18]);
    const action = player.decide_action();

    assert.ok(action);
    assert.ok(Array.isArray(action.discard));
    assert.ok(action.discard.length > 0);
    assert.ok(action.draw === 'deck' || typeof action.draw === 'number');
  });

  it('should_declare_yaniv returns false when hand > 5', () => {
    const player = makeAzPlayerWithHand(model, [10, 14, 18, 22, 26]);
    assert.equal(player.should_declare_yaniv(), false);
  });

  it('integrates with YanivGame without crashing', () => {
    const az = new AlphaZeroPlayer('AZ', model, {
      numDeterminizations: 2,
      iterationsPerDet: 5,
    });
    const heuristic = createAIPlayer('H1');
    const heuristic2 = createAIPlayer('H2');

    const game = new YanivGame([az, heuristic, heuristic2]);
    game.startGame();

    let moves = 0;
    while (game.players.length > 1 && moves < 50) {
      const [currentPlayer] = game.startTurn();
      const handValue = currentPlayer.hand.reduce((s, c) => s + c.value, 0);

      if (handValue <= 5 && currentPlayer.should_declare_yaniv()) {
        const [, , winner] = game.declareYaniv(currentPlayer);
        if (winner) break;
        moves += 1;
        continue;
      }

      const action = currentPlayer.decide_action();
      game.playTurn(currentPlayer, action);
      moves += 1;
    }

    assert.ok(moves > 0, 'Game should have played at least one move');
  });

  it('falls back to heuristic when model is null', () => {
    const player = makeAzPlayerWithHand(null, [2, 6, 10, 14, 18]);
    const action = player.decide_action();
    assert.ok(action);
    assert.ok(Array.isArray(action.discard));
  });
});

describe('ReplayBuffer', () => {
  it('adds and samples examples', () => {
    const rb = new ReplayBuffer(100);

    for (let i = 0; i < 50; i += 1) {
      rb.add({
        state: new Float32Array(STATE_SIZE),
        policy: new Float32Array(ACTION_SPACE_SIZE),
        value: Math.random() * 2 - 1,
      });
    }

    assert.equal(rb.size, 50);

    const sampled = rb.sample(10);
    assert.equal(sampled.length, 10);
  });

  it('wraps around at max capacity', () => {
    const rb = new ReplayBuffer(10);

    for (let i = 0; i < 25; i += 1) {
      rb.add({ state: new Float32Array([i]), policy: new Float32Array([i]), value: i });
    }

    assert.equal(rb.size, 10);
    assert.equal(rb.totalAdded, 25);
  });

  it('save and load round-trips correctly', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const tmpPath = path.join('/tmp/claude-0/-home-user-yaniv/a3eb2355-4f2c-50c0-99b2-523abdf2755d/scratchpad', 'test_buffer.json');

    const rb = new ReplayBuffer(100);
    rb.add({ state: new Float32Array([1, 2, 3]), policy: new Float32Array([0.5, 0.5]), value: 0.7 });
    rb.add({ state: new Float32Array([4, 5, 6]), policy: new Float32Array([0.3, 0.7]), value: -0.3 });
    rb.save(tmpPath);

    const loaded = ReplayBuffer.load(tmpPath);
    assert.equal(loaded.size, 2);
    assert.equal(loaded.totalAdded, 2);
    assert.ok(Math.abs(loaded.buffer[0].value - 0.7) < 0.01);

    fs.unlinkSync(tmpPath);
  });
});
