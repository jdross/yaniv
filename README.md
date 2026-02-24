# Yaniv Card Game Engine & Interface
A game engine and simple "AI" player for the Yaniv card game

- **yaniv.py** has all the game logic and API for 'playing' a game of Yaniv. 
- **yaniv-cli.py** is a very basic reference implementation of the game, helpful to create better clients. It runs in the command line
- **card.py**, **player.py** and **aiplayer.py** are required classes and self-explanatory

### House rules:
- Game is to 100
- Resets of -50 points landing at multiples of 50
- 5 or fewer points to declare Yaniv
- Assaf'ed players get 30 points & everyone else gets 0 points
- Optional slamdowns in human-only games

### Running tests

Frontend unit tests (Node built-in test runner):

```bash
npm test
# or
npm run test:frontend
```

Python test suite:

```bash
npm run test:python
# or
python3 -m unittest discover -s tests -v
```

Database integration tests (runs against a real Postgres database):

```bash
export YANIV_DB_TEST_URL=postgresql://jdross@localhost/yaniv
npm run test:db
# or
YANIV_DB_TEST_URL=postgresql://jdross@localhost/yaniv python3 -m unittest tests.test_db_integration -v
```

DB integration tests automatically skip when `YANIV_DB_TEST_URL` (or `DATABASE_URL`) is not set or cannot be reached.

### Running server

Install Python dependencies:

```bash
pip3 install -r requirements.txt
```

Development server:

```bash
npm run server:dev
# or
python3 application/server.py
```

Production server (Gunicorn):

```bash
PORT=5174 npm run server:prod
# or
PORT=5174 gunicorn --workers 4 --threads 8 --bind 0.0.0.0:5174 application.server:app
```

### Benchmark AI

Run seeded benchmarks for the modern AI policy:

```bash
python3 scripts/benchmark_ai.py --games 250 --players 3 --scenario modern_vs_random
# Parallelize across CPU cores (deterministic wins/turns; latency timings remain machine/load dependent):
python3 scripts/benchmark_ai.py --games 250 --players 3 --scenario modern_vs_random --jobs 8
```

Results are written to `metrics/ai_benchmark_<timestamp>.json` by default.
