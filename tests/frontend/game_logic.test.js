const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const logic = require(path.join(__dirname, '../../static/js/shared/game-logic.js'));

test('sortHand sorts by id ascending', () => {
  const hand = [{ id: 10 }, { id: 1 }, { id: 7 }];
  assert.deepEqual(logic.sortHand(hand).map(c => c.id), [1, 7, 10]);
});

test('validateDiscard accepts single cards and sets', () => {
  assert.deepEqual(logic.validateDiscard([{ rank: 'K', suit: 'Hearts' }]), { valid: true });
  assert.deepEqual(
    logic.validateDiscard([
      { rank: '7', suit: 'Hearts' },
      { rank: '7', suit: 'Spades' },
      { rank: 'Joker', suit: null },
    ]),
    { valid: true }
  );
});

test('validateDiscard accepts runs with joker gap fill', () => {
  const result = logic.validateDiscard([
    { rank: '4', suit: 'Hearts' },
    { rank: 'Joker', suit: null },
    { rank: '6', suit: 'Hearts' },
  ]);
  assert.equal(result.valid, true);
});

test('validateDiscard rejects invalid pairs and mixed-suit runs', () => {
  const invalidPair = logic.validateDiscard([
    { rank: '4', suit: 'Hearts' },
    { rank: '5', suit: 'Hearts' },
  ]);
  assert.equal(invalidPair.valid, false);
  assert.equal(invalidPair.reason, 'Two cards must share the same rank');

  const mixedRun = logic.validateDiscard([
    { rank: '4', suit: 'Hearts' },
    { rank: '5', suit: 'Clubs' },
    { rank: '6', suit: 'Hearts' },
  ]);
  assert.equal(mixedRun.valid, false);
  assert.equal(
    mixedRun.reason,
    'Cards must form a set (same rank) or a run (3+ same suit, consecutive)'
  );
});

test('cardColor and suitSymbol map suits consistently', () => {
  assert.equal(logic.cardColor({ suit: 'Diamonds' }), 'red');
  assert.equal(logic.cardColor({ suit: 'Spades' }), '');
  assert.equal(logic.suitSymbol('Hearts'), '♥');
  assert.equal(logic.suitSymbol('Unknown'), '');
});
