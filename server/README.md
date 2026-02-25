# Server (Node.js)

This folder contains the Yaniv backend server and core game logic.

## Install

```bash
npm run server:install
```

## Run

```bash
npm run server:dev
```

The server reads:

- `DATABASE_URL` (default: `postgresql://jdross@localhost/yaniv`)
- `PORT` (default: `5174`)

It serves the same static frontend from `../static` and exposes the same API/SSE routes.
