const { Card } = require('../card');

const NUM_CARDS = 54;
const MAX_OPPONENTS = 2;
const STATE_SIZE = NUM_CARDS * 4 + 1 + MAX_OPPONENTS * 3 + 2;

const SINGLE_CARD_OFFSET = 0;
const SET_BY_RANK_OFFSET = NUM_CARDS;
const RUN_BY_SUIT_OFFSET = SET_BY_RANK_OFFSET + 13;
const DISCARD_VOCAB_SIZE = RUN_BY_SUIT_OFFSET + 4;

const DRAW_DECK = 0;
const DRAW_OPTION_0 = 1;
const DRAW_OPTION_1 = 2;
const DRAW_OPTIONS_COUNT = 3;

const ACTION_SPACE_SIZE = DISCARD_VOCAB_SIZE * DRAW_OPTIONS_COUNT + 1;
const YANIV_ACTION_INDEX = ACTION_SPACE_SIZE - 1;

function encodeState(player, drawOptions) {
  const state = new Float32Array(STATE_SIZE);
  let offset = 0;

  for (const card of player.hand) {
    state[offset + card.id] = 1;
  }
  offset += NUM_CARDS;

  for (const card of drawOptions) {
    state[offset + card.id] = 1;
  }
  offset += NUM_CARDS;

  for (const playerInfo of Object.values(player.other_players)) {
    for (const card of playerInfo.known_cards) {
      state[offset + card.id] = 1;
    }
  }
  offset += NUM_CARDS;

  for (const card of player.public_discard_pile) {
    state[offset + card.id] = 1;
  }
  offset += NUM_CARDS;

  state[offset] = player.score / 100;
  offset += 1;

  const opponents = Object.values(player.other_players);
  for (let i = 0; i < MAX_OPPONENTS; i += 1) {
    if (i < opponents.length) {
      state[offset + i] = opponents[i].current_score / 100;
      state[offset + MAX_OPPONENTS + i] = opponents[i].hand_count / 10;
      state[offset + MAX_OPPONENTS * 2 + i] = (opponents[i].estimated_score ?? 50) / 50;
    }
  }
  offset += MAX_OPPONENTS * 3;

  state[offset] = player.hand.length / 10;
  offset += 1;

  state[offset] = drawOptions.length / 3;

  return state;
}

function discardToActionIndex(discardOption, drawChoice) {
  let discardIndex;

  if (discardOption.length === 1) {
    discardIndex = SINGLE_CARD_OFFSET + discardOption[0].id;
  } else {
    const nonJokers = discardOption.filter((c) => c.rank !== 'Joker');
    if (nonJokers.length > 0 && nonJokers.every((c) => c.rank === nonJokers[0].rank)) {
      const rankIdx = Card.ranks.indexOf(nonJokers[0].rank) - 1;
      discardIndex = SET_BY_RANK_OFFSET + rankIdx;
    } else {
      const suit = nonJokers.length > 0 ? nonJokers[0].suit : discardOption[0].suit;
      const suitIdx = Card.suits.indexOf(suit);
      discardIndex = RUN_BY_SUIT_OFFSET + suitIdx;
    }
  }

  let drawIndex;
  if (drawChoice === 'deck') {
    drawIndex = DRAW_DECK;
  } else {
    drawIndex = drawChoice + 1;
  }

  return discardIndex * DRAW_OPTIONS_COUNT + drawIndex;
}

function decodeAction(actionIndex, hand, drawOptions, discardOptions) {
  if (actionIndex === YANIV_ACTION_INDEX) {
    return { declareYaniv: true };
  }

  const drawIndex = actionIndex % DRAW_OPTIONS_COUNT;
  const discardIndex = (actionIndex - drawIndex) / DRAW_OPTIONS_COUNT;
  const drawChoice = drawIndex === DRAW_DECK ? 'deck' : drawIndex - 1;

  if (typeof drawChoice === 'number' && drawChoice >= drawOptions.length) {
    return null;
  }

  let bestMatch = null;

  if (discardIndex < SINGLE_CARD_OFFSET + NUM_CARDS) {
    const cardId = discardIndex - SINGLE_CARD_OFFSET;
    bestMatch = discardOptions.find(
      (opt) => opt.length === 1 && opt[0].id === cardId,
    );
  } else if (discardIndex < SET_BY_RANK_OFFSET + 13) {
    const rankIdx = discardIndex - SET_BY_RANK_OFFSET;
    const targetRank = Card.ranks[rankIdx + 1];
    bestMatch = discardOptions.find((opt) => {
      if (opt.length < 2) return false;
      const nonJokers = opt.filter((c) => c.rank !== 'Joker');
      return nonJokers.length > 0 && nonJokers.every((c) => c.rank === targetRank);
    });
  } else if (discardIndex < RUN_BY_SUIT_OFFSET + 4) {
    const suitIdx = discardIndex - RUN_BY_SUIT_OFFSET;
    const targetSuit = Card.suits[suitIdx];
    bestMatch = discardOptions.find((opt) => {
      if (opt.length < 3) return false;
      const nonJokers = opt.filter((c) => c.rank !== 'Joker');
      return nonJokers.length > 0 && nonJokers.every((c) => c.suit === targetSuit);
    });
  }

  if (!bestMatch) return null;
  return { discard: bestMatch, draw: drawChoice };
}

function legalActionMask(hand, drawOptions, discardOptions, canDeclareYaniv) {
  const mask = new Float32Array(ACTION_SPACE_SIZE);
  const drawCount = Math.min(drawOptions.length, 2);

  for (const option of discardOptions) {
    const nonJokers = option.filter((c) => c.rank !== 'Joker');

    if (option.length === 1) {
      const idx = SINGLE_CARD_OFFSET + option[0].id;
      mask[idx * DRAW_OPTIONS_COUNT + DRAW_DECK] = 1;
      for (let d = 0; d < drawCount; d += 1) {
        if (!option.some((c) => c.id === drawOptions[d].id)) {
          mask[idx * DRAW_OPTIONS_COUNT + d + 1] = 1;
        }
      }
    }

    if (option.length >= 2 && nonJokers.length > 0 && nonJokers.every((c) => c.rank === nonJokers[0].rank)) {
      const rankIdx = Card.ranks.indexOf(nonJokers[0].rank) - 1;
      const idx = SET_BY_RANK_OFFSET + rankIdx;
      mask[idx * DRAW_OPTIONS_COUNT + DRAW_DECK] = 1;
      for (let d = 0; d < drawCount; d += 1) {
        if (!option.some((c) => c.id === drawOptions[d].id)) {
          mask[idx * DRAW_OPTIONS_COUNT + d + 1] = 1;
        }
      }
    }

    if (option.length >= 3) {
      const isSameSuit = nonJokers.length > 0 && nonJokers.every((c) => c.suit === nonJokers[0].suit);
      const isNotSet = nonJokers.length < 2 || !nonJokers.every((c) => c.rank === nonJokers[0].rank);
      if (isSameSuit && isNotSet) {
        const suitIdx = Card.suits.indexOf(nonJokers[0].suit);
        const idx = RUN_BY_SUIT_OFFSET + suitIdx;
        mask[idx * DRAW_OPTIONS_COUNT + DRAW_DECK] = 1;
        for (let d = 0; d < drawCount; d += 1) {
          if (!option.some((c) => c.id === drawOptions[d].id)) {
            mask[idx * DRAW_OPTIONS_COUNT + d + 1] = 1;
          }
        }
      }
    }
  }

  if (canDeclareYaniv) {
    mask[YANIV_ACTION_INDEX] = 1;
  }

  return mask;
}

module.exports = {
  STATE_SIZE,
  ACTION_SPACE_SIZE,
  YANIV_ACTION_INDEX,
  DISCARD_VOCAB_SIZE,
  DRAW_OPTIONS_COUNT,
  encodeState,
  discardToActionIndex,
  decodeAction,
  legalActionMask,
};
