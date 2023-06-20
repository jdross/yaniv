import unittest
from aiplayer import AIPlayer, Card

class TestAIPlayer(unittest.TestCase):
    def setUp(self):
        self.aiplayer = AIPlayer("AI")

    # Testing discard options validation

    def test_get_discard_options_run(self):
        
        # Valid joker runs
        self.aiplayer.hand = [Card('4', 'Hearts'), Card('Joker', 'j2'), Card('6', 'Hearts'), Card('5', 'Hearts')]
        expected_output = [[Card('4', 'Hearts')], [Card('Joker', 'j2')], [Card('6', 'Hearts')],
                           [Card('4', 'Hearts')], [Card('5', 'Hearts')], [Card('6', 'Hearts')],
                           [Card('4', 'Hearts')], [Card('5', 'Hearts')], [Card('Joker', 'j2')],
                           [Card('Joker', 'j2'), Card('5', 'Hearts'), Card('6', 'Hearts')]]
        actual_output = self.aiplayer._get_discard_options()
        for option in expected_output:
            self.assertIn(option, actual_output)

        # Test sorting
        self.aiplayer.hand = [Card('4', 'Hearts'), Card('6', 'Hearts'), Card('Joker', 'j1')]
        self.assertIn([Card('4', 'Hearts'), Card('Joker', 'j1'), Card('6', 'Hearts')], 
                      self.aiplayer._get_discard_options())

    def test_get_discard_options_joker_end(self):
        # Joker at end
        self.aiplayer.hand = [Card('4', 'Hearts'), Card('5', 'Hearts'), Card('Joker', 'j1')]
        self.assertIn([Card('4', 'Hearts'), Card('5', 'Hearts'), Card('Joker', 'j1')], 
                      self.aiplayer._get_discard_options())
        self.assertIn([Card('Joker', 'j1'), Card('4', 'Hearts'), Card('5', 'Hearts')], 
                      self.aiplayer._get_discard_options())
    
    def test_get_discard_options_two_jokers(self):
        self.aiplayer.hand = [Card('4', 'Hearts'), Card('6', 'Hearts'), Card('Joker', 'j1'), Card('Joker', 'j2')]
        expected_output = [[Card('4', 'Hearts'), Card('Joker', 'j1'), Card('6', 'Hearts')],
                           [Card('4', 'Hearts'), Card('Joker', 'j1'), Card('6', 'Hearts'), Card('Joker', 'j2')],
                           [Card('Joker', 'j2'), Card('4', 'Hearts'), Card('Joker', 'j1'), Card('6', 'Hearts')]]
        actual_output = self.aiplayer._get_discard_options()
        for option in expected_output:
            self.assertIn(option, actual_output)
    
    def test_get_discard_options_two_middle_jokers(self):
        ## Two jokers in a row
        self.aiplayer.hand = [Card('4', 'Hearts'), Card('7', 'Hearts'), Card('Joker', 'j1'), Card('Joker', 'j2')]
        actual_output = self.aiplayer._get_discard_options()
        self.assertIn([Card('4', 'Hearts'), Card('Joker', 'j2'), Card('Joker', 'j1'), Card('7', 'Hearts')], actual_output)
        self.assertNotIn([Card('4', 'Hearts'), Card('Joker', 'j1'), Card('7', 'Hearts')], actual_output)
        self.assertNotIn([Card('4', 'Hearts'), Card('Joker', 'j2'), Card('7', 'Hearts')], actual_output)
        self.assertNotIn([Card('4', 'Hearts'), Card('Joker', 'j2'), Card('7', 'Hearts'), Card('Joker','j1')], actual_output)

    def test_get_discard_options_invalid(self):
        # Invalid runs
        self.aiplayer.hand = [Card('4', 'Hearts'), Card('Joker', 'j2'), Card('6', 'Clubs'), Card('6','Hearts'), Card('9', 'Hearts')]
        actual_output = self.aiplayer._get_discard_options()
        unexpected_output = [
            [Card('4', 'Hearts'), Card('Joker', 'j2'), Card('6', 'Clubs')],
            [Card('4', 'Hearts'), Card('6', 'Hearts')],
            [Card('4', 'Hearts'), Card('6', 'Hearts'),Card('9','Hearts')],
        ]
        for option in unexpected_output:
            self.assertNotIn(option, actual_output)
        
        self.aiplayer.hand = [Card('4', 'Hearts'), Card('Joker', 'j2'), Card('7', 'Hearts')]
        self.assertNotIn([Card('4', 'Hearts'), Card('Joker', 'j2'), Card('7', 'Hearts')], 
                         self.aiplayer._get_discard_options())

        self.aiplayer.hand = [Card('4', 'Hearts'), Card('5', 'Hearts'), Card('6', 'Clubs')]
        self.assertNotIn([Card('4', 'Hearts'), Card('5', 'Hearts'), Card('6', 'Clubs')], 
                         self.aiplayer._get_discard_options())
        self.assertNotIn([Card('4', 'Hearts'), Card('5', 'Hearts')], 
                         self.aiplayer._get_discard_options())
        
    def test_get_discard_options_invalid_jokers(self):
        self.aiplayer.hand = [Card('Q', 'Hearts'), Card('K', 'Hearts'), Card('Joker', 'j1')]
        self.assertIn([Card('Joker', 'j1'), Card('Q', 'Hearts'), Card('K', 'Hearts')], 
                         self.aiplayer._get_discard_options())
        self.assertNotIn([Card('Q', 'Hearts'), Card('K', 'Hearts'), Card('Joker', 'j1')], 
                         self.aiplayer._get_discard_options())
        
        self.aiplayer.hand = [Card('A', 'Hearts'), Card('2', 'Hearts'), Card('Joker', 'j1')]
        self.assertIn([Card('A', 'Hearts'), Card('2', 'Hearts'), Card('Joker', 'j1')], 
                         self.aiplayer._get_discard_options())
        self.assertNotIn([Card('Joker', 'j1'), Card('A', 'Hearts'), Card('2', 'Hearts')], 
                         self.aiplayer._get_discard_options())

    # Test identification of a good vs bad discard
    def test_get_best_discard_option(self):
        self.aiplayer.hand = [Card('J', 'Hearts'), Card('Q', 'Hearts'), Card('K', 'Hearts')]
        discard_options = [[Card('J', 'Hearts')], [Card('Q', 'Hearts')], [Card('K', 'Hearts')], [Card('J', 'Hearts'), Card('Q', 'Hearts'), Card('K', 'Hearts')]]
        best_option = self.aiplayer._get_best_discard_options(discard_options)
        self.assertTrue(len(best_option) == 1)
        self.assertEqual(best_option[0], [Card('J', 'Hearts'), Card('Q', 'Hearts'), Card('K', 'Hearts')])

        self.aiplayer.hand = [Card('7', 'Hearts'), Card('8', 'Hearts'), Card('9', 'Hearts')]
        discard_options = [[Card('7', 'Hearts')], [Card('8', 'Hearts')], [Card('9', 'Hearts')], [Card('7', 'Hearts'), Card('8', 'Hearts'), Card('9', 'Hearts')]]
        self.assertEqual(self.aiplayer._get_best_discard_options(discard_options)[0], [Card('7', 'Hearts'), Card('8', 'Hearts'), Card('9', 'Hearts')])

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
        print("Draw to complete run vs complete set")
        self.aiplayer.hand = [Card('9', 'Hearts'), Card('10', 'Hearts'), Card('J', 'Hearts'), Card('K', 'Hearts')]
        self.aiplayer.discard_pile = [Card('K', 'Spades'), Card('Q','Hearts')]
        self.aiplayer.draw_options = self.aiplayer.discard_pile
        self.assertEqual(self.aiplayer._simulate_next_turn()['draw'], 1)

    def test_simulate_next_turn_run_2(self):
        print("Draw for a set against complete run")
        self.aiplayer.hand = [Card('9', 'Hearts'), Card('10', 'Hearts'), Card('J', 'Hearts'), Card('K', 'Hearts')]
        self.aiplayer.discard_pile = [Card('Q','Hearts'), Card('K', 'Spades')]
        self.aiplayer.draw_options = self.aiplayer.discard_pile
        self.assertNotEqual(self.aiplayer._simulate_next_turn()['draw'], 'deck')
        # self.assertEqual(self.aiplayer._simulate_next_turn(), 0)
        # TODO Fix this. should drop run and take the king; currently drops set then tries to complete the dropped run :O
    
    def test_simulate_next_turn_complete_run_drop(self):
        print("Draw against a complete run")
        self.aiplayer.hand = [Card('J', 'Hearts'), Card('Q', 'Hearts'), Card('K', 'Hearts'), Card('A','Spades')]
        self.aiplayer.discard_pile = [Card('K', 'Spades')]
        self.aiplayer.draw_options = self.aiplayer.discard_pile
        action = self.aiplayer._simulate_next_turn()
        self.assertEqual(action['discard'], [Card('J', 'Hearts'), Card('Q', 'Hearts'), Card('K', 'Hearts')])
        self.assertEqual(action['draw'], 'deck')

    def test_simulate_next_turn_complete_run_pile(self):
        print("Draw to complete run")
        self.aiplayer.hand = [Card('J', 'Hearts'), Card('Q', 'Hearts'), Card('2', 'Hearts')]
        self.aiplayer.discard_pile = [Card('K', 'Hearts')]
        self.aiplayer.draw_options = self.aiplayer.discard_pile
        action = self.aiplayer._simulate_next_turn()
        self.assertEqual(action['draw'], 0)
        self.assertEqual(action['discard'], [Card('2','Hearts')])

    def test_simulate_next_turn_set(self):
        print("Draw for a set")
        self.aiplayer.hand = [Card('Q', 'Hearts'), Card('K', 'Hearts')]
        self.aiplayer.discard_pile = [Card('10', 'Spades'), Card('J', 'Spades'), Card('Q', 'Spades')]
        self.aiplayer.draw_options = self.aiplayer.discard_pile
        action = self.aiplayer._simulate_next_turn()
        self.assertEqual(action['draw'], 2)

    def test_simulate_next_turn_joker(self):
        print("Keep Joker Set")
        # TODO: Support "Keep the joker" logic in other scenarios
        self.aiplayer.hand = [Card('Joker', 'j1'), Card('Q', 'Hearts'), Card('K', 'Hearts'), Card('9', 'Hearts')]
        self.aiplayer.discard_pile = [Card('J', 'Hearts')]
        self.aiplayer.draw_options = self.aiplayer.discard_pile
        action = self.aiplayer._simulate_next_turn()
        self.assertEqual(action['draw'], 0)
        self.assertEqual(action['discard'], [Card('K', 'Hearts')])
        self.assertEqual(action['points'], 0)

    def test_simulate_next_turn_joker_2(self):
        print("Drop Joker No Set")
        # Discard the Q, take the Jack
        self.aiplayer.hand = [Card('Joker', 'j1'), Card('Q', 'Hearts'), Card('K', 'Hearts')]
        self.aiplayer.discard_pile = [Card('J', 'Spades')]
        self.aiplayer.draw_options = self.aiplayer.discard_pile
        action = self.aiplayer._simulate_next_turn()
        self.assertEqual(action['draw'], 'deck')
        self.assertEqual(action['discard'], [Card('Joker', 'j1'), Card('Q', 'Hearts'), Card('K', 'Hearts')])
    
    def test_simulate_next_turn_overdone_set(self):
        print("Simulate Too Complete")
        self.aiplayer.hand = [Card('9', 'Hearts'), Card('10', 'Hearts'), Card('J', 'Hearts'), Card('K', 'Hearts')]
        # Get the best discard option and new total points
        self.aiplayer.discard_pile = [Card('Q','Hearts')]
        self.aiplayer.draw_options = self.aiplayer.discard_pile
        action = self.aiplayer._simulate_next_turn()
        self.assertEqual(action['draw'], 0)
        # self.assertEqual(action['discard'], [Card('K', 'Hearts')]) # TODO: Discard King, Keep 9
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
