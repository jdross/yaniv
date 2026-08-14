# Yaniv AI Improvement Log

Record of attempts to improve the AI player strategy, so future efforts can
build on what was learned rather than repeat what was tried.

---

## 2026-08-14 — Retrained learned action model (checkpoint learned-20260814_011550)

**Result: New strongest AI.** Promoted. The March champion
(`learned-py-20260323_130916`, training_iteration 6) was not at a ceiling --
simply running the existing JS pipeline for three more self-play iterations
produced a checkpoint that beats it reproducibly.

### Benchmarks (candidate vs promoted champion, both inside V4)

| Matchup | Games | New | Old |
|---|---|---|---|
| 2p, seed 8140 | 800 | **54.3%** | 45.8% |
| 2p, seed 991177 | 800 | **53.3%** | 46.8% |
| 2p, seed 313131 (seats swapped) | 700 | **52.4%** | 47.6% |
| **2p aggregate** | **2300** | **53.3%** (~3.2 SE above even) | 46.7% |
| 3p, 1 new vs 2 old | 450 | **38.4%** | 30.8%/seat (parity 33.3%) |

New champion vs V3: 64.6% (500 games). Latency unchanged (~0.94ms avg).

The gain shows up as **better Yaniv discipline**: assaf rate fell from
6.7-6.9% to 5.5% in 2p and 8.4% to 7.4% in 3p, and average final score
dropped ~4 points. It is calling into fewer Assafs, not calling more often.

### How to reproduce / continue

    node scripts/learned_ai.js burst --seconds 1500 --games 40 \
      --eval-games-2p 40 --eval-games-3p 24 --jobs 12
    # then validate independently -- do NOT trust the pipeline's own
    # promotion_recommended flag, which fired on a 12-game run:
    YANIV_CANDIDATE_MANIFEST=<candidate.json> node scripts/benchmark.js \
      --players v4cand,v4 --games 800 --seed <seed>
    node scripts/learned_ai.js promote --candidate-manifest-path <candidate.json>

`benchmark.js` gained a `v4cand` policy (V4 loading an arbitrary checkpoint via
`YANIV_CANDIDATE_MANIFEST`) so a candidate and the champion can play each other
in the same match, and a `v4cal` policy (see below).

### Calibrated action features: tried, currently negative

V4 computes a calibrated opponent-hand estimate (`_calibrated_estimated_score`)
but uses it only for the Yaniv call; the learned action features (`threat`,
`yaniv_next_turn_prob`, `reset_bonus`) still read the uncalibrated
`estimated_score`. Routing the calibrated value into them
(`new AIPlayerV4(name, rs, { calibratedFeatures: true })`, benchmark policy
`v4cal`) measured **48.5% vs 51.5%** over 600 games with a *higher* assaf rate
(6.4% vs 5.8%) -- the expected signature of a train/serve mismatch: better
features, weights fit to the old distribution.

It stays **off by default**. To pursue it, the model must be retrained with the
flag enabled during data generation, which needs the calibration moved down
from `AIPlayerV4` to `AIPlayerLearned` (along with `turns_taken` tracking) and
the flag recorded in the checkpoint manifest so serving matches training.

---

## 2026-08-13 — AlphaZero / determinized search rebuild (branch: claude/alphazero-ai-player-jWDWW)

**Result: Failed. V4 remains the strongest.** Every variant measured below V4.
All numbers are one candidate seated against two V4s in a 3-player match, so
**parity is 33.3%**; V4 itself scores 28-36% depending on the sample.

| Player | Win rate vs 2x V4 |
|---|---|
| **V4 (baseline)** | **28-36%** |
| V4-imitation net + determinized MCTS | 20.0% +/- 4.2 (N=90) |
| Flat 1-ply expectimax + greedy rollouts | 15.0% +/- 4.6 (N=60) |
| PIMC tree + rollouts | 12-17% (N=60) |
| 1-ply lookahead anchored on V4, V3 rollouts | 14.2% +/- 3.2 (N=120) |
| Pure policy net, no search | ~0-5% |

This independently **re-confirmed the 2026-06-10 finding** that determinized
rollout search is not viable for action selection here. That entry should have
been read first; doing so would have saved the entire effort. **Read this log
before starting.**

### New measurements worth keeping

1. **Deeper determinized search makes play worse**, with two unrelated leaf
   evaluators (neural value head and Monte Carlo rollouts). Fixed budget
   reallocated: 16 determinizations x 64 sims = 15.6%, 8 x 128 = 8.9%,
   4 x 256 = 6.7%. Raising total sims: 128 -> 7%, 1024 -> 7%, 2048 -> 3%.
   Tree search agreed with brute-force 1-ply evaluation on only 9 of 25
   positions. This is the PIMC strategy-fusion pathology: inside a sampled
   world the searcher sees hidden cards and plans as if it will still know
   them deeper in the tree. **Keep search shallow and wide, or avoid it.**
2. **Imitating V4 caps at ~82% top-1 agreement**, worth only ~20% win rate.
   Not a capacity limit (512-wide/2-block, 1.29M params, 3.2x slower: 82.8%)
   and not a feature limit (+43 hand-engineered features V4 uses: 82.1%).
   V4 selects via stochastic rollout sampling, so ~18% of its moves are not
   recoverable from board state. Imitation also caps at V4's own strength.
3. **The round-outcome value target is mostly noise** (R^2 ceiling ~0.09;
   correlation with hand value only -0.08). A round's result is dominated by
   cards not yet drawn. More data does not help - R^2 plateaued by epoch 5.
4. **AlphaZero self-play has no policy-improvement signal here**: search picks
   the policy's own move 98.3% of the time. Its only real contribution is
   Yaniv timing, where the simulator gives exact terminal scores.
5. **V4's Yaniv calling is already well-calibrated.** Replacing
   `_estimate_assaf_probability` with exact Monte Carlo sampling of opponent
   hands changed nothing as a veto (+0.2pp, inside +/-1.9 noise) and was worse
   as a replacement. Consistent with the 2026-06-10 calibration work.

### Methodology traps that produced false signals

- **Unpaired rollouts.** `YanivGame.fromDict` reshuffles the deck with
  `Math.random`, so each candidate action was judged against a different
  future. Reusing one deck order per determinization (common random numbers)
  is essential or the differences vanish into noise.
- **Ranking candidates by points shed alone ignores the draw choice**, so ties
  break to the deck and the player never picks up from the discard pile. That
  single omission cost the entire ~40pp gap.
- **Winner's curse.** Taking the argmax of K noisy action estimates selects the
  luckiest, not the best. Anchor on a known-good action and require a margin.
- **Varying the evaluation seed per run makes trends unreadable.** At N=60 the
  standard error is ~6pp. Use fixed seeds across compared configurations.

### Engine facts

- `tfjs-node` on Apple Silicon is CPU-only; backprop runs ~230us/example
  regardless of batch size. Batch-1 inference costs about the same as
  batch-128, so batch leaf evaluations or waste ~100x.
- `V4.decide_action` is ~0.8ms, too slow to use as a rollout policy
  (a 30-ply rollout costs ~24ms). V3 with 4 rollout samples is ~85us.
- Greedy simulator rollouts are ~9us, but far too weak to rank actions.

---

## 2026-06-10 — AIPlayerV4: calibrated opponent model + EV-based Yaniv call (branch: claude/game-ai-improvement-98326m)

**Result: New strongest AI.** V4 = learned action policy + determinized
expected-value Yaniv calling on a *calibrated* opponent-hand model. Now wired
as the `hard` difficulty (`createAIPlayer`).

### Benchmarks (vs the previous champion, `learned`)

| Matchup | V4 win/seat | learned win/seat |
|---------|-------------|------------------|
| 2p, 1250+ games across 5 seed batches | ~53-55% | ~45-47% |
| 3p (1 V4 seat vs 2 learned), 150 games | 42.7% | 28.7% |
| 4p (1 V4 seat vs 3 learned), 100 games | 45.0% | 18.3% |

V4's assaf rate per call: 4.7-5.9% (2p). It also *induces* a much higher
assaf rate in opponents (learned jumped from ~6% in the old baseline to
9-12% against V4) because V4 knows when an opponent is about to call and
holds punishing low hands instead of calling into them. Note: the stale
claim of "learned beats V3 75%" was re-measured at 57.7% (300 games).
Latency is unchanged (~2.6ms avg; rollouts only run when hand <= 5).

### The key insight: opponent hand estimates were badly mis-calibrated

Every prior tier estimated an opponent's unknown cards at the mean of the
unseen pool (~5.5-6.3 points/card). Measurement over learned/V3 self-play
(150 games, 2p+3p) showed the *actual* average value of unknown opponent
cards decays sharply as the opponent takes turns, since they curate toward
Yaniv:

- ~0.92-1.00x of unseen mean at turn 0-1, falling to ~0.50x by turn 7+ for
  4-5 card hands (floor ~0.47-0.53).
- 2-card hands decay slower (floor ~0.64).
- A *single* unknown card skews HIGH (~1.05-1.15x): if it were low the
  opponent would already have called Yaniv (survivorship).

The calibration lives in `AIPlayerV4._unknown_value_ratio(handCount,
turnsTaken)` and is applied two ways: (1) exponential tilting of the
belief-weighted card sampling used to build determinized opponent hands, and
(2) the `estimated_score` used by the reset short-circuit. The harness that
produced the curve is easy to rebuild: hook a game loop, and for each
observer record opponent `turns_taken`, hand count, and actual vs predicted
unknown-card value.

### What V4 does

1. **Actions**: unchanged — delegates to the learned policy (still the best
   action chooser; see failed experiments below).
2. **Yaniv call**: for 24 determinizations (belief- and calibration-weighted
   opponent hands + shuffled residual deck), price "call now" *exactly*
   (Assaf comparison, 50/100 reset rule, eliminations) against "play on"
   (roll the chosen action forward up to 28 plies with greedy policies,
   race-aware horizon evaluation). Call iff
   `cost(call) <= cost(play on) + callMargin`.
3. Tuned constants: `callMargin 0.75`, `opponentWeight 0.5` (opponent score
   deltas count half of own), `determinizations 24`. Sweeps showed margin
   0.5-1.0 and dets 24-40 are all within noise; opponentWeight 0.5 slightly
   better than 0.35 in 2p.

### What did NOT work (do not retry blindly)

1. **Determinized rollout search for action selection.** Scoring every
   candidate (discard, draw) by rollouts lost badly: 5% win rate naively,
   still 38-43% vs V3 after fixes. Causes: (a) greedy rollout policies hover
   at 4-5 cards so 16-ply rollouts rarely reached a round end, leaving a
   noisy horizon eval; (b) rollout noise (SE ~2 points at 14-20 dets)
   swamps true action differences (~0.5-1 point) even with common random
   numbers; (c) the simulator cannot see information effects (picking up a
   discard reveals your hand to opponents; the tuned feed/heuristic terms
   capture this implicitly). The well-tuned one-ply heuristic + learned
   ranking remains better for actions.
2. **Uncalibrated EV calling.** With unseen-mean opponent hands, the EV rule
   over-calls into Assafs (7.4% assaf rate) AND defers good calls; it only
   reached parity with V3's hand-tuned thresholds. The calibration is what
   made EV calling win.

### Future ideas

- Re-train the learned action model with the calibrated opponent features
  (estimated_score is an input to several features; the current checkpoint
  was trained on the uncalibrated values).
- Replace the play-on rollout with a 2-3 ply expectimax over determinized
  hands; most call/wait decisions resolve within a few plies anyway.
- Calibrate `_sim_should_call` probabilities from observed call behavior.

---

## 2026-03-22 — AIPlayerV2 (branch: claude/improve-yaniv-ai-strategy-7jpUU)

**Result: No meaningful improvement.** V2 performed within noise of the baseline
Modern AI across 3x1000-game benchmarks (49.7% aggregate win rate).

### What was tried

`AIPlayerV2` extended the base `AIPlayer` with
four targeted changes:

1. **Threat-reactive feed penalty** — increased the cost of discarding cards
   opponents can use, scaling with how close they are to calling Yaniv
   (base 0.22 up to 0.34 at max threat).
2. **Phase-scaled composition bonus** — stronger preference for building
   groups/runs in early/mid game (weight 0.15 vs 0.10, cap 8 vs 6).
3. **More aggressive Yaniv declaration** — lower hand-value threshold for
   calling Yaniv (shifted by ~0.5 points).
4. **Score-pressure-aware Yaniv** — more willing to call Yaniv when own score
   is high (60+) and elimination risk is real.

### Benchmark results (3 runs, 1000 games each)

| Run | V2 wins | Modern wins | V2 Assafs | Modern Assafs |
|-----|---------|-------------|-----------|---------------|
| 1   | 51.3%   | 48.4%       | 572       | 521           |
| 2   | 47.9%   | 51.9%       | 606       | 488           |
| 3   | 49.9%   | 49.6%       | 587       | 510           |

**Aggregate: V2 49.7%, Modern 49.9%** — statistically indistinguishable.

### Key observations

- **V2 consistently receives more Assafs** (~588 avg vs ~506 avg). The more
  aggressive Yaniv calling backfires — it gets caught more often than it gains.
- **Score resets are roughly equal**, so the composition bonus had negligible
  impact on hitting 50/100 resets.
- **Average final scores are within noise** (~83 vs ~83), confirming no
  real improvement.
- **Latency is identical** (~1.33ms avg), so V2 adds no performance cost.

### Why it didn't work

1. **The baseline AI is already well-tuned.** The existing heuristic weights
   in `aiplayer.js` (threat scaling, feed penalty, composition bonus, Yaniv
   threshold) are close to locally optimal. Small perturbations don't help.
2. **Aggressive Yaniv calling is net-negative.** Calling Yaniv with a slightly
   lower hand value increases Assaf risk more than it increases win rate. The
   penalty for getting Assaf'd (30 points) is steep.
3. **Feed avoidance is hard to improve without better opponent modeling.** The
   threat-reactive feed penalty is a blunt instrument — without tracking which
   specific cards opponents need, raising the penalty just makes the AI more
   conservative about all discards.
4. **Composition bonus tuning has diminishing returns.** The base AI already
   does a good job of building groups/runs. Slightly stronger preference
   doesn't change outcomes.

### Suggestions for future attempts

- **Opponent hand tracking**: The biggest untapped information source is
  remembering what opponents pick up from the discard pile. This tells you
  exactly what they're collecting and lets you avoid feeding them.
- **Discard pile memory**: Track what has been discarded to estimate
  probabilities of drawing useful cards vs opponents holding them.
- **Yaniv timing based on opponent hand size**: Instead of just own hand value,
  factor in how many cards opponents hold (public info) to estimate Assaf risk.
- **Multi-player dynamics**: The current AI treats all opponents equally. In
  3-4 player games, targeting the leader or protecting against the player
  closest to calling Yaniv could matter.
- **Monte Carlo simulation**: For critical decisions (call Yaniv vs play on),
  simulate likely outcomes given known information.
- **Fundamentally different approach**: The current heuristic framework may be
  near its ceiling. A learning-based approach (e.g., trained policy via
  self-play) might be needed to break through.
