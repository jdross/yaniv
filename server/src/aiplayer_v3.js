const { AIPlayer: BaseAIPlayer } = require('./aiplayer_base');

function containsCard(cards, target) {
  return cards.some((card) => card.id === target.id);
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
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

function sumCardValues(cards) {
  return cards.reduce((sum, card) => sum + card.value, 0);
}

class AIPlayerV3 extends BaseAIPlayer {
  static _YANIV_SAMPLES = 32;

  constructor(name, rollout_samples = 24) {
    super(name, rollout_samples);
    this._turn_counter = 0;
    this._belief_sample_cache = new Map();
  }

  observe_round(round_info) {
    super.observe_round(round_info);
    this._turn_counter = 0;
    this._belief_sample_cache.clear();

    for (const player_info of Object.values(this.other_players)) {
      this._ensure_belief_fields(player_info);
    }
  }

  observe_turn(turn_info, discard_pile, draw_options) {
    const previous_draw_options = [...this.draw_options];
    this._turn_counter += 1;
    this._decay_all_beliefs();
    super.observe_turn(turn_info, discard_pile, draw_options);

    const player_name = turn_info.player.name;
    if (!Object.prototype.hasOwnProperty.call(this.other_players, player_name)) {
      return;
    }

    const playerInfo = this.other_players[player_name];
    this._ensure_belief_fields(playerInfo);
    playerInfo.last_action_turn = this._turn_counter;

    if (turn_info.drawn_card !== null && turn_info.drawn_card !== undefined) {
      this._update_beliefs_from_pickup(playerInfo, turn_info.drawn_card);
    } else if (turn_info.action && turn_info.action.draw === 'deck' && previous_draw_options.length > 0) {
      this._mark_refused_options(playerInfo, previous_draw_options);
    }

    if (Array.isArray(turn_info.discarded_cards) && turn_info.discarded_cards.length > 0) {
      this._update_beliefs_from_discards(playerInfo, turn_info.discarded_cards);
    }

    this._refresh_low_card_bias(playerInfo);
    this._belief_sample_cache.clear();
  }

  _ensure_belief_fields(playerInfo) {
    if (!playerInfo.need_by_rank) {
      playerInfo.need_by_rank = {};
    }
    if (!playerInfo.need_by_suit_rank) {
      playerInfo.need_by_suit_rank = {};
    }
    if (!playerInfo.discard_refusals) {
      playerInfo.discard_refusals = {
        by_rank: {},
        by_suit_rank: {},
      };
    } else {
      playerInfo.discard_refusals.by_rank = playerInfo.discard_refusals.by_rank || {};
      playerInfo.discard_refusals.by_suit_rank = playerInfo.discard_refusals.by_suit_rank || {};
    }
    if (typeof playerInfo.low_card_bias !== 'number') {
      playerInfo.low_card_bias = 0;
    }
    if (typeof playerInfo.last_action_turn !== 'number') {
      playerInfo.last_action_turn = 0;
    }
  }

  _decay_all_beliefs() {
    for (const playerInfo of Object.values(this.other_players)) {
      this._ensure_belief_fields(playerInfo);
      this._decay_scalar_map(playerInfo.need_by_rank, 0.84);
      for (const suitMap of Object.values(playerInfo.need_by_suit_rank)) {
        this._decay_scalar_map(suitMap, 0.84);
      }
      this._decay_scalar_map(playerInfo.discard_refusals.by_rank, 0.92);
      for (const suitMap of Object.values(playerInfo.discard_refusals.by_suit_rank)) {
        this._decay_scalar_map(suitMap, 0.92);
      }
      playerInfo.low_card_bias *= 0.94;
    }
  }

  _decay_scalar_map(map, factor) {
    for (const key of Object.keys(map)) {
      map[key] *= factor;
      if (map[key] < 0.05) {
        delete map[key];
      }
    }
  }

  _boost_rank_need(playerInfo, rank, amount) {
    if (rank === 'Joker') {
      return;
    }
    playerInfo.need_by_rank[rank] = clamp((playerInfo.need_by_rank[rank] || 0) + amount, 0, 6);
  }

  _boost_suit_need(playerInfo, suit, rankIndex, amount) {
    if (rankIndex < 1 || rankIndex > 13) {
      return;
    }
    if (!playerInfo.need_by_suit_rank[suit]) {
      playerInfo.need_by_suit_rank[suit] = {};
    }
    const suitMap = playerInfo.need_by_suit_rank[suit];
    suitMap[rankIndex] = clamp((suitMap[rankIndex] || 0) + amount, 0, 6);
  }

  _add_refusal(playerInfo, card, amount) {
    if (card.rank === 'Joker') {
      return;
    }
    playerInfo.discard_refusals.by_rank[card.rank] = clamp(
      (playerInfo.discard_refusals.by_rank[card.rank] || 0) + amount,
      0,
      4,
    );
    if (!playerInfo.discard_refusals.by_suit_rank[card.suit]) {
      playerInfo.discard_refusals.by_suit_rank[card.suit] = {};
    }
    const suitMap = playerInfo.discard_refusals.by_suit_rank[card.suit];
    const idx = card.rankIndex();
    suitMap[idx] = clamp((suitMap[idx] || 0) + amount, 0, 4);
  }

  _update_beliefs_from_pickup(playerInfo, drawn_card) {
    if (drawn_card.rank === 'Joker') {
      playerInfo.low_card_bias = clamp(playerInfo.low_card_bias + 0.12, 0, 1.6);
      return;
    }

    const rank = drawn_card.rank;
    const suit = drawn_card.suit;
    const rankIndex = drawn_card.rankIndex();
    const repeatedRankPickups = playerInfo.pickup_history.filter((card) => card.rank === rank).length;
    const repeatedSuitPickups = playerInfo.pickup_history.filter(
      (card) => card.suit === suit && Math.abs(card.rankIndex() - rankIndex) <= 2,
    ).length;

    this._boost_rank_need(playerInfo, rank, 1.35 + (0.18 * repeatedRankPickups));
    this._boost_suit_need(playerInfo, suit, rankIndex - 1, 1.15 + (0.12 * repeatedSuitPickups));
    this._boost_suit_need(playerInfo, suit, rankIndex + 1, 1.15 + (0.12 * repeatedSuitPickups));
    this._boost_suit_need(playerInfo, suit, rankIndex - 2, 0.45);
    this._boost_suit_need(playerInfo, suit, rankIndex + 2, 0.45);

    if (drawn_card.value <= 3) {
      playerInfo.low_card_bias = clamp(playerInfo.low_card_bias + 0.08, 0, 1.6);
    }
  }

  _update_beliefs_from_discards(playerInfo, discarded_cards) {
    for (const card of discarded_cards) {
      if (card.rank === 'Joker') {
        playerInfo.low_card_bias *= 0.95;
        continue;
      }

      if (playerInfo.need_by_rank[card.rank]) {
        playerInfo.need_by_rank[card.rank] *= 0.45;
        if (playerInfo.need_by_rank[card.rank] < 0.05) {
          delete playerInfo.need_by_rank[card.rank];
        }
      }

      const suitMap = playerInfo.need_by_suit_rank[card.suit];
      const rankIndex = card.rankIndex();
      if (suitMap) {
        const impacted = [rankIndex - 1, rankIndex, rankIndex + 1];
        for (const idx of impacted) {
          if (suitMap[idx]) {
            suitMap[idx] *= idx === rankIndex ? 0.30 : 0.60;
            if (suitMap[idx] < 0.05) {
              delete suitMap[idx];
            }
          }
        }
      }

      this._add_refusal(playerInfo, card, card.value <= 4 ? 0.65 : 0.40);
      if (card.value <= 3) {
        playerInfo.low_card_bias *= 0.88;
      }
    }
  }

  _mark_refused_options(playerInfo, draw_options) {
    for (const card of draw_options) {
      this._add_refusal(playerInfo, card, 0.25);
      if (card.rank !== 'Joker' && playerInfo.need_by_rank[card.rank]) {
        playerInfo.need_by_rank[card.rank] *= 0.92;
      }
    }
  }

  _refresh_low_card_bias(playerInfo) {
    let inferredBias = 0;
    const estimated = playerInfo.estimated_score ?? 50;
    const hand_count = playerInfo.hand_count ?? 5;

    if (hand_count <= 2) inferredBias += 0.45;
    if (hand_count <= 1) inferredBias += 0.25;
    if (estimated <= 6.5) inferredBias += clamp((6.5 - estimated) * 0.12, 0, 0.45);

    const lowKnown = playerInfo.known_cards.filter((card) => card.value <= 3).length;
    inferredBias += 0.12 * lowKnown;

    const recentLowPickups = playerInfo.pickup_history.slice(-2).filter((card) => card.value <= 3).length;
    inferredBias += 0.08 * recentLowPickups;

    playerInfo.low_card_bias = clamp((playerInfo.low_card_bias * 0.55) + inferredBias, 0, 1.6);
  }

  *_iter_candidate_actions(context) {
    const discard_options = this._get_discard_options_cached(this.hand);

    for (const discard_option of discard_options) {
      const post_discard_hand = this.hand.filter((card) => !containsCard(discard_option, card));
      const post_turn_without_draw = sumCardValues(post_discard_hand);
      const discard_value = sumCardValues(discard_option);
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
          composition_bonus = 0.10 * this._hand_composition_bonus(remaining);
        }

        yield [
          { discard: discard_option, draw: i },
          future_score + heuristic_cost - reset_bonus - composition_bonus,
          discard_value,
        ];
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
            total_bonus += this._hand_composition_bonus(remaining);
          }
        }
        deck_composition_bonus = 0.10 * (total_bonus / context.sampled_cards.length);
      }

      yield [
        { discard: discard_option, draw: 'deck' },
        expected_future + heuristic_cost + uncertainty_cost - expected_reset_bonus - deck_composition_bonus,
        discard_value,
      ];
    }
  }

  _feed_penalty(discard_option, known_ranks = null, known_suit_ranks = null) {
    const baselinePenalty = super._feed_penalty(discard_option, known_ranks, known_suit_ranks);
    let inferredDanger = 0;

    for (const card of discard_option) {
      inferredDanger += this._belief_card_danger(card);
    }

    return baselinePenalty + Math.min(7.5, inferredDanger);
  }

  _belief_card_danger(card) {
    if (card.rank === 'Joker') {
      return 0.8;
    }

    let danger = 0;
    const cardRank = card.rankIndex();

    for (const playerInfo of Object.values(this.other_players)) {
      this._ensure_belief_fields(playerInfo);

      const rankNeed = playerInfo.need_by_rank[card.rank] || 0;
      const suitMap = playerInfo.need_by_suit_rank[card.suit] || {};
      const suitNeed = (suitMap[cardRank] || 0)
        + (0.65 * (suitMap[cardRank - 1] || 0))
        + (0.65 * (suitMap[cardRank + 1] || 0))
        + (0.25 * (suitMap[cardRank - 2] || 0))
        + (0.25 * (suitMap[cardRank + 2] || 0));

      const refusalDanger = this._refusal_score(playerInfo, card);
      let playerDanger = (0.75 * rankNeed) + (0.90 * suitNeed) - (0.45 * refusalDanger);

      if (card.value <= 3) {
        playerDanger += 0.55 * playerInfo.low_card_bias;
      }

      if ((playerInfo.hand_count ?? 5) <= 2) {
        playerDanger *= 1.20;
      }
      if ((playerInfo.estimated_score ?? 50) <= 6.5) {
        playerDanger *= 1.15;
      }

      danger += clamp(playerDanger, 0, 3.5);
    }

    return danger;
  }

  _refusal_score(playerInfo, card) {
    if (card.rank === 'Joker') {
      return 0;
    }

    const byRank = playerInfo.discard_refusals.by_rank[card.rank] || 0;
    const suitMap = playerInfo.discard_refusals.by_suit_rank[card.suit] || {};
    return byRank + (suitMap[card.rankIndex()] || 0);
  }

  _sample_weighted_opponent_hands(playerName, playerInfo, unseenCards, sampleCount, salt = '') {
    this._ensure_belief_fields(playerInfo);
    const unknownCount = Math.max(0, playerInfo.hand_count - playerInfo.known_cards.length);
    if (unknownCount === 0 || unseenCards.length === 0) {
      return [{
        hand: [...playerInfo.known_cards],
        weight: 1,
      }];
    }

    const sampleKey = `${playerName}|${this._player_belief_signature(playerInfo)}|${this._cards_signature(unseenCards)}|${sampleCount}|${salt}`;
    const cached = this._cache_get(this._belief_sample_cache, sampleKey);
    if (cached !== null) {
      return cached;
    }

    const rng = mulberry32(this._seed_from_text(sampleKey));
    const out = [];
    const drawCount = Math.min(unknownCount, unseenCards.length);

    for (let i = 0; i < sampleCount; i += 1) {
      const unknowns = sampleWithoutReplacement(unseenCards, drawCount, rng);
      const hand = [...playerInfo.known_cards, ...unknowns];
      const weight = this._sample_weight(playerInfo, unknowns);
      out.push({ hand, weight });
    }

    this._cache_set(this._belief_sample_cache, sampleKey, out);
    return out;
  }

  _sample_weight(playerInfo, unknowns) {
    let score = 0;

    for (const card of unknowns) {
      if (card.rank !== 'Joker') {
        const rankNeed = playerInfo.need_by_rank[card.rank] || 0;
        const suitMap = playerInfo.need_by_suit_rank[card.suit] || {};
        const suitNeed = (suitMap[card.rankIndex()] || 0)
          + (0.45 * (suitMap[card.rankIndex() - 1] || 0))
          + (0.45 * (suitMap[card.rankIndex() + 1] || 0));
        const refusal = this._refusal_score(playerInfo, card);
        score += (0.24 * rankNeed) + (0.28 * suitNeed) - (0.18 * refusal);
      }

      if (card.value <= 3) {
        score += 0.22 * playerInfo.low_card_bias;
      } else if (card.value >= 8) {
        score -= 0.05 * playerInfo.low_card_bias;
      }
    }

    const handTotal = sumCardValues(playerInfo.known_cards) + sumCardValues(unknowns);
    if (playerInfo.low_card_bias > 0.6) {
      score += clamp((8 - handTotal) * 0.09, -0.4, 0.6);
    }
    if ((playerInfo.hand_count ?? 5) <= 2 && handTotal > 10) {
      score -= 0.45;
    }

    return Math.exp(clamp(score, -3.5, 3.5));
  }

  should_declare_yaniv() {
    const own_hand_value = sumCardValues(this.hand);
    if (own_hand_value > 5) {
      return false;
    }

    if (Object.keys(this.other_players).length === 0) {
      return super.should_declare_yaniv();
    }

    const assafRisk = this._estimate_assaf_probability_mc(own_hand_value);
    const resetPenalty = this._evaluate_yaniv_reset_impact_mc();
    const threat = this._opponent_threat_score();
    const yanivNextTurnProb = this._opponent_yaniv_next_turn_probability();

    const thresholdMap = {
      0: 0.60,
      1: 0.54,
      2: 0.44,
      3: 0.30,
      4: 0.18,
      5: 0.10,
    };
    let riskThreshold = thresholdMap[own_hand_value] ?? 0.08;
    riskThreshold *= (1 - (0.30 * clamp(this.score / 100, 0, 1)));
    riskThreshold -= 0.04 * resetPenalty;
    riskThreshold = Math.max(0.03, riskThreshold);

    const callNowCost = (30 * assafRisk) + (5.5 * resetPenalty);
    const playOnCost = own_hand_value + (8.5 * yanivNextTurnProb) + (2.5 * threat);

    return assafRisk <= riskThreshold && callNowCost <= (playOnCost + 2.5);
  }

  _estimate_assaf_probability_mc(own_hand_value) {
    let notAssafProb = 1;
    const unseen = this._get_unseen_cards();

    for (const [playerName, playerInfo] of Object.entries(this.other_players)) {
      const samples = this._sample_weighted_opponent_hands(
        playerName,
        playerInfo,
        unseen,
        AIPlayerV3._YANIV_SAMPLES,
        `yaniv-${own_hand_value}`,
      );

      let belowOrEqualWeight = 0;
      let totalWeight = 0;
      for (const sample of samples) {
        const handTotal = sumCardValues(sample.hand);
        if (handTotal <= own_hand_value) {
          belowOrEqualWeight += sample.weight;
        }
        totalWeight += sample.weight;
      }

      const playerAssafProb = totalWeight > 0 ? (belowOrEqualWeight / totalWeight) : 0;
      notAssafProb *= (1 - playerAssafProb);
    }

    return 1 - notAssafProb;
  }

  _evaluate_yaniv_reset_impact_mc() {
    let penalty = 0;
    const unseen = this._get_unseen_cards();

    for (const [playerName, playerInfo] of Object.entries(this.other_players)) {
      const samples = this._sample_weighted_opponent_hands(
        playerName,
        playerInfo,
        unseen,
        Math.max(12, Math.floor(AIPlayerV3._YANIV_SAMPLES / 2)),
        'yaniv-reset',
      );

      let weightedPenalty = 0;
      let totalWeight = 0;
      for (const sample of samples) {
        const total = playerInfo.current_score + sumCardValues(sample.hand);
        let samplePenalty = 0;
        if ((total === 50 || total === 100) && playerInfo.current_score < total) {
          samplePenalty = 2.5;
        } else if (Math.abs(total - 50) <= 3 && playerInfo.current_score < 50) {
          samplePenalty = 0.8;
        } else if (Math.abs(total - 100) <= 3 && playerInfo.current_score < 100) {
          samplePenalty = 0.8;
        }

        weightedPenalty += samplePenalty * sample.weight;
        totalWeight += sample.weight;
      }

      if (totalWeight > 0) {
        penalty += weightedPenalty / totalWeight;
      }
    }

    return Math.min(4.0, penalty);
  }

  _player_belief_signature(playerInfo) {
    const knownSig = this._cards_signature(playerInfo.known_cards);
    const rankSig = Object.entries(playerInfo.need_by_rank)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([rank, weight]) => `${rank}:${weight.toFixed(2)}`)
      .join(',');
    const suitSig = Object.entries(playerInfo.need_by_suit_rank)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([suit, weights]) => {
        const parts = Object.entries(weights)
          .sort(([a], [b]) => Number(a) - Number(b))
          .map(([idx, weight]) => `${idx}:${weight.toFixed(2)}`)
          .join('.');
        return `${suit}[${parts}]`;
      })
      .join('|');
    const refusalSig = Object.entries(playerInfo.discard_refusals.by_rank)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([rank, weight]) => `${rank}:${weight.toFixed(2)}`)
      .join(',');

    return [
      playerInfo.current_score,
      playerInfo.hand_count,
      knownSig,
      playerInfo.low_card_bias.toFixed(2),
      rankSig,
      suitSig,
      refusalSig,
    ].join('|');
  }

  _cards_signature(cards) {
    return cards.map((card) => card.id).sort((a, b) => a - b).join(',');
  }

  _seed_from_text(text) {
    let hash = 2166136261;
    for (let i = 0; i < text.length; i += 1) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 16777619) >>> 0;
    }
    return hash >>> 0;
  }
}

module.exports = { AIPlayerV3 };
