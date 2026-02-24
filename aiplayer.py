import itertools
import math
import random

from player import Player, Card


class AIPlayer(Player):
    def __init__(self, name, policy='v2', rollout_samples=24):
        super().__init__(name)
        self.policy = policy if policy in ('v1', 'v2') else 'v2'
        self.rollout_samples = max(4, int(rollout_samples))
        self.other_players = {}
        self.draw_options = []
        self.public_discard_pile = []

        # Lightweight caches keyed by hand signature to reduce repeated search work.
        self._discard_options_cache = {}
        self._best_residual_cache = {}

    def observe_round(self, round_info):
        """
        Update the AI's knowledge based on the information given at the end of a round.

        Args:
            round_info (dict): A dictionary containing information about each remaining player and their current scores.
        """
        self.other_players = {}
        self.draw_options = []
        self.public_discard_pile = []
        self._discard_options_cache.clear()
        self._best_residual_cache.clear()
        for player_info in round_info:
            if player_info['name'] != self.name:
                self.other_players[player_info['name']] = {
                    'current_score': player_info['score'],
                    'hand_count': 5,
                    'known_cards': [],
                    'estimated_score': 50,
                }

    def observe_turn(self, turn_info, discard_pile, draw_options):
        """
        Update the AI's knowledge based on the information given after each turn.

        Args:
            turn_info (dict): A dictionary containing information about the player who just played, the number of cards
                              remaining in their hand, the card(s) they discarded, and the card they drew if it was
                              from the discard pile.
            discard_pile (list): The current discard pile.
        """
        player_name = turn_info['player'].name
        self.draw_options = list(draw_options)
        self.public_discard_pile = list(discard_pile)

        if player_name in self.other_players:
            self.other_players[player_name]['hand_count'] = turn_info['hand_count']

            discarded_cards = turn_info['discarded_cards']
            drawn_card = turn_info['drawn_card']  # None when drawn from deck

            for card in discarded_cards:
                if card in self.other_players[player_name]['known_cards']:
                    self.other_players[player_name]['known_cards'].remove(card)

            if drawn_card is not None:
                if isinstance(drawn_card, int):
                    # Legacy wire format can send draw-option index.
                    if 0 <= drawn_card < len(draw_options):
                        drawn_card = draw_options[drawn_card]
                    else:
                        drawn_card = None
                if drawn_card is not None:
                    self.other_players[player_name]['known_cards'].append(
                        drawn_card)

            self.estimate_hand_values()

    def decide_action(self):
        """Decide what action to take based on the observed game state."""
        if self.policy == 'v2':
            return self._decide_action_v2()
        return self._decide_action_v1()

    def _decide_action_v1(self):
        # First, check if the AI estimates that another player is going to declare Yaniv on their next turn
        # and the AI can perform an action so their hand sums to a score that would allow them to reset.
        for player_info in self.other_players.values():
            if player_info['estimated_score'] <= 5:
                reset_action = self.action_to_reset()
                if reset_action is not None:
                    return reset_action

        # If not, play to win the hand with the lowest score.
        return self.action_to_minimize_score()

    def _decide_action_v2(self):
        # Preserve reset opportunism from v1, then evaluate all legal actions by EV.
        for player_info in self.other_players.values():
            if player_info['estimated_score'] <= 5:
                reset_action = self.action_to_reset()
                if reset_action is not None:
                    return reset_action

        unseen_cards = self._get_unseen_cards()
        threat = self._opponent_threat_score()
        best_action = None
        best_score = float('inf')
        best_discard_value = -1

        discard_options = self._get_discard_options_cached(self.hand)
        for discard_option in discard_options:
            post_discard_hand = [
                card for card in self.hand if card not in discard_option]
            feed_penalty = self._feed_penalty(discard_option)
            discard_value = sum(card.value for card in discard_option)
            joker_discard_penalty = 1.5 * \
                sum(1 for card in discard_option if card.rank == 'Joker')
            post_turn_without_draw = sum(
                card.value for card in post_discard_hand)

            # Known draw options from discard pile.
            for i, draw_card in enumerate(self.draw_options):
                future_score, _best_discard = self._simulate_action(
                    post_discard_hand, draw_card)
                immediate_points = post_turn_without_draw + draw_card.value
                heuristic_cost = (0.06 * threat * immediate_points) + \
                    (0.12 * feed_penalty) + (0.08 * joker_discard_penalty)
                action_score = future_score + heuristic_cost
                if action_score < best_score or (
                    action_score == best_score and discard_value > best_discard_value
                ):
                    best_score = action_score
                    best_discard_value = discard_value
                    best_action = {'discard': discard_option, 'draw': i}

            # Unknown deck draw.
            expected_future, expected_immediate, draw_variance = self._evaluate_deck_draw(
                post_discard_hand,
                unseen_cards
            )
            uncertainty_cost = 0.04 * math.sqrt(draw_variance) * (1.0 + threat)
            heuristic_cost = (0.06 * threat * expected_immediate) + \
                (0.12 * feed_penalty) + (0.08 * joker_discard_penalty)
            action_score = expected_future + heuristic_cost + uncertainty_cost
            if action_score < best_score or (
                action_score == best_score and discard_value > best_discard_value
            ):
                best_score = action_score
                best_discard_value = discard_value
                best_action = {'discard': discard_option, 'draw': 'deck'}

        if best_action is None:
            return self.action_to_minimize_score()
        return best_action

    def action_to_reset(self):
        """
        Returns:
            dict: Action to take if the AI can reset with a card in discard options, None otherwise.
        """
        # The AI can reset if there is discard and replace with a card it could draw from discard_options,
        # where (drawn card value - discard value + AIPlayer's current score) % 50 = 0.
        for discard_option in self._get_discard_options():
            discard_value = sum(card.value for card in discard_option)
            for draw_card in self.draw_options:
                if (discard_value - draw_card.value + self.score) % 50 == 0:
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
        discard_options = [[card] for card in hand]

        jokers = [card for card in hand if card.rank == 'Joker']
        non_jokers = [card for card in hand if card.rank != 'Joker']

        for combo_size in range(2, len(non_jokers) + 1):
            for combo in itertools.combinations(non_jokers, combo_size):
                if len(set(card.rank for card in combo)) == 1:
                    for num_jokers in range(len(jokers) + 1):
                        for joker_combo in itertools.combinations(jokers, num_jokers):
                            discard_options.append(
                                list(combo) + list(joker_combo))
                elif len(set(card.suit for card in combo)) == 1:
                    sorted_combo = sorted(
                        combo, key=lambda card: card.rank_index())

                    gaps = [
                        (i, sorted_combo[i + 1].rank_index() -
                         sorted_combo[i].rank_index() - 1)
                        for i in range(len(sorted_combo) - 1)
                        if sorted_combo[i + 1].rank_index() - sorted_combo[i].rank_index() > 1
                    ]

                    if sum(gap for _, gap in gaps) <= len(jokers):
                        joker_index = 0
                        for i, gap in gaps:
                            for _ in range(gap):
                                if joker_index < len(jokers):
                                    sorted_combo.insert(
                                        i + 1, jokers[joker_index])
                                    joker_index += 1

                        remaining_jokers = jokers[joker_index:]
                        for joker in remaining_jokers:
                            if sorted_combo[0].rank_index() > 1:
                                discard_options.append([joker] + sorted_combo)
                            if sorted_combo[-1].rank_index() < 13:
                                discard_options.append(sorted_combo + [joker])

                        if len(sorted_combo) >= 3:
                            discard_options.append(sorted_combo)

        return discard_options

    def _get_discard_options_cached(self, hand):
        signature = self._hand_signature(hand)
        cached = self._discard_options_cache.get(signature)
        if cached is None:
            cached = self._get_discard_options(hand)
            self._discard_options_cache[signature] = cached
        return cached

    def _hand_signature(self, hand):
        return tuple(sorted(card._card for card in hand))

    def _option_value(self, option):
        return sum(card.value for card in option)

    def _simulate_action(self, potential_hand, draw_card):
        # Simulates the score for a specific discard & draw action.
        # Returns the score and the discard options for the best score.
        new_hand = potential_hand + [draw_card]
        next_discard_options = self._get_discard_options(new_hand)
        best_next_discard_options = self._get_best_discard_options(
            next_discard_options)

        future_expected_points = float('inf')
        best_next_discard_option = None
        for discard_option in best_next_discard_options:
            expected_points = self._calculate_new_total_points(
                new_hand, discard_option)
            if expected_points <= future_expected_points:
                future_expected_points = expected_points
                best_next_discard_option = discard_option

        return future_expected_points, best_next_discard_option

    def _get_best_action(self, post_discard_hand):
        best_score = float('inf')
        best_draw_card = 'deck'

        for i, draw_card in enumerate(self.draw_options):
            score, _next_discard_option = self._simulate_action(
                post_discard_hand, draw_card)
            if score < best_score:
                best_score = score
                best_draw_card = i

        return best_draw_card, best_score

    def _simulate_next_turn(self):
        best_discard = self._get_best_discard_options(
            self._get_discard_options())[0]
        best_score = sum(card.value for card in self.hand) - \
            sum(card.value for card in best_discard) + 0
        best_draw_card = 'deck'

        discard_options = self._get_discard_options()
        for discard_option in discard_options:
            post_discard_hand = [
                card for card in self.hand if card not in discard_option]
            draw_card, score = self._get_best_action(post_discard_hand)

            if score < best_score:
                best_score = score
                best_draw_card = draw_card
                best_discard = discard_option
            if score == best_score:
                if sum(card.value for card in discard_option) < sum(card.value for card in best_discard):
                    best_score = score
                    best_draw_card = draw_card
                    best_discard = discard_option
        return {'draw': best_draw_card, 'discard': best_discard, 'points': best_score}

    def _get_best_discard_options(self, discard_options):
        """
        Determine the best option to discard from the given list of discard options.
        """
        best_discard_options = []
        best_points = 0

        for option in discard_options:
            discard_points = sum(card.value for card in option)
            if discard_points > best_points:
                best_points = discard_points
                best_discard_options = [option]
            elif discard_points == best_points and len(best_discard_options) > 0:
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
        if self.policy == 'v2':
            return self._should_declare_yaniv_v2()
        return self._should_declare_yaniv_v1()

    def _should_declare_yaniv_v1(self):
        own_hand_value = sum(card.value for card in self.hand)
        if own_hand_value > 5:
            return False
        if all(player_info['estimated_score'] > own_hand_value for player_info in self.other_players.values()):
            return True
        return False

    def _should_declare_yaniv_v2(self):
        own_hand_value = sum(card.value for card in self.hand)
        if own_hand_value > 5:
            return False

        if not self.other_players:
            return own_hand_value <= 2

        unseen = self._get_unseen_cards()
        mean_value, var_value = self._mean_and_variance(unseen)

        assaf_risk = 0.0
        not_assaf_prob = 1.0
        for player_info in self.other_players.values():
            p = self._estimate_assaf_probability(
                player_info, own_hand_value, mean_value, var_value)
            not_assaf_prob *= (1.0 - p)
        assaf_risk = 1.0 - not_assaf_prob

        risk_threshold = {
            0: 0.60,
            1: 0.55,
            2: 0.45,
            3: 0.32,
            4: 0.20,
            5: 0.12,
        }.get(own_hand_value, 0.10)

        # Higher current score means assaf risk is more expensive.
        score_pressure = min(1.0, max(0.0, self.score / 100.0))
        risk_threshold *= (1.0 - 0.35 * score_pressure)
        risk_threshold = max(0.03, risk_threshold)

        return assaf_risk <= risk_threshold

    def _estimate_assaf_probability(self, player_info, own_hand_value, mean_value, var_value):
        known_sum = sum(card.value for card in player_info['known_cards'])
        unknown_count = max(
            0, player_info['hand_count'] - len(player_info['known_cards']))
        if unknown_count == 0:
            return 1.0 if known_sum <= own_hand_value else 0.0

        expected = known_sum + unknown_count * mean_value
        variance = max(0.01, unknown_count * var_value)
        stddev = math.sqrt(variance)
        z = ((own_hand_value + 0.5) - expected) / stddev
        cdf = 0.5 * (1.0 + math.erf(z / math.sqrt(2.0)))
        return min(0.99, max(0.01, cdf))

    def estimate_hand_values(self):
        """Estimate the hand values for the other players."""
        all_known_cards = [
            card
            for other in self.other_players.values()
            for card in other['known_cards']
        ]

        for player_info in self.other_players.values():
            unknown_cards_count = player_info['hand_count'] - \
                len(player_info['known_cards'])
            estimated_unknown_card_score = self.estimate_unknown_cards(
                unknown_cards_count, all_known_cards)
            player_info['estimated_score'] = (
                sum(card.value for card in player_info['known_cards']
                    ) + estimated_unknown_card_score
            )

    def estimate_unknown_cards(self, num_unknown_cards, known_cards):
        """
        Estimate the expected score contribution of unknown cards.

        Args:
            num_unknown_cards (int): The number of hidden cards to estimate.
            known_cards (list): Known public cards (kept for compatibility; not used directly in v1).

        Returns:
            float: Estimated summed value of unknown cards.
        """
        if num_unknown_cards <= 0:
            return 0
        if self.policy != 'v2':
            return num_unknown_cards * 5

        unseen_cards = self._get_unseen_cards()
        mean_value, _var_value = self._mean_and_variance(unseen_cards)
        return num_unknown_cards * mean_value

    def _get_unseen_cards(self):
        visible_ids = {card._card for card in self.hand}
        visible_ids.update(card._card for card in self.draw_options)
        visible_ids.update(card._card for card in self.public_discard_pile)
        for player_info in self.other_players.values():
            visible_ids.update(
                card._card for card in player_info['known_cards'])

        return [card for card in Card.create_deck() if card._card not in visible_ids]

    def _mean_and_variance(self, cards):
        if not cards:
            return 5.0, 8.0
        values = [card.value for card in cards]
        mean_value = sum(values) / len(values)
        variance = sum((v - mean_value) ** 2 for v in values) / len(values)
        return mean_value, variance

    def _state_seed(self):
        seed = 2166136261
        for value in (
            [self.score]
            + sorted(card._card for card in self.hand)
            + sorted(card._card for card in self.draw_options)
            + [len(self.public_discard_pile)]
            + [
                player_info['hand_count']
                for _name, player_info in sorted(self.other_players.items(), key=lambda item: item[0])
            ]
        ):
            seed ^= int(value) + 0x9E3779B9
            seed = (seed * 16777619) & 0xFFFFFFFF
        return seed

    def _evaluate_deck_draw(self, post_discard_hand, unseen_cards):
        if not unseen_cards:
            fallback = self._best_residual_points(post_discard_hand)
            immediate = sum(card.value for card in post_discard_hand) + 5.0
            return fallback, immediate, 8.0

        rng = random.Random(self._state_seed())
        sample_count = min(self.rollout_samples, len(unseen_cards))
        sampled_cards = rng.sample(unseen_cards, sample_count) if sample_count < len(
            unseen_cards) else unseen_cards

        future_scores = []
        immediate_scores = []
        for draw_card in sampled_cards:
            future_score, _best_discard = self._simulate_action(
                post_discard_hand, draw_card)
            future_scores.append(future_score)
            immediate_scores.append(
                sum(card.value for card in post_discard_hand) + draw_card.value)

        mean_future = sum(future_scores) / len(future_scores)
        mean_immediate = sum(immediate_scores) / len(immediate_scores)
        _mean_value, variance = self._mean_and_variance(unseen_cards)
        return mean_future, mean_immediate, variance

    def _evaluate_candidate_hand(self, hand_after, threat):
        immediate_points = sum(card.value for card in hand_after)
        best_residual = self._best_residual_points(hand_after)
        meld_potential = self._meld_potential_score(hand_after)

        # Lower is better.
        score = 0.68 * immediate_points + 0.32 * best_residual
        score -= 0.45 * meld_potential
        score += 0.30 * threat * immediate_points
        return score

    def _best_residual_points(self, hand):
        signature = self._hand_signature(hand)
        cached = self._best_residual_cache.get(signature)
        if cached is not None:
            return cached

        total = sum(card.value for card in hand)
        discard_options = self._get_discard_options_cached(hand)
        best_residual = total
        for option in discard_options:
            residual = total - sum(card.value for card in option)
            if residual < best_residual:
                best_residual = residual

        self._best_residual_cache[signature] = best_residual
        return best_residual

    def _meld_potential_score(self, hand):
        options = self._get_discard_options_cached(hand)
        combo_options = [opt for opt in options if len(opt) >= 2]
        if not combo_options:
            return 0.0

        longest = max(len(opt) for opt in combo_options)
        strongest = max(sum(card.value for card in opt)
                        for opt in combo_options)
        return (0.7 * longest) + (0.1 * strongest)

    def _opponent_threat_score(self):
        threat = 0.0
        for player_info in self.other_players.values():
            estimated = player_info.get('estimated_score', 50)
            hand_count = player_info.get('hand_count', 5)
            player_threat = max(0.0, (8.0 - estimated) / 8.0)
            if hand_count <= 2:
                player_threat += 0.30
            if hand_count <= 1:
                player_threat += 0.25
            threat = max(threat, player_threat)
        return min(1.5, threat)

    def _feed_penalty(self, discard_option):
        known_cards = [
            card
            for player_info in self.other_players.values()
            for card in player_info['known_cards']
        ]

        penalty = 0.0
        for card in discard_option:
            if card.rank == 'Joker':
                penalty += 4.0
                continue

            if card.value <= 3:
                penalty += 1.5
            elif card.value <= 5:
                penalty += 1.0
            else:
                penalty += 0.2

            if any(k.rank == card.rank for k in known_cards if k.rank != 'Joker'):
                penalty += 1.3

            if any(
                k.rank != 'Joker'
                and k.suit == card.suit
                and abs(k.rank_index() - card.rank_index()) <= 1
                for k in known_cards
            ):
                penalty += 0.8

        return penalty
