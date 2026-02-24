class Card:
    ranks = ['Joker', 'A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K']
    suits = ['Clubs', 'Diamonds', 'Hearts', 'Spades']

    def __init__(self, rank, suit=None):
        if isinstance(rank, int) and suit is None:
            self._card = rank
            self.rank = Card.ranks[self.rank_index()]
            self.suit = Card.suits[self.suit_index()]
        elif isinstance(rank, str) and isinstance(suit, str):
            rank_index = self.ranks.index(rank)
            suit_index = self.suits.index(suit)
            if rank == "Joker":
                self._card = suit_index - 2
            else:
                self._card = (rank_index - 1) * 4 + suit_index + 2
            self.rank = rank
            self.suit = suit
        self.value = min(self.rank_index(), 10)

    def rank_index(self):
        if self._card < 2:  # If it's a Joker
            return 0
        return (self._card - 2) // 4 + 1

    def suit_index(self):
        if self._card < 2:  # If it's a Joker
            return self._card + 2
        return (self._card - 2) % 4

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
