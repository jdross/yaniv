import random
import uuid

from aiplayer import AIPlayer
from player import Player
from card import Card


class YanivGame:
    def __init__(self, players=None, rng=None):
        self.game_id = str(uuid.uuid4())
        self._rng = rng if rng is not None else random
        self.deck = []
        self.discard_pile = []
        self.last_discard = []  # Track the most recent discarded cards separately
        self.slamdown_player = None  # name of player eligible to slamdown
        self.slamdown_card = None    # Card object that can be slammed down
        self.previous_scores = []
        self.current_player_index = 0
        if players:
            self._create_players(players)
        else:
            self.players = []

    def to_dict(self):
        # serialize the essential game state
        return {
            'game_id': self.game_id,
            'discard_pile': [card.serialize() for card in self.discard_pile],
            'players': [
                {
                    'name': player.name,
                    'score': player.score,
                    'hand': [card.serialize() for card in player.hand],
                    'is_ai': isinstance(player, AIPlayer),
                }
                for player in self.players
            ],
            'current_player_index': self.current_player_index,
            'previous_scores': list(self.previous_scores),
            'last_discard_size': len(self.last_discard),
            'slamdown_player': self.slamdown_player,
            'slamdown_card': self.slamdown_card._card if self.slamdown_card else None,
        }

    @classmethod
    def from_dict(cls, data):
        game = cls()

        game.game_id = data.get('game_id', str(uuid.uuid4()))

        players = []
        for player_data in data.get('players', []):
            is_ai = bool(player_data.get('is_ai', False))
            player = AIPlayer(player_data['name']) if is_ai else Player(
                player_data['name'])
            player.score = player_data.get('score', 0)
            player.hand = [Card.deserialize(card_data)
                           for card_data in player_data.get('hand', [])]
            players.append(player)

        game._create_players(players)
        game.current_player_index = data.get('current_player_index', 0)
        game.previous_scores = data.get(
            'previous_scores',
            [player.score for player in game.players],
        )
        game.discard_pile = [Card.deserialize(
            card_data) for card_data in data.get('discard_pile', [])]
        game.last_discard = game.discard_pile[-data.get(
            'last_discard_size', 0):]

        game._create_deck()
        used_ids = {card._card for card in game.discard_pile}
        used_ids |= {
            card._card for player in game.players for card in player.hand}
        game.deck = [card for card in game.deck if card._card not in used_ids]
        game._shuffle_deck()

        game.slamdown_player = data.get('slamdown_player')
        sdc = data.get('slamdown_card')
        game.slamdown_card = Card(sdc) if sdc is not None else None

        # Rehydrate AI observations used for turn decisions.
        round_info = [{"name": p.name, "score": p.score} for p in game.players]
        for player in game.players:
            if isinstance(player, AIPlayer):
                player.observe_round(round_info)

        return game

    ### Game API ###
    def start_game(self):
        """
        Start a new game by resetting the deck and discard pile, shuffling the deck, and dealing the cards.

        Raises:
            ValueError: If no players have been added to the game.
        """
        if not self.players:
            raise ValueError("No players have been added to the game.")
        self._deal_new_hand()

        # create inital round state for AIPlayers
        round_info = [{"name": p.name, "score": p.score} for p in self.players]
        for player in self.players:
            if isinstance(player, AIPlayer):
                player.observe_round(round_info)

    def start_turn(self):
        """
        Start a new turn.

        Returns:
            current_player (Player): The player who is currently taking their turn.
            discard_options (list): The list of cards that the current player can draw from the discard pile.
        """
        current_player = self._get_player()
        current_player.hand.sort()  # sort the hand by rank
        discard_options = self._get_draw_options()
        return current_player, discard_options

    def play_turn(self, player, action=None):
        """
        Play a turn for the specified player.

        Args:
            player (Player): The player who is currently taking their turn.
            action (dict): The action that the player is taking. The action should be a dictionary with keys 'discard'
                           (a list of cards to discard) and 'draw' (either 'deck' or an index of a card in discard pile).

        Raises:
            ValueError: If the 'discard' action is not a list of cards, or if the 'draw' action is not 'deck' or a valid
                        index of a card in discard pile.
        """
        if isinstance(player, AIPlayer):
            action = player.decide_action()

        if not isinstance(action['discard'], list):
            raise ValueError(
                "Invalid 'discard' action. Must be a list of cards.")

        # Capture hand identity before draw to detect the newly drawn card
        hand_before_ids = set(id(c) for c in player.hand)

        if action['draw'] == 'deck':
            drawn_card_obj = self._draw_card(player)
        elif isinstance(action['draw'], int) and action['draw'] >= 0:
            draw_options = self._get_draw_options()
            if action['draw'] < len(draw_options):
                drawn_card_obj = self._draw_card(
                    player, from_discard=True, draw_option_index=action['draw'])
            else:
                raise ValueError(
                    "Invalid 'draw' action. Index out of range of draw options.")
        else:
            raise ValueError(
                "Invalid 'draw' action. Must be 'deck' or a valid index of a card in discard pile.")

        # Identify the newly drawn card (for slamdown check and AI observation)
        newly_drawn = next((c for c in player.hand if id(c)
                           not in hand_before_ids), None)
        drawn_card = drawn_card_obj if action['draw'] != 'deck' else None
        self._discard_cards(player, action['discard'])

        # Check if a slamdown is possible before advancing the turn
        drew_from_deck = action['draw'] == 'deck'
        self._check_slamdown(
            player, action['discard'], newly_drawn, drew_from_deck)

        # Inform AIPlayers what happened
        for other_player in self.players:
            if isinstance(other_player, AIPlayer) and other_player != player:
                turn_info = {
                    "player": player,
                    "action": action,
                    "hand_count": len(player.hand),
                    "discarded_cards": action['discard'],
                    "drawn_card": drawn_card
                }
                other_player.observe_turn(
                    turn_info, self.discard_pile, self._get_draw_options())

        self._next_turn()
        return action

    def can_declare_yaniv(self, player):
        """
        Returns whether a player can declare yaniv
        """
        return sum(card.value for card in player.hand) <= 5

    def declare_yaniv(self, player):
        """
        Handle a Yaniv declaration by the specified player.

        Args:
            player (Player): The player who is declaring Yaniv.

        Raises:
            ValueError: If the player's hand sums to more than 5 points.

        Returns:
            update_info (dict): Information about the updates to the players' scores.
            eliminated_players (list): The list of players who have been eliminated from the game.
            winner (Player or None): The player who won the game, or None if the game has not ended.
        """
        if sum(card.value for card in player.hand) > 5:
            raise ValueError("Cannot declare Yaniv with more than 5 points.")

        # Clear any pending slamdown
        self.slamdown_player = None
        self.slamdown_card = None

        # Update previous scores
        self.previous_scores = [player.score for player in self.players]

        update_info = self._update_scores(player)
        eliminated_players = [p for p in self.players if p.score > 100]
        for p in eliminated_players:
            self.players.remove(p)
        # After removing eliminated players the index may be out of range; clamp it.
        if self.players:
            self.current_player_index = self.current_player_index % len(
                self.players)
        winner = self._check_end_of_game()

        self._deal_new_hand()
        # Inform AIPlayers
        round_info = [{"name": p.name, "score": p.score} for p in self.players]
        for player in self.players:
            if isinstance(player, AIPlayer):
                player.observe_round(round_info)

        return update_info, eliminated_players, winner

    ### Internal Methods ###
    def _create_players(self, players):
        self.players = players
        # Track previous scores to implement reset rule
        self.previous_scores = [0 for _ in players]
        self.current_player_index = self._rng.randint(
            0, len(players) - 1) if players else 0

    def _create_deck(self):
        self.deck = Card.create_deck()

    def _shuffle_deck(self):
        self._rng.shuffle(self.deck)

    def _deal_cards(self):
        for player in self.players:
            player.hand = []  # reset hand
            for _ in range(5):
                card = self.deck.pop(0)
                player.hand.append(card)

        # Move a card from the deck to the discard pile at the beginning of the game
        first_discard = self.deck.pop(0)
        self.discard_pile.append(first_discard)
        self.last_discard.append(first_discard)
        for player in self.players:
            if isinstance(player, AIPlayer):
                player.draw_options.append(first_discard)

    def _deal_new_hand(self):
        self.discard_pile = []
        self.last_discard = []
        self._create_deck()
        self._shuffle_deck()
        self._deal_cards()

    def _get_player(self):
        return self.players[self.current_player_index]

    def _next_turn(self):
        self.current_player_index = (
            self.current_player_index + 1) % len(self.players)

    def _is_valid_discard(self, cards):
        """Returns True if cards form a legal discard: single card, set (same rank), or run (3+ same suit, consecutive)."""
        if len(cards) == 1:
            return True
        # Set: all non-joker cards share the same rank
        non_jokers = [c for c in cards if c.rank != 'Joker']
        if not non_jokers or len(set(c.rank for c in non_jokers)) == 1:
            return True
        # Run: 3+ cards, same suit, consecutive (jokers fill gaps)
        if len(cards) >= 3 and self._return_run_if_valid(cards) is not False:
            return True
        return False

    def _discard_cards(self, player, cards):
        if not isinstance(cards, list):
            cards = [cards]

        if not self._is_valid_discard(cards):
            raise ValueError(
                "Invalid discard: must be a single card, a set (same rank), "
                "or a run (3 or more consecutive cards of the same suit)."
            )

        # A new discard clears any pending slamdown from the previous turn
        self.slamdown_player = None
        self.slamdown_card = None

        # Update discards
        self.last_discard = []
        for card in cards:
            player.hand.remove(card)
            self.discard_pile.append(card)
            self.last_discard.append(card)

    def _check_slamdown(self, player, discarded_cards, drawn_card, drew_from_deck):
        """After a turn, determine if the player can slamdown their drawn card."""
        self.slamdown_player = None
        self.slamdown_card = None

        # AI players can't slamdown (handled at room level, but guard here too)
        if isinstance(player, AIPlayer):
            return

        # Slamdowns are only eligible on deck draws.
        if not drew_from_deck:
            return

        # No card drawn, or player only has 1 card left (can't slam their last card)
        if drawn_card is None or len(player.hand) <= 1:
            return

        non_jokers_discarded = [
            c for c in discarded_cards if c.rank != 'Joker']

        # Case 1: Rank match — drawn card same rank as discarded set
        if non_jokers_discarded and drawn_card.rank == non_jokers_discarded[0].rank:
            self.slamdown_player = player.name
            self.slamdown_card = drawn_card
            return

        # Case 2: Run extension — drawn card extends the discarded run on either end
        run = self._return_run_if_valid(discarded_cards)
        if run:
            non_joker_run = [c for c in run if c.rank != 'Joker']
            if non_joker_run and drawn_card.rank != 'Joker':
                # Check same suit as the run
                run_suit = non_joker_run[0].suit
                if drawn_card.suit == run_suit:
                    low_rank = min(c.rank_index() for c in non_joker_run)
                    high_rank = max(c.rank_index() for c in non_joker_run)
                    drawn_rank = drawn_card.rank_index()
                    if drawn_rank == low_rank - 1 or drawn_rank == high_rank + 1:
                        self.slamdown_player = player.name
                        self.slamdown_card = drawn_card

    def perform_slamdown(self, player):
        """Execute a slamdown: remove the card from hand and append to the pile."""
        if self.slamdown_player != player.name:
            raise ValueError("No slamdown available for this player.")
        if self.slamdown_card not in player.hand:
            raise ValueError("Slamdown card not in hand.")
        if len(player.hand) <= 1:
            raise ValueError("Cannot slamdown your last card.")

        card = self.slamdown_card
        player.hand.remove(card)
        self.discard_pile.append(card)
        self.last_discard.append(card)

        self.slamdown_player = None
        self.slamdown_card = None

        return card

    def _return_run_if_valid(self, cards):
        if len(cards) < 3:
            return False

        non_joker_cards = [card for card in cards if card.rank != 'Joker']
        if not non_joker_cards:
            return False

        if len(set(card.suit for card in non_joker_cards)) > 1:
            return False

        sorted_non_jokers = sorted(non_joker_cards, key=lambda card: card.rank_index())
        ranks = [card.rank_index() for card in sorted_non_jokers]
        if any(ranks[i] == ranks[i + 1] for i in range(len(ranks) - 1)):
            return False

        gaps = [ranks[i + 1] - ranks[i] - 1 for i in range(len(ranks) - 1)]
        if any(gap < 0 for gap in gaps):
            return False

        joker_cards = [card for card in cards if card.rank == 'Joker']
        jokers_needed = sum(gaps)
        if jokers_needed > len(joker_cards):
            return False

        leading = 0
        while leading < len(cards) and cards[leading].rank == 'Joker':
            leading += 1
        trailing = 0
        while trailing < len(cards) - leading and cards[len(cards) - 1 - trailing].rank == 'Joker':
            trailing += 1

        leading_jokers = list(cards[:leading])
        trailing_jokers = list(cards[len(cards) - trailing:]) if trailing else []
        interior_jokers = [
            card
            for card in cards[leading:len(cards) - trailing]
            if card.rank == 'Joker'
        ]

        gap_jokers = []
        needed = jokers_needed
        while needed and interior_jokers:
            gap_jokers.append(interior_jokers.pop(0))
            needed -= 1
        while needed and leading_jokers:
            # Consume jokers nearest to the center first to preserve edge intent.
            gap_jokers.append(leading_jokers.pop())
            needed -= 1
        while needed and trailing_jokers:
            # Consume jokers nearest to the center first to preserve edge intent.
            gap_jokers.append(trailing_jokers.pop(0))
            needed -= 1
        if needed:
            return False

        ordered_run = list(leading_jokers)
        # Keep extra interior jokers at the low end of the run.
        ordered_run.extend(interior_jokers)

        gap_idx = 0
        for i, non_joker in enumerate(sorted_non_jokers):
            ordered_run.append(non_joker)
            if i < len(gaps):
                for _ in range(gaps[i]):
                    ordered_run.append(gap_jokers[gap_idx])
                    gap_idx += 1

        ordered_run.extend(trailing_jokers)
        if len(ordered_run) < 3:
            return False
        return ordered_run

    def _get_draw_options(self):
        top_cards = self.last_discard[:]

        # Check if the top cards form a run
        run = self._return_run_if_valid(top_cards)

        if run:
            # If it's a run, only the first and last cards are options
            options = [run[0], run[-1]]
        else:
            # If it's not a run, all cards are options
            options = top_cards

        return options

    def _draw_card(self, player, from_discard=False, draw_option_index=None):
        # reshuffle if empty deck
        if not self.deck:
            # Exclude all cards involved in the last set or run from the reshuffle
            last_set_or_run = list(self.last_discard)
            self.deck = [
                card for card in self.discard_pile if card not in last_set_or_run]
            self._shuffle_deck()
            self.discard_pile = list(last_set_or_run)

        if from_discard:
            if draw_option_index is None:
                raise ValueError("Draw option index is required for discard draws.")
            draw_options = list(self._get_draw_options())
            if draw_option_index < len(draw_options):
                card_to_draw = draw_options[draw_option_index]
                card_index_in_pile = self.discard_pile.index(card_to_draw)
                card = self.discard_pile.pop(
                    card_index_in_pile)  # remove card
            else:
                raise ValueError("Invalid discard option index.")
        else:
            card = self.deck.pop(0)
        player.hand.append(card)
        return card

    def _update_scores(self, yaniv_player):
        yaniv_points = sum(card.value for card in yaniv_player.hand)
        other_players = [
            player for player in self.players if player != yaniv_player]
        other_players_points = [
            sum(card.value for card in player.hand) for player in other_players]

        min_points = min(other_players_points)
        min_points_player = other_players[other_players_points.index(
            min_points)]

        update_info = {}

        if yaniv_points < min_points:
            for player in self.players:
                if player == yaniv_player:
                    player.score += 0
                else:
                    player.score += sum(card.value for card in player.hand)
        else:
            yaniv_player.score += 30
            update_info['assaf'] = {
                'assafed_by': min_points_player, 'assafed': yaniv_player}

        update_info['reset_players'] = self._reset_player_scores()

        return update_info

    def _reset_player_scores(self):
        reset_players = []
        for index, player in enumerate(self.players):
            if player.score in [50, 100] and self.previous_scores[index] < player.score:
                player.score -= 50
                reset_players.append(player)
        return reset_players

    def _check_end_of_game(self):
        players_with_100_or_fewer = [
            player for player in self.players if player.score <= 100]
        if len(players_with_100_or_fewer) == 1:
            return players_with_100_or_fewer[0]
        else:
            return None
