# AGENTS.md

This file is a practical guide for future coding agents working in this repo.

## Project Summary

- Project: Yaniv (card game), Node.js backend + static web frontend.
- Runtime: CommonJS (`type: commonjs`), Express server.
- Naming standard:
  - JavaScript identifiers and wire JSON fields use `camelCase`.
  - SQL table/column names use `snake_case`.

## Repository Layout

- `server/src/server.js`: Express API, SSE, in-memory room state, optional Postgres persistence.
- `server/src/yaniv.js`: Core game engine/rules.
- `server/src/aiplayer.js`: Primary AI policy.
- `server/src/aiplayer_legacy.js`: Legacy AI policy for benchmark comparisons.
- `server/src/card.js`, `server/src/player.js`: Card and player models.
- `static/`: Frontend assets.
  - `static/index.html`: Create/join page + rules shown to users.
  - `static/game.html`: Game screen shell.
  - `static/js/game/*.js`: Split client modules (`core`, `actions`, `render`, `main`, `animations`).
  - `static/js/shared/game-logic.js`: Shared discard validation helpers.
  - `static/js/shared/pid.js`: Persistent local player ID key (`yanivPid`).
- `tests/frontend/*.test.js`: Frontend logic tests.
- `tests/server/*.test.js`: API/game integration tests.
- `scripts/benchmark_ai_node.js`: Modern AI vs random benchmark.
- `scripts/benchmark_compare.js`: Modern AI vs legacy AI benchmark.

## Quick Commands

- Install deps: `npm install`
- Run app: `npm run dev`
- Run tests: `npm test`
- Server tests only: `npm run test:server`
- Frontend tests only: `npm run test:frontend`

## Game Rules Implemented

From product copy and engine behavior:

- Start: each player gets 5 cards.
- Turn: discard valid card set, then draw one card.
- Valid discard:
  - Single card, or
  - Set (2+ same rank, jokers can participate), or
  - Run (3+ consecutive same-suit cards, jokers can fill gaps).
- Card values: Joker 0, Ace 1, 2-9 face value, 10/J/Q/K are 10.
- Yaniv declaration allowed at hand total `<= 5`.
- Assaf rule: if another player has hand total `<=` declarer total, declarer gets `+30`.
- Resets: landing exactly on 50 or 100 (after score increase) applies `-50` reset.
- Elimination: score `> 100`.
- Winner: last remaining player.

### Slamdown (optional rule)

- Configured via `slamdownsAllowed` option.
- Only available for human players (disabled for AI games by policy).
- Triggered after drawing from deck (not discard pile) when drawn card extends the just-discarded set/run.
- Cannot slamdown your last card.

## Runtime Architecture

### Authoritative state

- Server holds authoritative room/game state in memory (`rooms` map).
- Each room includes:
  - `status`: `waiting | playing | finished`
  - `members` with `pid`, `name`, `isAi`
  - `game` (`YanivGame`) when active
  - UI fields: `lastTurn`, `lastRound`, `roundBannerTurnsLeft`, `nextRoom`, `options`

### State delivery

- Clients receive full snapshots over SSE:
  - Endpoint: `GET /api/events/:code/:pid`
- Snapshot can also be fetched via:
  - `GET /api/room/:code?pid=...`
- Server pushes state after every mutation with `pushState()`:
  - Broadcast SSE
  - Persist to DB when configured

### Persistence

- Optional Postgres via `DATABASE_URL`.
- If DB unavailable, app still runs (in-memory only).
- Tables: `rooms`, `members`, `game_state`.
- Important: SQL remains `snake_case`; alias DB fields to `camelCase` in JS query results.

## API Contract (Current)

All request/response JSON uses `camelCase`.

- `POST /api/create` `{ name, pid, aiCount }`
- `POST /api/join` `{ code, pid, name }`
- `POST /api/leave` `{ code, pid }`
- `GET /api/room/:code?pid=...`
- `POST /api/options` `{ code, pid, slamdownsAllowed }`
- `POST /api/start` `{ code, pid, slamdownsAllowed? }`
- `POST /api/action`
  - Turn play: `{ code, pid, discard: number[], draw: 'deck' | number }`
  - Declare Yaniv: `{ code, pid, declareYaniv: true }`
  - Declare slamdown: `{ code, pid, declareSlamdown: true }`
- `POST /api/playAgain` `{ code, pid }`

## Frontend State Notes

- Client modules are split intentionally; keep responsibilities separated:
  - `core.js`: shared state, DOM refs, helpers.
  - `actions.js`: network + user input handlers.
  - `render.js`: all render/markup logic.
  - `main.js`: state orchestration + SSE startup.
- SSE dedup keys in client are explicit (not `JSON.stringify`) to avoid key-order issues across in-memory objects vs JSONB-restored objects.

## AI and Benchmarks

- Main AI API uses camelCase methods (`decideAction`, `shouldDeclareYaniv`, etc.).
- Legacy AI exists only for comparison, but follows current naming style.
- Benchmark scripts are safe places to evaluate behavior/perf after AI changes.

## Conventions and Guardrails

- Keep JS and wire fields camelCase.
- Keep SQL identifiers snake_case.
- If changing API fields/routes, update all of:
  - Server route handlers
  - Frontend fetch calls
  - Tests
  - Any benchmark/script callsites
- Prefer explicit pure helper functions for parse/normalize/format logic.
- Avoid adding compatibility shims for old snake_case payloads unless explicitly requested.

## Agent Change Checklist

Before finishing a change:

1. Run syntax checks for edited JS files (`node --check ...`).
2. Run `npm test`.
3. Ensure endpoint/path renames are mirrored in frontend and tests.
4. If DB query field names are changed, verify aliases still map to expected room state keys.

## Known Good Defaults

- Port default: `5174`
- DB default: `postgresql://localhost/yaniv`
- Max AI players in lobby create flow: `3`

## Common Pitfalls

- Mixing camelCase into SQL column names in raw queries.
- Changing route names without updating frontend module `static/js/game/actions.js`.
- Forgetting server test updates when game engine method names change.
- Reintroducing JSON stringify dedup for SSE state comparisons.
