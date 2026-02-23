(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.YanivGameLogic = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const ORDER = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];

  function sortHand(hand) {
    return [...hand].sort((a, b) => a.id - b.id);
  }

  function suitSymbol(suit) {
    return { Clubs: '♣', Diamonds: '♦', Hearts: '♥', Spades: '♠' }[suit] || '';
  }

  function cardColor(card) {
    return (card.suit === 'Hearts' || card.suit === 'Diamonds') ? 'red' : '';
  }

  function isValidRun(cards) {
    const nonJokers = cards.filter(c => c.rank !== 'Joker');
    const jokerCount = cards.length - nonJokers.length;
    if (nonJokers.length > 0 && new Set(nonJokers.map(c => c.suit)).size > 1) return false;
    const ranks = nonJokers.map(c => ORDER.indexOf(c.rank)).sort((a, b) => a - b);
    let needed = 0;
    for (let i = 0; i < ranks.length - 1; i++) needed += ranks[i + 1] - ranks[i] - 1;
    return needed <= jokerCount;
  }

  function validateDiscard(cards) {
    if (cards.length === 0) return { valid: false };
    if (cards.length === 1) return { valid: true };

    const nonJokers = cards.filter(c => c.rank !== 'Joker');
    if (nonJokers.length === 0 || new Set(nonJokers.map(c => c.rank)).size === 1) {
      return { valid: true };
    }

    if (cards.length >= 3 && isValidRun(cards)) return { valid: true };

    if (cards.length === 2) {
      return { valid: false, reason: 'Two cards must share the same rank' };
    }
    return { valid: false, reason: 'Cards must form a set (same rank) or a run (3+ same suit, consecutive)' };
  }

  return {
    cardColor,
    isValidRun,
    sortHand,
    suitSymbol,
    validateDiscard,
  };
});
