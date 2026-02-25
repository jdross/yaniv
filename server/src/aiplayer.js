const { Player } = require('./player');
const { Card } = require('./card');

function combinations(values, size) {
  if (size === 0) return [[]];
  if (size > values.length) return [];
  if (size === 1) return values.map((value) => [value]);

  const out = [];
  for (let i = 0; i <= values.length - size; i += 1) {
    const head = values[i];
    const tails = combinations(values.slice(i + 1), size - 1);
    for (const tail of tails) {
      out.push([head, ...tail]);
    }
  }
  return out;
}

function containsCard(cards, target) {
  return cards.some((card) => card.id === target.id);
}

function removeFirstMatchingCard(cards, target) {
  const idx = cards.findIndex((card) => card.id === target.id);
  if (idx !== -1) {
    cards.splice(idx, 1);
    return true;
  }
  return false;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function erf(x) {
  const sign = x >= 0 ? 1 : -1;
  const absX = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * absX);
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const y = 1 - (((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-absX * absX));
  return sign * y;
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

function sampleWithoutReplacement(values, sampleCount, rng) {
  const copy = [...values];
  for (let i = 0; i < sampleCount; i += 1) {
    const j = i + Math.floor(rng() * (copy.length - i));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, sampleCount);
}

class AIPlayer extends Player {
  static _FULL_DECK = Card.createDeck();
  static _MAX_CACHE_ENTRIES = 50000;

  constructor(name, rolloutSamples = 24) {
    super(name);
    this.rolloutSamples = Math.max(4, Number.parseInt(rolloutSamples, 10));
    this.otherPlayers = {};
    this.drawOptions = [];
    this.publicDiscardPile = [];

    this._discardOptionsCache = new Map();
    this._bestResidualCache = new Map();
    this._bestDiscardOptionsCache = new Map();
    this._simulateActionCache = new Map();
  }

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
          pickupHistory: [],
          discardHistory: [],
          collectedRanks: {},
          collectedSuitRanks: {},
        };
      }
    }
  }

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
        removeFirstMatchingCard(playerInfo.knownCards, card);
        playerInfo.discardHistory.push(card);
      }

      if (drawnCard !== null && drawnCard !== undefined) {
        playerInfo.knownCards.push(drawnCard);
        playerInfo.pickupHistory.push(drawnCard);
        if (drawnCard.rank !== 'Joker') {
          playerInfo.collectedRanks[drawnCard.rank] = (playerInfo.collectedRanks[drawnCard.rank] || 0) + 1;
          if (!playerInfo.collectedSuitRanks[drawnCard.suit]) {
            playerInfo.collectedSuitRanks[drawnCard.suit] = new Set();
          }
          playerInfo.collectedSuitRanks[drawnCard.suit].add(drawnCard.rankIndex());
        }
      }

      this.estimateHandValues();
    }
  }

  _cacheSet(cache, key, value) {
    if (cache.has(key)) {
      cache.delete(key);
    } else if (cache.size >= AIPlayer._MAX_CACHE_ENTRIES) {
      const firstKey = cache.keys().next().value;
      cache.delete(firstKey);
    }
    cache.set(key, value);
  }

  _cacheGet(cache, key) {
    if (!cache.has(key)) {
      return null;
    }
    const value = cache.get(key);
    cache.delete(key);
    cache.set(key, value);
    return value;
  }

  decideAction() {
    for (const playerInfo of Object.values(this.otherPlayers)) {
      if (playerInfo.estimatedScore <= 5) {
        const resetAction = this.actionToReset();
        if (resetAction !== null) {
          return resetAction;
        }
      }
    }

    const context = this._buildActionContext();
    let bestAction = null;
    let bestScore = Number.POSITIVE_INFINITY;
    let bestDiscardValue = -1;

    for (const [action, actionScore, discardValue] of this._iterCandidateActions(context)) {
      if (actionScore < bestScore || (actionScore === bestScore && discardValue > bestDiscardValue)) {
        bestScore = actionScore;
        bestDiscardValue = discardValue;
        bestAction = action;
      }
    }

    if (bestAction === null) {
      return this.actionToMinimizeScore();
    }
    return bestAction;
  }

  _buildActionContext() {
    const unseenCards = this._getUnseenCards();
    const [sampledCards, deckVariance] = this._deckRolloutContext(unseenCards);
    const [knownRanks, knownSuitRanks] = this._knownCardIndexes();
    const threat = this._opponentThreatScore();
    const yanivNextTurnProb = this._opponentYanivNextTurnProbability();

    return {
      sampledCards,
      deckVariance,
      knownRanks,
      knownSuitRanks,
      threat,
      yanivNextTurnProb,
    };
  }

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
        const [futureScore, bestNextDiscard] = this._simulateAction(postDiscardHand, drawCard, false);
        const immediatePoints = postTurnWithoutDraw + drawCard.value;
        const heuristicCost = this._heuristicActionCost(
          context.threat,
          immediatePoints,
          feedPenalty,
          jokerDiscardPenalty,
        );
        const resetBonus = this._resetBonus(immediatePoints, context.yanivNextTurnProb);
        // Bonus for keeping cards with good set/run potential
        let compositionBonus = 0;
        if (bestNextDiscard) {
          const newHand = [...postDiscardHand, drawCard];
          const remaining = newHand.filter((c) => !containsCard(bestNextDiscard, c));
          compositionBonus = 0.10 * this._handCompositionBonus(remaining);
        }
        const actionScore = futureScore + heuristicCost - resetBonus - compositionBonus;

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
      // Average composition bonus from deck draws
      let deckCompositionBonus = 0;
      if (context.sampledCards.length > 0) {
        let totalBonus = 0;
        for (const drawCard of context.sampledCards) {
          const [, bestNext] = this._simulateAction(postDiscardHand, drawCard, false);
          if (bestNext) {
            const newHand = [...postDiscardHand, drawCard];
            const remaining = newHand.filter((c) => !containsCard(bestNext, c));
            totalBonus += this._handCompositionBonus(remaining);
          }
        }
        deckCompositionBonus = 0.10 * (totalBonus / context.sampledCards.length);
      }
      const actionScore = expectedFuture + heuristicCost + uncertaintyCost - expectedResetBonus - deckCompositionBonus;

      yield [{ discard: discardOption, draw: 'deck' }, actionScore, discardValue];
    }
  }

  _heuristicActionCost(threat, immediatePoints, feedPenalty, jokerDiscardPenalty) {
    return (0.06 * threat * immediatePoints) + (0.22 * feedPenalty) + (0.08 * jokerDiscardPenalty);
  }

  _opponentYanivNextTurnProbability() {
    const opponents = Object.values(this.otherPlayers);
    if (opponents.length === 0) {
      return 0;
    }

    let notYanivProb = 1;
    for (const playerInfo of opponents) {
      const estimated = playerInfo.estimatedScore ?? 50;
      const handCount = playerInfo.handCount ?? 5;

      if (estimated > 6.5) {
        continue;
      }

      let p;
      if (estimated <= 5.0) {
        p = 0.55 + (5.0 - estimated) * 0.08;
      } else {
        p = 0.18 + (6.5 - estimated) * 0.25;
      }

      if (handCount <= 2) {
        p += 0.10;
      } else if (handCount === 3) {
        p += 0.05;
      }

      const lowKnown = playerInfo.knownCards.filter((card) => card.value <= 3).length;
      p += 0.03 * lowKnown;
      p = clamp(p, 0, 0.92);
      notYanivProb *= (1 - p);
    }

    return 1 - notYanivProb;
  }

  _resetBonus(handTotal, yanivNextTurnProb) {
    const projectedScore = this.score + handTotal;
    if (projectedScore !== 50 && projectedScore !== 100) {
      return 0;
    }

    let successFactor;
    if (handTotal <= 5) {
      successFactor = 0.25;
    } else if (handTotal <= 7) {
      successFactor = 0.55;
    } else {
      successFactor = 0.75;
    }

    const expectedResetValue = 50 * yanivNextTurnProb * successFactor;
    return Math.min(24, expectedResetValue);
  }

  _expectedResetBonusFromSamples(postTurnWithoutDraw, sampledCards, yanivNextTurnProb) {
    if (sampledCards.length === 0) {
      return 0;
    }

    let totalBonus = 0;
    for (const drawCard of sampledCards) {
      const handTotal = postTurnWithoutDraw + drawCard.value;
      totalBonus += this._resetBonus(handTotal, yanivNextTurnProb);
    }
    return totalBonus / sampledCards.length;
  }

  actionToReset() {
    for (const discardOption of this._getDiscardOptionsCached(this.hand)) {
      const discardValue = discardOption.reduce((sum, card) => sum + card.value, 0);
      for (let drawIndex = 0; drawIndex < this.drawOptions.length; drawIndex += 1) {
        const drawCard = this.drawOptions[drawIndex];
        if ((discardValue - drawCard.value + this.score) % 50 === 0) {
          return {
            discard: discardOption,
            draw: drawIndex,
          };
        }
      }
    }
    return null;
  }

  actionToMinimizeScore() {
    const action = this._simulateNextTurn();
    return {
      discard: action.discard,
      draw: action.draw,
    };
  }

  _getDiscardOptions(hand = this.hand) {
    const discardOptions = hand.map((card) => [card]);

    const jokers = hand.filter((card) => card.rank === 'Joker');
    const nonJokers = hand.filter((card) => card.rank !== 'Joker');
    const jokerCount = jokers.length;

    const rankIndexById = {};
    for (const card of hand) {
      rankIndexById[card.id] = card.rankIndex();
    }

    for (let comboSize = 2; comboSize <= nonJokers.length; comboSize += 1) {
      const combos = combinations(nonJokers, comboSize);
      for (const combo of combos) {
        const firstRank = combo[0].rank;
        if (combo.every((card) => card.rank === firstRank)) {
          for (let numJokers = 0; numJokers <= jokerCount; numJokers += 1) {
            const jokerCombos = combinations(jokers, numJokers);
            for (const jokerCombo of jokerCombos) {
              discardOptions.push([...combo, ...jokerCombo]);
            }
          }
          continue;
        }

        const firstSuit = combo[0].suit;
        if (combo.every((card) => card.suit === firstSuit)) {
          let sortedCombo = [...combo].sort((a, b) => rankIndexById[a.id] - rankIndexById[b.id]);
          const gaps = [];
          for (let i = 0; i < sortedCombo.length - 1; i += 1) {
            const gap = rankIndexById[sortedCombo[i + 1].id] - rankIndexById[sortedCombo[i].id] - 1;
            if (gap > 0) {
              gaps.push([i, gap]);
            }
          }

          const totalGaps = gaps.reduce((sum, [, gap]) => sum + gap, 0);
          if (totalGaps <= jokerCount) {
            sortedCombo = [...sortedCombo];
            let jokerIndex = 0;
            for (const [i, gap] of gaps) {
              for (let j = 0; j < gap; j += 1) {
                if (jokerIndex < jokerCount) {
                  sortedCombo.splice(i + 1, 0, jokers[jokerIndex]);
                  jokerIndex += 1;
                }
              }
            }

            const remainingJokers = jokers.slice(jokerIndex);
            for (const joker of remainingJokers) {
              if (rankIndexById[sortedCombo[0].id] > 1) {
                discardOptions.push([joker, ...sortedCombo]);
              }
              if (rankIndexById[sortedCombo[sortedCombo.length - 1].id] < 13) {
                discardOptions.push([...sortedCombo, joker]);
              }
            }

            if (sortedCombo.length >= 3) {
              discardOptions.push(sortedCombo);
            }
          }
        }
      }
    }

    return discardOptions;
  }

  _getDiscardOptionsCached(hand) {
    const signature = this._handSignature(hand);
    let cached = this._cacheGet(this._discardOptionsCache, signature);
    if (cached === null) {
      cached = this._getDiscardOptions(hand);
      this._cacheSet(this._discardOptionsCache, signature, cached);
    }
    return cached;
  }

  _handSignature(hand) {
    return hand.map((card) => card.id).sort((a, b) => a - b).join(',');
  }

  _getBestDiscardOptionsCached(hand) {
    const signature = this._handSignature(hand);
    let cached = this._cacheGet(this._bestDiscardOptionsCache, signature);
    if (cached === null) {
      const discardOptions = this._getDiscardOptionsCached(hand);
      cached = this._getBestDiscardOptions(discardOptions);
      this._cacheSet(this._bestDiscardOptionsCache, signature, cached);
    }
    return cached;
  }

  _simulateAction(potentialHand, drawCard, pruneToBestDiscard = true) {
    const newHand = [...potentialHand, drawCard];
    const signature = this._handSignature(newHand);
    const cacheKey = `${signature}|${pruneToBestDiscard ? 1 : 0}`;
    const cached = this._cacheGet(this._simulateActionCache, cacheKey);
    if (cached !== null) {
      return cached;
    }

    const candidateDiscardOptions = pruneToBestDiscard
      ? this._getBestDiscardOptionsCached(newHand)
      : this._getDiscardOptionsCached(newHand);

    let futureExpectedPoints = Number.POSITIVE_INFINITY;
    let bestNextDiscardOption = null;

    for (const discardOption of candidateDiscardOptions) {
      const expectedPoints = this._calculateNewTotalPoints(newHand, discardOption);
      if (expectedPoints <= futureExpectedPoints) {
        futureExpectedPoints = expectedPoints;
        bestNextDiscardOption = discardOption;
      }
    }

    const out = [futureExpectedPoints, bestNextDiscardOption];
    this._cacheSet(this._simulateActionCache, cacheKey, out);
    return out;
  }

  _getBestAction(postDiscardHand) {
    let bestScore = Number.POSITIVE_INFINITY;
    let bestDrawCard = 'deck';

    for (let i = 0; i < this.drawOptions.length; i += 1) {
      const drawCard = this.drawOptions[i];
      const [score] = this._simulateAction(postDiscardHand, drawCard);
      if (score < bestScore) {
        bestScore = score;
        bestDrawCard = i;
      }
    }

    return [bestDrawCard, bestScore];
  }

  _simulateNextTurn() {
    const discardOptions = this._getDiscardOptionsCached(this.hand);
    let bestDiscard = this._getBestDiscardOptions(discardOptions)[0];
    let bestScore = this.hand.reduce((sum, card) => sum + card.value, 0)
      - bestDiscard.reduce((sum, card) => sum + card.value, 0)
      + 0;
    let bestDrawCard = 'deck';

    for (const discardOption of discardOptions) {
      const postDiscardHand = this.hand.filter((card) => !containsCard(discardOption, card));
      const [drawCard, score] = this._getBestAction(postDiscardHand);

      if (score < bestScore) {
        bestScore = score;
        bestDrawCard = drawCard;
        bestDiscard = discardOption;
      }
      if (score === bestScore) {
        const discardSum = discardOption.reduce((sum, card) => sum + card.value, 0);
        const bestDiscardSum = bestDiscard.reduce((sum, card) => sum + card.value, 0);
        if (discardSum < bestDiscardSum) {
          bestScore = score;
          bestDrawCard = drawCard;
          bestDiscard = discardOption;
        }
      }
    }

    return { draw: bestDrawCard, discard: bestDiscard, points: bestScore };
  }

  _getBestDiscardOptions(discardOptions) {
    const bestDiscardOptions = [];
    let bestPoints = 0;

    for (const option of discardOptions) {
      const discardPoints = option.reduce((sum, card) => sum + card.value, 0);
      if (discardPoints > bestPoints) {
        bestPoints = discardPoints;
        bestDiscardOptions.length = 0;
        bestDiscardOptions.push(option);
      } else if (discardPoints === bestPoints && bestDiscardOptions.length > 0) {
        if (option.length < bestDiscardOptions[0].length) {
          bestDiscardOptions.length = 0;
          bestDiscardOptions.push(option);
        } else if (option.length === bestDiscardOptions[0].length) {
          bestDiscardOptions.push(option);
        }
      }
    }

    return bestDiscardOptions;
  }

  _calculateNewTotalPoints(potentialHand, discardOption) {
    return potentialHand
      .filter((card) => !containsCard(discardOption, card))
      .reduce((sum, card) => sum + card.value, 0);
  }

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

    const scorePressure = clamp(this.score / 100, 0, 1);
    riskThreshold *= (1 - 0.35 * scorePressure);
    riskThreshold = Math.max(0.03, riskThreshold);

    // Reduce threshold (less willing to call) if it would give an opponent a reset.
    // Giving someone a -50 reset is very costly and worth avoiding.
    const resetPenalty = this._evaluateYanivResetImpact();
    riskThreshold -= resetPenalty * 0.04;
    riskThreshold = Math.max(0.03, riskThreshold);

    return assafRisk <= riskThreshold;
  }

  _evaluateYanivResetImpact() {
    // Returns a penalty for calling Yaniv if it would give opponents a beneficial reset
    let penalty = 0;
    for (const playerInfo of Object.values(this.otherPlayers)) {
      const opponentScore = playerInfo.currentScore;
      const estimatedHand = playerInfo.estimatedScore ?? 50;
      const newScore = opponentScore + estimatedHand;

      // Would they land on a reset threshold?
      if ((newScore === 50 || newScore === 100) && opponentScore < newScore) {
        penalty += 2.5;
      }
      // Close to a reset threshold (might land on it with actual hand)
      else if (Math.abs(newScore - 50) <= 3 && opponentScore < 50) {
        penalty += 0.8;
      } else if (Math.abs(newScore - 100) <= 3 && opponentScore < 100) {
        penalty += 0.8;
      }
    }
    return Math.min(4.0, penalty);
  }

  _estimateAssafProbability(playerInfo, ownHandValue, meanValue, varValue) {
    const knownSum = playerInfo.knownCards.reduce((sum, card) => sum + card.value, 0);
    const unknownCount = Math.max(0, playerInfo.handCount - playerInfo.knownCards.length);

    if (unknownCount === 0) {
      return knownSum <= ownHandValue ? 1 : 0;
    }

    const expected = knownSum + unknownCount * meanValue;
    const variance = Math.max(0.01, unknownCount * varValue);
    const stddev = Math.sqrt(variance);
    const z = ((ownHandValue + 0.5) - expected) / stddev;
    const cdf = 0.5 * (1 + erf(z / Math.sqrt(2)));
    return clamp(cdf, 0.01, 0.99);
  }

  estimateHandValues() {
    for (const playerInfo of Object.values(this.otherPlayers)) {
      const unknownCardsCount = playerInfo.handCount - playerInfo.knownCards.length;
      const estimatedUnknownCardScore = this.estimateUnknownCards(unknownCardsCount);
      playerInfo.estimatedScore = playerInfo.knownCards.reduce((sum, card) => sum + card.value, 0)
        + estimatedUnknownCardScore;
    }
  }

  estimateUnknownCards(numUnknownCards) {
    if (numUnknownCards <= 0) {
      return 0;
    }

    const unseenCards = this._getUnseenCards();
    const [meanValue] = this._meanAndVariance(unseenCards);
    return numUnknownCards * meanValue;
  }

  _getUnseenCards() {
    const visibleIds = new Set(this.hand.map((card) => card.id));
    for (const card of this.drawOptions) {
      visibleIds.add(card.id);
    }
    for (const card of this.publicDiscardPile) {
      visibleIds.add(card.id);
    }
    for (const playerInfo of Object.values(this.otherPlayers)) {
      for (const card of playerInfo.knownCards) {
        visibleIds.add(card.id);
      }
    }

    return AIPlayer._FULL_DECK.filter((card) => !visibleIds.has(card.id));
  }

  _knownCardIndexes() {
    const knownRanks = new Set();
    const knownSuitRanks = new Map();

    for (const playerInfo of Object.values(this.otherPlayers)) {
      for (const card of playerInfo.knownCards) {
        if (card.rank === 'Joker') {
          continue;
        }
        knownRanks.add(card.rank);
        if (!knownSuitRanks.has(card.suit)) {
          knownSuitRanks.set(card.suit, new Set());
        }
        knownSuitRanks.get(card.suit).add(card.rankIndex());
      }
    }

    return [knownRanks, knownSuitRanks];
  }

  _meanAndVariance(cards) {
    if (cards.length === 0) {
      return [5.0, 8.0];
    }

    const values = cards.map((card) => card.value);
    const meanValue = values.reduce((sum, value) => sum + value, 0) / values.length;
    const variance = values.reduce((sum, value) => sum + ((value - meanValue) ** 2), 0) / values.length;
    return [meanValue, variance];
  }

  _stateSeed() {
    let seed = 2166136261;

    const handCounts = Object.entries(this.otherPlayers)
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([, playerInfo]) => playerInfo.handCount);

    const values = [
      this.score,
      ...this.hand.map((card) => card.id).sort((a, b) => a - b),
      ...this.drawOptions.map((card) => card.id).sort((a, b) => a - b),
      this.publicDiscardPile.length,
      ...handCounts,
    ];

    for (const rawValue of values) {
      const value = Number.parseInt(rawValue, 10);
      seed ^= (value + 0x9e3779b9);
      seed = Math.imul(seed, 16777619) >>> 0;
    }

    return seed >>> 0;
  }

  _deckRolloutContext(unseenCards) {
    if (unseenCards.length === 0) {
      return [[], 8.0];
    }

    const sampleCount = Math.min(this.rolloutSamples, unseenCards.length);
    let sampledCards;
    if (sampleCount < unseenCards.length) {
      const rng = mulberry32(this._stateSeed());
      sampledCards = sampleWithoutReplacement(unseenCards, sampleCount, rng);
    } else {
      sampledCards = unseenCards;
    }

    const [, variance] = this._meanAndVariance(unseenCards);
    return [sampledCards, variance];
  }

  _evaluateDeckDrawSamples(postDiscardHand, sampledCards, pruneToBestDiscard = true) {
    if (sampledCards.length === 0) {
      const baselineResidual = this._bestResidualPoints(postDiscardHand);
      const immediate = postDiscardHand.reduce((sum, card) => sum + card.value, 0) + 5.0;
      return [baselineResidual, immediate];
    }

    const postTurnWithoutDraw = postDiscardHand.reduce((sum, card) => sum + card.value, 0);
    let futureTotal = 0;
    let immediateTotal = 0;

    for (const drawCard of sampledCards) {
      const [futureScore] = this._simulateAction(postDiscardHand, drawCard, pruneToBestDiscard);
      futureTotal += futureScore;
      immediateTotal += postTurnWithoutDraw + drawCard.value;
    }

    const sampleSize = sampledCards.length;
    return [futureTotal / sampleSize, immediateTotal / sampleSize];
  }

  _bestResidualPoints(hand) {
    const signature = this._handSignature(hand);
    const cached = this._cacheGet(this._bestResidualCache, signature);
    if (cached !== null) {
      return cached;
    }

    const total = hand.reduce((sum, card) => sum + card.value, 0);
    const discardOptions = this._getDiscardOptionsCached(hand);
    let bestResidual = total;

    for (const option of discardOptions) {
      const optionSum = option.reduce((sum, card) => sum + card.value, 0);
      const residual = total - optionSum;
      if (residual < bestResidual) {
        bestResidual = residual;
      }
    }

    this._cacheSet(this._bestResidualCache, signature, bestResidual);
    return bestResidual;
  }

  _handCompositionBonus(hand) {
    // Returns a bonus for hands with good set/run potential.
    // Higher bonus = better hand composition = prefer keeping these cards together.
    let bonus = 0;
    const nonJokers = hand.filter((c) => c.rank !== 'Joker');
    const jokerCount = hand.length - nonJokers.length;

    // Pairs/trips have strong set-discard potential
    const rankCounts = {};
    for (const card of nonJokers) {
      rankCounts[card.rank] = (rankCounts[card.rank] || 0) + 1;
    }
    for (const [rank, count] of Object.entries(rankCounts)) {
      if (count >= 2) {
        const cardValue = nonJokers.find((c) => c.rank === rank).value;
        bonus += 1.2 + 0.08 * cardValue * count;
      }
    }

    // Consecutive same-suit cards have run potential
    const suitCards = {};
    for (const card of nonJokers) {
      if (!suitCards[card.suit]) suitCards[card.suit] = [];
      suitCards[card.suit].push(card);
    }
    for (const cards of Object.values(suitCards)) {
      if (cards.length < 2) continue;
      cards.sort((a, b) => a.rankIndex() - b.rankIndex());
      for (let i = 0; i < cards.length - 1; i += 1) {
        const gap = cards[i + 1].rankIndex() - cards[i].rankIndex();
        if (gap === 1) {
          // Directly consecutive: strong run potential
          bonus += 1.5 + 0.06 * (cards[i].value + cards[i + 1].value);
        } else if (gap === 2 && jokerCount > 0) {
          // One-gap bridgeable by joker
          bonus += 0.8;
        }
      }
    }

    return Math.min(6.0, bonus);
  }

  _opponentThreatScore() {
    let threat = 0;
    for (const playerInfo of Object.values(this.otherPlayers)) {
      const estimated = playerInfo.estimatedScore ?? 50;
      const handCount = playerInfo.handCount ?? 5;

      let playerThreat = Math.max(0, (8 - estimated) / 8);
      if (handCount <= 2) {
        playerThreat += 0.30;
      }
      if (handCount <= 1) {
        playerThreat += 0.25;
      }

      threat = Math.max(threat, playerThreat);
    }

    return Math.min(1.5, threat);
  }

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

      // Enhanced: penalize based on opponent collection patterns
      for (const playerInfo of Object.values(this.otherPlayers)) {
        // Penalty if opponent has been picking up this rank (building a set)
        const collectedCount = playerInfo.collectedRanks[card.rank] || 0;
        if (collectedCount > 0) {
          penalty += 2.0 * collectedCount;
        }

        // Penalty if card is adjacent to opponent's suit-run collection
        const opponentSuitRanks = playerInfo.collectedSuitRanks[card.suit];
        if (opponentSuitRanks) {
          if (opponentSuitRanks.has(cardRank) || opponentSuitRanks.has(cardRank - 1) || opponentSuitRanks.has(cardRank + 1)) {
            penalty += 1.5;
          }
          // Extra penalty if this card would bridge two collected cards (completes a run)
          if (opponentSuitRanks.has(cardRank - 1) && opponentSuitRanks.has(cardRank + 1)) {
            penalty += 2.5;
          }
        }

        // Safety bonus if opponent recently discarded this rank (they don't want it)
        if (playerInfo.discardHistory.some((d) => d.rank === card.rank)) {
          penalty -= 0.6;
        }
      }
    }

    return penalty;
  }
}

module.exports = { AIPlayer };
