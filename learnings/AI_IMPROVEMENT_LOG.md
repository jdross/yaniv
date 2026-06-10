# Yaniv AI Improvement Log

Record of attempts to improve the AI player strategy, so future efforts can
build on what was learned rather than repeat what was tried.

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
