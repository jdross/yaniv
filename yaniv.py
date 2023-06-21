import random, uuid
from aiplayer import *

class YanivGame:
    def __init__(self, players=None):
        self.game_id = str(uuid.uuid4())
        self.deck = []
        self.discard_pile = []
        self.last_discard = []  # Track the most recent discarded cards separately
        self.players = players if players else []
        if players:
            self._create_players(players)
        else:
            self.players = []
    
    def to_dict(self):
        # serialize the essential game state
        return {
            'game_id': self.game_id,
            'discard_pile': [card.serialize() for card in self.discard_pile],
            'players': [player.to_dict() for player in self.players],
            'current_player_index': self.current_player_index,
            'last_discard_size': len(self.last_discard),
        }
    
    @classmethod
    def from_dict(cls, data):
        # Create a method to construct a game from a dictionary
        game = cls()
        game.game_id = data['game_id']
        game.players = [Player.from_dict(player_data) for player_data in data['players']]
        game.current_player_index = data['current_player_index']
        game.discard_pile = [Card.deserialize(card_data) for card_data in data['discard_pile']]
        game.last_discard = game.discard_pile[-data['last_discard_size']:]
        
        game._create_deck()
        for card in game.discard_pile + [card for player in game.players for card in player.hand]:
            game.deck.remove(card)
        game._shuffle_deck()

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
        current_player.hand.sort() # sort the hand by rank
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
            raise ValueError("Invalid 'discard' action. Must be a list of cards.")
        
        if action['draw'] == 'deck':
            self._draw_card(player)
        elif isinstance(action['draw'], int) and action['draw'] >= 0:
            draw_options = self._get_draw_options()
            if action['draw'] < len(draw_options):
                self._draw_card(player, from_discard=True, draw_option_index=action['draw'])
            else:
                raise ValueError("Invalid 'draw' action. Index out of range of draw options.")
        else:
            raise ValueError("Invalid 'draw' action. Must be 'deck' or a valid index of a card in discard pile.")

        drawn_card = self.last_discard[action['draw']] if action['draw'] != 'deck' else None
        self._discard_cards(player, action['discard'])
        
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
                other_player.observe_turn(turn_info, self.discard_pile, self._get_draw_options())
        
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
        
        self.previous_scores = [player.score for player in self.players]  # Update previous scores
        
        update_info = self._update_scores(player)
        eliminated_players = [p for p in self.players if p.score > 100]
        for p in eliminated_players:
            self.players.remove(p)
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
        self.previous_scores = [0 for _ in players]  # Track previous scores to implement reset rule
        self.current_player_index = random.randint(0, len(players) - 1)  # Choose random first player

    def _create_deck(self):
        self.deck = Card.create_deck()

    def _shuffle_deck(self):
        random.shuffle(self.deck)

    def _deal_cards(self):
        for player in self.players:
            player.hand = [] #reset hand
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
        self.current_player_index = (self.current_player_index + 1) % len(self.players)

    def _discard_cards(self, player, cards):
        if not isinstance(cards, list):
            cards = [cards]

        # Update discards
        self.last_discard = []
        for card in cards:
            player.hand.remove(card)
            self.discard_pile.append(card)
            self.last_discard.append(card)
    
    def _return_run_if_valid(self, cards):
        # Extract all the non-joker cards
        non_joker_cards = [card for card in cards if card.rank != 'Joker']

        # Check if all non-joker cards have the same suit
        if len(set(card.suit for card in non_joker_cards)) > 1:
            return False

        # Get the ranks of the non-joker cards
        ranks = [card.rank_index() for card in non_joker_cards]
        ranks.sort()

        # Count the number of jokers
        num_jokers = len(cards) - len(non_joker_cards)

        # Calculate the number of Jokers needed to fill in the gaps in the ranks
        jokers_needed = sum(ranks[i + 1] - ranks[i] - 1 for i in range(len(ranks) - 1))

        # Check if the number of available Jokers is enough to fill in the gaps
        has_enough_jokers = jokers_needed <= num_jokers

        # A valid run needs to be at least 3 cards
        is_valid_length = len(ranks) + num_jokers >= 3

        if has_enough_jokers and is_valid_length:
            # If the run is valid, return the sorted run's cards with Jokers in their proper places
            sorted_run = []
            jokers = [card for card in cards if card.rank == 'Joker']
            for i in range(len(ranks) - 1):
                sorted_run.append(non_joker_cards[i])
                for _ in range(ranks[i + 1] - ranks[i] - 1):
                    sorted_run.append(jokers.pop())
            sorted_run.append(non_joker_cards[-1])
            sorted_run = jokers + sorted_run  # Add any remaining Jokers to the beginning of the run
            return sorted_run
        else:
            # If the run is invalid, return False
            return False

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
        #reshuffle if empty deck
        if not self.deck:
            # Exclude all cards involved in the last set or run from the reshuffle
            last_set_or_run = self.last_discard
            self.deck = [card for card in self.discard_pile if card not in last_set_or_run]
            self._shuffle_deck()
            self.discard_pile = last_set_or_run
        
        if from_discard:
            if draw_option_index is not None:
                draw_options = list(self._get_draw_options())
                if draw_option_index < len(draw_options):
                    card_to_draw = draw_options[draw_option_index]
                    card_index_in_pile = self.discard_pile.index(card_to_draw)
                    card = self.discard_pile.pop(card_index_in_pile) # remove card
                else:
                    raise ValueError("Invalid discard option index.")
            else:
                card = self.discard_pile.pop()
        else:
            card = self.deck.pop(0)
        player.hand.append(card)

    def _update_scores(self, yaniv_player):
        yaniv_points = sum(card.value for card in yaniv_player.hand)
        other_players = [player for player in self.players if player != yaniv_player]
        other_players_points = [sum(card.value for card in player.hand) for player in other_players]

        min_points = min(other_players_points)
        min_points_player = other_players[other_players_points.index(min_points)]

        update_info = {}

        if yaniv_points < min_points:
            for player in self.players:
                if player == yaniv_player:
                    player.score += 0
                else:
                    player.score += sum(card.value for card in player.hand)
        else:
            yaniv_player.score += 30
            update_info['assaf'] = {'assafed_by': min_points_player, 'assafed': yaniv_player}

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
        players_with_100_or_fewer = [player for player in self.players if player.score <= 100]
        if len(players_with_100_or_fewer) == 1:
            return players_with_100_or_fewer[0]
        else:
            return None