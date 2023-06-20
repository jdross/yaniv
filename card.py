class Card:
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
        return {'rank': self.rank, 'suit': self.suit, 'value': self.value}
    
    @classmethod
    def from_dict(cls, data):
        return cls(data['rank'], data['suit'])
    
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