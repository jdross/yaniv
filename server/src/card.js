class Card {
  static ranks = ['Joker', 'A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
  static suits = ['Clubs', 'Diamonds', 'Hearts', 'Spades'];

  constructor(rank, suit) {
    if (typeof rank === 'number' && (suit === undefined || suit === null)) {
      this.id = rank;
      this.rank = Card.ranks[this.rankIndex()];
      this.suit = Card.suits[this.suitIndex()];
    } else if (typeof rank === 'string' && typeof suit === 'string') {
      const rankIndex = Card.ranks.indexOf(rank);
      const suitIndex = Card.suits.indexOf(suit);
      if (rankIndex === -1 || suitIndex === -1) {
        throw new Error('Invalid rank or suit');
      }
      if (rank === 'Joker') {
        this.id = suitIndex - 2;
      } else {
        this.id = (rankIndex - 1) * 4 + suitIndex + 2;
      }
      this.rank = rank;
      this.suit = suit;
    } else {
      throw new Error('Invalid card input');
    }

    this.value = Math.min(this.rankIndex(), 10);
  }

  rankIndex() {
    if (this.id < 2) {
      return 0;
    }
    return Math.floor((this.id - 2) / 4) + 1;
  }

  suitIndex() {
    if (this.id < 2) {
      return this.id + 2;
    }
    return (this.id - 2) % 4;
  }

  equals(other) {
    return other instanceof Card && this.id === other.id;
  }

  toString() {
    if (this.id < 2) {
      return this.rank;
    }
    return `${this.rank} of ${this.suit}`;
  }

  serialize() {
    return this.id;
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
