// AIPlayerV2: Strategic improvements to the base AI.
//
// Changes over base AIPlayer:
//   1. Threat-reactive feed penalty — more careful about feeding opponents
//      when they're close to Yaniv (0.22 → 0.22 + 0.12*threat)
//   2. Phase-scaled composition bonus — slightly stronger group-building
//      preference in early/mid game (cap 8 vs 6, weight 0.15 vs 0.10)
//   3. Moderately more aggressive Yaniv declaration at low hand values
//   4. Score-pressure-aware Yaniv — more willing to call when score is
//      high (60+) and elimination risk is real

const { AIPlayer } = require('./aiplayer');

function containsCard(cards, target) {
  return cards.some((card) => card._card === target._card);
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

class AIPlayerV2 extends AIPlayer {
  // -----------------------------------------------------------------------
  // Threat-reactive feed penalty: base 0.22 scales up to 0.34 when
  // opponents are threatening Yaniv.
  // -----------------------------------------------------------------------

  _heuristic_action_cost(threat, immediate_points, feed_penalty, joker_discard_penalty) {
    const feed_weight = 0.22 + 0.12 * threat;
    return (0.06 * threat * immediate_points) + (feed_weight * feed_penalty) + (0.08 * joker_discard_penalty);
  }

  // -----------------------------------------------------------------------
  // Phase-scaled composition bonus — early game favors groups more.
  // -----------------------------------------------------------------------

  *_iter_candidate_actions(context) {
    const discard_options = this._get_discard_options_cached(this.hand);
    const hand_value = this.hand.reduce((sum, c) => sum + c.value, 0);
    const comp_weight = hand_value >= 15 ? 0.15 : hand_value >= 8 ? 0.12 : 0.10;

    for (const discard_option of discard_options) {
      const post_discard_hand = this.hand.filter((card) => !containsCard(discard_option, card));
      const post_turn_without_draw = post_discard_hand.reduce((sum, card) => sum + card.value, 0);
      const discard_value = discard_option.reduce((sum, card) => sum + card.value, 0);
      const feed_penalty = this._feed_penalty(discard_option, context.known_ranks, context.known_suit_ranks);
      const joker_discard_penalty = 1.5 * discard_option.filter((card) => card.rank === 'Joker').length;

      for (let i = 0; i < this.draw_options.length; i += 1) {
        const draw_card = this.draw_options[i];
        const [future_score, best_next_discard] = this._simulate_action(post_discard_hand, draw_card, false);
        const immediate_points = post_turn_without_draw + draw_card.value;
        const heuristic_cost = this._heuristic_action_cost(
          context.threat,
          immediate_points,
          feed_penalty,
          joker_discard_penalty,
        );
        const reset_bonus = this._reset_bonus(immediate_points, context.yaniv_next_turn_prob);

        let composition_bonus = 0;
        if (best_next_discard) {
          const new_hand = [...post_discard_hand, draw_card];
          const remaining = new_hand.filter((c) => !containsCard(best_next_discard, c));
          composition_bonus = comp_weight * this._hand_composition_bonus_v2(remaining);
        }

        const action_score = future_score + heuristic_cost - reset_bonus - composition_bonus;
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

      let deck_composition_bonus = 0;
      if (context.sampled_cards.length > 0) {
        let total_bonus = 0;
        for (const draw_card of context.sampled_cards) {
          const [, best_next] = this._simulate_action(post_discard_hand, draw_card, false);
          if (best_next) {
            const new_hand = [...post_discard_hand, draw_card];
            const remaining = new_hand.filter((c) => !containsCard(best_next, c));
            total_bonus += this._hand_composition_bonus_v2(remaining);
          }
        }
        deck_composition_bonus = comp_weight * (total_bonus / context.sampled_cards.length);
      }

      const action_score = expected_future + heuristic_cost + uncertainty_cost
        - expected_reset_bonus - deck_composition_bonus;
      yield [{ discard: discard_option, draw: 'deck' }, action_score, discard_value];
    }
  }

  _hand_composition_bonus_v2(hand) {
    let bonus = 0;
    const non_jokers = hand.filter((c) => c.rank !== 'Joker');
    const joker_count = hand.length - non_jokers.length;

    const rankCounts = {};
    for (const card of non_jokers) {
      rankCounts[card.rank] = (rankCounts[card.rank] || 0) + 1;
    }
    for (const [rank, count] of Object.entries(rankCounts)) {
      if (count >= 2) {
        const card_value = non_jokers.find((c) => c.rank === rank).value;
        bonus += 1.2 + 0.08 * card_value * count;
      }
    }

    const suitCards = {};
    for (const card of non_jokers) {
      if (!suitCards[card.suit]) suitCards[card.suit] = [];
      suitCards[card.suit].push(card);
    }
    for (const cards of Object.values(suitCards)) {
      if (cards.length < 2) continue;
      cards.sort((a, b) => a.rank_index() - b.rank_index());
      for (let i = 0; i < cards.length - 1; i += 1) {
        const gap = cards[i + 1].rank_index() - cards[i].rank_index();
        if (gap === 1) {
          bonus += 1.5 + 0.06 * (cards[i].value + cards[i + 1].value);
        } else if (gap === 2 && joker_count > 0) {
          bonus += 0.8;
        }
      }
    }

    return Math.min(8.0, bonus);
  }

  // -----------------------------------------------------------------------
  // Yaniv declaration: slightly more aggressive, especially under score
  // pressure.  Also accounts for opponent hand count more heavily —
  // fewer cards in opponent's hand = higher assaf risk.
  // -----------------------------------------------------------------------

  should_declare_yaniv() {
    const own_hand_value = this.hand.reduce((sum, card) => sum + card.value, 0);
    if (own_hand_value > 5) {
      return false;
    }

    if (Object.keys(this.other_players).length === 0) {
      return own_hand_value <= 3;
    }

    const unseen = this._get_unseen_cards();
    const [mean_value, var_value] = this._mean_and_variance(unseen);

    let not_assaf_prob = 1;
    for (const player_info of Object.values(this.other_players)) {
      const p = this._estimate_assaf_probability(player_info, own_hand_value, mean_value, var_value);
      not_assaf_prob *= (1 - p);
    }
    const assaf_risk = 1 - not_assaf_prob;

    // Slightly more aggressive base thresholds
    const thresholdMap = {
      0: 0.62,  // was 0.60
      1: 0.56,  // was 0.55
      2: 0.46,  // was 0.45
      3: 0.34,  // was 0.32
      4: 0.22,  // was 0.20
      5: 0.13,  // was 0.12
    };
    let risk_threshold = thresholdMap[own_hand_value] ?? 0.11;

    // Under high score pressure, be more willing to declare.
    // At score 70+, you're 2-3 lost rounds from elimination.
    const score_pressure = clamp(this.score / 100, 0, 1);
    if (score_pressure >= 0.7) {
      // Desperate: reduce threshold penalty
      risk_threshold *= (1 - 0.15 * score_pressure);
    } else if (score_pressure >= 0.4) {
      risk_threshold *= (1 - 0.25 * score_pressure);
    } else {
      risk_threshold *= (1 - 0.35 * score_pressure);
    }
    risk_threshold = Math.max(0.05, risk_threshold);

    // Reduce threshold if declaring would give opponents a reset
    const reset_penalty = this._evaluate_yaniv_reset_impact();
    risk_threshold -= reset_penalty * 0.04;
    risk_threshold = Math.max(0.05, risk_threshold);

    return assaf_risk <= risk_threshold;
  }
}

module.exports = { AIPlayerV2 };
