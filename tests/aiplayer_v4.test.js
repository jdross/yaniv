const test = require('node:test');
const assert = require('node:assert/strict');

const { Card } = require('../server/src/card');
const { AIPlayerV4 } = require('../server/src/aiplayer_v4');

function serializeAction(action) {
  return {
    draw: action.draw,
    discard: action.discard.map((card) => card.id).sort((a, b) => a - b),
  };
}

function makeRound() {
  return [
    { name: 'AI', score: 0 },
    { name: 'Opp', score: 0 },
  ];
}

function makePlayer() {
  const ai = new AIPlayerV4('AI');
  ai.observe_round(makeRound());
  return ai;
}

test('V4 tracks opponent turns taken per round', () => {
  const ai = makePlayer();
  assert.equal(ai.other_players.Opp.turns_taken, 0);

  ai.observe_turn({
    player: { name: 'Opp' },
    action: { draw: 'deck' },
    hand_count: 5,
    discarded_cards: [new Card('K', 'Clubs')],
    drawn_card: null,
  }, [new Card('K', 'Clubs')], [new Card('K', 'Clubs')]);

  assert.equal(ai.other_players.Opp.turns_taken, 1);

  ai.observe_round(makeRound());
  assert.equal(ai.other_players.Opp.turns_taken, 0);
});

test('calibrated unknown-card ratio shrinks with opponent turns taken', () => {
  const ai = makePlayer();
  assert.equal(ai._unknown_value_ratio(5, 0), 1.0);
  assert.ok(ai._unknown_value_ratio(5, 4) < ai._unknown_value_ratio(5, 1));
  assert.ok(ai._unknown_value_ratio(4, 8) >= 0.47);
  // A single unknown card skews high (a low one would already be a Yaniv call).
  assert.ok(ai._unknown_value_ratio(1, 6) > 1.0);
});

test('determinization sampling reflects round-progress calibration', () => {
  const fresh = makePlayer();
  fresh.hand = [new Card('K', 'Spades'), new Card('Q', 'Hearts'), new Card('9', 'Clubs')];
  fresh.draw_options = [new Card('5', 'Hearts')];
  fresh.public_discard_pile = [new Card('5', 'Hearts')];

  const late = makePlayer();
  late.hand = [...fresh.hand];
  late.draw_options = [...fresh.draw_options];
  late.public_discard_pile = [...fresh.public_discard_pile];
  late.other_players.Opp.turns_taken = 8;

  const meanSampledTotal = (player) => {
    const dets = player._build_determinizations();
    let total = 0;
    let n = 0;
    for (const det of dets) {
      for (const opp of det.opponents) {
        total += opp.hand.reduce((sum, card) => sum + card.value, 0);
        n += 1;
      }
    }
    return total / n;
  };

  assert.ok(meanSampledTotal(late) < meanSampledTotal(fresh) - 3);
});

test('V4 calls Yaniv with a strong hand against a fresh opponent', () => {
  const ai = makePlayer();
  ai.hand = [new Card('A', 'Clubs'), new Card('A', 'Diamonds')];
  ai.draw_options = [new Card('10', 'Hearts')];
  ai.public_discard_pile = [new Card('10', 'Hearts')];
  ai.other_players.Opp.hand_count = 5;

  assert.equal(ai.should_declare_yaniv(), true);
});

test('V4 refuses to call when known opponent cards guarantee an Assaf', () => {
  const ai = makePlayer();
  ai.hand = [new Card('2', 'Clubs'), new Card('3', 'Diamonds')];
  ai.draw_options = [new Card('10', 'Hearts')];
  ai.public_discard_pile = [new Card('10', 'Hearts')];
  ai.other_players.Opp.hand_count = 2;
  ai.other_players.Opp.known_cards = [new Card('A', 'Hearts'), new Card('A', 'Spades')];
  ai.other_players.Opp.turns_taken = 6;

  assert.equal(ai.should_declare_yaniv(), false);
});

test('V4 never declares Yaniv above the legal threshold', () => {
  const ai = makePlayer();
  ai.hand = [new Card('4', 'Clubs'), new Card('4', 'Diamonds')];
  ai.draw_options = [new Card('10', 'Hearts')];
  ai.public_discard_pile = [new Card('10', 'Hearts')];

  assert.equal(ai.should_declare_yaniv(), false);
});

test('V4 returns a legal action and is deterministic for the same public state', () => {
  const createPlayer = () => {
    const ai = makePlayer();
    ai.hand = [
      new Card('7', 'Spades'),
      new Card('8', 'Clubs'),
      new Card('8', 'Diamonds'),
      new Card('A', 'Hearts'),
      new Card('K', 'Clubs'),
    ];
    ai.draw_options = [new Card('5', 'Hearts')];
    ai.public_discard_pile = [new Card('5', 'Hearts')];
    ai.other_players.Opp.hand_count = 4;
    ai.other_players.Opp.turns_taken = 2;
    return ai;
  };

  const playerOne = createPlayer();
  const actionOne = playerOne.decide_action();
  assert.ok(Array.isArray(actionOne.discard) && actionOne.discard.length > 0);
  assert.ok(actionOne.draw === 'deck' || (Number.isInteger(actionOne.draw) && actionOne.draw >= 0));
  for (const card of actionOne.discard) {
    assert.ok(playerOne.hand.some((held) => held.id === card.id));
  }

  const actionTwo = createPlayer().decide_action();
  assert.deepEqual(serializeAction(actionOne), serializeAction(actionTwo));
});

test('rollout simulation ends rounds and scores Assaf correctly', () => {
  const ai = makePlayer();
  ai.hand = [new Card('2', 'Clubs'), new Card('2', 'Diamonds')];
  ai.draw_options = [new Card('10', 'Hearts')];
  ai.public_discard_pile = [new Card('10', 'Hearts')];

  // Opponent calls with 4 while we hold 4: opponent is Assaf'd (+30), we add 0.
  const state = {
    players: [
      { name: 'AI', isMe: true, score: 10, hand: [new Card('2', 'Clubs'), new Card('2', 'Diamonds')] },
      { name: 'Opp', isMe: false, score: 5, hand: [new Card('4', 'Spades')] },
    ],
    deck: [],
    lastDiscard: [],
    simDiscards: [],
    turnIndex: 1,
  };
  const cost = ai._score_round_end(state, 1);
  // Our delta is 0; opponent delta is +30 -> cost = 0 - 0.5 * 30 = -15.
  assert.equal(cost, -0.5 * 30);
});

test('round-end scoring applies the 50-point reset rule', () => {
  const ai = makePlayer();
  // Assaf'd caller at score 20 lands exactly on 50 and resets to 0.
  const state = {
    players: [
      { name: 'AI', isMe: true, score: 10, hand: [new Card('2', 'Clubs'), new Card('2', 'Diamonds')] },
      { name: 'Opp', isMe: false, score: 20, hand: [new Card('4', 'Spades')] },
    ],
    deck: [],
    lastDiscard: [],
    simDiscards: [],
    turnIndex: 1,
  };
  const cost = ai._score_round_end(state, 1);
  // Opponent's effective delta is 50 - 20 - 50 = -20 -> cost = 0 - 0.5 * -20 = +10.
  assert.equal(cost, 10);
});
