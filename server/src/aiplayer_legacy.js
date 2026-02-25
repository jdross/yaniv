// Legacy AI policy: the pre-improvement strategy used for A/B benchmarking.
// Extends the current AIPlayer so instanceof checks work with YanivGame,
// but overrides the methods that were changed to restore the old behaviour.

const { AIPlayer } = require('./aiplayer');

function containsCard(cards, target) {
  return cards.some((card) => card.id === target.id);
}

class LegacyAIPlayer extends AIPlayer {
  // --- observeRound: no collection-tracking fields ---
  observeRound(roundInfo) {
    this.otherPlayers = {};
    this.drawOptions = [];
    this.publicDiscardPile = [];
    this._discardOptionsCache.clear();
    this._bestResidualCache.clear();
    this._bestDiscardOptionsCache.clear();
    this._simulateActionCache.clear();

    for (const playerInfo of roundInfo) {
      if (playerInfo.name !== this.name) {
        this.otherPlayers[playerInfo.name] = {
          currentScore: playerInfo.score,
          handCount: 5,
          knownCards: [],
          estimatedScore: 50,
          // Legacy: no pickupHistory, discardHistory, collectedRanks, collectedSuitRanks
          pickupHistory: [],
          discardHistory: [],
          collectedRanks: {},
          collectedSuitRanks: {},
        };
      }
    }
  }

  // --- observeTurn: no collection pattern tracking ---
  observeTurn(turnInfo, discardPile, drawOptions) {
    const playerName = turnInfo.player.name;
    this.drawOptions = [...drawOptions];
    this.publicDiscardPile = [...discardPile];

    if (Object.prototype.hasOwnProperty.call(this.otherPlayers, playerName)) {
      const playerInfo = this.otherPlayers[playerName];
      playerInfo.handCount = turnInfo.handCount;

      const discardedCards = turnInfo.discardedCards;
      const drawnCard = turnInfo.drawnCard;

      for (const card of discardedCards) {
        const idx = playerInfo.knownCards.findIndex((c) => c.id === card.id);
        if (idx !== -1) playerInfo.knownCards.splice(idx, 1);
      }

      if (drawnCard !== null && drawnCard !== undefined) {
        playerInfo.knownCards.push(drawnCard);
      }

      this.estimateHandValues();
    }
  }

  // --- old heuristic weight: 0.12 for feed penalty ---
  _heuristicActionCost(threat, immediatePoints, feedPenalty, jokerDiscardPenalty) {
    return (0.06 * threat * immediatePoints) + (0.12 * feedPenalty) + (0.08 * jokerDiscardPenalty);
  }

  // --- old iter: no composition bonus ---
  *_iterCandidateActions(context) {
    const discardOptions = this._getDiscardOptionsCached(this.hand);

    for (const discardOption of discardOptions) {
      const postDiscardHand = this.hand.filter((card) => !containsCard(discardOption, card));
      const postTurnWithoutDraw = postDiscardHand.reduce((sum, card) => sum + card.value, 0);
      const discardValue = discardOption.reduce((sum, card) => sum + card.value, 0);
      const feedPenalty = this._feedPenalty(discardOption, context.knownRanks, context.knownSuitRanks);
      const jokerDiscardPenalty = 1.5 * discardOption.filter((card) => card.rank === 'Joker').length;

      for (let i = 0; i < this.drawOptions.length; i += 1) {
        const drawCard = this.drawOptions[i];
        const [futureScore] = this._simulateAction(postDiscardHand, drawCard, false);
        const immediatePoints = postTurnWithoutDraw + drawCard.value;
        const heuristicCost = this._heuristicActionCost(
          context.threat,
          immediatePoints,
          feedPenalty,
          jokerDiscardPenalty,
        );
        const resetBonus = this._resetBonus(immediatePoints, context.yanivNextTurnProb);
        const actionScore = futureScore + heuristicCost - resetBonus;

        yield [{ discard: discardOption, draw: i }, actionScore, discardValue];
      }

      const [expectedFuture, expectedImmediate] = this._evaluateDeckDrawSamples(
        postDiscardHand,
        context.sampledCards,
        false,
      );
      const expectedResetBonus = this._expectedResetBonusFromSamples(
        postTurnWithoutDraw,
        context.sampledCards,
        context.yanivNextTurnProb,
      );
      const uncertaintyCost = 0.04 * Math.sqrt(context.deckVariance) * (1 + context.threat);
      const heuristicCost = this._heuristicActionCost(
        context.threat,
        expectedImmediate,
        feedPenalty,
        jokerDiscardPenalty,
      );
      const actionScore = expectedFuture + heuristicCost + uncertaintyCost - expectedResetBonus;

      yield [{ discard: discardOption, draw: 'deck' }, actionScore, discardValue];
    }
  }

  // --- old feed penalty: no collection-based penalties ---
  _feedPenalty(discardOption, knownRanks = null, knownSuitRanks = null) {
    if (knownRanks === null || knownSuitRanks === null) {
      [knownRanks, knownSuitRanks] = this._knownCardIndexes();
    }

    let penalty = 0;

    for (const card of discardOption) {
      if (card.rank === 'Joker') {
        penalty += 4.0;
        continue;
      }

      if (card.value <= 3) {
        penalty += 1.5;
      } else if (card.value <= 5) {
        penalty += 1.0;
      } else {
        penalty += 0.2;
      }

      if (knownRanks.has(card.rank)) {
        penalty += 1.3;
      }

      const cardRank = card.rankIndex();
      const suitRanks = knownSuitRanks.get(card.suit) ?? new Set();
      if (
        suitRanks.has(cardRank)
        || suitRanks.has(cardRank - 1)
        || suitRanks.has(cardRank + 1)
      ) {
        penalty += 0.8;
      }
    }

    return penalty;
  }

  // --- old shouldDeclareYaniv: no assaf hunting or reset awareness ---
  shouldDeclareYaniv() {
    const ownHandValue = this.hand.reduce((sum, card) => sum + card.value, 0);
    if (ownHandValue > 5) {
      return false;
    }

    if (Object.keys(this.otherPlayers).length === 0) {
      return ownHandValue <= 2;
    }

    const unseen = this._getUnseenCards();
    const [meanValue, varValue] = this._meanAndVariance(unseen);

    let notAssafProb = 1;
    for (const playerInfo of Object.values(this.otherPlayers)) {
      const p = this._estimateAssafProbability(playerInfo, ownHandValue, meanValue, varValue);
      notAssafProb *= (1 - p);
    }
    const assafRisk = 1 - notAssafProb;

    const thresholdMap = {
      0: 0.60,
      1: 0.55,
      2: 0.45,
      3: 0.32,
      4: 0.20,
      5: 0.12,
    };
    let riskThreshold = thresholdMap[ownHandValue] ?? 0.10;

    const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
    const scorePressure = clamp(this.score / 100, 0, 1);
    riskThreshold *= (1 - 0.35 * scorePressure);
    riskThreshold = Math.max(0.03, riskThreshold);

    return assafRisk <= riskThreshold;
  }
}

module.exports = { LegacyAIPlayer };
