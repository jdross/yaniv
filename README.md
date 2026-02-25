# Yaniv Local Setup

This repo runs a Node.js backend at `server/src/server.js` and serves the frontend from `static/`.
Start the server, then open [http://localhost:5174](http://localhost:5174).

## Optional environment setup

```bash
cp .env.example .env
```

Useful env vars:

- `PORT` (default: `5174`)
- `DATABASE_URL` (default: `postgresql://localhost/yaniv`)

If Postgres is unavailable, the app still runs, but persistence is disabled.

## Install dependencies

Requirements: Node.js + npm

```bash
npm install
```

## Run the server

```bash
npm run dev
```

For production-style startup:

```bash
npm run start
```

## Quick test commands

```bash
npm test
```
