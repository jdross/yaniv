const { AIPlayerLearned } = require('./aiplayer_learned');

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function containsCard(cards, target) {
  return cards.some((card) => card.id === target.id);
}

function sumCardValues(cards) {
  return cards.reduce((sum, card) => sum + card.value, 0);
}

function average(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
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

function shuffleInPlace(values, rng) {
  for (let i = values.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [values[i], values[j]] = [values[j], values[i]];
  }
}

const DEFAULT_SEARCH_OPTIONS = Object.freeze({
  determinizations: 24,
  horizonPlies: 28,
  opponentWeight: 0.5,
  horizonFactor: 0.85,
  callMargin: 0.75,
});

// AIPlayerV4 keeps the learned policy's action selection (the strongest action
// chooser available) and replaces the Yaniv call decision with a determinized
// expected-value comparison: "call now" is priced exactly against sampled
// opponent hands (Assaf, 50/100 resets, eliminations included), while "play
// on" is priced by rolling the chosen action forward to the end of the round.
// Opponent hands are sampled from a calibrated model of how much value an
// opponent still holds given how many turns they have taken this round.
class AIPlayerV4 extends AIPlayerLearned {
  constructor(name, rollout_samples = 24, options = null) {
    super(name, rollout_samples, options);
    this.policy_id = 'v4';
    this.search_options = {
      ...DEFAULT_SEARCH_OPTIONS,
      ...((options && options.searchOptions) || {}),
    };
    this._round_order = [];
    this._turn_search = null;
  }

  observe_round(round_info) {
    super.observe_round(round_info);
    this._round_order = round_info.map((player_info) => player_info.name);
    this._turn_search = null;
    for (const player_info of Object.values(this.other_players)) {
      player_info.turns_taken = 0;
    }
  }

  observe_turn(turn_info, discard_pile, draw_options) {
    super.observe_turn(turn_info, discard_pile, draw_options);
    const player_info = this.other_players[turn_info.player.name];
    if (player_info) {
      player_info.turns_taken = (player_info.turns_taken || 0) + 1;
    }
  }

  // Empirical calibration (measured over learned/V3 self-play): the average
  // value of an opponent's unknown cards shrinks as they take turns curating
  // their hand, with a strong hand-count effect. A single unknown card skews
  // high — with a low one they would already have called Yaniv.
  _unknown_value_ratio(hand_count, turns_taken) {
    if (turns_taken <= 0) {
      return 1.0;
    }
    if (hand_count <= 1) {
      return 1.05;
    }
    if (hand_count === 2) {
      return clamp(0.90 - (0.030 * turns_taken), 0.64, 1.0);
    }
    if (hand_count === 3) {
      return clamp(1.00 - (0.070 * turns_taken), 0.53, 1.0);
    }
    if (hand_count === 4) {
      return clamp(0.95 - (0.070 * turns_taken), 0.47, 1.0);
    }
    return clamp(0.92 - (0.070 * turns_taken), 0.50, 1.0);
  }

  _calibrated_estimated_score(player_info, mean_unseen) {
    const unknown_count = Math.max(0, player_info.hand_count - player_info.known_cards.length);
    const ratio = this._unknown_value_ratio(player_info.hand_count ?? 5, player_info.turns_taken || 0);
    return player_info.known_cards.reduce((sum, card) => sum + card.value, 0)
      + (unknown_count * ratio * mean_unseen);
  }

  decide_action() {
    const [mean_unseen] = this._mean_and_variance(this._get_unseen_cards());
    for (const player_info of Object.values(this.other_players)) {
      if (this._calibrated_estimated_score(player_info, mean_unseen) <= 5) {
        const reset_action = this.action_to_reset();
        if (reset_action !== null) {
          return reset_action;
        }
      }
    }

    const search = this._ensure_turn_search();
    if (search && search.best_action) {
      return search.best_action;
    }
    return super.decide_action();
  }

  should_declare_yaniv() {
    const own_hand_value = sumCardValues(this.hand);
    if (own_hand_value > 5) {
      return false;
    }
    if (Object.keys(this.other_players).length === 0) {
      return super.should_declare_yaniv();
    }

    const search = this._ensure_turn_search();
    if (!search || !Number.isFinite(search.call_cost) || !Number.isFinite(search.best_play_cost)) {
      return super.should_declare_yaniv();
    }
    return search.call_cost <= search.best_play_cost + this.search_options.callMargin;
  }

  _ensure_turn_search() {
    const signature = this._turn_signature();
    if (this._turn_search && this._turn_search.signature === signature) {
      return this._turn_search;
    }

    const result = this._run_search();
    if (result) {
      result.signature = signature;
    }
    this._turn_search = result;
    return result;
  }

  _turn_signature() {
    const handSig = this.hand.map((card) => card.id).sort((a, b) => a - b).join(',');
    const drawSig = this.draw_options.map((card) => card.id).join(',');
    const oppSig = Object.entries(this.other_players)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, info]) => `${name}:${info.hand_count}:${info.current_score}`)
      .join('|');
    return `${this.score}#${handSig}#${drawSig}#${this.public_discard_pile.length}#${oppSig}`;
  }

  _run_search() {
    const best_action = super.decide_action();
    if (!best_action) {
      return null;
    }

    const result = {
      best_action,
      best_play_cost: Number.POSITIVE_INFINITY,
      call_cost: Number.POSITIVE_INFINITY,
    };

    // Rollouts are only needed to price a potential Yaniv call.
    if (sumCardValues(this.hand) > 5) {
      return result;
    }

    const determinizations = this._build_determinizations();
    if (determinizations.length === 0) {
      return result;
    }

    const call_costs = [];
    const play_costs = [];
    for (const det of determinizations) {
      call_costs.push(this._evaluate_call_now(det));

      const rng = mulberry32(det.seed ^ 0x5bd1e995);
      const state = this._make_sim_state(det);
      this._apply_candidate(state, best_action);
      play_costs.push(this._rollout(state, rng));
    }

    result.call_cost = average(call_costs);
    result.best_play_cost = average(play_costs);
    return result;
  }

  _opponent_order() {
    const myIdx = this._round_order.indexOf(this.name);
    if (myIdx >= 0) {
      const ordered = [];
      for (let offset = 1; offset < this._round_order.length; offset += 1) {
        const name = this._round_order[(myIdx + offset) % this._round_order.length];
        if (Object.prototype.hasOwnProperty.call(this.other_players, name)) {
          ordered.push(name);
        }
      }
      if (ordered.length > 0) {
        return ordered;
      }
    }
    return Object.keys(this.other_players);
  }

  _build_determinizations() {
    const unseen = this._get_unseen_cards();
    const opponentNames = this._opponent_order();
    const baseSeed = this._state_seed();
    const [mean_unseen, var_unseen] = this._mean_and_variance(unseen);
    const out = [];

    for (let d = 0; d < this.search_options.determinizations; d += 1) {
      const seed = (baseSeed + Math.imul(d + 1, 0x9e3779b9)) >>> 0;
      const rng = mulberry32(seed);
      const pool = [...unseen];
      const opponents = [];

      for (const name of opponentNames) {
        const info = this.other_players[name];
        const unknownCount = Math.max(0, (info.hand_count ?? 5) - info.known_cards.length);
        // Exponential tilt so sampled unknown cards match the calibrated mean
        // for this opponent's round progress: E[v] shifts by roughly -beta*var.
        const ratio = this._unknown_value_ratio(info.hand_count ?? 5, info.turns_taken || 0);
        const beta = (mean_unseen * (1 - ratio)) / Math.max(1, var_unseen);
        const unknowns = this._sample_belief_cards(info, pool, unknownCount, rng, beta, mean_unseen);
        opponents.push({
          name,
          score: info.current_score ?? 0,
          hand: [...info.known_cards, ...unknowns],
        });
      }

      const deck = pool;
      shuffleInPlace(deck, rng);
      out.push({ seed, opponents, deck });
    }

    return out;
  }

  _sample_belief_cards(player_info, pool, count, rng, value_tilt = 0, mean_unseen = 5.5) {
    this._ensure_belief_fields(player_info);
    const out = [];

    for (let i = 0; i < count && pool.length > 0; i += 1) {
      let totalWeight = 0;
      const weights = new Array(pool.length);
      for (let j = 0; j < pool.length; j += 1) {
        const weight = this._card_belief_weight(player_info, pool[j], value_tilt, mean_unseen);
        weights[j] = weight;
        totalWeight += weight;
      }

      let pick = rng() * totalWeight;
      let chosen = pool.length - 1;
      for (let j = 0; j < pool.length; j += 1) {
        pick -= weights[j];
        if (pick <= 0) {
          chosen = j;
          break;
        }
      }
      out.push(pool.splice(chosen, 1)[0]);
    }

    return out;
  }

  _card_belief_weight(player_info, card, value_tilt = 0, mean_unseen = 5.5) {
    let score = -value_tilt * (card.value - mean_unseen);

    if (card.rank !== 'Joker') {
      const rankNeed = player_info.need_by_rank[card.rank] || 0;
      const suitMap = player_info.need_by_suit_rank[card.suit] || {};
      const idx = card.rankIndex();
      const suitNeed = (suitMap[idx] || 0)
        + (0.45 * (suitMap[idx - 1] || 0))
        + (0.45 * (suitMap[idx + 1] || 0));
      score += (0.24 * rankNeed) + (0.28 * suitNeed) - (0.18 * this._refusal_score(player_info, card));
    }

    if (card.value <= 3) {
      score += 0.22 * player_info.low_card_bias;
    } else if (card.value >= 8) {
      score -= 0.05 * player_info.low_card_bias;
    }

    return Math.exp(clamp(score, -3.0, 3.0));
  }

  _make_sim_state(det) {
    const optionIds = new Set(this.draw_options.map((card) => card.id));
    return {
      players: [
        { name: this.name, isMe: true, score: this.score, hand: [...this.hand] },
        ...det.opponents.map((opp) => ({
          name: opp.name,
          isMe: false,
          score: opp.score,
          hand: [...opp.hand],
        })),
      ],
      deck: [...det.deck],
      lastDiscard: [],
      simDiscards: this.public_discard_pile.filter((card) => !optionIds.has(card.id)),
      turnIndex: 1,
    };
  }

  _apply_candidate(state, action) {
    const me = state.players[0];
    me.hand = me.hand.filter((card) => !containsCard(action.discard, card));

    let drawn = null;
    if (action.draw === 'deck') {
      drawn = state.deck.pop() || null;
    } else {
      drawn = this.draw_options[action.draw] || null;
    }

    for (const card of this.draw_options) {
      if (!drawn || card.id !== drawn.id) {
        state.simDiscards.push(card);
      }
    }

    if (drawn) {
      me.hand.push(drawn);
    }
    state.lastDiscard = [...action.discard];
  }

  _rollout(state, rng) {
    for (let ply = 0; ply < this.search_options.horizonPlies; ply += 1) {
      const player = state.players[state.turnIndex];
      const total = sumCardValues(player.hand);
      if (total <= 5 && this._sim_should_call(total, rng)) {
        return this._score_round_end(state, state.turnIndex);
      }
      this._sim_play_turn(state, rng);
      state.turnIndex = (state.turnIndex + 1) % state.players.length;
    }
    return this._horizon_cost(state);
  }

  _sim_should_call(total, rng) {
    let prob;
    if (total <= 1) {
      prob = 0.97;
    } else if (total === 2) {
      prob = 0.92;
    } else if (total === 3) {
      prob = 0.85;
    } else if (total === 4) {
      prob = 0.70;
    } else {
      prob = 0.55;
    }
    return rng() < prob;
  }

  _sim_play_turn(state, rng) {
    const player = state.players[state.turnIndex];
    const drawOptions = this._sim_draw_options(state.lastDiscard);
    const discard = this._greedy_discard(player.hand);
    const postHand = player.hand.filter((card) => !containsCard(discard, card));

    let drawn = this._sim_pick_draw(drawOptions, postHand);
    if (drawn) {
      state.lastDiscard = state.lastDiscard.filter((card) => card.id !== drawn.id);
    } else {
      if (state.deck.length === 0) {
        this._sim_reshuffle(state, rng);
      }
      drawn = state.deck.pop() || null;
    }

    state.simDiscards.push(...state.lastDiscard);
    state.lastDiscard = discard;
    player.hand = drawn ? [...postHand, drawn] : postHand;
  }

  _sim_draw_options(lastDiscard) {
    if (lastDiscard.length === 0) {
      return [];
    }
    if (lastDiscard.length < 3) {
      return lastDiscard;
    }
    const nonJokers = lastDiscard.filter((card) => card.rank !== 'Joker');
    if (nonJokers.length > 0 && nonJokers.every((card) => card.rank === nonJokers[0].rank)) {
      return lastDiscard;
    }
    return [lastDiscard[0], lastDiscard[lastDiscard.length - 1]];
  }

  _greedy_discard(hand) {
    const options = this._get_discard_options_cached(hand);
    let best = options[0];
    let bestValue = best ? sumCardValues(best) : 0;

    for (const option of options) {
      const value = sumCardValues(option);
      if (value > bestValue || (value === bestValue && option.length > best.length)) {
        best = option;
        bestValue = value;
      }
    }
    return best || [];
  }

  _sim_pick_draw(drawOptions, postHand) {
    let best = null;
    let bestScore = Number.POSITIVE_INFINITY;

    for (const card of drawOptions) {
      let score = Number.POSITIVE_INFINITY;
      if (card.value <= 2) {
        score = card.value;
      } else if (
        card.value <= 6
        && card.rank !== 'Joker'
        && postHand.some((held) => held.rank === card.rank)
      ) {
        score = card.value - 3;
      }
      if (score < bestScore) {
        bestScore = score;
        best = card;
      }
    }

    return Number.isFinite(bestScore) ? best : null;
  }

  _sim_reshuffle(state, rng) {
    state.deck = state.simDiscards;
    state.simDiscards = [];
    shuffleInPlace(state.deck, rng);
  }

  _evaluate_call_now(det) {
    const state = this._make_sim_state(det);
    return this._score_round_end(state, 0);
  }

  _score_round_end(state, callerIdx) {
    const totals = state.players.map((player) => sumCardValues(player.hand));
    const callerTotal = totals[callerIdx];

    let minOther = Number.POSITIVE_INFINITY;
    for (let i = 0; i < totals.length; i += 1) {
      if (i !== callerIdx && totals[i] < minOther) {
        minOther = totals[i];
      }
    }
    const assaf = minOther <= callerTotal;

    const newScores = state.players.map((player, i) => {
      let delta;
      if (i === callerIdx) {
        delta = assaf ? 30 : 0;
      } else {
        delta = assaf ? 0 : totals[i];
      }
      let score = player.score + delta;
      if ((score === 50 || score === 100) && delta > 0) {
        score -= 50;
      }
      return score;
    });

    let cost = newScores[0] - state.players[0].score;
    const oppDeltas = [];
    for (let i = 1; i < state.players.length; i += 1) {
      oppDeltas.push(newScores[i] - state.players[i].score);
    }
    cost -= this.search_options.opponentWeight * average(oppDeltas);

    const myEliminated = newScores[0] > 100;
    let oppsEliminated = 0;
    for (let i = 1; i < newScores.length; i += 1) {
      if (newScores[i] > 100) {
        oppsEliminated += 1;
      }
    }

    if (myEliminated) {
      cost += 40;
    }
    if (oppsEliminated > 0) {
      cost -= 18 * oppsEliminated;
      if (!myEliminated && oppsEliminated === state.players.length - 1) {
        cost -= 30;
      }
    }

    return cost;
  }

  _horizon_cost(state) {
    // Race-aware terminal evaluation: someone eventually calls Yaniv, so the
    // expected cost depends on who is closer to a callable hand (low total and
    // few cards), not just on raw hand values.
    const totals = state.players.map((player) => sumCardValues(player.hand));
    const myDistance = totals[0] + (1.2 * state.players[0].hand.length);

    let minOppDistance = Number.POSITIVE_INFINITY;
    const oppTotals = [];
    for (let i = 1; i < state.players.length; i += 1) {
      oppTotals.push(totals[i]);
      const distance = totals[i] + (1.2 * state.players[i].hand.length);
      if (distance < minOppDistance) {
        minOppDistance = distance;
      }
    }

    const meFirstProb = 1 / (1 + Math.exp(-(minOppDistance - myDistance) / 6));
    const expected = ((1 - meFirstProb) * totals[0])
      - (meFirstProb * this.search_options.opponentWeight * average(oppTotals));
    return this.search_options.horizonFactor * expected;
  }
}

module.exports = { AIPlayerV4 };
