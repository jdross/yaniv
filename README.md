# Yaniv Local Setup

This repo runs on a Node.js backend in `server/`.
Start the server, then open [http://localhost:5174](http://localhost:5174).

## Optional environment setup

```bash
cp .env.example .env
```

Useful env vars:

- `PORT` (default: `5174`)
- `DATABASE_URL` (default: `postgresql://localhost/yaniv`)

If Postgres is unavailable, the app still runs, but persistence is disabled.

## Run the server

Requirements: Node.js + npm

```bash
npm run server:install
npm run server:dev
```

For production-style startup:

```bash
npm run server:start
```

## Quick test commands

```bash
npm test
```
