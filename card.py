class Card:
    ranks = ['Joker', 'A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K']
    suits = [None, 'Spades', 'Hearts', 'Diamonds', 'Clubs']

    def __init__(self, rank, suit=None):
        if isinstance(rank, int) and suit is None:
            self._card = rank
            self.rank = Card.ranks[self.rank_index()]
            self.suit = Card.suits[self.suit_index()]
        elif isinstance(rank, str) and isinstance(suit, str):
            if rank == 'Joker':
                self._card = 0 if suit == 'Spades' else 1
            else:
                rank_index = self.ranks.index(rank)
                suit_index = self.suits.index(suit)
                self._card = (suit_index - 1) * 13 + rank_index
            self.rank = rank
            self.suit = suit
        self.value = min(self.rank_index(), 10)

    def rank_index(self):
        if self._card < 2:  # If it's a Joker
            return 0
        return (self._card - 2) % 13 + 1

    def suit_index(self):
        if self._card < 2:  # If it's a Joker
            return 0
        return (self._card - 2) // 13 + 1

    def __lt__(self, other):
        return self._card < other._card

    def __eq__(self, other):
        return isinstance(other, Card) and self._card == other._card

    def __str__(self):
        if self._card < 2:  # If it's a Joker
            return self.rank
        return f'{self.rank} of {self.suit}'
    
    def __repr__(self):
        return f"Card('{self.rank}', '{self.suit}')"

    def serialize(self):
        return self._card

    @staticmethod
    def deserialize(card):
        return Card(card)
    
    @staticmethod
    def create_deck():
        deck = []
        for i in range(54):
            deck.append(Card(i))
        return deck


class CardOld:
    RANKS = {
        'A': 1,
        '2': 2,
        '3': 3,
        '4': 4,
        '5': 5,
        '6': 6,
        '7': 7,
        '8': 8,
        '9': 9,
        '10': 10,
        'J': 11,
        'Q': 12,
        'K': 13,
        'Joker': 0,
    }
    SUITS = ['Hearts', 'Diamonds', 'Clubs', 'Spades']

    def __init__(self, rank, suit):
        self.rank = rank
        self.suit = suit
        self.value = min(Card.RANKS[rank],10)
    
    def __str__(self):
        if self.rank == 'Joker':
            return 'Joker'
        return f"{self.rank} of {self.suit}"
    
    def __repr__(self):
        return f"Card('{self.rank}', '{self.suit}')"
    
    def __eq__(self, other):
        if isinstance(other, Card):
            if self.rank == 'Joker' and other.rank == 'Joker':
                return True
            return self.rank == other.rank and self.suit == other.suit
        return False
    
    def __lt__(self, other):
        return Card.RANKS[self.rank] < Card.RANKS[other.rank]
    
    def to_dict(self):
        return {self.rank, self.suit}
    
    @classmethod
    def from_dict(cls, data):
        return cls(data[0], data[1])
    
    @staticmethod
    def create_deck():
        deck = []
        ranks = list(Card.RANKS.keys())[:-1]  # Exclude the Joker
        for suit in Card.SUITS:
            for rank in ranks:
                deck.append(Card(rank, suit))
        # Add jokers
        deck.append(Card('Joker', 'j1'))
        deck.append(Card('Joker', 'j2'))
        return deck