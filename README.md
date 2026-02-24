# Yaniv Local Setup

This repo includes two backend implementations for the same Yaniv web app:

- `server/` (Node.js)
- `python-server/` (Python)

Start either one, then open [http://localhost:5174](http://localhost:5174).

## Optional environment setup

```bash
cp .env.example .env
```

Useful env vars:

- `PORT` (default: `5174`)
- `DATABASE_URL` (default: `postgresql://localhost/yaniv`)

If Postgres is unavailable, the app still runs, but persistence is disabled.

## Run the Node server

Requirements: Node.js + npm

```bash
npm run server:node:install
npm run server:node:dev
```

For production-style startup:

```bash
npm run server:node:start
```

## Run the Python server

Requirements: Python 3 + pip

```bash
python3 -m pip install -r python-server/requirements.txt
npm run server:dev
```

Equivalent direct run:

```bash
python3 python-server/application/server.py
```

For production-style startup (Gunicorn):

```bash
PORT=8080 npm run server:prod
```

## Quick test commands

```bash
npm test
npm run test:python
```
