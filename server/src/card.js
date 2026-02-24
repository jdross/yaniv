class Card {
  static ranks = ['Joker', 'A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
  static suits = ['Clubs', 'Diamonds', 'Hearts', 'Spades'];

  constructor(rank, suit) {
    if (typeof rank === 'number' && (suit === undefined || suit === null)) {
      this._card = rank;
      this.rank = Card.ranks[this.rank_index()];
      this.suit = Card.suits[this.suit_index()];
    } else if (typeof rank === 'string' && typeof suit === 'string') {
      const rankIndex = Card.ranks.indexOf(rank);
      const suitIndex = Card.suits.indexOf(suit);
      if (rankIndex === -1 || suitIndex === -1) {
        throw new Error('Invalid rank or suit');
      }
      if (rank === 'Joker') {
        this._card = suitIndex - 2;
      } else {
        this._card = (rankIndex - 1) * 4 + suitIndex + 2;
      }
      this.rank = rank;
      this.suit = suit;
    } else {
      throw new Error('Invalid card input');
    }

    this.value = Math.min(this.rank_index(), 10);
  }

  rank_index() {
    if (this._card < 2) {
      return 0;
    }
    return Math.floor((this._card - 2) / 4) + 1;
  }

  suit_index() {
    if (this._card < 2) {
      return this._card + 2;
    }
    return (this._card - 2) % 4;
  }

  equals(other) {
    return other instanceof Card && this._card === other._card;
  }

  toString() {
    if (this._card < 2) {
      return this.rank;
    }
    return `${this.rank} of ${this.suit}`;
  }

  serialize() {
    return this._card;
  }

  static deserialize(card) {
    return new Card(card);
  }

  static createDeck() {
    const deck = [];
    for (let i = 0; i < 54; i += 1) {
      deck.push(new Card(i));
    }
    return deck;
  }
}

module.exports = { Card };
