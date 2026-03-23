# Yaniv AI Improvement Log

Record of attempts to improve the AI player strategy, so future efforts can
build on what was learned rather than repeat what was tried.

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
