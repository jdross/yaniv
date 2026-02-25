const crypto = require('node:crypto');

const { AIPlayer } = require('./aiplayer');
const { Player } = require('./player');
const { Card } = require('./card');

function randomUuid() {
  if (typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function defaultRandom() {
  return Math.random();
}

function shuffleInPlace(values, randomFn = defaultRandom) {
  for (let i = values.length - 1; i > 0; i -= 1) {
    const j = Math.floor(randomFn() * (i + 1));
    [values[i], values[j]] = [values[j], values[i]];
  }
}

function containsCard(cards, target) {
  return cards.some((card) => card.id === target.id);
}

class YanivGame {
  constructor(players = null, rng = null) {
    this.gameId = randomUuid();
    this._rng = rng;
    this.deck = [];
    this.discardPile = [];
    this.lastDiscard = [];
    this.slamdownPlayer = null;
    this.slamdownCard = null;
    this.previousScores = [];
    this.currentPlayerIndex = 0;

    if (players) {
      this._createPlayers(players);
    } else {
      this.players = [];
    }
  }

  _rand() {
    if (this._rng && typeof this._rng.random === 'function') {
      return this._rng.random();
    }
    return Math.random();
  }

  _randint(min, maxInclusive) {
    if (this._rng && typeof this._rng.randint === 'function') {
      return this._rng.randint(min, maxInclusive);
    }
    return min + Math.floor(this._rand() * (maxInclusive - min + 1));
  }

  toDict() {
    return {
      gameId: this.gameId,
      discardPile: this.discardPile.map((card) => card.serialize()),
      players: this.players.map((player) => ({
        name: player.name,
        score: player.score,
        hand: player.hand.map((card) => card.serialize()),
        isAi: player instanceof AIPlayer,
      })),
      currentPlayerIndex: this.currentPlayerIndex,
      previousScores: [...this.previousScores],
      lastDiscardSize: this.lastDiscard.length,
      slamdownPlayer: this.slamdownPlayer,
      slamdownCard: this.slamdownCard ? this.slamdownCard.id : null,
    };
  }

  static fromDict(data) {
    const game = new YanivGame();

    game.gameId = data.gameId || randomUuid();

    const players = [];
    for (const playerData of data.players || []) {
      const isAi = Boolean(playerData.isAi || false);
      const player = isAi ? new AIPlayer(playerData.name) : new Player(playerData.name);
      player.score = playerData.score || 0;
      player.hand = (playerData.hand || []).map((cardData) => Card.deserialize(cardData));
      players.push(player);
    }

    game._createPlayers(players);
    game.currentPlayerIndex = data.currentPlayerIndex || 0;
    game.previousScores = data.previousScores || game.players.map((player) => player.score);
    game.discardPile = (data.discardPile || []).map((cardData) => Card.deserialize(cardData));

    const lastDiscardSize = data.lastDiscardSize || 0;
    game.lastDiscard = game.discardPile.slice(-lastDiscardSize);

    game._createDeck();
    const usedIds = new Set(game.discardPile.map((card) => card.id));
    for (const player of game.players) {
      for (const card of player.hand) {
        usedIds.add(card.id);
      }
    }
    game.deck = game.deck.filter((card) => !usedIds.has(card.id));
    game._shuffleDeck();

    game.slamdownPlayer = data.slamdownPlayer;
    const sdc = data.slamdownCard;
    game.slamdownCard = sdc !== null && sdc !== undefined ? new Card(sdc) : null;

    const roundInfo = game.players.map((player) => ({ name: player.name, score: player.score }));
    for (const player of game.players) {
      if (player instanceof AIPlayer) {
        player.observeRound(roundInfo);
      }
    }

    return game;
  }

  startGame() {
    if (!this.players || this.players.length === 0) {
      throw new Error('No players have been added to the game.');
    }

    this._dealNewHand();

    const roundInfo = this.players.map((player) => ({ name: player.name, score: player.score }));
    for (const player of this.players) {
      if (player instanceof AIPlayer) {
        player.observeRound(roundInfo);
      }
    }
  }

  startTurn() {
    const currentPlayer = this.getCurrentPlayer();
    currentPlayer.hand.sort((a, b) => a.id - b.id);
    const drawOptions = this._getDrawOptions();
    return [currentPlayer, drawOptions];
  }

  playTurn(player, action = null) {
    if (player instanceof AIPlayer) {
      action = player.decideAction();
    }

    if (!Array.isArray(action.discard)) {
      throw new Error("Invalid 'discard' action. Must be a list of cards.");
    }

    const handBeforeRefs = new Set(player.hand);
    let drawnCardObj;

    if (action.draw === 'deck') {
      drawnCardObj = this._drawCard(player);
    } else if (Number.isInteger(action.draw) && action.draw >= 0) {
      const drawOptions = this._getDrawOptions();
      if (action.draw < drawOptions.length) {
        drawnCardObj = this._drawCard(player, true, action.draw);
      } else {
        throw new Error("Invalid 'draw' action. Index out of range of draw options.");
      }
    } else {
      throw new Error("Invalid 'draw' action. Must be 'deck' or a valid index of a card in discard pile.");
    }

    const newlyDrawn = player.hand.find((card) => !handBeforeRefs.has(card)) || null;
    const drawnCard = action.draw !== 'deck' ? drawnCardObj : null;
    this._discardCards(player, action.discard);

    const drewFromDeck = action.draw === 'deck';
    this._checkSlamdown(player, action.discard, newlyDrawn, drewFromDeck);

    for (const otherPlayer of this.players) {
      if (otherPlayer instanceof AIPlayer && otherPlayer !== player) {
        const turnInfo = {
          player,
          action,
          handCount: player.hand.length,
          discardedCards: action.discard,
          drawnCard,
        };
        otherPlayer.observeTurn(turnInfo, this.discardPile, this._getDrawOptions());
      }
    }

    this._nextTurn();
    return action;
  }

  canDeclareYaniv(player) {
    return player.hand.reduce((sum, card) => sum + card.value, 0) <= 5;
  }

  declareYaniv(player) {
    if (player.hand.reduce((sum, card) => sum + card.value, 0) > 5) {
      throw new Error('Cannot declare Yaniv with more than 5 points.');
    }

    this.slamdownPlayer = null;
    this.slamdownCard = null;

    this.previousScores = this.players.map((p) => p.score);

    const updateInfo = this._updateScores(player);
    const eliminatedPlayers = this.players.filter((p) => p.score > 100);
    this.players = this.players.filter((p) => p.score <= 100);

    if (this.players.length > 0) {
      this.currentPlayerIndex = this.currentPlayerIndex % this.players.length;
    }

    const winner = this._checkEndOfGame();

    this._dealNewHand();
    const roundInfo = this.players.map((p) => ({ name: p.name, score: p.score }));
    for (const remainingPlayer of this.players) {
      if (remainingPlayer instanceof AIPlayer) {
        remainingPlayer.observeRound(roundInfo);
      }
    }

    return [updateInfo, eliminatedPlayers, winner];
  }

  _createPlayers(players) {
    this.players = players;
    this.previousScores = players.map(() => 0);
    this.currentPlayerIndex = players.length > 0 ? this._randint(0, players.length - 1) : 0;
  }

  _createDeck() {
    this.deck = Card.createDeck();
  }

  _shuffleDeck() {
    if (this._rng && typeof this._rng.shuffle === 'function') {
      this._rng.shuffle(this.deck);
      return;
    }
    shuffleInPlace(this.deck, this._rand.bind(this));
  }

  _dealCards() {
    for (const player of this.players) {
      player.hand = [];
      for (let i = 0; i < 5; i += 1) {
        const card = this.deck.pop();
        player.hand.push(card);
      }
    }

    const firstDiscard = this.deck.pop();
    this.discardPile.push(firstDiscard);
    this.lastDiscard.push(firstDiscard);

    for (const player of this.players) {
      if (player instanceof AIPlayer) {
        player.drawOptions.push(firstDiscard);
      }
    }
  }

  _dealNewHand() {
    this.discardPile = [];
    this.lastDiscard = [];
    this._createDeck();
    this._shuffleDeck();
    this._dealCards();
  }

  getCurrentPlayer() {
    return this.players[this.currentPlayerIndex];
  }

  _nextTurn() {
    this.currentPlayerIndex = (this.currentPlayerIndex + 1) % this.players.length;
  }

  _isValidDiscard(cards) {
    if (cards.length === 1) {
      return true;
    }

    const nonJokers = cards.filter((card) => card.rank !== 'Joker');
    if (nonJokers.length === 0 || new Set(nonJokers.map((card) => card.rank)).size === 1) {
      return true;
    }

    if (cards.length >= 3 && this._returnRunIfValid(cards) !== false) {
      return true;
    }

    return false;
  }

  _discardCards(player, cards) {
    const cardsList = Array.isArray(cards) ? cards : [cards];

    if (!this._isValidDiscard(cardsList)) {
      throw new Error(
        'Invalid discard: must be a single card, a set (same rank), or a run (3 or more consecutive cards of the same suit).',
      );
    }

    this.slamdownPlayer = null;
    this.slamdownCard = null;

    this.lastDiscard = [];
    for (const card of cardsList) {
      const idx = player.hand.findIndex((h) => h.id === card.id);
      if (idx === -1) {
        throw new Error('Card not in hand');
      }
      const [removed] = player.hand.splice(idx, 1);
      this.discardPile.push(removed);
      this.lastDiscard.push(removed);
    }
  }

  _checkSlamdown(player, discardedCards, drawnCard, drewFromDeck) {
    this.slamdownPlayer = null;
    this.slamdownCard = null;

    if (player instanceof AIPlayer) {
      return;
    }

    if (!drewFromDeck) {
      return;
    }

    if (drawnCard === null || drawnCard === undefined || player.hand.length <= 1) {
      return;
    }

    const nonJokersDiscarded = discardedCards.filter((card) => card.rank !== 'Joker');

    if (nonJokersDiscarded.length > 0 && drawnCard.rank === nonJokersDiscarded[0].rank) {
      this.slamdownPlayer = player.name;
      this.slamdownCard = drawnCard;
      return;
    }

    const run = this._returnRunIfValid(discardedCards);
    if (run) {
      const nonJokerRun = run.filter((card) => card.rank !== 'Joker');
      if (nonJokerRun.length > 0 && drawnCard.rank !== 'Joker') {
        const runSuit = nonJokerRun[0].suit;
        if (drawnCard.suit === runSuit) {
          const lowRank = Math.min(...nonJokerRun.map((card) => card.rankIndex()));
          const highRank = Math.max(...nonJokerRun.map((card) => card.rankIndex()));
          const drawnRank = drawnCard.rankIndex();
          if (drawnRank === lowRank - 1 || drawnRank === highRank + 1) {
            this.slamdownPlayer = player.name;
            this.slamdownCard = drawnCard;
          }
        }
      }
    }
  }

  performSlamdown(player) {
    if (this.slamdownPlayer !== player.name) {
      throw new Error('No slamdown available for this player.');
    }
    if (!player.hand.some((card) => this.slamdownCard && card.id === this.slamdownCard.id)) {
      throw new Error('Slamdown card not in hand.');
    }
    if (player.hand.length <= 1) {
      throw new Error('Cannot slamdown your last card.');
    }

    const idx = player.hand.findIndex((card) => this.slamdownCard && card.id === this.slamdownCard.id);
    const [card] = player.hand.splice(idx, 1);
    this.discardPile.push(card);
    this.lastDiscard.push(card);

    this.slamdownPlayer = null;
    this.slamdownCard = null;

    return card;
  }

  _returnRunIfValid(cards) {
    if (cards.length < 3) {
      return false;
    }

    const nonJokerCards = cards.filter((card) => card.rank !== 'Joker');
    if (nonJokerCards.length === 0) {
      return false;
    }

    if (new Set(nonJokerCards.map((card) => card.suit)).size > 1) {
      return false;
    }

    const sortedNonJokers = [...nonJokerCards].sort((a, b) => a.rankIndex() - b.rankIndex());
    const ranks = sortedNonJokers.map((card) => card.rankIndex());

    for (let i = 0; i < ranks.length - 1; i += 1) {
      if (ranks[i] === ranks[i + 1]) {
        return false;
      }
    }

    const gaps = [];
    for (let i = 0; i < ranks.length - 1; i += 1) {
      const gap = ranks[i + 1] - ranks[i] - 1;
      if (gap < 0) {
        return false;
      }
      gaps.push(gap);
    }

    const jokerCards = cards.filter((card) => card.rank === 'Joker');
    const jokersNeeded = gaps.reduce((sum, gap) => sum + gap, 0);
    if (jokersNeeded > jokerCards.length) {
      return false;
    }

    let leading = 0;
    while (leading < cards.length && cards[leading].rank === 'Joker') {
      leading += 1;
    }

    let trailing = 0;
    while (trailing < cards.length - leading && cards[cards.length - 1 - trailing].rank === 'Joker') {
      trailing += 1;
    }

    const leadingJokers = cards.slice(0, leading);
    const trailingJokers = trailing ? cards.slice(cards.length - trailing) : [];
    const interiorJokers = cards.slice(leading, cards.length - trailing).filter((card) => card.rank === 'Joker');

    const gapJokers = [];
    let needed = jokersNeeded;

    while (needed > 0 && interiorJokers.length > 0) {
      gapJokers.push(interiorJokers.shift());
      needed -= 1;
    }
    while (needed > 0 && leadingJokers.length > 0) {
      gapJokers.push(leadingJokers.pop());
      needed -= 1;
    }
    while (needed > 0 && trailingJokers.length > 0) {
      gapJokers.push(trailingJokers.shift());
      needed -= 1;
    }
    if (needed > 0) {
      return false;
    }

    const orderedRun = [...leadingJokers, ...interiorJokers];

    let gapIndex = 0;
    for (let i = 0; i < sortedNonJokers.length; i += 1) {
      const nonJoker = sortedNonJokers[i];
      orderedRun.push(nonJoker);
      if (i < gaps.length) {
        for (let j = 0; j < gaps[i]; j += 1) {
          orderedRun.push(gapJokers[gapIndex]);
          gapIndex += 1;
        }
      }
    }

    orderedRun.push(...trailingJokers);
    if (orderedRun.length < 3) {
      return false;
    }

    return orderedRun;
  }

  _getDrawOptions() {
    const topCards = [...this.lastDiscard];
    const run = this._returnRunIfValid(topCards);

    if (run) {
      return [run[0], run[run.length - 1]];
    }

    return topCards;
  }

  _drawCard(player, fromDiscard = false, drawOptionIndex = null) {
    if (this.deck.length === 0) {
      const lastSetOrRun = [...this.lastDiscard];
      this.deck = this.discardPile.filter((card) => !containsCard(lastSetOrRun, card));
      this._shuffleDeck();
      this.discardPile = [...lastSetOrRun];
    }

    let card;
    if (fromDiscard) {
      if (drawOptionIndex === null || drawOptionIndex === undefined) {
        throw new Error('Draw option index is required for discard draws.');
      }
      const drawOptions = [...this._getDrawOptions()];
      if (drawOptionIndex < drawOptions.length) {
        const cardToDraw = drawOptions[drawOptionIndex];
        const cardIndexInPile = this.discardPile.findIndex((c) => c.id === cardToDraw.id);
        if (cardIndexInPile === -1) {
          throw new Error('Invalid discard option index.');
        }
        [card] = this.discardPile.splice(cardIndexInPile, 1);
      } else {
        throw new Error('Invalid discard option index.');
      }
    } else {
      card = this.deck.pop();
    }

    player.hand.push(card);
    return card;
  }

  _updateScores(yanivPlayer) {
    const yanivPoints = yanivPlayer.hand.reduce((sum, card) => sum + card.value, 0);
    const otherPlayers = this.players.filter((player) => player !== yanivPlayer);
    const otherPlayersPoints = otherPlayers.map((player) => player.hand.reduce((sum, card) => sum + card.value, 0));

    const minPoints = Math.min(...otherPlayersPoints);
    const minPointsPlayer = otherPlayers[otherPlayersPoints.indexOf(minPoints)];

    const updateInfo = {};

    if (yanivPoints < minPoints) {
      for (const player of this.players) {
        if (player !== yanivPlayer) {
          player.score += player.hand.reduce((sum, card) => sum + card.value, 0);
        }
      }
    } else {
      yanivPlayer.score += 30;
      updateInfo.assaf = {
        assafedBy: minPointsPlayer,
        assafed: yanivPlayer,
      };
    }

    updateInfo.resetPlayers = this._resetPlayerScores();
    return updateInfo;
  }

  _resetPlayerScores() {
    const resetPlayers = [];

    for (let index = 0; index < this.players.length; index += 1) {
      const player = this.players[index];
      if ((player.score === 50 || player.score === 100) && this.previousScores[index] < player.score) {
        player.score -= 50;
        resetPlayers.push(player);
      }
    }

    return resetPlayers;
  }

  _checkEndOfGame() {
    const playersWith100OrFewer = this.players.filter((player) => player.score <= 100);
    if (playersWith100OrFewer.length === 1) {
      return playersWith100OrFewer[0];
    }
    return null;
  }
}

module.exports = { YanivGame };
