import unittest, sys, os
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from yaniv import YanivGame, Player, Card

class TestCard(unittest.TestCase):
    def test_card_string_representation(self):
        card = Card('5', 'Hearts')
        self.assertEqual(str(card), '5 of Hearts')

    def test_card_equality(self):
        card1 = Card('6', 'Spades')
        card2 = Card('6', 'Spades')
        card3 = Card('6', 'Diamonds')
        self.assertEqual(card1, card2)
        self.assertNotEqual(card1, card3)

    def test_card_sorting(self):
        card1 = Card('4', 'Hearts')
        card2 = Card('7', 'Clubs')
        card3 = Card('A', 'Diamonds')
        card4 = Card('Joker', 'Spades')
        card5 = Card('K', 'Spades')
        card6 = Card('Q', 'Hearts')
        card7 = Card('K', 'Diamonds')
        cards = [card1, card2, card3, card4, card5, card6, card7]
        cards.sort()
        self.assertEqual(cards, [card4, card3, card1, card2, card6, card7, card5])

class TestYanivGame(unittest.TestCase):
    def setUp(self):
        self.player1 = Player('Player 1')
        self.player2 = Player('Player 2')
        self.game = YanivGame([self.player1, self.player2])

    def test_yaniv_declaration(self):
        self.player1.hand = [Card('2', 'Hearts'), Card('2', 'Diamonds'), Card('A', 'Spades')]
        self.assertTrue(self.game.can_declare_yaniv(self.player1))

        self.player2.hand = [Card('2', 'Hearts'), Card('3', 'Diamonds'), Card('4', 'Spades')]
        self.assertFalse(self.game.can_declare_yaniv(self.player2))

    def test_assaf(self):
        self.player1.hand = [Card('2', 'Hearts'), Card('2', 'Diamonds'), Card('A', 'Spades')]
        self.player2.hand = [Card('2', 'Hearts'), Card('3', 'Diamonds'), Card('4', 'Spades')]
        self.game._update_scores(self.player1)
        self.assertEqual(self.player1.score, 0)
        self.assertEqual(self.player2.score, 9)
        
        self.player1.hand = [Card('2', 'Hearts'), Card('2', 'Diamonds'), Card('A', 'Spades')]
        self.player2.hand = [Card('2', 'Spades'), Card('A', 'Diamonds'), Card('A', 'Clubs')]
        self.game._update_scores(self.player1)
        self.assertEqual(self.player1.score, 30)
        self.assertEqual(self.player2.score, 9)

        self.player1.hand = [Card('2', 'Hearts'), Card('2', 'Diamonds'), Card('A', 'Spades')]
        self.player2.hand = [Card('2', 'Spades'), Card('A', 'Diamonds'), Card('2', 'Clubs')]
        self.game._update_scores(self.player2)
        self.assertEqual(self.player1.score, 30)
        self.assertEqual(self.player2.score, 39)

        self.player1.hand = [Card('Joker', 'Spades'), Card('2', 'Diamonds'), Card('A', 'Spades')]
        self.player2.hand = [Card('2', 'Spades'), Card('A', 'Diamonds'), Card('2', 'Clubs')]
        self.game._update_scores(self.player1)
        self.assertEqual(self.player1.score, 30)
        self.assertEqual(self.player2.score, 44)

        # Lose & Reset
        self.player1.hand = [Card('Joker', 'Spades'), Card('2', 'Diamonds'), Card('A', 'Spades')]
        self.player2.hand = [Card('2', 'Spades'), Card('3', 'Diamonds'), Card('A', 'Clubs')]
        self.game._update_scores(self.player1)
        self.assertEqual(self.player1.score, 30)
        self.assertEqual(self.player2.score, 0)

        # Assaf to Reset
        self.player1.score = 20
        self.player1.hand = [Card('Joker', 'Spades'), Card('2', 'Diamonds'), Card('A', 'Spades')]
        self.player2.hand = [Card('Joker', 'Hearts'), Card('A', 'Diamonds')]
        self.game._update_scores(self.player1)
        self.assertEqual(self.player1.score, 0)
        self.assertEqual(self.player2.score, 0)

    def test_reset_score(self):
        self.player1.score = 50
        self.player2.score = 100
        self.game.previous_scores = [45, 95]
        self.game._reset_player_scores()
        self.assertEqual(self.player1.score, 0)
        self.assertEqual(self.player2.score, 50)

    def test_reset_score_3player(self):
        # Create a game with three players
        players = [Player("Player1"), Player("Player2"), Player("Player3")]
        self.game._create_players(players)

        # Manually set the scores for players such that Player1 has 50 points, Player2 has 100 points, and Player3 has 30 points
        self.game.players[0].score = 50
        self.game.players[1].score = 100
        self.game.players[2].score = 30

        # Set previous scores to be lower than current scores
        self.game.previous_scores = [40, 90, 20]

        # Call reset_scores
        self.game._reset_player_scores()

        # Now Player1 and Player2's scores should be reset to 0 and 50, respectively, and Player3's score should remain 30
        self.assertEqual(self.game.players[0].score, 0)
        self.assertEqual(self.game.players[1].score, 50)
        self.assertEqual(self.game.players[2].score, 30)
    

    def test_return_run_if_valid(self):
        # Test with a valid run without Jokers
        cards = [Card('2', 'Hearts'), Card('3', 'Hearts'), Card('4', 'Hearts')]
        self.assertEqual(self.game._return_run_if_valid(cards), cards)

        # Test with a valid run with a Joker replacing the middle card
        cards = [Card('2', 'Hearts'), Card('Joker', 'Spades'), Card('4', 'Hearts')]
        expected = [Card('2', 'Hearts'), Card('Joker', 'Spades'), Card('4', 'Hearts')]
        self.assertEqual(self.game._return_run_if_valid(cards), expected)

        # Test with a valid run with a Joker replacing the first card
        cards = [Card('Joker', 'Spades'), Card('3', 'Hearts'), Card('4', 'Hearts')]
        expected = [Card('Joker', 'Spades'), Card('3', 'Hearts'), Card('4', 'Hearts')]
        self.assertEqual(self.game._return_run_if_valid(cards), expected)

        # Test with a valid run with two Jokers replacing the first two cards
        cards = [Card('Joker', 'Spades'), Card('Joker', 'Spades'), Card('4', 'Hearts')]
        expected = [Card('Joker', 'Spades'), Card('Joker', 'Spades'), Card('4', 'Hearts')]
        self.assertEqual(self.game._return_run_if_valid(cards), expected)

    def test_return_run_if_valid_invalid(self):
        # Test with an invalid run (not enough cards)
        cards = [Card('2', 'Hearts'), Card('3', 'Hearts')]
        self.assertFalse(self.game._return_run_if_valid(cards))

        # Test with an invalid run (cards not of the same suit)
        cards = [Card('2', 'Hearts'), Card('3', 'Clubs'), Card('4', 'Hearts')]
        self.assertFalse(self.game._return_run_if_valid(cards))

        # Test with an invalid run (ranks not contiguous)
        cards = [Card('2', 'Hearts'), Card('4', 'Hearts'), Card('5', 'Hearts')]
        self.assertFalse(self.game._return_run_if_valid(cards))

        # Test with an invalid run (not enough Jokers to fill in the gaps)
        cards = [Card('2', 'Hearts'), Card('Joker', 'Spades'), Card('5', 'Hearts')]
        self.assertFalse(self.game._return_run_if_valid(cards))

    def test_get_draw_options_set(self):
        # Test with a set in the last discarded cards
        self.game.last_discard = [Card('2', 'Hearts'), Card('2', 'Diamonds'), Card('2', 'Clubs')]
        self.assertCountEqual(self.game._get_draw_options(), self.game.last_discard)

    def test_get_draw_options_run(self):
        # Test with a run in the last discarded cards
        game = self.game
        game.last_discard = [Card('2', 'Hearts'), Card('3', 'Hearts'), Card('4', 'Hearts')]
        options = game._get_draw_options()
        self.assertEqual(options, [game.last_discard[0], game.last_discard[-1]])

    def test_get_draw_options_run_with_joker(self):
        # Test with a run that includes a Joker in the last discarded cards
        game = self.game
        game.last_discard = [Card('2', 'Hearts'), Card('Joker', 'Spades'), Card('4', 'Hearts')]
        self.assertEqual(game._get_draw_options(), [game.last_discard[0], game.last_discard[-1]])

    def test_discard_and_draw(self):
        # Scenario 1: Player discards a card and draws from deck
        self.player1.hand = [Card('10', 'Hearts'), Card('J', 'Diamonds'), Card('Q', 'Spades')]
        self.game.discard_pile = [Card('9', 'Hearts')]
        self.game.last_discard = [Card('9', 'Hearts')]
        self.game.deck = [Card('A', 'Clubs')]
        
        self.game._draw_card(self.player1)
        self.assertEqual(self.player1.hand, [Card('10', 'Hearts'), Card('J', 'Diamonds'), Card('Q', 'Spades'), Card('A', 'Clubs')])

        self.game._discard_cards(self.player1, [Card('10', 'Hearts')])
        self.assertEqual(self.player1.hand, [Card('J', 'Diamonds'), Card('Q', 'Spades'), Card('A', 'Clubs')])
        self.assertEqual(self.game.discard_pile[-1], Card('10', 'Hearts'))

        # Scenario 2: Player discards a card and draws from discard pile
        self.player2.hand = [Card('2', 'Hearts'), Card('3', 'Diamonds'), Card('4', 'Spades')]
        self.game.discard_pile = [Card('A', 'Hearts'), Card('10', 'Hearts')]
        self.game.last_discard = [Card('10', 'Hearts')]
        self.game.deck = [Card('5', 'Clubs')]
        # Draw must be done before discarding, internally
        self.game._draw_card(self.player2, True, 0)
        self.game._discard_cards(self.player2, [Card('4', 'Spades')])
        self.assertEqual(self.player2.hand, [Card('2', 'Hearts'), Card('3', 'Diamonds'), Card('10', 'Hearts')])
        self.assertEqual(self.game.discard_pile[-1], Card('4', 'Spades'))

    def test_end_of_game(self):
        self.player1.score = 69
        self.player2.score = 99
        self.assertFalse(self.game._check_end_of_game())
        self.player1.score = 101
        self.assertTrue(self.game._check_end_of_game())
        self.player2.score = 10
        self.assertTrue(self.game._check_end_of_game())

        # Three-player elimination flow.
        player3 = Player("Player 3")
        self.game = YanivGame([self.player1, self.player2, player3])
        self.player1.score = 70
        self.player2.score = 90
        player3.score = 90
        self.assertIsNone(self.game._check_end_of_game())

        self.player2.score = 120
        self.assertIsNone(self.game._check_end_of_game())

        player3.score = 140
        self.assertEqual(self.game._check_end_of_game(), self.player1)

    def test_run(self):
        # Scenario 3: Player discards a run and draws from deck
        self.player1.hand = [Card('10', 'Hearts'), Card('J', 'Hearts'), Card('Q', 'Hearts'), Card('K', 'Hearts')]
        self.game.discard_pile = [Card('9', 'Hearts')]
        self.game.deck = [Card('A', 'Clubs')]
        self.game._draw_card(self.player1)
        self.game._discard_cards(self.player1, [Card('10', 'Hearts'), Card('J', 'Hearts'), Card('Q', 'Hearts')])
        self.assertEqual(self.player1.hand, [Card('K', 'Hearts'), Card('A', 'Clubs')])
        self.assertEqual(self.game.discard_pile[-3:], [Card('10', 'Hearts'), Card('J', 'Hearts'), Card('Q', 'Hearts')])

    def test_start_game(self):
        # Test starting a game with no players
        game_with_no_players = YanivGame()
        with self.assertRaises(ValueError):
            game_with_no_players.start_game()

        # Test starting a game with players
        self.game.start_game()
        self.assertEqual(len(self.game.discard_pile), 1)
        self.assertEqual(len(self.game.last_discard), 1)
        self.assertEqual(len(self.game.deck), 54 - 5*len(self.game.players) - 1)
        self.game.start_game()
        self.assertEqual(len(self.game.discard_pile), 1)
        self.assertEqual(len(self.game.last_discard), 1)
        self.assertEqual(len(self.game.deck), 54 - 5*len(self.game.players) - 1)

    def test_start_turn(self):
        self.game.start_game()
        current_player, discard_options = self.game.start_turn()
        self.assertEqual(current_player, self.game._get_player())
        self.assertEqual(discard_options, self.game._get_draw_options())

    def test_play_turn(self):
        self.game.start_game()
        current_player, discard_options = self.game.start_turn()
        valid_discard = [current_player.hand[0]]
        
        # Test discard validation
        with self.assertRaises(ValueError):
            self.game.play_turn(current_player, {'discard': "not a list", 'draw': 'deck'})
        
        # Test draw validation
        with self.assertRaises(ValueError):
            self.game.play_turn(current_player, {'discard': valid_discard, 'draw': "not 'deck' or an int"})
        
        with self.assertRaises(ValueError):
            self.game.play_turn(current_player, {'discard': valid_discard, 'draw': len(discard_options)})

    def test_slamdown_allowed_after_deck_draw(self):
        self.player1.hand = [Card('7', 'Hearts'), Card('3', 'Clubs'), Card('4', 'Diamonds')]
        self.game.discard_pile = [Card('K', 'Spades')]
        self.game.last_discard = [Card('K', 'Spades')]
        self.game.deck = [Card('7', 'Spades')]

        self.game.play_turn(self.player1, {'discard': [self.player1.hand[0]], 'draw': 'deck'})

        self.assertEqual(self.game.slamdown_player, self.player1.name)
        self.assertEqual(self.game.slamdown_card, Card('7', 'Spades'))

    def test_slamdown_not_allowed_after_pile_draw(self):
        self.player1.hand = [Card('7', 'Hearts'), Card('3', 'Clubs'), Card('4', 'Diamonds')]
        self.game.discard_pile = [Card('2', 'Hearts'), Card('7', 'Spades')]
        self.game.last_discard = [Card('7', 'Spades')]
        self.game.deck = [Card('A', 'Clubs')]

        self.game.play_turn(self.player1, {'discard': [self.player1.hand[0]], 'draw': 0})

        self.assertIsNone(self.game.slamdown_player)
        self.assertIsNone(self.game.slamdown_card)

    def test_declare_yaniv(self):
        self.game.start_game()
        current_player, discard_options = self.game.start_turn()
        
        # Test Yaniv declaration with more than 5 points
        current_player.hand = [Card('2', 'Hearts'), Card('5', 'Hearts')]
        with self.assertRaises(ValueError):
            self.game.declare_yaniv(current_player)
        
        # Test Yaniv declaration with 5 or fewer points
        current_player.hand = [Card('2', 'Hearts'), Card('3', 'Hearts')]
        update_info, eliminated_players, winner = self.game.declare_yaniv(current_player)
        self.assertNotIn('assaf', update_info)
    
    def test_declare_yaniv_assaf(self):
        self.game.start_game()

        # Set up hands so that the second player has fewer points than the first
        first_player, _ = self.game.start_turn()
        first_player.hand = [Card('2', 'Hearts'), Card('3', 'Hearts')]
        self.game._next_turn()
        second_player, _ = self.game.start_turn()
        second_player.hand = [Card('A', 'Hearts')]

        # Now, when the first player declares Yaniv, they should get Assaf'ed by the second player
        self.game._next_turn()
        update_info, eliminated_players, winner = self.game.declare_yaniv(first_player)
        self.assertIn('assaf', update_info)
        self.assertEqual(update_info['assaf']['assafed'], first_player)
        self.assertEqual(update_info['assaf']['assafed_by'], second_player)
    
    def test_declare_yaniv_with_reset(self):
        self.game.start_game()

        # Set up contrived hand so that the first player can declare Yaniv and has a score of 50
        self.player1.score = 33
        self.player2.score = 45
        self.game.previous_scores = [33,45]
        self.player1.hand = [Card('2', 'Hearts')]
        self.player2.hand = [Card('2', 'Hearts'), Card('3', 'Hearts')]

        # When the first player declares Yaniv, they should not get Assaf'ed and their score should reset to 0
        update_info, eliminated_players, winner = self.game.declare_yaniv(self.player1)
        self.assertNotIn('assaf', update_info)
        self.assertIn('reset_players', update_info)
        self.assertIn(self.player2, update_info['reset_players'])
        self.assertEqual(self.player2.score, 0)
    
if __name__ == '__main__':
    unittest.main()
