import itertools
import math
import random
from collections import OrderedDict
from dataclasses import dataclass

from player import Player
from card import Card


@dataclass(frozen=True)
class ActionContext:
    sampled_cards: list
    deck_variance: float
    known_ranks: set
    known_suit_ranks: dict
    threat: float
    yaniv_next_turn_prob: float


class AIPlayer(Player):
    _FULL_DECK = tuple(Card.create_deck())
    _MAX_CACHE_ENTRIES = 50_000

    def __init__(self, name, rollout_samples=24):
        super().__init__(name)
        self.rollout_samples = max(4, int(rollout_samples))
        self.other_players = {}
        self.draw_options = []
        self.public_discard_pile = []

        self._discard_options_cache = OrderedDict()
        self._best_residual_cache = OrderedDict()
        self._best_discard_options_cache = OrderedDict()
        self._simulate_action_cache = OrderedDict()

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
        self._best_discard_options_cache.clear()
        self._simulate_action_cache.clear()
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
                self.other_players[player_name]['known_cards'].append(drawn_card)

            self.estimate_hand_values()

    def _cache_set(self, cache, key, value):
        if key in cache:
            cache.pop(key)
        elif len(cache) >= self._MAX_CACHE_ENTRIES:
            cache.popitem(last=False)
        cache[key] = value

    def _cache_get(self, cache, key):
        value = cache.get(key)
        if value is None:
            return None
        cache.move_to_end(key)
        return value

    def decide_action(self):
        """Decide what action to take based on the observed game state."""
        for player_info in self.other_players.values():
            if player_info['estimated_score'] <= 5:
                reset_action = self.action_to_reset()
                if reset_action is not None:
                    return reset_action

        context = self._build_action_context()
        best_action = None
        best_score = float('inf')
        best_discard_value = -1

        for action, action_score, discard_value in self._iter_candidate_actions(context):
            if action_score < best_score or (
                action_score == best_score and discard_value > best_discard_value
            ):
                best_score = action_score
                best_discard_value = discard_value
                best_action = action

        if best_action is None:
            return self.action_to_minimize_score()
        return best_action

    def _build_action_context(self):
        unseen_cards = self._get_unseen_cards()
        sampled_cards, deck_variance = self._deck_rollout_context(unseen_cards)
        known_ranks, known_suit_ranks = self._known_card_indexes()
        threat = self._opponent_threat_score()
        yaniv_next_turn_prob = self._opponent_yaniv_next_turn_probability()
        return ActionContext(
            sampled_cards=sampled_cards,
            deck_variance=deck_variance,
            known_ranks=known_ranks,
            known_suit_ranks=known_suit_ranks,
            threat=threat,
            yaniv_next_turn_prob=yaniv_next_turn_prob,
        )

    def _iter_candidate_actions(self, context):
        discard_options = self._get_discard_options_cached(self.hand)
        for discard_option in discard_options:
            post_discard_hand = [
                card for card in self.hand if card not in discard_option]
            post_turn_without_draw = sum(card.value for card in post_discard_hand)
            discard_value = sum(card.value for card in discard_option)
            feed_penalty = self._feed_penalty(
                discard_option,
                known_ranks=context.known_ranks,
                known_suit_ranks=context.known_suit_ranks,
            )
            joker_discard_penalty = 1.5 * sum(
                1 for card in discard_option if card.rank == 'Joker')

            for i, draw_card in enumerate(self.draw_options):
                future_score, _best_discard = self._simulate_action(
                    post_discard_hand, draw_card, prune_to_best_discard=False)
                immediate_points = post_turn_without_draw + draw_card.value
                heuristic_cost = self._heuristic_action_cost(
                    threat=context.threat,
                    immediate_points=immediate_points,
                    feed_penalty=feed_penalty,
                    joker_discard_penalty=joker_discard_penalty,
                )
                reset_bonus = self._reset_bonus(
                    immediate_points,
                    context.yaniv_next_turn_prob,
                )
                action_score = future_score + heuristic_cost - reset_bonus
                yield {'discard': discard_option, 'draw': i}, action_score, discard_value

            expected_future, expected_immediate = self._evaluate_deck_draw_samples(
                post_discard_hand,
                context.sampled_cards,
                prune_to_best_discard=False,
            )
            expected_reset_bonus = self._expected_reset_bonus_from_samples(
                post_turn_without_draw,
                context.sampled_cards,
                context.yaniv_next_turn_prob,
            )
            uncertainty_cost = 0.04 * \
                math.sqrt(context.deck_variance) * (1.0 + context.threat)
            heuristic_cost = self._heuristic_action_cost(
                threat=context.threat,
                immediate_points=expected_immediate,
                feed_penalty=feed_penalty,
                joker_discard_penalty=joker_discard_penalty,
            )
            action_score = expected_future + heuristic_cost + \
                uncertainty_cost - expected_reset_bonus
            yield {'discard': discard_option, 'draw': 'deck'}, action_score, discard_value

    def _heuristic_action_cost(self, threat, immediate_points, feed_penalty, joker_discard_penalty):
        return (
            (0.06 * threat * immediate_points)
            + (0.12 * feed_penalty)
            + (0.08 * joker_discard_penalty)
        )

    def _opponent_yaniv_next_turn_probability(self):
        # Conservative estimate of "someone will likely Yaniv next turn" based on low estimated hands.
        if not self.other_players:
            return 0.0

        not_yaniv_prob = 1.0
        for player_info in self.other_players.values():
            estimated = player_info.get('estimated_score', 50)
            hand_count = player_info.get('hand_count', 5)

            if estimated > 6.5:
                continue

            if estimated <= 5.0:
                p = 0.55 + (5.0 - estimated) * 0.08
            else:
                p = 0.18 + (6.5 - estimated) * 0.25

            if hand_count <= 2:
                p += 0.10
            elif hand_count == 3:
                p += 0.05

            low_known = sum(1 for card in player_info['known_cards'] if card.value <= 3)
            p += 0.03 * low_known
            p = min(0.92, max(0.0, p))
            not_yaniv_prob *= (1.0 - p)

        return 1.0 - not_yaniv_prob

    def _reset_bonus(self, hand_total, yaniv_next_turn_prob):
        projected_score = self.score + hand_total
        if projected_score not in (50, 100):
            return 0.0

        # Opponent must both Yaniv and succeed for this to convert into our reset.
        if hand_total <= 5:
            success_factor = 0.25
        elif hand_total <= 7:
            success_factor = 0.55
        else:
            success_factor = 0.75

        expected_reset_value = 50.0 * yaniv_next_turn_prob * success_factor
        return min(24.0, expected_reset_value)

    def _expected_reset_bonus_from_samples(self, post_turn_without_draw, sampled_cards, yaniv_next_turn_prob):
        if not sampled_cards:
            return 0.0
        total_bonus = 0.0
        for draw_card in sampled_cards:
            hand_total = post_turn_without_draw + draw_card.value
            total_bonus += self._reset_bonus(hand_total, yaniv_next_turn_prob)
        return total_bonus / len(sampled_cards)

    def action_to_reset(self):
        """
        Returns:
            dict: Action to take if the AI can reset with a card in discard options, None otherwise.
        """
        # The AI can reset if there is discard and replace with a card it could draw from discard_options,
        # where (drawn card value - discard value + AIPlayer's current score) % 50 = 0.
        for discard_option in self._get_discard_options_cached(self.hand):
            discard_value = sum(card.value for card in discard_option)
            for draw_idx, draw_card in enumerate(self.draw_options):
                if (discard_value - draw_card.value + self.score) % 50 == 0:
                    return {
                        'discard': discard_option,
                        'draw': draw_idx,
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
        joker_count = len(jokers)
        rank_index_by_id = {card._card: card.rank_index() for card in hand}

        for combo_size in range(2, len(non_jokers) + 1):
            for combo in itertools.combinations(non_jokers, combo_size):
                first_rank = combo[0].rank
                if all(card.rank == first_rank for card in combo):
                    for num_jokers in range(joker_count + 1):
                        for joker_combo in itertools.combinations(jokers, num_jokers):
                            discard_options.append(
                                list(combo) + list(joker_combo))
                    continue

                first_suit = combo[0].suit
                if all(card.suit == first_suit for card in combo):
                    sorted_combo = sorted(combo, key=lambda card: rank_index_by_id[card._card])
                    gaps = [
                        (
                            i,
                            rank_index_by_id[sorted_combo[i + 1]._card] -
                            rank_index_by_id[sorted_combo[i]._card] - 1,
                        )
                        for i in range(len(sorted_combo) - 1)
                        if rank_index_by_id[sorted_combo[i + 1]._card] - rank_index_by_id[sorted_combo[i]._card] > 1
                    ]

                    if sum(gap for _, gap in gaps) <= joker_count:
                        sorted_combo = list(sorted_combo)
                        joker_index = 0
                        for i, gap in gaps:
                            for _ in range(gap):
                                if joker_index < joker_count:
                                    sorted_combo.insert(
                                        i + 1, jokers[joker_index])
                                    joker_index += 1

                        remaining_jokers = jokers[joker_index:]
                        for joker in remaining_jokers:
                            if rank_index_by_id[sorted_combo[0]._card] > 1:
                                discard_options.append([joker] + sorted_combo)
                            if rank_index_by_id[sorted_combo[-1]._card] < 13:
                                discard_options.append(sorted_combo + [joker])

                        if len(sorted_combo) >= 3:
                            discard_options.append(sorted_combo)

        return discard_options

    def _get_discard_options_cached(self, hand):
        signature = self._hand_signature(hand)
        cached = self._cache_get(self._discard_options_cache, signature)
        if cached is None:
            cached = self._get_discard_options(hand)
            self._cache_set(self._discard_options_cache, signature, cached)
        return cached

    def _hand_signature(self, hand):
        return tuple(sorted(card._card for card in hand))

    def _get_best_discard_options_cached(self, hand):
        signature = self._hand_signature(hand)
        cached = self._cache_get(self._best_discard_options_cache, signature)
        if cached is None:
            discard_options = self._get_discard_options_cached(hand)
            cached = self._get_best_discard_options(discard_options)
            self._cache_set(self._best_discard_options_cache, signature, cached)
        return cached

    def _simulate_action(self, potential_hand, draw_card, prune_to_best_discard=True):
        # Simulates the score for a specific discard & draw action.
        # Returns the score and the discard options for the best score.
        new_hand = potential_hand + [draw_card]
        signature = self._hand_signature(new_hand)
        cache_key = (signature, bool(prune_to_best_discard))
        cached = self._cache_get(self._simulate_action_cache, cache_key)
        if cached is not None:
            return cached

        if prune_to_best_discard:
            candidate_discard_options = self._get_best_discard_options_cached(new_hand)
        else:
            candidate_discard_options = self._get_discard_options_cached(new_hand)

        future_expected_points = float('inf')
        best_next_discard_option = None
        for discard_option in candidate_discard_options:
            expected_points = self._calculate_new_total_points(
                new_hand, discard_option)
            if expected_points <= future_expected_points:
                future_expected_points = expected_points
                best_next_discard_option = discard_option

        out = (future_expected_points, best_next_discard_option)
        self._cache_set(self._simulate_action_cache, cache_key, out)
        return out

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
        discard_options = self._get_discard_options_cached(self.hand)
        best_discard = self._get_best_discard_options(discard_options)[0]
        best_score = sum(card.value for card in self.hand) - \
            sum(card.value for card in best_discard) + 0
        best_draw_card = 'deck'

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
        own_hand_value = sum(card.value for card in self.hand)
        if own_hand_value > 5:
            return False

        if not self.other_players:
            return own_hand_value <= 2

        unseen = self._get_unseen_cards()
        mean_value, var_value = self._mean_and_variance(unseen)

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
        for player_info in self.other_players.values():
            unknown_cards_count = player_info['hand_count'] - \
                len(player_info['known_cards'])
            estimated_unknown_card_score = self.estimate_unknown_cards(
                unknown_cards_count)
            player_info['estimated_score'] = (
                sum(card.value for card in player_info['known_cards']
                    ) + estimated_unknown_card_score
            )

    def estimate_unknown_cards(self, num_unknown_cards):
        """
        Estimate the expected score contribution of unknown cards.

        Args:
            num_unknown_cards (int): The number of hidden cards to estimate.

        Returns:
            float: Estimated summed value of unknown cards.
        """
        if num_unknown_cards <= 0:
            return 0

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

        return [card for card in self._FULL_DECK if card._card not in visible_ids]

    def _known_card_indexes(self):
        known_ranks = set()
        known_suit_ranks = {}
        for player_info in self.other_players.values():
            for card in player_info['known_cards']:
                if card.rank == 'Joker':
                    continue
                known_ranks.add(card.rank)
                known_suit_ranks.setdefault(card.suit, set()).add(card.rank_index())
        return known_ranks, known_suit_ranks

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

    def _deck_rollout_context(self, unseen_cards):
        if not unseen_cards:
            return [], 8.0

        sample_count = min(self.rollout_samples, len(unseen_cards))
        if sample_count < len(unseen_cards):
            rng = random.Random(self._state_seed())
            sampled_cards = rng.sample(unseen_cards, sample_count)
        else:
            sampled_cards = unseen_cards

        _mean_value, variance = self._mean_and_variance(unseen_cards)
        return sampled_cards, variance

    def _evaluate_deck_draw_samples(self, post_discard_hand, sampled_cards, prune_to_best_discard=True):
        if not sampled_cards:
            baseline_residual = self._best_residual_points(post_discard_hand)
            immediate = sum(card.value for card in post_discard_hand) + 5.0
            return baseline_residual, immediate

        post_turn_without_draw = sum(card.value for card in post_discard_hand)
        future_total = 0.0
        immediate_total = 0.0
        for draw_card in sampled_cards:
            future_score, _best_discard = self._simulate_action(
                post_discard_hand,
                draw_card,
                prune_to_best_discard=prune_to_best_discard,
            )
            future_total += future_score
            immediate_total += post_turn_without_draw + draw_card.value

        sample_size = len(sampled_cards)
        return future_total / sample_size, immediate_total / sample_size

    def _best_residual_points(self, hand):
        signature = self._hand_signature(hand)
        cached = self._cache_get(self._best_residual_cache, signature)
        if cached is not None:
            return cached

        total = sum(card.value for card in hand)
        discard_options = self._get_discard_options_cached(hand)
        best_residual = total
        for option in discard_options:
            residual = total - sum(card.value for card in option)
            if residual < best_residual:
                best_residual = residual

        self._cache_set(self._best_residual_cache, signature, best_residual)
        return best_residual

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

    def _feed_penalty(self, discard_option, known_ranks=None, known_suit_ranks=None):
        if known_ranks is None or known_suit_ranks is None:
            known_ranks, known_suit_ranks = self._known_card_indexes()

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

            if card.rank in known_ranks:
                penalty += 1.3

            card_rank = card.rank_index()
            suit_ranks = known_suit_ranks.get(card.suit, set())
            if (
                card_rank in suit_ranks
                or (card_rank - 1) in suit_ranks
                or (card_rank + 1) in suit_ranks
            ):
                penalty += 0.8

        return penalty
