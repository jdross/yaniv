# Lettermelt — state of play

A mobile-web word game: swipe to trace words on a dynamic grid of connected
letters. Everything lives under `static/lettermelt/` plus
`scripts/build_zanagrams_wordlists.js` and `tests/frontend/zanagrams.test.js`.

Run it: `python3 -m http.server 5174` from `static/`, then open
`http://localhost:5174/lettermelt/`. Tests: `node --test tests/frontend/zanagrams.test.js`
(40 tests, ~35s, all passing).

## The model, in one paragraph

The board is EXACTLY the union of the remaining words' canonical paths. A
letter is on the board iff at least one unsolved word uses it; a connection is
drawn iff at least one unsolved word steps across it. Solving a word recomputes
the union, so only orphaned letters and lanes disappear. This is what makes the
puzzle solvable by construction — canonical paths are never disturbed, so
removal can never strand a word that is still to be found.

## Rules the generator enforces

- Fixed 5x5 grid (<= 25 cells), gaps allowed; 10-16 required words.
- Exactly one 8-11 letter "base" word; every other word is 4+ letters. Three-letter
  traces are never valid.
- Every *common* word traceable on the board is promoted into the required set.
  Extras are exclusively rare/uncommon words — that is why "surge" and "find"
  can't come back as "not a word".
- No plurals, -ed, -ing, or comparatives anywhere. No proper nouns as required
  words (kept as extras only when they have another meaning, e.g. "roger"). No
  mature or offensive words at all.
- Same-root pairs (print/printer) are penalised; merely-overlapping different
  words (race/trace) are not — those are still fun to find.
- Over-full boards are fixed by trimming *connections* (each carries a known
  word set) rather than being thrown away; the base word's route is protected.

Commonness comes from Zipf frequency (`scripts/dump_word_zipf.py` writes
`scripts/data/word-zipf.txt` using Python `wordfreq`, so the Node build needs no
Python at build time). SCOWL spell-check tiers are used ONLY to filter lowercase
proper nouns — they rank familiarity backwards otherwise (lath 35, gator 55).

## Clock, stars and modes

`STAR_SCHEDULES` in `js/engine.js` is the single source of truth.

| mode | 5 stars | 4 | 3 | 2 | 1 | fail |
|------|---------|---|---|---|---|------|
| hard | < 5:00  | < 6:00 | < 7:30 | < 10:00 | — | 10:00 |
| easy | < 3:00  | < 3:30 | < 4:00 | < 4:30  | < 5:00 | 5:00 |

Elapsed time counts up; the vial shows what is left of `failMs`. Reaching the
deadline sets `status = 'lost'`. The only win is emptying the board. Extra words
subtract elapsed time (clamped at zero), so they can buy a spent star back.

## Generation is a pure function of its seed

This matters: share links carry only `?s=<seed>&m=<mode>`, so the recipient must
rebuild the identical board. The generator therefore has **no wall-clock
budget** — the search is bounded by `CONFIG.restarts` (40, ~200ms) and the DFS
step budgets, and by nothing else. A `timeBudgetMs` deadline used to cut the
restart loop short at a different point on every load, so the same seed built
different puzzles. Do not reintroduce one; `CONFIG.timeBudgetMs` being
`undefined` is asserted by a test.

## The vial (the clock UI)

`.vial` in `zan.css`: one clipped rounded bore, a five-stop lava gradient,
rising bubbles that are children of the liquid (so they vanish as the level
drops), a swelling meniscus at the draining edge, and a specular glass sweep
painted across liquid and empty alike.

Star notches sit on the **floor** of the tube as graduations. They were
full-height lines twice and both times they read as hard dividers chopping the
lava into segments — the "border artifacts" the design brief rules out. Any
mark drawn across the liquid at this height (30px) will do that. Keep them on
the rim.

## Layout

`.hud-row` is a `1fr auto 1fr` grid: word count left, stars centred in the
screen, mode/new buttons right. The base word is not shown anywhere; solving it
just flashes "longest word!", which fades like any other message.

## Traps worth knowing

- **Renderer callbacks outliving a puzzle.** Node ids restart at 1 for each new
  puzzle, so a melt timeout or position tween from the previous board will move
  the new board's tiles. `state.gen` is a generation token that cancels stale
  deferred callbacks; keep new deferred work behind it.
- **Trim vs laid words.** After edge-trimming, always re-route words through the
  enumerator. Re-adding a word's original route can restore a cut edge and break
  the union invariant.
- **Fallback word lists.** `Generator.FALLBACK_COMMON`/`FALLBACK_EXTRA` are a
  substitute for the real lists, never something to concatenate onto them — they
  contain sample plurals that would otherwise leak in as required words.
- **Driving the game from a test harness.** Cells store *grid* coordinates
  (x,y = column,row), not pixels — use `renderer.nodeClientPoint(id)` for screen
  points. Edges are `[a, b]` arrays, not `{a, b}` objects. And wait for the board
  to go idle before the next trace: `main.js` holds `busy` through a
  hold-then-melt beat during which nothing moves, so "positions are stable" alone
  is not a readiness signal — poll for `#currentText` being empty as well.

## Verified in a real browser

Chromium at 390x844 with `hasTouch`, `playwright-core` from `node_modules`,
executable at `/opt/pw-browsers/chromium-1194/chrome-linux/chrome`. A full
16-word board was solved end to end through synthesised touch traces: no stuck
lanes, no orphaned letters or lanes at any step, board empties to zero, win
sheet reports 5 stars, no console errors. The same seed rebuilt the same board
across three page loads.
