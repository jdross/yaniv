import unittest, sys, os
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
PYTHON_SERVER_ROOT = os.path.join(ROOT, "python-server")
if PYTHON_SERVER_ROOT not in sys.path:
    sys.path.insert(0, PYTHON_SERVER_ROOT)
from aiplayer import AIPlayer, Card

class TestAIPlayer(unittest.TestCase):
    def setUp(self):
        self.aiplayer = AIPlayer("AI")

    def test_estimate_unknown_cards_returns_zero_when_no_unknowns(self):
        ai = AIPlayer("AI")
        ai.observe_round([
            {'name': 'AI', 'score': 0},
            {'name': 'P2', 'score': 0},
        ])
        self.assertEqual(ai.estimate_unknown_cards(0), 0)

    def test_estimate_unknown_cards_positive_for_hidden_cards(self):
        ai = AIPlayer("AI")
        ai.hand = [Card('2', 'Hearts')]
        ai.observe_round([
            {'name': 'AI', 'score': 0},
            {'name': 'P2', 'score': 0},
        ])
        self.assertGreater(ai.estimate_unknown_cards(2), 0)

    # Testing discard options validation

    def test_get_discard_options_run(self):
        
        # Valid joker runs
        self.aiplayer.hand = [Card('4', 'Hearts'), Card('Joker', 'Hearts'), Card('6', 'Hearts'), Card('5', 'Hearts')]
        expected_output = [[Card('4', 'Hearts')], [Card('Joker', 'Hearts')], [Card('6', 'Hearts')],
                           [Card('4', 'Hearts')], [Card('5', 'Hearts')], [Card('6', 'Hearts')],
                           [Card('4', 'Hearts')], [Card('5', 'Hearts')], [Card('Joker', 'Hearts')],
                           [Card('Joker', 'Hearts'), Card('5', 'Hearts'), Card('6', 'Hearts')]]
        actual_output = self.aiplayer._get_discard_options()
        for option in expected_output:
            self.assertIn(option, actual_output)

        # Test sorting
        self.aiplayer.hand = [Card('4', 'Hearts'), Card('6', 'Hearts'), Card('Joker', 'Spades')]
        self.assertIn([Card('4', 'Hearts'), Card('Joker', 'Spades'), Card('6', 'Hearts')], 
                      self.aiplayer._get_discard_options())

    def test_get_discard_options_joker_end(self):
        # Joker at end
        self.aiplayer.hand = [Card('4', 'Hearts'), Card('5', 'Hearts'), Card('Joker', 'Spades')]
        self.assertIn([Card('4', 'Hearts'), Card('5', 'Hearts'), Card('Joker', 'Spades')], 
                      self.aiplayer._get_discard_options())
        self.assertIn([Card('Joker', 'Spades'), Card('4', 'Hearts'), Card('5', 'Hearts')], 
                      self.aiplayer._get_discard_options())
    
    def test_get_discard_options_two_jokers(self):
        self.aiplayer.hand = [Card('4', 'Hearts'), Card('6', 'Hearts'), Card('Joker', 'Spades'), Card('Joker', 'Hearts')]
        expected_output = [[Card('4', 'Hearts'), Card('Joker', 'Spades'), Card('6', 'Hearts')],
                           [Card('4', 'Hearts'), Card('Joker', 'Spades'), Card('6', 'Hearts'), Card('Joker', 'Hearts')],
                           [Card('Joker', 'Hearts'), Card('4', 'Hearts'), Card('Joker', 'Spades'), Card('6', 'Hearts')]]
        actual_output = self.aiplayer._get_discard_options()
        for option in expected_output:
            self.assertIn(option, actual_output)
    
    def test_get_discard_options_two_middle_jokers(self):
        ## Two jokers in a row
        self.aiplayer.hand = [Card('4', 'Hearts'), Card('7', 'Hearts'), Card('Joker', 'Spades'), Card('Joker', 'Hearts')]
        actual_output = self.aiplayer._get_discard_options()
        self.assertIn([Card('4', 'Hearts'), Card('Joker', 'Hearts'), Card('Joker', 'Spades'), Card('7', 'Hearts')], actual_output)
        self.assertNotIn([Card('4', 'Hearts'), Card('Joker', 'Spades'), Card('7', 'Hearts')], actual_output)
        self.assertNotIn([Card('4', 'Hearts'), Card('Joker', 'Hearts'), Card('7', 'Hearts')], actual_output)
        self.assertNotIn([Card('4', 'Hearts'), Card('Joker', 'Hearts'), Card('7', 'Hearts'), Card('Joker','Spades')], actual_output)

    def test_get_discard_options_invalid(self):
        # Invalid runs
        self.aiplayer.hand = [Card('4', 'Hearts'), Card('Joker', 'Hearts'), Card('6', 'Clubs'), Card('6','Hearts'), Card('9', 'Hearts')]
        actual_output = self.aiplayer._get_discard_options()
        unexpected_output = [
            [Card('4', 'Hearts'), Card('Joker', 'Hearts'), Card('6', 'Clubs')],
            [Card('4', 'Hearts'), Card('6', 'Hearts')],
            [Card('4', 'Hearts'), Card('6', 'Hearts'),Card('9','Hearts')],
        ]
        for option in unexpected_output:
            self.assertNotIn(option, actual_output)
        
        self.aiplayer.hand = [Card('4', 'Hearts'), Card('Joker', 'Hearts'), Card('7', 'Hearts')]
        self.assertNotIn([Card('4', 'Hearts'), Card('Joker', 'Hearts'), Card('7', 'Hearts')], 
                         self.aiplayer._get_discard_options())

        self.aiplayer.hand = [Card('4', 'Hearts'), Card('5', 'Hearts'), Card('6', 'Clubs')]
        self.assertNotIn([Card('4', 'Hearts'), Card('5', 'Hearts'), Card('6', 'Clubs')], 
                         self.aiplayer._get_discard_options())
        self.assertNotIn([Card('4', 'Hearts'), Card('5', 'Hearts')], 
                         self.aiplayer._get_discard_options())
        
    def test_get_discard_options_invalid_jokers(self):
        self.aiplayer.hand = [Card('Q', 'Hearts'), Card('K', 'Hearts'), Card('Joker', 'Spades')]
        self.assertIn([Card('Joker', 'Spades'), Card('Q', 'Hearts'), Card('K', 'Hearts')], 
                         self.aiplayer._get_discard_options())
        self.assertNotIn([Card('Q', 'Hearts'), Card('K', 'Hearts'), Card('Joker', 'Spades')], 
                         self.aiplayer._get_discard_options())
        
        self.aiplayer.hand = [Card('A', 'Hearts'), Card('2', 'Hearts'), Card('Joker', 'Spades')]
        self.assertIn([Card('A', 'Hearts'), Card('2', 'Hearts'), Card('Joker', 'Spades')], 
                         self.aiplayer._get_discard_options())
        self.assertNotIn([Card('Joker', 'Spades'), Card('A', 'Hearts'), Card('2', 'Hearts')], 
                         self.aiplayer._get_discard_options())

    # Test identification of a good vs bad discard
    def test_get_best_discard_option(self):
        self.aiplayer.hand = [Card('J', 'Hearts'), Card('Q', 'Hearts'), Card('K', 'Hearts')]
        discard_options = [[Card('J', 'Hearts')], [Card('Q', 'Hearts')], [Card('K', 'Hearts')], [Card('J', 'Hearts'), Card('Q', 'Hearts'), Card('K', 'Hearts')]]
        best_option = self.aiplayer._get_best_discard_options(discard_options)
        self.assertTrue(len(best_option) == 1)
        self.assertEqual(best_option[0], [Card('J', 'Hearts'), Card('Q', 'Hearts'), Card('K', 'Hearts')])

        self.aiplayer.hand = [Card('7', 'Hearts'), Card('9', 'Hearts'), Card('9', 'Diamonds')]
        discard_options = [[Card('7', 'Hearts')], [Card('9', 'Hearts')], [Card('9', 'Diamonds'), Card('9', 'Hearts')]]
        best_option = self.aiplayer._get_best_discard_options(discard_options)
        self.assertTrue(len(best_option) == 1)
        self.assertEqual(best_option[0], [Card('9', 'Diamonds'), Card('9', 'Hearts')])

        self.aiplayer.hand = [Card('7', 'Hearts'), Card('8', 'Hearts'), Card('9', 'Hearts'), Card('9', 'Diamonds')]
        discard_options = [[Card('7', 'Hearts')], [Card('8', 'Hearts')], [Card('9', 'Hearts')], [Card('7', 'Hearts'), Card('8', 'Hearts'), Card('9', 'Hearts')], [Card('9', 'Diamonds'), Card('9', 'Hearts')]]
        best_option = self.aiplayer._get_best_discard_options(discard_options)
        self.assertTrue(len(best_option) == 1)
        self.assertEqual(best_option[0], [Card('7', 'Hearts'), Card('8', 'Hearts'), Card('9', 'Hearts')])

    # Test best discard option won't discard a joker if it doesn't need to
    def test_get_best_discard_option_joker(self):
        self.aiplayer.hand = [Card('Joker', 'Spades'), Card('J', 'Hearts'), Card('Q', 'Hearts'), Card('K', 'Hearts')]
        discard_options = [[Card('Joker', 'Spades')], [Card('J', 'Hearts')], [Card('Q', 'Hearts')], [Card('K', 'Hearts')],
                           [Card('J', 'Hearts'), Card('Q', 'Hearts'), Card('K', 'Hearts')],
                           [Card('Joker', 'Spades'), Card('J', 'Hearts'), Card('Q', 'Hearts'), Card('K', 'Hearts')]]
        best_option = self.aiplayer._get_best_discard_options(discard_options)
        self.assertTrue(len(best_option) == 1)
        self.assertEqual(best_option[0], [Card('J', 'Hearts'), Card('Q', 'Hearts'), Card('K', 'Hearts')])

    # Test best discard options
    def test_discard_pair(self):
        discard_options = [[Card('8', 'Hearts')], [Card('8', 'Spades')], [Card('8', 'Hearts'), Card('8', 'Spades')]]
        best_discard_options = self.aiplayer._get_best_discard_options(discard_options)
        self.assertEqual(best_discard_options, [[Card('8', 'Hearts'), Card('8', 'Spades')]])

    def test_discard_high_card(self):
        discard_options = [[Card('A', 'Hearts')], [Card('7', 'Hearts')], [Card('10', 'Hearts')], [Card('K', 'Hearts')]]
        best_discard_options = self.aiplayer._get_best_discard_options(discard_options)
        self.assertEqual(best_discard_options, [[Card('10', 'Hearts')], [Card('K', 'Hearts')]])

    def test_discard_all_individuals(self):
        discard_options = [[Card('10', 'Hearts')], [Card('J', 'Hearts')], [Card('K', 'Hearts')]]
        best_discard_options = self.aiplayer._get_best_discard_options(discard_options)
        self.assertEqual(best_discard_options, [[Card('10', 'Hearts')], [Card('J', 'Hearts')], [Card('K', 'Hearts')]])

    # Test calculation of new total points
    def test_calculate_new_total_points(self):
        self.aiplayer.hand = [Card('J', 'Hearts'), Card('Q', 'Hearts'), Card('K', 'Hearts')]
        best_discard_option = [Card('J', 'Hearts')]
        self.assertEqual(self.aiplayer._calculate_new_total_points(self.aiplayer.hand, best_discard_option), 20)

        self.aiplayer.hand = [Card('7', 'Hearts'), Card('8', 'Hearts'), Card('9', 'Hearts')]
        best_discard_option = [Card('7', 'Hearts'), Card('8', 'Hearts'), Card('9','Hearts')]
        self.assertEqual(self.aiplayer._calculate_new_total_points(self.aiplayer.hand, best_discard_option), 0)

        self.aiplayer.hand = [Card('J', 'Hearts'), Card('Q', 'Hearts'), Card('K', 'Hearts'), Card('A','Spades')]
        best_discard_option = [Card('J', 'Hearts'), Card('Q', 'Hearts'), Card('K', 'Hearts')]
        self.assertEqual(self.aiplayer._calculate_new_total_points(self.aiplayer.hand, best_discard_option), 1)

    # Testing drawing logic
    def test_simulate_next_turn_run(self):
        """ Draw to complete run vs complete set """
        self.aiplayer.hand = [Card('9', 'Hearts'), Card('10', 'Hearts'), Card('J', 'Hearts'), Card('K', 'Hearts')]
        self.aiplayer.discard_pile = [Card('K', 'Spades'), Card('Q','Hearts')]
        self.aiplayer.draw_options = self.aiplayer.discard_pile
        self.assertEqual(self.aiplayer._simulate_next_turn()['draw'], 1)

    def test_simulate_next_turn_run_2(self):
        """ Draw for a set against complete run """
        self.aiplayer.hand = [Card('9', 'Hearts'), Card('10', 'Hearts'), Card('J', 'Hearts'), Card('K', 'Hearts')]
        self.aiplayer.discard_pile = [Card('Q','Hearts'), Card('K', 'Spades')]
        self.aiplayer.draw_options = self.aiplayer.discard_pile
        action = self.aiplayer._simulate_next_turn()
        self.assertNotEqual(action['draw'], 'deck')
    
    def test_simulate_next_turn_complete_run_drop(self):
        """ Draw against a complete run """
        self.aiplayer.hand = [Card('J', 'Hearts'), Card('Q', 'Hearts'), Card('K', 'Hearts'), Card('A','Spades')]
        self.aiplayer.discard_pile = [Card('K', 'Spades')]
        self.aiplayer.draw_options = self.aiplayer.discard_pile
        action = self.aiplayer._simulate_next_turn()
        self.assertEqual(action['discard'], [Card('J', 'Hearts'), Card('Q', 'Hearts'), Card('K', 'Hearts')])
        self.assertEqual(action['draw'], 'deck')

    def test_simulate_next_turn_complete_run_pile(self):
        """ Draw to complete run """
        self.aiplayer.hand = [Card('J', 'Hearts'), Card('Q', 'Hearts'), Card('2', 'Hearts')]
        self.aiplayer.discard_pile = [Card('K', 'Hearts')]
        self.aiplayer.draw_options = self.aiplayer.discard_pile
        action = self.aiplayer._simulate_next_turn()
        self.assertEqual(action['draw'], 0)
        self.assertEqual(action['discard'], [Card('2','Hearts')])

    def test_simulate_next_turn_set(self):
        """ Draw for a set """
        self.aiplayer.hand = [Card('Q', 'Hearts'), Card('K', 'Hearts')]
        self.aiplayer.discard_pile = [Card('10', 'Spades'), Card('J', 'Spades'), Card('Q', 'Spades')]
        self.aiplayer.draw_options = self.aiplayer.discard_pile
        action = self.aiplayer._simulate_next_turn()
        self.assertEqual(action['draw'], 2)

    def test_simulate_next_turn_joker(self):
        """ Keep the Joker in the set """
        self.aiplayer.hand = [Card('Joker', 'Spades'), Card('Q', 'Hearts'), Card('K', 'Hearts'), Card('9', 'Hearts')]
        self.aiplayer.discard_pile = [Card('J', 'Hearts')]
        self.aiplayer.draw_options = self.aiplayer.discard_pile
        action = self.aiplayer._simulate_next_turn()
        self.assertEqual(action['draw'], 0)
        self.assertEqual(action['discard'], [Card('9', 'Hearts')])
        self.assertEqual(action['points'], 0)

    def test_simulate_next_turn_joker_2(self):
        self.aiplayer.hand = [Card('Joker', 'Spades'), Card('Q', 'Hearts'), Card('K', 'Hearts')]
        self.aiplayer.discard_pile = [Card('J', 'Spades')]
        self.aiplayer.draw_options = self.aiplayer.discard_pile
        action = self.aiplayer._simulate_next_turn()
        self.assertEqual(action['draw'], 'deck')
        self.assertEqual(action['discard'], [Card('Joker', 'Spades'), Card('Q', 'Hearts'), Card('K', 'Hearts')])
    
    def test_simulate_next_turn_overdone_set(self):
        self.aiplayer.hand = [Card('9', 'Hearts'), Card('10', 'Hearts'), Card('J', 'Hearts'), Card('K', 'Hearts')]
        # Get the best discard option and new total points
        self.aiplayer.discard_pile = [Card('Q','Hearts')]
        self.aiplayer.draw_options = self.aiplayer.discard_pile
        action = self.aiplayer._simulate_next_turn()
        self.assertEqual(action['draw'], 0)
        self.assertEqual(action['discard'], [Card('9', 'Hearts')])
        self.assertEqual(action['points'], 0)

    def test_simulate_action(self):
        self.aiplayer.hand = [Card('9', 'Hearts'), Card('10', 'Hearts'), Card('J', 'Hearts'), Card('K', 'Hearts')]
        # Get the best discard option and new total points
        new_total_points, best_discard_option = self.aiplayer._simulate_action(self.aiplayer.hand, Card('Q','Diamonds'))

        # The best discard option should be ['9 of Hearts', '10 of Hearts', 'J of Hearts'] and the new total points should be 20
        self.assertEqual(best_discard_option, [Card('9', 'Hearts'), Card('10', 'Hearts'), Card('J', 'Hearts')])
        self.assertEqual(new_total_points, 20)

    def test_simulate_action_2(self):
        self.aiplayer.hand = [Card('9', 'Hearts'), Card('10', 'Hearts'), Card('J', 'Hearts'), Card('K', 'Hearts')]
        # Get the best discard option and new total points
        new_total_points, best_discard_option = self.aiplayer._simulate_action(self.aiplayer.hand, Card('K','Spades'))

        # The best discard option should be ['9 of Hearts', '10 of Hearts', 'J of Hearts'] and the new total points should be 20
        self.assertEqual(best_discard_option, [Card('9', 'Hearts'), Card('10', 'Hearts'), Card('J', 'Hearts')])
        self.assertEqual(new_total_points, 20)


if __name__ == '__main__':
    unittest.main()
