function expectedScore(ratingA, ratingB) {
  return 1 / (1 + (10 ** ((ratingB - ratingA) / 400)));
}

function updateHeadToHeadRatings(ratingA, ratingB, actualScoreA, kFactor = 24) {
  const expectedA = expectedScore(ratingA, ratingB);
  const delta = kFactor * (actualScoreA - expectedA);
  return {
    rating_a: ratingA + delta,
    rating_b: ratingB - delta,
  };
}

function compareScores(scoreA, scoreB) {
  if (scoreA < scoreB) return 1;
  if (scoreA > scoreB) return 0;
  return 0.5;
}

function updatePairwiseMultiplayerRatings(ratingsByPlayer, playerMetrics, kFactor = 12) {
  const updated = { ...ratingsByPlayer };

  for (let i = 0; i < playerMetrics.length; i += 1) {
    const left = playerMetrics[i];
    for (let j = i + 1; j < playerMetrics.length; j += 1) {
      const right = playerMetrics[j];
      const actualLeft = compareScores(left.score, right.score);
      const leftRating = updated[left.policy_id];
      const rightRating = updated[right.policy_id];
      const next = updateHeadToHeadRatings(leftRating, rightRating, actualLeft, kFactor);
      updated[left.policy_id] = next.rating_a;
      updated[right.policy_id] = next.rating_b;
    }
  }

  return updated;
}

function averagePairwiseScore(policyId, playerMetrics) {
  const player = playerMetrics.find((metric) => metric.policy_id === policyId);
  if (!player) {
    return 0;
  }

  let total = 0;
  let count = 0;
  for (const other of playerMetrics) {
    if (other === player) continue;
    total += compareScores(player.score, other.score);
    count += 1;
  }

  if (count === 0) return 0;
  return total / count;
}

module.exports = {
  averagePairwiseScore,
  compareScores,
  expectedScore,
  updateHeadToHeadRatings,
  updatePairwiseMultiplayerRatings,
};
