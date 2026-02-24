import unittest, sys, os
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
PYTHON_SERVER_ROOT = os.path.join(ROOT, "python-server")
if PYTHON_SERVER_ROOT not in sys.path:
    sys.path.insert(0, PYTHON_SERVER_ROOT)

from card import Card

class TestCardSorting(unittest.TestCase):

    def test_card_creation(self):
        cards = [Card(0), Card(2), Card(10), Card(53), Card(30), Card(1)]
        self.assertEqual(cards[0].rank, 'Joker')
        self.assertEqual(cards[0].suit, 'Hearts')
        self.assertEqual(str(cards[0]), 'Joker')
        self.assertEqual(cards[0].value, 0)
        self.assertEqual(cards[5].value, 0)

        self.assertEqual(cards[1].rank, 'A')
        self.assertEqual(cards[1].suit, 'Clubs')
        self.assertEqual(str(cards[1]), 'A of Clubs')
        self.assertEqual(cards[1].value, 1)

    def test_card_sorting_by_card_index(self):
        cards = [Card(10), Card(2), Card(53), Card(30), Card(1)]
        cards.sort()
        self.assertEqual([card._card for card in cards], [1, 2, 10, 30, 53])

    def test_card_sorting_by_rank_suit(self):
        # Creating an unordered list of cards with rank and suit
        cards = [Card('Joker', 'Spades'),
            Card('Joker', 'Hearts'),
            Card('A', 'Diamonds'),
            Card('A', 'Spades'),
            Card('2', 'Spades'),
            Card('10', 'Clubs'),
            Card('Q', 'Clubs'),
            Card('Q', 'Hearts'),
            Card('K', 'Spades'),
        ]

        # Sorting the cards
        cards.sort()

        # Check if cards are sorted correctly by comparing their _card values
        self.assertEqual([card for card in cards],
            [Card('Joker', 'Hearts'),
            Card('Joker', 'Spades'),
            Card('A', 'Diamonds'),
            Card('A', 'Spades'),
            Card('2', 'Spades'),
            Card('10', 'Clubs'),
            Card('Q', 'Clubs'),
            Card('Q', 'Hearts'),
            Card('K', 'Spades'),])
        self.assertEqual(cards[0]._card, 0)
        self.assertEqual(cards[0].value, 0)
        self.assertEqual(cards[1]._card, 1)
        self.assertEqual(cards[1].value, 0)
        self.assertEqual(cards[6].value, 10)

if __name__ == '__main__':
    unittest.main()
