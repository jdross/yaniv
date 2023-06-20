from card import Card

class Player:
    def __init__(self, name):
        self.name = name
        self.hand = []
        self.score = 0
    
    def to_dict(self):
        return {'name': self.name, 'score': self.score, 'hand': [card.to_dict() for card in self.hand]}

    @classmethod
    def from_dict(cls, data):
        player = cls(data['name'])
        player.hand = [Card.from_dict(card_data) for card_data in data['hand']]
        player.score = data['score']
        return player
