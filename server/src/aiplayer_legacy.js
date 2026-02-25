// Legacy AI policy: the pre-improvement strategy used for A/B benchmarking.
// Extends the current AIPlayer so instanceof checks work with YanivGame,
// but overrides the methods that were changed to restore the old behaviour.

const { AIPlayer } = require('./aiplayer');

function containsCard(cards, target) {
  return cards.some((card) => card._card === target._card);
}

class LegacyAIPlayer extends AIPlayer {
  // --- observe_round: no collection-tracking fields ---
  observe_round(round_info) {
    this.other_players = {};
    this.draw_options = [];
    this.public_discard_pile = [];
    this._discard_options_cache.clear();
    this._best_residual_cache.clear();
    this._best_discard_options_cache.clear();
    this._simulate_action_cache.clear();

    for (const player_info of round_info) {
      if (player_info.name !== this.name) {
        this.other_players[player_info.name] = {
          current_score: player_info.score,
          hand_count: 5,
          known_cards: [],
          estimated_score: 50,
          // Legacy: no pickup_history, discard_history, collected_ranks, collected_suit_ranks
          pickup_history: [],
          discard_history: [],
          collected_ranks: {},
          collected_suit_ranks: {},
        };
      }
    }
  }

  // --- observe_turn: no collection pattern tracking ---
  observe_turn(turn_info, discard_pile, draw_options) {
    const player_name = turn_info.player.name;
    this.draw_options = [...draw_options];
    this.public_discard_pile = [...discard_pile];

    if (Object.prototype.hasOwnProperty.call(this.other_players, player_name)) {
      const playerInfo = this.other_players[player_name];
      playerInfo.hand_count = turn_info.hand_count;

      const discarded_cards = turn_info.discarded_cards;
      const drawn_card = turn_info.drawn_card;

      for (const card of discarded_cards) {
        const idx = playerInfo.known_cards.findIndex((c) => c._card === card._card);
        if (idx !== -1) playerInfo.known_cards.splice(idx, 1);
      }

      if (drawn_card !== null && drawn_card !== undefined) {
        playerInfo.known_cards.push(drawn_card);
      }

      this.estimate_hand_values();
    }
  }

  // --- old heuristic weight: 0.12 for feed penalty ---
  _heuristic_action_cost(threat, immediate_points, feed_penalty, joker_discard_penalty) {
    return (0.06 * threat * immediate_points) + (0.12 * feed_penalty) + (0.08 * joker_discard_penalty);
  }

  // --- old iter: no composition bonus ---
  *_iter_candidate_actions(context) {
    const discard_options = this._get_discard_options_cached(this.hand);

    for (const discard_option of discard_options) {
      const post_discard_hand = this.hand.filter((card) => !containsCard(discard_option, card));
      const post_turn_without_draw = post_discard_hand.reduce((sum, card) => sum + card.value, 0);
      const discard_value = discard_option.reduce((sum, card) => sum + card.value, 0);
      const feed_penalty = this._feed_penalty(discard_option, context.known_ranks, context.known_suit_ranks);
      const joker_discard_penalty = 1.5 * discard_option.filter((card) => card.rank === 'Joker').length;

      for (let i = 0; i < this.draw_options.length; i += 1) {
        const draw_card = this.draw_options[i];
        const [future_score] = this._simulate_action(post_discard_hand, draw_card, false);
        const immediate_points = post_turn_without_draw + draw_card.value;
        const heuristic_cost = this._heuristic_action_cost(
          context.threat,
          immediate_points,
          feed_penalty,
          joker_discard_penalty,
        );
        const reset_bonus = this._reset_bonus(immediate_points, context.yaniv_next_turn_prob);
        const action_score = future_score + heuristic_cost - reset_bonus;

        yield [{ discard: discard_option, draw: i }, action_score, discard_value];
      }

      const [expected_future, expected_immediate] = this._evaluate_deck_draw_samples(
        post_discard_hand,
        context.sampled_cards,
        false,
      );
      const expected_reset_bonus = this._expected_reset_bonus_from_samples(
        post_turn_without_draw,
        context.sampled_cards,
        context.yaniv_next_turn_prob,
      );
      const uncertainty_cost = 0.04 * Math.sqrt(context.deck_variance) * (1 + context.threat);
      const heuristic_cost = this._heuristic_action_cost(
        context.threat,
        expected_immediate,
        feed_penalty,
        joker_discard_penalty,
      );
      const action_score = expected_future + heuristic_cost + uncertainty_cost - expected_reset_bonus;

      yield [{ discard: discard_option, draw: 'deck' }, action_score, discard_value];
    }
  }

  // --- old feed penalty: no collection-based penalties ---
  _feed_penalty(discard_option, known_ranks = null, known_suit_ranks = null) {
    if (known_ranks === null || known_suit_ranks === null) {
      [known_ranks, known_suit_ranks] = this._known_card_indexes();
    }

    let penalty = 0;

    for (const card of discard_option) {
      if (card.rank === 'Joker') {
        penalty += 4.0;
        continue;
      }

      if (card.value <= 3) {
        penalty += 1.5;
      } else if (card.value <= 5) {
        penalty += 1.0;
      } else {
        penalty += 0.2;
      }

      if (known_ranks.has(card.rank)) {
        penalty += 1.3;
      }

      const card_rank = card.rank_index();
      const suit_ranks = known_suit_ranks.get(card.suit) ?? new Set();
      if (
        suit_ranks.has(card_rank)
        || suit_ranks.has(card_rank - 1)
        || suit_ranks.has(card_rank + 1)
      ) {
        penalty += 0.8;
      }
    }

    return penalty;
  }

  // --- old should_declare_yaniv: no assaf hunting or reset awareness ---
  should_declare_yaniv() {
    const own_hand_value = this.hand.reduce((sum, card) => sum + card.value, 0);
    if (own_hand_value > 5) {
      return false;
    }

    if (Object.keys(this.other_players).length === 0) {
      return own_hand_value <= 2;
    }

    const unseen = this._get_unseen_cards();
    const [mean_value, var_value] = this._mean_and_variance(unseen);

    let not_assaf_prob = 1;
    for (const player_info of Object.values(this.other_players)) {
      const p = this._estimate_assaf_probability(player_info, own_hand_value, mean_value, var_value);
      not_assaf_prob *= (1 - p);
    }
    const assaf_risk = 1 - not_assaf_prob;

    const thresholdMap = {
      0: 0.60,
      1: 0.55,
      2: 0.45,
      3: 0.32,
      4: 0.20,
      5: 0.12,
    };
    let risk_threshold = thresholdMap[own_hand_value] ?? 0.10;

    const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
    const score_pressure = clamp(this.score / 100, 0, 1);
    risk_threshold *= (1 - 0.35 * score_pressure);
    risk_threshold = Math.max(0.03, risk_threshold);

    return assaf_risk <= risk_threshold;
  }
}

module.exports = { LegacyAIPlayer };
