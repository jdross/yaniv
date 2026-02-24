import unittest
import sys
import os

sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from yaniv import YanivGame
from player import Player
from aiplayer import AIPlayer
from card import Card


class TestSerialization(unittest.TestCase):
    def test_card_round_trip(self):
        card = Card("Q", "Hearts")
        data = card.serialize()
        rebuilt = Card.deserialize(data)
        self.assertEqual(card, rebuilt)

    def test_game_round_trip_preserves_players_and_state(self):
        players = [Player("Human"), AIPlayer("Bot")]
        game = YanivGame(players)
        game.start_game()

        players[0].score = 12
        players[1].score = 33
        game.slamdown_player = players[0].name
        game.slamdown_card = players[0].hand[0]

        data = game.to_dict()
        rebuilt = YanivGame.from_dict(data)

        self.assertEqual(rebuilt.game_id, game.game_id)
        self.assertEqual(len(rebuilt.players), 2)
        self.assertIsInstance(rebuilt.players[0], Player)
        self.assertIsInstance(rebuilt.players[1], AIPlayer)
        self.assertEqual(rebuilt.players[0].score, 12)
        self.assertEqual(rebuilt.players[1].score, 33)
        self.assertEqual(len(rebuilt.discard_pile), len(game.discard_pile))
        self.assertEqual(len(rebuilt.last_discard), len(game.last_discard))
        self.assertEqual(rebuilt.slamdown_player, game.slamdown_player)
        self.assertEqual(rebuilt.slamdown_card, game.slamdown_card)


if __name__ == "__main__":
    unittest.main()
