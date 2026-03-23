const test = require('node:test');
const assert = require('node:assert/strict');

const { Card } = require('../server/src/card');
const { AIPlayer } = require('../server/src/aiplayer_v1');
const { AIPlayerV3 } = require('../server/src/aiplayer_v3');

function serializeAction(action) {
  return {
    draw: action.draw,
    discard: action.discard.map((card) => card._card).sort((a, b) => a - b),
  };
}

function makeRound() {
  return [
    { name: 'AI', score: 0 },
    { name: 'Opp', score: 0 },
  ];
}

function setupYanivPlayer(PlayerClass) {
  const ai = new PlayerClass('AI');
  ai.observe_round(makeRound());
  ai.hand = [new Card('2', 'Clubs'), new Card('2', 'Diamonds')];
  ai.draw_options = [];
  ai.public_discard_pile = [];
  ai.other_players.Opp.hand_count = 2;
  ai.other_players.Opp.known_cards = [];
  ai.other_players.Opp.estimated_score = 4;
  return ai;
}

test('belief update from discard pickup boosts rank and adjacent run needs', () => {
  const ai = new AIPlayerV3('AI');
  ai.observe_round(makeRound());
  ai.draw_options = [new Card('7', 'Hearts')];

  ai.observe_turn({
    player: { name: 'Opp' },
    action: { draw: 0 },
    hand_count: 5,
    discarded_cards: [new Card('K', 'Clubs')],
    drawn_card: new Card('7', 'Hearts'),
  }, [new Card('K', 'Clubs')], [new Card('K', 'Clubs')]);

  const opp = ai.other_players.Opp;
  assert.ok(opp.need_by_rank['7'] > 0);
  assert.ok(opp.need_by_suit_rank.Hearts[6] > 0);
  assert.ok(opp.need_by_suit_rank.Hearts[8] > 0);
});

test('belief decay lowers rank need after opponent discards out of the tracked structure', () => {
  const ai = new AIPlayerV3('AI');
  ai.observe_round(makeRound());
  ai.draw_options = [new Card('7', 'Hearts')];

  ai.observe_turn({
    player: { name: 'Opp' },
    action: { draw: 0 },
    hand_count: 5,
    discarded_cards: [new Card('K', 'Clubs')],
    drawn_card: new Card('7', 'Hearts'),
  }, [new Card('K', 'Clubs')], [new Card('K', 'Clubs')]);

  const before = ai.other_players.Opp.need_by_rank['7'];

  ai.observe_turn({
    player: { name: 'Opp' },
    action: { draw: 'deck' },
    hand_count: 4,
    discarded_cards: [new Card('7', 'Diamonds')],
    drawn_card: null,
  }, [new Card('7', 'Diamonds')], [new Card('7', 'Diamonds')]);

  const after = ai.other_players.Opp.need_by_rank['7'] || 0;
  assert.ok(after < before);
});

test('belief-based feed penalty marks tracked cards as more dangerous to discard', () => {
  const ai = new AIPlayerV3('AI');
  ai.observe_round(makeRound());
  ai.other_players.Opp.hand_count = 2;
  ai.other_players.Opp.estimated_score = 4;
  ai.other_players.Opp.need_by_rank['7'] = 2.5;
  ai.other_players.Opp.need_by_suit_rank.Hearts = { 6: 1.8, 8: 1.8 };
  ai.other_players.Opp.low_card_bias = 1.2;

  const dangerous = ai._feed_penalty([new Card('7', 'Spades')]);
  const safer = ai._feed_penalty([new Card('9', 'Clubs')]);

  assert.ok(dangerous > safer);
});

test('V3 becomes more conservative than baseline when low-hand opponent beliefs imply assaf risk', () => {
  const baseline = setupYanivPlayer(AIPlayer);
  const v3 = setupYanivPlayer(AIPlayerV3);

  v3.other_players.Opp.low_card_bias = 1.6;
  v3.other_players.Opp.need_by_rank.A = 3.0;
  v3.other_players.Opp.need_by_rank['2'] = 2.5;
  v3.other_players.Opp.need_by_rank['3'] = 2.0;
  v3.other_players.Opp.need_by_suit_rank.Hearts = { 1: 2.0, 2: 2.0, 3: 1.8 };

  assert.equal(baseline.should_declare_yaniv(), true);
  assert.equal(v3.should_declare_yaniv(), false);
});

test('V3 still calls Yaniv when public known cards make assaf impossible', () => {
  const v3 = setupYanivPlayer(AIPlayerV3);
  v3.other_players.Opp.hand_count = 2;
  v3.other_players.Opp.known_cards = [new Card('10', 'Hearts'), new Card('9', 'Spades')];
  v3.other_players.Opp.estimated_score = 19;
  v3.other_players.Opp.low_card_bias = 0;

  assert.equal(v3.should_declare_yaniv(), true);
});

test('V3 action selection is deterministic for the same public state', () => {
  const createPlayer = () => {
    const ai = new AIPlayerV3('AI');
    ai.observe_round(makeRound());
    ai.hand = [new Card('7', 'Spades'), new Card('8', 'Clubs'), new Card('8', 'Diamonds'), new Card('A', 'Hearts')];
    ai.draw_options = [new Card('5', 'Hearts')];
    ai.public_discard_pile = [new Card('5', 'Hearts')];
    ai.other_players.Opp.hand_count = 2;
    ai.other_players.Opp.estimated_score = 4;
    ai.other_players.Opp.need_by_rank['7'] = 2.0;
    ai.other_players.Opp.low_card_bias = 1.0;
    return ai;
  };

  const actionOne = serializeAction(createPlayer().decide_action());
  const actionTwo = serializeAction(createPlayer().decide_action());
  assert.deepEqual(actionOne, actionTwo);
});
