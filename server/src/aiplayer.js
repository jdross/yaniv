const { Player } = require('./player');
const { Card } = require('./card');

function combinations(values, size) {
  if (size === 0) return [[]];
  if (size > values.length) return [];
  if (size === 1) return values.map((value) => [value]);

  const out = [];
  for (let i = 0; i <= values.length - size; i += 1) {
    const head = values[i];
    const tails = combinations(values.slice(i + 1), size - 1);
    for (const tail of tails) {
      out.push([head, ...tail]);
    }
  }
  return out;
}

function containsCard(cards, target) {
  return cards.some((card) => card._card === target._card);
}

function removeFirstMatchingCard(cards, target) {
  const idx = cards.findIndex((card) => card._card === target._card);
  if (idx !== -1) {
    cards.splice(idx, 1);
    return true;
  }
  return false;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function erf(x) {
  const sign = x >= 0 ? 1 : -1;
  const absX = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * absX);
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const y = 1 - (((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-absX * absX));
  return sign * y;
}

function mulberry32(seed) {
  let t = seed >>> 0;
  return () => {
    t += 0x6d2b79f5;
    let x = Math.imul(t ^ (t >>> 15), 1 | t);
    x ^= x + Math.imul(x ^ (x >>> 7), 61 | x);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

function sampleWithoutReplacement(values, sampleCount, rng) {
  const copy = [...values];
  for (let i = 0; i < sampleCount; i += 1) {
    const j = i + Math.floor(rng() * (copy.length - i));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, sampleCount);
}

class AIPlayer extends Player {
  static _FULL_DECK = Card.createDeck();
  static _MAX_CACHE_ENTRIES = 50000;

  constructor(name, rollout_samples = 24) {
    super(name);
    this.rollout_samples = Math.max(4, Number.parseInt(rollout_samples, 10));
    this.other_players = {};
    this.draw_options = [];
    this.public_discard_pile = [];

    this._discard_options_cache = new Map();
    this._best_residual_cache = new Map();
    this._best_discard_options_cache = new Map();
    this._simulate_action_cache = new Map();
  }

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
          pickup_history: [],
          discard_history: [],
          collected_ranks: {},
          collected_suit_ranks: {},
        };
      }
    }
  }

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
        removeFirstMatchingCard(playerInfo.known_cards, card);
        playerInfo.discard_history.push(card);
      }

      if (drawn_card !== null && drawn_card !== undefined) {
        playerInfo.known_cards.push(drawn_card);
        playerInfo.pickup_history.push(drawn_card);
        if (drawn_card.rank !== 'Joker') {
          playerInfo.collected_ranks[drawn_card.rank] = (playerInfo.collected_ranks[drawn_card.rank] || 0) + 1;
          if (!playerInfo.collected_suit_ranks[drawn_card.suit]) {
            playerInfo.collected_suit_ranks[drawn_card.suit] = new Set();
          }
          playerInfo.collected_suit_ranks[drawn_card.suit].add(drawn_card.rank_index());
        }
      }

      this.estimate_hand_values();
    }
  }

  _cache_set(cache, key, value) {
    if (cache.has(key)) {
      cache.delete(key);
    } else if (cache.size >= AIPlayer._MAX_CACHE_ENTRIES) {
      const firstKey = cache.keys().next().value;
      cache.delete(firstKey);
    }
    cache.set(key, value);
  }

  _cache_get(cache, key) {
    if (!cache.has(key)) {
      return null;
    }
    const value = cache.get(key);
    cache.delete(key);
    cache.set(key, value);
    return value;
  }

  decide_action() {
    for (const player_info of Object.values(this.other_players)) {
      if (player_info.estimated_score <= 5) {
        const reset_action = this.action_to_reset();
        if (reset_action !== null) {
          return reset_action;
        }
      }
    }

    const context = this._build_action_context();
    let best_action = null;
    let best_score = Number.POSITIVE_INFINITY;
    let best_discard_value = -1;

    for (const [action, action_score, discard_value] of this._iter_candidate_actions(context)) {
      if (action_score < best_score || (action_score === best_score && discard_value > best_discard_value)) {
        best_score = action_score;
        best_discard_value = discard_value;
        best_action = action;
      }
    }

    if (best_action === null) {
      return this.action_to_minimize_score();
    }
    return best_action;
  }

  _build_action_context() {
    const unseen_cards = this._get_unseen_cards();
    const [sampled_cards, deck_variance] = this._deck_rollout_context(unseen_cards);
    const [known_ranks, known_suit_ranks] = this._known_card_indexes();
    const threat = this._opponent_threat_score();
    const yaniv_next_turn_prob = this._opponent_yaniv_next_turn_probability();

    return {
      sampled_cards,
      deck_variance,
      known_ranks,
      known_suit_ranks,
      threat,
      yaniv_next_turn_prob,
    };
  }

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
        const [future_score, best_next_discard] = this._simulate_action(post_discard_hand, draw_card, false);
        const immediate_points = post_turn_without_draw + draw_card.value;
        const heuristic_cost = this._heuristic_action_cost(
          context.threat,
          immediate_points,
          feed_penalty,
          joker_discard_penalty,
        );
        const reset_bonus = this._reset_bonus(immediate_points, context.yaniv_next_turn_prob);
        // Bonus for keeping cards with good set/run potential
        let composition_bonus = 0;
        if (best_next_discard) {
          const new_hand = [...post_discard_hand, draw_card];
          const remaining = new_hand.filter((c) => !containsCard(best_next_discard, c));
          composition_bonus = 0.10 * this._hand_composition_bonus(remaining);
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
      // Average composition bonus from deck draws
      let deck_composition_bonus = 0;
      if (context.sampled_cards.length > 0) {
        let total_bonus = 0;
        for (const draw_card of context.sampled_cards) {
          const [, best_next] = this._simulate_action(post_discard_hand, draw_card, false);
          if (best_next) {
            const new_hand = [...post_discard_hand, draw_card];
            const remaining = new_hand.filter((c) => !containsCard(best_next, c));
            total_bonus += this._hand_composition_bonus(remaining);
          }
        }
        deck_composition_bonus = 0.10 * (total_bonus / context.sampled_cards.length);
      }
      const action_score = expected_future + heuristic_cost + uncertainty_cost - expected_reset_bonus - deck_composition_bonus;

      yield [{ discard: discard_option, draw: 'deck' }, action_score, discard_value];
    }
  }

  _heuristic_action_cost(threat, immediate_points, feed_penalty, joker_discard_penalty) {
    return (0.06 * threat * immediate_points) + (0.22 * feed_penalty) + (0.08 * joker_discard_penalty);
  }

  _opponent_yaniv_next_turn_probability() {
    const opponents = Object.values(this.other_players);
    if (opponents.length === 0) {
      return 0;
    }

    let not_yaniv_prob = 1;
    for (const player_info of opponents) {
      const estimated = player_info.estimated_score ?? 50;
      const hand_count = player_info.hand_count ?? 5;

      if (estimated > 6.5) {
        continue;
      }

      let p;
      if (estimated <= 5.0) {
        p = 0.55 + (5.0 - estimated) * 0.08;
      } else {
        p = 0.18 + (6.5 - estimated) * 0.25;
      }

      if (hand_count <= 2) {
        p += 0.10;
      } else if (hand_count === 3) {
        p += 0.05;
      }

      const low_known = player_info.known_cards.filter((card) => card.value <= 3).length;
      p += 0.03 * low_known;
      p = clamp(p, 0, 0.92);
      not_yaniv_prob *= (1 - p);
    }

    return 1 - not_yaniv_prob;
  }

  _reset_bonus(hand_total, yaniv_next_turn_prob) {
    const projected_score = this.score + hand_total;
    if (projected_score !== 50 && projected_score !== 100) {
      return 0;
    }

    let success_factor;
    if (hand_total <= 5) {
      success_factor = 0.25;
    } else if (hand_total <= 7) {
      success_factor = 0.55;
    } else {
      success_factor = 0.75;
    }

    const expected_reset_value = 50 * yaniv_next_turn_prob * success_factor;
    return Math.min(24, expected_reset_value);
  }

  _expected_reset_bonus_from_samples(post_turn_without_draw, sampled_cards, yaniv_next_turn_prob) {
    if (sampled_cards.length === 0) {
      return 0;
    }

    let total_bonus = 0;
    for (const draw_card of sampled_cards) {
      const hand_total = post_turn_without_draw + draw_card.value;
      total_bonus += this._reset_bonus(hand_total, yaniv_next_turn_prob);
    }
    return total_bonus / sampled_cards.length;
  }

  action_to_reset() {
    for (const discard_option of this._get_discard_options_cached(this.hand)) {
      const discard_value = discard_option.reduce((sum, card) => sum + card.value, 0);
      for (let draw_idx = 0; draw_idx < this.draw_options.length; draw_idx += 1) {
        const draw_card = this.draw_options[draw_idx];
        if ((discard_value - draw_card.value + this.score) % 50 === 0) {
          return {
            discard: discard_option,
            draw: draw_idx,
          };
        }
      }
    }
    return null;
  }

  action_to_minimize_score() {
    const action = this._simulate_next_turn();
    return {
      discard: action.discard,
      draw: action.draw,
    };
  }

  _get_discard_options(hand = this.hand) {
    const discard_options = hand.map((card) => [card]);

    const jokers = hand.filter((card) => card.rank === 'Joker');
    const non_jokers = hand.filter((card) => card.rank !== 'Joker');
    const joker_count = jokers.length;

    const rank_index_by_id = {};
    for (const card of hand) {
      rank_index_by_id[card._card] = card.rank_index();
    }

    for (let combo_size = 2; combo_size <= non_jokers.length; combo_size += 1) {
      const combos = combinations(non_jokers, combo_size);
      for (const combo of combos) {
        const first_rank = combo[0].rank;
        if (combo.every((card) => card.rank === first_rank)) {
          for (let num_jokers = 0; num_jokers <= joker_count; num_jokers += 1) {
            const joker_combos = combinations(jokers, num_jokers);
            for (const joker_combo of joker_combos) {
              discard_options.push([...combo, ...joker_combo]);
            }
          }
          continue;
        }

        const first_suit = combo[0].suit;
        if (combo.every((card) => card.suit === first_suit)) {
          let sorted_combo = [...combo].sort((a, b) => rank_index_by_id[a._card] - rank_index_by_id[b._card]);
          const gaps = [];
          for (let i = 0; i < sorted_combo.length - 1; i += 1) {
            const gap = rank_index_by_id[sorted_combo[i + 1]._card] - rank_index_by_id[sorted_combo[i]._card] - 1;
            if (gap > 0) {
              gaps.push([i, gap]);
            }
          }

          const totalGaps = gaps.reduce((sum, [, gap]) => sum + gap, 0);
          if (totalGaps <= joker_count) {
            sorted_combo = [...sorted_combo];
            let joker_index = 0;
            for (const [i, gap] of gaps) {
              for (let j = 0; j < gap; j += 1) {
                if (joker_index < joker_count) {
                  sorted_combo.splice(i + 1, 0, jokers[joker_index]);
                  joker_index += 1;
                }
              }
            }

            const remaining_jokers = jokers.slice(joker_index);
            for (const joker of remaining_jokers) {
              if (rank_index_by_id[sorted_combo[0]._card] > 1) {
                discard_options.push([joker, ...sorted_combo]);
              }
              if (rank_index_by_id[sorted_combo[sorted_combo.length - 1]._card] < 13) {
                discard_options.push([...sorted_combo, joker]);
              }
            }

            if (sorted_combo.length >= 3) {
              discard_options.push(sorted_combo);
            }
          }
        }
      }
    }

    return discard_options;
  }

  _get_discard_options_cached(hand) {
    const signature = this._hand_signature(hand);
    let cached = this._cache_get(this._discard_options_cache, signature);
    if (cached === null) {
      cached = this._get_discard_options(hand);
      this._cache_set(this._discard_options_cache, signature, cached);
    }
    return cached;
  }

  _hand_signature(hand) {
    return hand.map((card) => card._card).sort((a, b) => a - b).join(',');
  }

  _get_best_discard_options_cached(hand) {
    const signature = this._hand_signature(hand);
    let cached = this._cache_get(this._best_discard_options_cache, signature);
    if (cached === null) {
      const discard_options = this._get_discard_options_cached(hand);
      cached = this._get_best_discard_options(discard_options);
      this._cache_set(this._best_discard_options_cache, signature, cached);
    }
    return cached;
  }

  _simulate_action(potential_hand, draw_card, prune_to_best_discard = true) {
    const new_hand = [...potential_hand, draw_card];
    const signature = this._hand_signature(new_hand);
    const cache_key = `${signature}|${prune_to_best_discard ? 1 : 0}`;
    const cached = this._cache_get(this._simulate_action_cache, cache_key);
    if (cached !== null) {
      return cached;
    }

    const candidate_discard_options = prune_to_best_discard
      ? this._get_best_discard_options_cached(new_hand)
      : this._get_discard_options_cached(new_hand);

    let future_expected_points = Number.POSITIVE_INFINITY;
    let best_next_discard_option = null;

    for (const discard_option of candidate_discard_options) {
      const expected_points = this._calculate_new_total_points(new_hand, discard_option);
      if (expected_points <= future_expected_points) {
        future_expected_points = expected_points;
        best_next_discard_option = discard_option;
      }
    }

    const out = [future_expected_points, best_next_discard_option];
    this._cache_set(this._simulate_action_cache, cache_key, out);
    return out;
  }

  _get_best_action(post_discard_hand) {
    let best_score = Number.POSITIVE_INFINITY;
    let best_draw_card = 'deck';

    for (let i = 0; i < this.draw_options.length; i += 1) {
      const draw_card = this.draw_options[i];
      const [score] = this._simulate_action(post_discard_hand, draw_card);
      if (score < best_score) {
        best_score = score;
        best_draw_card = i;
      }
    }

    return [best_draw_card, best_score];
  }

  _simulate_next_turn() {
    const discard_options = this._get_discard_options_cached(this.hand);
    let best_discard = this._get_best_discard_options(discard_options)[0];
    let best_score = this.hand.reduce((sum, card) => sum + card.value, 0)
      - best_discard.reduce((sum, card) => sum + card.value, 0)
      + 0;
    let best_draw_card = 'deck';

    for (const discard_option of discard_options) {
      const post_discard_hand = this.hand.filter((card) => !containsCard(discard_option, card));
      const [draw_card, score] = this._get_best_action(post_discard_hand);

      if (score < best_score) {
        best_score = score;
        best_draw_card = draw_card;
        best_discard = discard_option;
      }
      if (score === best_score) {
        const discardSum = discard_option.reduce((sum, card) => sum + card.value, 0);
        const bestDiscardSum = best_discard.reduce((sum, card) => sum + card.value, 0);
        if (discardSum < bestDiscardSum) {
          best_score = score;
          best_draw_card = draw_card;
          best_discard = discard_option;
        }
      }
    }

    return { draw: best_draw_card, discard: best_discard, points: best_score };
  }

  _get_best_discard_options(discard_options) {
    const best_discard_options = [];
    let best_points = 0;

    for (const option of discard_options) {
      const discard_points = option.reduce((sum, card) => sum + card.value, 0);
      if (discard_points > best_points) {
        best_points = discard_points;
        best_discard_options.length = 0;
        best_discard_options.push(option);
      } else if (discard_points === best_points && best_discard_options.length > 0) {
        if (option.length < best_discard_options[0].length) {
          best_discard_options.length = 0;
          best_discard_options.push(option);
        } else if (option.length === best_discard_options[0].length) {
          best_discard_options.push(option);
        }
      }
    }

    return best_discard_options;
  }

  _calculate_new_total_points(potential_hand, discard_option) {
    return potential_hand
      .filter((card) => !containsCard(discard_option, card))
      .reduce((sum, card) => sum + card.value, 0);
  }

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

    const score_pressure = clamp(this.score / 100, 0, 1);
    risk_threshold *= (1 - 0.35 * score_pressure);
    risk_threshold = Math.max(0.03, risk_threshold);

    // Reduce threshold (less willing to call) if it would give an opponent a reset.
    // Giving someone a -50 reset is very costly and worth avoiding.
    const reset_penalty = this._evaluate_yaniv_reset_impact();
    risk_threshold -= reset_penalty * 0.04;
    risk_threshold = Math.max(0.03, risk_threshold);

    return assaf_risk <= risk_threshold;
  }

  _evaluate_yaniv_reset_impact() {
    // Returns a penalty for calling Yaniv if it would give opponents a beneficial reset
    let penalty = 0;
    for (const player_info of Object.values(this.other_players)) {
      const opponent_score = player_info.current_score;
      const estimated_hand = player_info.estimated_score ?? 50;
      const new_score = opponent_score + estimated_hand;

      // Would they land on a reset threshold?
      if ((new_score === 50 || new_score === 100) && opponent_score < new_score) {
        penalty += 2.5;
      }
      // Close to a reset threshold (might land on it with actual hand)
      else if (Math.abs(new_score - 50) <= 3 && opponent_score < 50) {
        penalty += 0.8;
      } else if (Math.abs(new_score - 100) <= 3 && opponent_score < 100) {
        penalty += 0.8;
      }
    }
    return Math.min(4.0, penalty);
  }

  _estimate_assaf_probability(player_info, own_hand_value, mean_value, var_value) {
    const known_sum = player_info.known_cards.reduce((sum, card) => sum + card.value, 0);
    const unknown_count = Math.max(0, player_info.hand_count - player_info.known_cards.length);

    if (unknown_count === 0) {
      return known_sum <= own_hand_value ? 1 : 0;
    }

    const expected = known_sum + unknown_count * mean_value;
    const variance = Math.max(0.01, unknown_count * var_value);
    const stddev = Math.sqrt(variance);
    const z = ((own_hand_value + 0.5) - expected) / stddev;
    const cdf = 0.5 * (1 + erf(z / Math.sqrt(2)));
    return clamp(cdf, 0.01, 0.99);
  }

  estimate_hand_values() {
    for (const player_info of Object.values(this.other_players)) {
      const unknown_cards_count = player_info.hand_count - player_info.known_cards.length;
      const estimated_unknown_card_score = this.estimate_unknown_cards(unknown_cards_count);
      player_info.estimated_score = player_info.known_cards.reduce((sum, card) => sum + card.value, 0)
        + estimated_unknown_card_score;
    }
  }

  estimate_unknown_cards(num_unknown_cards) {
    if (num_unknown_cards <= 0) {
      return 0;
    }

    const unseen_cards = this._get_unseen_cards();
    const [mean_value] = this._mean_and_variance(unseen_cards);
    return num_unknown_cards * mean_value;
  }

  _get_unseen_cards() {
    const visible_ids = new Set(this.hand.map((card) => card._card));
    for (const card of this.draw_options) {
      visible_ids.add(card._card);
    }
    for (const card of this.public_discard_pile) {
      visible_ids.add(card._card);
    }
    for (const player_info of Object.values(this.other_players)) {
      for (const card of player_info.known_cards) {
        visible_ids.add(card._card);
      }
    }

    return AIPlayer._FULL_DECK.filter((card) => !visible_ids.has(card._card));
  }

  _known_card_indexes() {
    const known_ranks = new Set();
    const known_suit_ranks = new Map();

    for (const player_info of Object.values(this.other_players)) {
      for (const card of player_info.known_cards) {
        if (card.rank === 'Joker') {
          continue;
        }
        known_ranks.add(card.rank);
        if (!known_suit_ranks.has(card.suit)) {
          known_suit_ranks.set(card.suit, new Set());
        }
        known_suit_ranks.get(card.suit).add(card.rank_index());
      }
    }

    return [known_ranks, known_suit_ranks];
  }

  _mean_and_variance(cards) {
    if (cards.length === 0) {
      return [5.0, 8.0];
    }

    const values = cards.map((card) => card.value);
    const mean_value = values.reduce((sum, value) => sum + value, 0) / values.length;
    const variance = values.reduce((sum, value) => sum + ((value - mean_value) ** 2), 0) / values.length;
    return [mean_value, variance];
  }

  _state_seed() {
    let seed = 2166136261;

    const handCounts = Object.entries(this.other_players)
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([, player_info]) => player_info.hand_count);

    const values = [
      this.score,
      ...this.hand.map((card) => card._card).sort((a, b) => a - b),
      ...this.draw_options.map((card) => card._card).sort((a, b) => a - b),
      this.public_discard_pile.length,
      ...handCounts,
    ];

    for (const rawValue of values) {
      const value = Number.parseInt(rawValue, 10);
      seed ^= (value + 0x9e3779b9);
      seed = Math.imul(seed, 16777619) >>> 0;
    }

    return seed >>> 0;
  }

  _deck_rollout_context(unseen_cards) {
    if (unseen_cards.length === 0) {
      return [[], 8.0];
    }

    const sample_count = Math.min(this.rollout_samples, unseen_cards.length);
    let sampled_cards;
    if (sample_count < unseen_cards.length) {
      const rng = mulberry32(this._state_seed());
      sampled_cards = sampleWithoutReplacement(unseen_cards, sample_count, rng);
    } else {
      sampled_cards = unseen_cards;
    }

    const [, variance] = this._mean_and_variance(unseen_cards);
    return [sampled_cards, variance];
  }

  _evaluate_deck_draw_samples(post_discard_hand, sampled_cards, prune_to_best_discard = true) {
    if (sampled_cards.length === 0) {
      const baseline_residual = this._best_residual_points(post_discard_hand);
      const immediate = post_discard_hand.reduce((sum, card) => sum + card.value, 0) + 5.0;
      return [baseline_residual, immediate];
    }

    const post_turn_without_draw = post_discard_hand.reduce((sum, card) => sum + card.value, 0);
    let future_total = 0;
    let immediate_total = 0;

    for (const draw_card of sampled_cards) {
      const [future_score] = this._simulate_action(post_discard_hand, draw_card, prune_to_best_discard);
      future_total += future_score;
      immediate_total += post_turn_without_draw + draw_card.value;
    }

    const sample_size = sampled_cards.length;
    return [future_total / sample_size, immediate_total / sample_size];
  }

  _best_residual_points(hand) {
    const signature = this._hand_signature(hand);
    const cached = this._cache_get(this._best_residual_cache, signature);
    if (cached !== null) {
      return cached;
    }

    const total = hand.reduce((sum, card) => sum + card.value, 0);
    const discard_options = this._get_discard_options_cached(hand);
    let best_residual = total;

    for (const option of discard_options) {
      const optionSum = option.reduce((sum, card) => sum + card.value, 0);
      const residual = total - optionSum;
      if (residual < best_residual) {
        best_residual = residual;
      }
    }

    this._cache_set(this._best_residual_cache, signature, best_residual);
    return best_residual;
  }

  _hand_composition_bonus(hand) {
    // Returns a bonus for hands with good set/run potential.
    // Higher bonus = better hand composition = prefer keeping these cards together.
    let bonus = 0;
    const non_jokers = hand.filter((c) => c.rank !== 'Joker');
    const joker_count = hand.length - non_jokers.length;

    // Pairs/trips have strong set-discard potential
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

    // Consecutive same-suit cards have run potential
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
          // Directly consecutive: strong run potential
          bonus += 1.5 + 0.06 * (cards[i].value + cards[i + 1].value);
        } else if (gap === 2 && joker_count > 0) {
          // One-gap bridgeable by joker
          bonus += 0.8;
        }
      }
    }

    return Math.min(6.0, bonus);
  }

  _opponent_threat_score() {
    let threat = 0;
    for (const player_info of Object.values(this.other_players)) {
      const estimated = player_info.estimated_score ?? 50;
      const hand_count = player_info.hand_count ?? 5;

      let player_threat = Math.max(0, (8 - estimated) / 8);
      if (hand_count <= 2) {
        player_threat += 0.30;
      }
      if (hand_count <= 1) {
        player_threat += 0.25;
      }

      threat = Math.max(threat, player_threat);
    }

    return Math.min(1.5, threat);
  }

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

      // Enhanced: penalize based on opponent collection patterns
      for (const player_info of Object.values(this.other_players)) {
        // Penalty if opponent has been picking up this rank (building a set)
        const collected_count = player_info.collected_ranks[card.rank] || 0;
        if (collected_count > 0) {
          penalty += 2.0 * collected_count;
        }

        // Penalty if card is adjacent to opponent's suit-run collection
        const opp_suit_ranks = player_info.collected_suit_ranks[card.suit];
        if (opp_suit_ranks) {
          if (opp_suit_ranks.has(card_rank) || opp_suit_ranks.has(card_rank - 1) || opp_suit_ranks.has(card_rank + 1)) {
            penalty += 1.5;
          }
          // Extra penalty if this card would bridge two collected cards (completes a run)
          if (opp_suit_ranks.has(card_rank - 1) && opp_suit_ranks.has(card_rank + 1)) {
            penalty += 2.5;
          }
        }

        // Safety bonus if opponent recently discarded this rank (they don't want it)
        if (player_info.discard_history.some((d) => d.rank === card.rank)) {
          penalty -= 0.6;
        }
      }
    }

    return penalty;
  }
}

module.exports = { AIPlayer };
