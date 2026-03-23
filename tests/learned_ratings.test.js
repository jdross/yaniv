const test = require('node:test');
const assert = require('node:assert/strict');

const {
  expectedScore,
  updateHeadToHeadRatings,
  updatePairwiseMultiplayerRatings,
} = require('../server/src/learned_ratings');

test('head-to-head Elo is symmetric', () => {
  const expected = expectedScore(1500, 1500);
  assert.equal(expected, 0.5);

  const updated = updateHeadToHeadRatings(1500, 1500, 1, 24);
  assert.equal(updated.rating_a, 1512);
  assert.equal(updated.rating_b, 1488);
});

test('pairwise multiplayer Elo rewards stronger final placement', () => {
  const updated = updatePairwiseMultiplayerRatings(
    { learned: 1500, v3: 1500, legacy: 1400 },
    [
      { policy_id: 'learned', score: 10 },
      { policy_id: 'v3', score: 18 },
      { policy_id: 'legacy', score: 42 },
    ],
    12,
  );

  assert.ok(updated.learned > 1500);
  assert.ok(updated.v3 < updated.learned);
  assert.ok(updated.legacy < 1400);
});
