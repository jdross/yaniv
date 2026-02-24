const crypto = require('node:crypto');

const { AIPlayer } = require('./aiplayer');
const { Player } = require('./player');
const { Card } = require('./card');

function randomUuid() {
  if (typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function defaultRandom() {
  return Math.random();
}

function shuffleInPlace(values, randomFn = defaultRandom) {
  for (let i = values.length - 1; i > 0; i -= 1) {
    const j = Math.floor(randomFn() * (i + 1));
    [values[i], values[j]] = [values[j], values[i]];
  }
}

function containsCard(cards, target) {
  return cards.some((card) => card._card === target._card);
}

class YanivGame {
  constructor(players = null, rng = null) {
    this.game_id = randomUuid();
    this._rng = rng;
    this.deck = [];
    this.discard_pile = [];
    this.last_discard = [];
    this.slamdown_player = null;
    this.slamdown_card = null;
    this.previous_scores = [];
    this.current_player_index = 0;

    if (players) {
      this._create_players(players);
    } else {
      this.players = [];
    }
  }

  _rand() {
    if (this._rng && typeof this._rng.random === 'function') {
      return this._rng.random();
    }
    return Math.random();
  }

  _randint(min, maxInclusive) {
    if (this._rng && typeof this._rng.randint === 'function') {
      return this._rng.randint(min, maxInclusive);
    }
    return min + Math.floor(this._rand() * (maxInclusive - min + 1));
  }

  to_dict() {
    return {
      game_id: this.game_id,
      discard_pile: this.discard_pile.map((card) => card.serialize()),
      players: this.players.map((player) => ({
        name: player.name,
        score: player.score,
        hand: player.hand.map((card) => card.serialize()),
        is_ai: player instanceof AIPlayer,
      })),
      current_player_index: this.current_player_index,
      previous_scores: [...this.previous_scores],
      last_discard_size: this.last_discard.length,
      slamdown_player: this.slamdown_player,
      slamdown_card: this.slamdown_card ? this.slamdown_card._card : null,
    };
  }

  static from_dict(data) {
    const game = new YanivGame();

    game.game_id = data.game_id || randomUuid();

    const players = [];
    for (const player_data of data.players || []) {
      const is_ai = Boolean(player_data.is_ai || false);
      const player = is_ai ? new AIPlayer(player_data.name) : new Player(player_data.name);
      player.score = player_data.score || 0;
      player.hand = (player_data.hand || []).map((card_data) => Card.deserialize(card_data));
      players.push(player);
    }

    game._create_players(players);
    game.current_player_index = data.current_player_index || 0;
    game.previous_scores = data.previous_scores || game.players.map((player) => player.score);
    game.discard_pile = (data.discard_pile || []).map((card_data) => Card.deserialize(card_data));

    const lastDiscardSize = data.last_discard_size || 0;
    game.last_discard = game.discard_pile.slice(-lastDiscardSize);

    game._create_deck();
    const used_ids = new Set(game.discard_pile.map((card) => card._card));
    for (const player of game.players) {
      for (const card of player.hand) {
        used_ids.add(card._card);
      }
    }
    game.deck = game.deck.filter((card) => !used_ids.has(card._card));
    game._shuffle_deck();

    game.slamdown_player = data.slamdown_player;
    const sdc = data.slamdown_card;
    game.slamdown_card = sdc !== null && sdc !== undefined ? new Card(sdc) : null;

    const round_info = game.players.map((player) => ({ name: player.name, score: player.score }));
    for (const player of game.players) {
      if (player instanceof AIPlayer) {
        player.observe_round(round_info);
      }
    }

    return game;
  }

  start_game() {
    if (!this.players || this.players.length === 0) {
      throw new Error('No players have been added to the game.');
    }

    this._deal_new_hand();

    const round_info = this.players.map((player) => ({ name: player.name, score: player.score }));
    for (const player of this.players) {
      if (player instanceof AIPlayer) {
        player.observe_round(round_info);
      }
    }
  }

  start_turn() {
    const current_player = this._get_player();
    current_player.hand.sort((a, b) => a._card - b._card);
    const discard_options = this._get_draw_options();
    return [current_player, discard_options];
  }

  play_turn(player, action = null) {
    if (player instanceof AIPlayer) {
      action = player.decide_action();
    }

    if (!Array.isArray(action.discard)) {
      throw new Error("Invalid 'discard' action. Must be a list of cards.");
    }

    const hand_before_refs = new Set(player.hand);
    let drawn_card_obj;

    if (action.draw === 'deck') {
      drawn_card_obj = this._draw_card(player);
    } else if (Number.isInteger(action.draw) && action.draw >= 0) {
      const draw_options = this._get_draw_options();
      if (action.draw < draw_options.length) {
        drawn_card_obj = this._draw_card(player, true, action.draw);
      } else {
        throw new Error("Invalid 'draw' action. Index out of range of draw options.");
      }
    } else {
      throw new Error("Invalid 'draw' action. Must be 'deck' or a valid index of a card in discard pile.");
    }

    const newly_drawn = player.hand.find((card) => !hand_before_refs.has(card)) || null;
    const drawn_card = action.draw !== 'deck' ? drawn_card_obj : null;
    this._discard_cards(player, action.discard);

    const drew_from_deck = action.draw === 'deck';
    this._check_slamdown(player, action.discard, newly_drawn, drew_from_deck);

    for (const other_player of this.players) {
      if (other_player instanceof AIPlayer && other_player !== player) {
        const turn_info = {
          player,
          action,
          hand_count: player.hand.length,
          discarded_cards: action.discard,
          drawn_card,
        };
        other_player.observe_turn(turn_info, this.discard_pile, this._get_draw_options());
      }
    }

    this._next_turn();
    return action;
  }

  can_declare_yaniv(player) {
    return player.hand.reduce((sum, card) => sum + card.value, 0) <= 5;
  }

  declare_yaniv(player) {
    if (player.hand.reduce((sum, card) => sum + card.value, 0) > 5) {
      throw new Error('Cannot declare Yaniv with more than 5 points.');
    }

    this.slamdown_player = null;
    this.slamdown_card = null;

    this.previous_scores = this.players.map((p) => p.score);

    const update_info = this._update_scores(player);
    const eliminated_players = this.players.filter((p) => p.score > 100);
    this.players = this.players.filter((p) => p.score <= 100);

    if (this.players.length > 0) {
      this.current_player_index = this.current_player_index % this.players.length;
    }

    const winner = this._check_end_of_game();

    this._deal_new_hand();
    const round_info = this.players.map((p) => ({ name: p.name, score: p.score }));
    for (const remainingPlayer of this.players) {
      if (remainingPlayer instanceof AIPlayer) {
        remainingPlayer.observe_round(round_info);
      }
    }

    return [update_info, eliminated_players, winner];
  }

  _create_players(players) {
    this.players = players;
    this.previous_scores = players.map(() => 0);
    this.current_player_index = players.length > 0 ? this._randint(0, players.length - 1) : 0;
  }

  _create_deck() {
    this.deck = Card.createDeck();
  }

  _shuffle_deck() {
    if (this._rng && typeof this._rng.shuffle === 'function') {
      this._rng.shuffle(this.deck);
      return;
    }
    shuffleInPlace(this.deck, this._rand.bind(this));
  }

  _deal_cards() {
    for (const player of this.players) {
      player.hand = [];
      for (let i = 0; i < 5; i += 1) {
        const card = this.deck.shift();
        player.hand.push(card);
      }
    }

    const first_discard = this.deck.shift();
    this.discard_pile.push(first_discard);
    this.last_discard.push(first_discard);

    for (const player of this.players) {
      if (player instanceof AIPlayer) {
        player.draw_options.push(first_discard);
      }
    }
  }

  _deal_new_hand() {
    this.discard_pile = [];
    this.last_discard = [];
    this._create_deck();
    this._shuffle_deck();
    this._deal_cards();
  }

  _get_player() {
    return this.players[this.current_player_index];
  }

  _next_turn() {
    this.current_player_index = (this.current_player_index + 1) % this.players.length;
  }

  _is_valid_discard(cards) {
    if (cards.length === 1) {
      return true;
    }

    const non_jokers = cards.filter((card) => card.rank !== 'Joker');
    if (non_jokers.length === 0 || new Set(non_jokers.map((card) => card.rank)).size === 1) {
      return true;
    }

    if (cards.length >= 3 && this._return_run_if_valid(cards) !== false) {
      return true;
    }

    return false;
  }

  _discard_cards(player, cards) {
    const cardsList = Array.isArray(cards) ? cards : [cards];

    if (!this._is_valid_discard(cardsList)) {
      throw new Error(
        'Invalid discard: must be a single card, a set (same rank), or a run (3 or more consecutive cards of the same suit).',
      );
    }

    this.slamdown_player = null;
    this.slamdown_card = null;

    this.last_discard = [];
    for (const card of cardsList) {
      const idx = player.hand.findIndex((h) => h._card === card._card);
      if (idx === -1) {
        throw new Error('Card not in hand');
      }
      const [removed] = player.hand.splice(idx, 1);
      this.discard_pile.push(removed);
      this.last_discard.push(removed);
    }
  }

  _check_slamdown(player, discarded_cards, drawn_card, drew_from_deck) {
    this.slamdown_player = null;
    this.slamdown_card = null;

    if (player instanceof AIPlayer) {
      return;
    }

    if (!drew_from_deck) {
      return;
    }

    if (drawn_card === null || drawn_card === undefined || player.hand.length <= 1) {
      return;
    }

    const non_jokers_discarded = discarded_cards.filter((card) => card.rank !== 'Joker');

    if (non_jokers_discarded.length > 0 && drawn_card.rank === non_jokers_discarded[0].rank) {
      this.slamdown_player = player.name;
      this.slamdown_card = drawn_card;
      return;
    }

    const run = this._return_run_if_valid(discarded_cards);
    if (run) {
      const non_joker_run = run.filter((card) => card.rank !== 'Joker');
      if (non_joker_run.length > 0 && drawn_card.rank !== 'Joker') {
        const run_suit = non_joker_run[0].suit;
        if (drawn_card.suit === run_suit) {
          const low_rank = Math.min(...non_joker_run.map((card) => card.rank_index()));
          const high_rank = Math.max(...non_joker_run.map((card) => card.rank_index()));
          const drawn_rank = drawn_card.rank_index();
          if (drawn_rank === low_rank - 1 || drawn_rank === high_rank + 1) {
            this.slamdown_player = player.name;
            this.slamdown_card = drawn_card;
          }
        }
      }
    }
  }

  perform_slamdown(player) {
    if (this.slamdown_player !== player.name) {
      throw new Error('No slamdown available for this player.');
    }
    if (!player.hand.some((card) => this.slamdown_card && card._card === this.slamdown_card._card)) {
      throw new Error('Slamdown card not in hand.');
    }
    if (player.hand.length <= 1) {
      throw new Error('Cannot slamdown your last card.');
    }

    const idx = player.hand.findIndex((card) => this.slamdown_card && card._card === this.slamdown_card._card);
    const [card] = player.hand.splice(idx, 1);
    this.discard_pile.push(card);
    this.last_discard.push(card);

    this.slamdown_player = null;
    this.slamdown_card = null;

    return card;
  }

  _return_run_if_valid(cards) {
    if (cards.length < 3) {
      return false;
    }

    const non_joker_cards = cards.filter((card) => card.rank !== 'Joker');
    if (non_joker_cards.length === 0) {
      return false;
    }

    if (new Set(non_joker_cards.map((card) => card.suit)).size > 1) {
      return false;
    }

    const sorted_non_jokers = [...non_joker_cards].sort((a, b) => a.rank_index() - b.rank_index());
    const ranks = sorted_non_jokers.map((card) => card.rank_index());

    for (let i = 0; i < ranks.length - 1; i += 1) {
      if (ranks[i] === ranks[i + 1]) {
        return false;
      }
    }

    const gaps = [];
    for (let i = 0; i < ranks.length - 1; i += 1) {
      const gap = ranks[i + 1] - ranks[i] - 1;
      if (gap < 0) {
        return false;
      }
      gaps.push(gap);
    }

    const joker_cards = cards.filter((card) => card.rank === 'Joker');
    const jokers_needed = gaps.reduce((sum, gap) => sum + gap, 0);
    if (jokers_needed > joker_cards.length) {
      return false;
    }

    let leading = 0;
    while (leading < cards.length && cards[leading].rank === 'Joker') {
      leading += 1;
    }

    let trailing = 0;
    while (trailing < cards.length - leading && cards[cards.length - 1 - trailing].rank === 'Joker') {
      trailing += 1;
    }

    const leading_jokers = cards.slice(0, leading);
    const trailing_jokers = trailing ? cards.slice(cards.length - trailing) : [];
    const interior_jokers = cards.slice(leading, cards.length - trailing).filter((card) => card.rank === 'Joker');

    const gap_jokers = [];
    let needed = jokers_needed;

    while (needed > 0 && interior_jokers.length > 0) {
      gap_jokers.push(interior_jokers.shift());
      needed -= 1;
    }
    while (needed > 0 && leading_jokers.length > 0) {
      gap_jokers.push(leading_jokers.pop());
      needed -= 1;
    }
    while (needed > 0 && trailing_jokers.length > 0) {
      gap_jokers.push(trailing_jokers.shift());
      needed -= 1;
    }
    if (needed > 0) {
      return false;
    }

    const ordered_run = [...leading_jokers, ...interior_jokers];

    let gap_idx = 0;
    for (let i = 0; i < sorted_non_jokers.length; i += 1) {
      const non_joker = sorted_non_jokers[i];
      ordered_run.push(non_joker);
      if (i < gaps.length) {
        for (let j = 0; j < gaps[i]; j += 1) {
          ordered_run.push(gap_jokers[gap_idx]);
          gap_idx += 1;
        }
      }
    }

    ordered_run.push(...trailing_jokers);
    if (ordered_run.length < 3) {
      return false;
    }

    return ordered_run;
  }

  _get_draw_options() {
    const top_cards = [...this.last_discard];
    const run = this._return_run_if_valid(top_cards);

    if (run) {
      return [run[0], run[run.length - 1]];
    }

    return top_cards;
  }

  _draw_card(player, from_discard = false, draw_option_index = null) {
    if (this.deck.length === 0) {
      const last_set_or_run = [...this.last_discard];
      this.deck = this.discard_pile.filter((card) => !containsCard(last_set_or_run, card));
      this._shuffle_deck();
      this.discard_pile = [...last_set_or_run];
    }

    let card;
    if (from_discard) {
      if (draw_option_index === null || draw_option_index === undefined) {
        throw new Error('Draw option index is required for discard draws.');
      }
      const draw_options = [...this._get_draw_options()];
      if (draw_option_index < draw_options.length) {
        const card_to_draw = draw_options[draw_option_index];
        const card_index_in_pile = this.discard_pile.findIndex((c) => c._card === card_to_draw._card);
        if (card_index_in_pile === -1) {
          throw new Error('Invalid discard option index.');
        }
        [card] = this.discard_pile.splice(card_index_in_pile, 1);
      } else {
        throw new Error('Invalid discard option index.');
      }
    } else {
      card = this.deck.shift();
    }

    player.hand.push(card);
    return card;
  }

  _update_scores(yaniv_player) {
    const yaniv_points = yaniv_player.hand.reduce((sum, card) => sum + card.value, 0);
    const other_players = this.players.filter((player) => player !== yaniv_player);
    const other_players_points = other_players.map((player) => player.hand.reduce((sum, card) => sum + card.value, 0));

    const min_points = Math.min(...other_players_points);
    const min_points_player = other_players[other_players_points.indexOf(min_points)];

    const update_info = {};

    if (yaniv_points < min_points) {
      for (const player of this.players) {
        if (player !== yaniv_player) {
          player.score += player.hand.reduce((sum, card) => sum + card.value, 0);
        }
      }
    } else {
      yaniv_player.score += 30;
      update_info.assaf = {
        assafed_by: min_points_player,
        assafed: yaniv_player,
      };
    }

    update_info.reset_players = this._reset_player_scores();
    return update_info;
  }

  _reset_player_scores() {
    const reset_players = [];

    for (let index = 0; index < this.players.length; index += 1) {
      const player = this.players[index];
      if ((player.score === 50 || player.score === 100) && this.previous_scores[index] < player.score) {
        player.score -= 50;
        reset_players.push(player);
      }
    }

    return reset_players;
  }

  _check_end_of_game() {
    const players_with_100_or_fewer = this.players.filter((player) => player.score <= 100);
    if (players_with_100_or_fewer.length === 1) {
      return players_with_100_or_fewer[0];
    }
    return null;
  }
}

module.exports = { YanivGame };
