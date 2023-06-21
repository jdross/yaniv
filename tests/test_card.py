import unittest, sys, os
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from card import Card

class TestCardSorting(unittest.TestCase):

    def test_card_sorting_by_card_value(self):
        cards = [Card(10), Card(2), Card(53), Card(30), Card(1)]
        cards.sort()
        self.assertEqual([card._card for card in cards], [1, 2, 10, 30, 53])

    def test_card_sorting_by_rank_suit(self):
        # Creating an unordered list of cards with rank and suit
        cards = [
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
            Card('A', 'Diamonds'),
            Card('A', 'Spades'),
            Card('2', 'Spades'),
            Card('10', 'Clubs'),
            Card('Q', 'Clubs'),
            Card('Q', 'Hearts'),
            Card('K', 'Spades'),])

if __name__ == '__main__':
    unittest.main()