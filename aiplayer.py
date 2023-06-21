import random, itertools
from player import Player, Card

class AIPlayer(Player):
    def __init__(self, name):
        super().__init__(name)
        self.other_players = {}
        self.draw_options = []

    def observe_round(self, round_info):
        """
        Update the AI's knowledge based on the information given at the end of a round.

        Args:
            round_info (dict): A dictionary containing information about each remaining player and their current scores.
        """
        self.other_players = {}
        self.draw_options = []
        for player_info in round_info:
            if player_info['name'] != self.name:
                self.other_players[player_info['name']] = {
                    'current_score': player_info['score'],
                    'hand_count': 5,
                    'known_cards': [],
                    'estimated_score': 50  # Initializing the estimated_score
                }

    def observe_turn(self, turn_info, discard_pile, draw_options):
        """
        Update the AI's knowledge based on the information given after each turn.

        Args:
            turn_info (dict): A dictionary containing information about the player who just played, the number of cards remaining in their hand, the card(s) they discarded, and the card they drew if it was from the discard pile.
            discard_pile (list): The current discard pile.
        """
        player_name = turn_info['player'].name
        self.draw_options = draw_options
        if player_name in self.other_players:
            self.other_players[player_name]['hand_count'] = turn_info['hand_count']

            discarded_cards = turn_info['discarded_cards']
            drawn_card = turn_info['drawn_card']  # This is None if the card was drawn from the deck

            for card in discarded_cards:
                if card in self.other_players[player_name]['known_cards']:
                    self.other_players[player_name]['known_cards'].remove(card)
            if drawn_card is not None:
                if isinstance(drawn_card, int): # HACK because for some reason send over the index at start of hand
                    drawn_card = draw_options[drawn_card]
                self.other_players[player_name]['known_cards'].append(drawn_card)

            # After observing the turn, estimate the hand values
            self.estimate_hand_values()

    def decide_action(self):
        """
        Decide what action to take based on the observed game state.
        """
        # First, check if the AI estimates that another player is going to declare Yaniv on their next turn
        # and the AI can perform an action so their hand sums to a score that would allow them to reset.
        for player_info in self.other_players.values():
            if player_info['estimated_score'] <= 5:
                reset_action = self.action_to_reset()
                if reset_action is not None:
                    return reset_action

        # If not, play to win the hand with the lowest score.
        # For example, the AI could try to minimize the points in its hand by discarding high-point cards.
        return self.action_to_minimize_score()

    def action_to_reset(self):
        """
        Returns:
            dict: Action to take if the AI can reset with a card in discard options, None otherwise.
        """
        # The AI can reset if there is discard and replace with a card it could draw from discard_options,
        # where (drawn card value - discard value + AIPlayer's current score) % 50 = 0.
        for discard_option in self._get_discard_options():  # consider sets and runs
            for draw_card in self.draw_options:
                if (sum(card.value for card in discard_option) - draw_card.value + self.score) % 50 == 0:
                    return {
                        'discard': discard_option,
                        'draw': self.draw_options.index(draw_card),
                    }
        return None

    def action_to_minimize_score(self):
        """
        Decide what action to take to minimize the score.

        Returns:
            dict: The action to take to minimize the score.
        """
        action = self._simulate_next_turn()
        return {
            'discard': action['discard'],
            'draw': action['draw'],
        }
    
    def _get_discard_options(self, hand=None):
        if hand is None:
            hand = self.hand
        discard_options = [[card] for card in hand]  # individual cards

        # Split hand into jokers and non-jokers
        jokers = [card for card in hand if card.rank == 'Joker']
        non_jokers = [card for card in hand if card.rank != 'Joker']

        # Check for valid sets and runs in the non-jokers
        for combo_size in range(2, len(non_jokers) + 1):
            for combo in itertools.combinations(non_jokers, combo_size):
                # Check if combo is a set
                if len(set(card.rank for card in combo)) == 1:
                    for num_jokers in range(len(jokers) + 1):  # add jokers to set
                        for joker_combo in itertools.combinations(jokers, num_jokers):
                            discard_options.append(list(combo) + list(joker_combo))
                # Check if combo of the same suit can be turned into a run using jokers
                elif len(set(card.suit for card in combo)) == 1:
                    sorted_combo = sorted(combo, key=lambda card: card.rank_index())

                    # Calculate gaps
                    gaps = [(i, sorted_combo[i+1].rank_index() - sorted_combo[i].rank_index() - 1)
                            for i in range(len(sorted_combo) - 1)
                            if sorted_combo[i+1].rank_index() - sorted_combo[i].rank_index() > 1]

                    if sum(gap for _, gap in gaps) <= len(jokers):
                        joker_index = 0
                        for i, gap in gaps:
                            for _ in range(gap):
                                if joker_index < len(jokers):
                                    sorted_combo.insert(i + 1, jokers[joker_index])
                                    joker_index += 1

                        # Add remaining jokers at the beginning and end of the run
                        remaining_jokers = jokers[joker_index:]
                        for joker in remaining_jokers:
                            if sorted_combo[0].rank_index() > 1:
                                discard_options.append([joker] + sorted_combo)  # add to the beginning if the first card isn't Ace
                            if sorted_combo[-1].rank_index() < 13:
                                discard_options.append(sorted_combo + [joker])  # add to the end if the last card isn't King
                        
                        if len(sorted_combo) >= 3:
                            discard_options.append(sorted_combo)  # add the potential run with jokers

        return discard_options

    def _option_value(self, option):
        return sum(card.value for card in option)

    def _simulate_action(self, potential_hand, draw_card):
        # Simulates the score for a specific discard & draw action
        # Returns the score and the discard options for the best score        
        new_hand = potential_hand + [draw_card]
        next_discard_options = self._get_discard_options(new_hand)
        best_next_discard_options = self._get_best_discard_options(next_discard_options)
        
        future_expected_points = float('inf')

        best_next_discard_option = None
        for discard_option in best_next_discard_options:
            expected_points = self._calculate_new_total_points(new_hand, discard_option)
            if expected_points < future_expected_points:
                future_expected_points = expected_points
                best_next_discard_option = discard_option
            if expected_points == future_expected_points: 
                future_expected_points = expected_points
                best_next_discard_option = discard_option
        
        return future_expected_points, best_next_discard_option

    def _get_best_action(self, post_discard_hand):
        best_score = float('inf')
        best_draw_card = 'deck'

        # Iterate over all possible cards to draw
        for i, draw_card in enumerate(self.draw_options):
            # Simulate action for drawing this card after discarding discard_option
            score, next_discard_option = self._simulate_action(post_discard_hand, draw_card)

            # Update the best action if the current score is lower or same w lower hand
            if score < best_score:
                best_score = score
                best_draw_card = i

        return best_draw_card, best_score

    def _simulate_next_turn(self):
        best_discard = self._get_best_discard_options(self._get_discard_options())[0]
        best_score = sum(card.value for card in self.hand) - sum(card.value for card in best_discard) + 0 # Assume draw joker...
        best_draw_card = 'deck'

        # Iterate over all possible discard options
        discard_options = self._get_discard_options()
        for discard_option in discard_options:
            # Create a hand after discarding the current option
            post_discard_hand = [card for card in self.hand if card not in discard_option]
            
            # For each possible discard, get the best action for the potential next turn
            draw_card, score = self._get_best_action(post_discard_hand)

            # Update the best action if the current score is lower
            if score < best_score:
                best_score = score
                best_draw_card = draw_card
                best_discard = discard_option
            if score == best_score:
                if sum(card.value for card in discard_option) < sum(card.value for card in best_discard):
                    best_score = score
                    best_draw_card = draw_card
                    best_discard = discard_option
        draw_string = best_draw_card if best_draw_card == 'deck' else str(self.draw_options[best_draw_card])
        return {'draw': best_draw_card, 'discard': best_discard, 'points': best_score}

    def _get_best_discard_options(self, discard_options):
        """
        Determine the best option to discard from the given list of discard options.
        """
        best_discard_options = []    
        best_points = 0 # Initialize

        for option in discard_options:
            discard_points = sum(card.value for card in option)
            if discard_points > best_points:
                best_points = discard_points
                best_discard_options = [option]
            elif discard_points == best_points and len(best_discard_options) > 0: # keep jokers when you can
                if len(option) < len(best_discard_options[0]):
                    best_discard_options = [option]
                elif len(option) == len(best_discard_options[0]):
                    best_discard_options.append(option)
        
        return best_discard_options

    def _calculate_new_total_points(self, potential_hand, discard_option):
        """
        Calculate the new total points given a hand and the best discard option.
        """
        return sum(card.value for card in potential_hand if card not in discard_option)

    def should_declare_yaniv(self):
        """
        Decide whether to declare Yaniv based on the observed game state and the AI's objective.
        """
        # The AI should declare Yaniv if the total points in its hand is less than 5,
        # and it estimates that all other players have a higher hand value.
        own_hand_value = sum(card.value for card in self.hand)
        if own_hand_value > 5:
            return False
        
        if all(player_info['estimated_score'] > own_hand_value for player_info in self.other_players.values()):
            return True
        return False

    def estimate_hand_values(self):
        """
        Estimate the hand values for the other players.
        """
        for player_name, player_info in self.other_players.items():
            known_cards = [card for player_info in self.other_players.values() for card in player_info['known_cards']]
            # print(f"-- Known cards for {player_name}: {known_cards}")
            unknown_cards_count = player_info['hand_count'] - len(player_info['known_cards'])
            estimated_unknown_card_score = self.estimate_unknown_cards(unknown_cards_count, known_cards)
            player_info['estimated_score'] = sum(card.value for card in player_info['known_cards']) + estimated_unknown_card_score

    def estimate_unknown_cards(self, num_unknown_cards, known_cards):
        """
        TODO: Should probably not naively Yaniv, this just being random
        Args:
            num_cards (int): The number of cards to estimate.
            known_cards (list): The known cards.

        Returns:
            list: The estimated cards.
        """
        return num_unknown_cards * 5
