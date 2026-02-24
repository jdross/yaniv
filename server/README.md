# Server (Node.js implementation)

This folder contains a lightweight Node.js port of the Python game server and core game logic.

## Install

```bash
npm run server:node:install
```

## Run

```bash
npm run server:node:dev
```

The Node server reads the same environment variables as the Python server:

- `DATABASE_URL` (default: `postgresql://jdross@localhost/yaniv`)
- `PORT` (default: `5174`)

It serves the same static frontend from `../static` and exposes the same API/SSE routes.
