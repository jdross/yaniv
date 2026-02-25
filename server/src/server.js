const path = require('node:path');
const crypto = require('node:crypto');

const dotenv = require('dotenv');
const express = require('express');

const { YanivGame } = require('./yaniv');
const { Player } = require('./player');
const { AIPlayer } = require('./aiplayer');

let Pool = null;
let hasPg = false;
try {
  ({ Pool } = require('pg'));
  hasPg = true;
} catch (_err) {
  hasPg = false;
}

dotenv.config();

const app = express();
app.use(express.json());

const staticFolder = path.join(__dirname, '..', '..', 'static');
app.use(express.static(staticFolder));

const rooms = new Map();
const sseClients = new Map();

const DB_URL = process.env.DATABASE_URL || 'postgresql://localhost/yaniv';
const DEFAULT_PORT = 5174;
const MAX_AI_PLAYERS = 3;
const HEARTBEAT_INTERVAL_MS = 25000;
const DEFAULT_ROOM_OPTIONS = Object.freeze({
  slamdownsAllowed: false,
});

let pool = null;

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS rooms (
    code       TEXT PRIMARY KEY,
    status     TEXT NOT NULL DEFAULT 'waiting',
    winner     TEXT,
    created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS members (
    code   TEXT REFERENCES rooms(code) ON DELETE CASCADE,
    pid    TEXT NOT NULL,
    name   TEXT NOT NULL,
    is_ai  BOOLEAN NOT NULL DEFAULT FALSE,
    PRIMARY KEY (code, pid)
);

CREATE TABLE IF NOT EXISTS game_state (
    code                    TEXT PRIMARY KEY REFERENCES rooms(code) ON DELETE CASCADE,
    game_json               JSONB,
    last_round              JSONB,
    last_turn               JSONB,
    round_banner_turns_left INTEGER NOT NULL DEFAULT 0,
    options                 JSONB NOT NULL DEFAULT '{}',
    updated_at              TIMESTAMPTZ DEFAULT now()
);
`;

function randomPid() {
  if (typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function parseRoomCode(rawCode) {
  return String(rawCode || '').trim().toLowerCase();
}

function parsePid(rawPid, fallback = null) {
  const pid = String(rawPid || '').trim();
  if (pid) {
    return pid;
  }
  return typeof fallback === 'function' ? fallback() : '';
}

function parsePlayerName(rawName) {
  if (typeof rawName !== 'string') {
    return 'Player';
  }
  return rawName.trim().slice(0, 20) || 'Player';
}

function parseAiCount(rawAiCount) {
  const parsed = Number.parseInt(rawAiCount ?? 0, 10);
  if (Number.isNaN(parsed)) {
    return null;
  }
  return Math.max(0, Math.min(MAX_AI_PLAYERS, parsed));
}

function parseDrawAction(rawDrawAction) {
  if (rawDrawAction === 'deck') {
    return { ok: true, drawAction: 'deck' };
  }

  const parsed = Number.parseInt(rawDrawAction, 10);
  if (Number.isNaN(parsed)) {
    return {
      ok: false,
      error: "Invalid 'draw' action. Must be 'deck' or a valid index of a card in discard pile.",
    };
  }
  return { ok: true, drawAction: parsed };
}

function parseSlamdownsAllowed(payload = {}) {
  return Boolean(payload.slamdownsAllowed ?? false);
}

function generateCode() {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz';
  let code = '';
  for (let i = 0; i < 5; i += 1) {
    code += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return code;
}

function generateUniqueCode() {
  let code = generateCode();
  while (rooms.has(code)) {
    code = generateCode();
  }
  return code;
}

function normalizeRoomOptions(rawOptions = null) {
  if (!rawOptions || typeof rawOptions !== 'object') {
    return { ...DEFAULT_ROOM_OPTIONS };
  }
  return {
    slamdownsAllowed: Boolean(rawOptions.slamdownsAllowed ?? false),
  };
}

function applySlamdownPolicy(options, hasAiPlayers) {
  return {
    ...options,
    slamdownsAllowed: Boolean(options.slamdownsAllowed) && !hasAiPlayers,
  };
}

function toWireRoomOptions(options = DEFAULT_ROOM_OPTIONS) {
  return {
    slamdownsAllowed: Boolean(options.slamdownsAllowed),
  };
}

function createRoom({
  code,
  status,
  members,
  game = null,
  winner = null,
  options = null,
}) {
  return {
    code,
    status,
    members,
    game,
    winner,
    lastRound: null,
    lastTurn: null,
    roundBannerTurnsLeft: 0,
    options: normalizeRoomOptions(options),
    aiWorkerActive: false,
    nextRoom: null,
  };
}

function registerSseClient(code, pid, client) {
  let roomClients = sseClients.get(code);
  if (!roomClients) {
    roomClients = new Map();
    sseClients.set(code, roomClients);
  }
  roomClients.set(pid, client);
}

function unregisterSseClient(code, pid, client) {
  const roomClients = sseClients.get(code);
  if (!roomClients) {
    return;
  }
  if (roomClients.get(pid) === client) {
    roomClients.delete(pid);
    if (roomClients.size === 0) {
      sseClients.delete(code);
    }
  }
}

function errorResponse(res, message, status = 400) {
  return res.status(status).json({ error: message });
}

function asJson(value) {
  return value === null || value === undefined ? null : JSON.stringify(value);
}

function parseJsonish(value) {
  if (value === null || value === undefined) {
    return null;
  }
  return typeof value === 'string' ? JSON.parse(value) : value;
}

function cardToDict(card) {
  return {
    id: card.id,
    rank: card.rank,
    suit: card.rank === 'Joker' ? null : card.suit,
    value: card.value,
  };
}

function roomState(room, pid = '') {
  const members = room.members.map((member) => ({
    pid: member.pid,
    name: member.name,
    isAi: member.isAi,
  }));

  const memberByName = new Map();
  const memberByPid = new Map();
  for (const member of room.members) {
    if (!member.isAi) {
      memberByName.set(member.name, member);
    }
    memberByPid.set(member.pid, member);
  }

  let game = null;
  if (room.game) {
    const gameRef = room.game;

    if (room.status === 'finished') {
      game = {
        players: gameRef.players.map((player) => ({
          name: player.name,
          score: player.score,
          handCount: player.hand.length,
          isAi: player instanceof AIPlayer,
          isCurrent: false,
          pid: memberByName.get(player.name)?.pid ?? null,
        })),
        discardTop: [],
        drawOptions: [],
        currentPlayerName: '',
        isMyTurn: false,
        deckSize: 0,
        canSlamdown: false,
        slamdownCard: null,
        slamdownsAllowed: Boolean(room.options?.slamdownsAllowed),
      };
    } else {
      const [currentPlayer, drawOptions] = gameRef.startTurn();
      const me = pid ? memberByPid.get(pid) : null;

      game = {
        players: gameRef.players.map((player) => {
          const humanMember = memberByName.get(player.name);
          const base = {
            name: player.name,
            score: player.score,
            handCount: player.hand.length,
            isAi: player instanceof AIPlayer,
            isCurrent: player === currentPlayer,
            pid: humanMember?.pid ?? null,
          };

          if (me && humanMember && humanMember.pid === me.pid) {
            base.hand = player.hand.map(cardToDict);
            base.isSelf = true;
            base.canYaniv = gameRef.canDeclareYaniv(player);
          }
          return base;
        }),
        discardTop: gameRef.lastDiscard.map(cardToDict),
        drawOptions: me && currentPlayer.name === me.name ? drawOptions.map(cardToDict) : [],
        currentPlayerName: currentPlayer.name,
        isMyTurn: Boolean(me && currentPlayer.name === me.name),
        deckSize: gameRef.deck.length,
        canSlamdown: Boolean(
          me && gameRef.slamdownPlayer === me.name && gameRef.slamdownCard,
        ),
        slamdownCard:
          me && gameRef.slamdownPlayer === me.name && gameRef.slamdownCard
            ? cardToDict(gameRef.slamdownCard)
            : null,
        slamdownsAllowed: Boolean(room.options?.slamdownsAllowed),
      };
    }
  }

  return {
    code: room.code,
    status: room.status,
    members,
    game,
    winner: room.winner,
    lastRound: room.lastRound,
    lastTurn: room.lastTurn,
    nextRoom: room.nextRoom,
    options: toWireRoomOptions(room.options),
  };
}

function formatRoundResult(
  updateInfo,
  eliminated,
  declarerName,
  allPlayersBefore,
  scoresBefore,
  finalHandsByName,
  declarerHandValue = 0,
) {
  const resetNames = new Set((updateInfo.resetPlayers || []).map((player) => player.name));
  const eliminatedNames = new Set((eliminated || []).map((player) => player.name));

  const result = {
    declarer: declarerName,
    declarerHandValue: declarerHandValue,
    assaf: null,
    resets: [...resetNames],
    eliminated: [...eliminatedNames],
    scoreChanges: [],
  };

  if (updateInfo.assaf) {
    result.assaf = {
      assafed: updateInfo.assaf.assafed.name,
      by: updateInfo.assaf.assafedBy.name,
    };
  }

  for (const player of allPlayersBefore) {
    const oldScore = scoresBefore[player.name];
    const net = player.score - oldScore;
    result.scoreChanges.push({
      name: player.name,
      added: resetNames.has(player.name) ? net + 50 : net,
      newScore: player.score,
      reset: resetNames.has(player.name),
      eliminated: eliminatedNames.has(player.name),
      finalHand: finalHandsByName[player.name] || [],
    });
  }

  return result;
}

function makeLastTurn(playerName, discardCards, drawAction, drawOptionsBefore) {
  const drawFromDeck = drawAction === 'deck';
  const drawnCard = !drawFromDeck && drawAction < drawOptionsBefore.length
    ? cardToDict(drawOptionsBefore[drawAction])
    : null;

  return {
    player: playerName,
    discarded: discardCards.map(cardToDict),
    drawnFrom: drawFromDeck ? 'deck' : 'pile',
    drawnCard: drawnCard,
    isSlamdown: false,
  };
}

function makeLastTurnSlamdown(playerName, slammedCard) {
  return {
    player: playerName,
    discarded: [cardToDict(slammedCard)],
    drawnFrom: 'slamdown',
    drawnCard: null,
    isSlamdown: true,
  };
}

function advanceRoundBanner(room) {
  const turnsLeft = room.roundBannerTurnsLeft || 0;
  if (turnsLeft > 0) {
    room.roundBannerTurnsLeft = turnsLeft - 1;
    if (room.roundBannerTurnsLeft === 0) {
      room.lastRound = null;
    }
    return;
  }
  room.lastRound = null;
}

function applyTurnOutcome(room, playerName, discardCards, drawAction, drawOptionsBefore) {
  advanceRoundBanner(room);
  room.lastTurn = makeLastTurn(playerName, discardCards, drawAction, drawOptionsBefore);
}

function applyYanivOutcome(room, game, declarer) {
  const allPlayersBefore = [...game.players];
  const scoresBefore = Object.fromEntries(
    game.players.map((player) => [player.name, player.score]),
  );
  const finalHandsByName = Object.fromEntries(
    game.players.map((player) => [player.name, player.hand.map(cardToDict)]),
  );
  const declarerHandValue = declarer.hand.reduce((sum, card) => sum + card.value, 0);

  const [updateInfo, eliminated, winner] = game.declareYaniv(declarer);
  room.lastRound = formatRoundResult(
    updateInfo,
    eliminated,
    declarer.name,
    allPlayersBefore,
    scoresBefore,
    finalHandsByName,
    declarerHandValue,
  );
  room.roundBannerTurnsLeft = game.players.length;
  room.lastTurn = null;

  if (winner) {
    room.status = 'finished';
    room.winner = winner.name;
    console.log(`[Server] Game won code=${room.code} winner=${winner.name}`);
  }

  return winner;
}

async function processAiTurns(code) {
  while (true) {
    const room = rooms.get(code);
    if (!room || room.status !== 'playing' || !room.game) {
      return;
    }

    const game = room.game;
    const [currentPlayer, drawOptionsBefore] = game.startTurn();
    if (!(currentPlayer instanceof AIPlayer)) {
      return;
    }

    if (game.canDeclareYaniv(currentPlayer) && currentPlayer.shouldDeclareYaniv()) {
      const winner = applyYanivOutcome(room, game, currentPlayer);
      await pushState(code);
      if (winner) {
        return;
      }
      continue;
    }

    const action = game.playTurn(currentPlayer);
    applyTurnOutcome(
      room,
      currentPlayer.name,
      action.discard,
      action.draw,
      drawOptionsBefore,
    );
    await pushState(code);
  }
}

async function aiWorkerLoop(code) {
  try {
    await processAiTurns(code);
  } finally {
    const room = rooms.get(code);
    if (room) {
      room.aiWorkerActive = false;
    }
  }
}

function startAiWorker(code) {
  const room = rooms.get(code);
  if (!room || room.aiWorkerActive) {
    return;
  }
  room.aiWorkerActive = true;

  setImmediate(() => {
    aiWorkerLoop(code).catch((error) => {
      console.error(`[AI] worker error for ${code}:`, error);
      const activeRoom = rooms.get(code);
      if (activeRoom) {
        activeRoom.aiWorkerActive = false;
      }
    });
  });
}

async function withDb(fn) {
  if (!pool) {
    throw new Error('DB pool not initialised');
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function ensureSchema() {
  await withDb((client) => client.query(SCHEMA_SQL));
}

async function cleanupStaleRooms() {
  const { finished, deleted } = await withDb(async (client) => {
    const finishedResult = await client.query(
      `
      UPDATE rooms
      SET status = 'finished'
      WHERE status = 'playing' AND created_at < now() - interval '7 days'
      `,
    );
    const deletedResult = await client.query(
      `
      DELETE FROM rooms
      WHERE status = 'waiting' AND created_at < now() - interval '12 hours'
      `,
    );

    return {
      finished: finishedResult.rowCount || 0,
      deleted: deletedResult.rowCount || 0,
    };
  });

  if (finished || deleted) {
    console.log(`[DB] Cleanup: ${finished} room(s) marked finished, ${deleted} stale waiting room(s) deleted`);
  }
}

async function saveRoom(code) {
  if (!pool) {
    return;
  }

  const room = rooms.get(code);
  if (!room) {
    return;
  }

  try {
    await withDb(async (client) => {
      await client.query(
        `
        INSERT INTO rooms (code, status, winner)
        VALUES ($1, $2, $3)
        ON CONFLICT (code) DO UPDATE SET
          status = EXCLUDED.status,
          winner = EXCLUDED.winner
        `,
        [code, room.status, room.winner || null],
      );

      if (room.members.length > 0) {
        await client.query(
          `
        INSERT INTO members (code, pid, name, is_ai)
        SELECT
          $1::text,
          member.pid,
          member.name,
          member.is_ai
        FROM UNNEST($2::text[], $3::text[], $4::boolean[]) AS member(pid, name, is_ai)
        ON CONFLICT (code, pid) DO NOTHING
        `,
          [
            code,
            room.members.map((member) => member.pid),
            room.members.map((member) => member.name),
            room.members.map((member) => member.isAi),
          ],
        );
      }

      await client.query(
        `
        INSERT INTO game_state
          (code, game_json, last_round, last_turn, round_banner_turns_left, options, updated_at)
        VALUES ($1, $2::jsonb, $3::jsonb, $4::jsonb, $5, $6::jsonb, now())
        ON CONFLICT (code) DO UPDATE SET
          game_json = EXCLUDED.game_json,
          last_round = EXCLUDED.last_round,
          last_turn = EXCLUDED.last_turn,
          round_banner_turns_left = EXCLUDED.round_banner_turns_left,
          options = EXCLUDED.options,
          updated_at = now()
        `,
        [
          code,
          asJson(room.game ? room.game.toDict() : null),
          asJson(room.lastRound),
          asJson(room.lastTurn),
          room.roundBannerTurnsLeft || 0,
          asJson(toWireRoomOptions(room.options)),
        ],
      );
    });
  } catch (error) {
    console.log(`[DB] saveRoom error for ${code}: ${error.message || error}`);
  }
}

async function loadRooms() {
  if (!pool) {
    return;
  }

  const client = await pool.connect();
  try {
    const roomResult = await client.query(
      "SELECT code, status, winner FROM rooms WHERE status IN ('playing', 'waiting')",
    );
    const roomRows = roomResult.rows;
    if (roomRows.length === 0) {
      return;
    }

    const codes = roomRows.map((row) => row.code);
    const memberResult = await client.query(
      `
      SELECT code, pid, name, is_ai AS "isAi"
      FROM members
      WHERE code = ANY($1::text[])
      ORDER BY code
      `,
      [codes],
    );
    const gameStateResult = await client.query(
      `
      SELECT
        code,
        game_json AS "gameJson",
        last_round AS "lastRound",
        last_turn AS "lastTurn",
        round_banner_turns_left AS "roundBannerTurnsLeft",
        options
      FROM game_state
      WHERE code = ANY($1::text[])
      `,
      [codes],
    );

    const membersByCode = new Map();
    for (const row of memberResult.rows) {
      if (!membersByCode.has(row.code)) {
        membersByCode.set(row.code, []);
      }
      membersByCode.get(row.code).push({
        pid: row.pid,
        name: row.name,
        isAi: row.isAi,
      });
    }

    const gameStateByCode = new Map(gameStateResult.rows.map((row) => [row.code, row]));

    for (const roomRow of roomRows) {
      const gs = gameStateByCode.get(roomRow.code);
      let game = null;
      if (gs && gs.gameJson !== null) {
        try {
          game = YanivGame.fromDict(parseJsonish(gs.gameJson));
        } catch (error) {
          console.log(`[DB] Could not restore game ${roomRow.code}: ${error.message || error}`);
        }
      }

      const room = createRoom({
        code: roomRow.code,
        status: roomRow.status,
        members: membersByCode.get(roomRow.code) || [],
        game,
        winner: roomRow.winner,
        options: normalizeRoomOptions(parseJsonish(gs?.options)),
      });
      room.lastRound = parseJsonish(gs?.lastRound);
      room.lastTurn = parseJsonish(gs?.lastTurn);
      room.roundBannerTurnsLeft = gs?.roundBannerTurnsLeft || 0;
      rooms.set(room.code, room);
    }
  } finally {
    client.release();
  }
}

async function broadcastRoomState(code) {
  const room = rooms.get(code);
  if (!room) {
    return;
  }

  const clients = sseClients.get(code);
  if (!clients || clients.size === 0) {
    return;
  }

  for (const [pid, client] of clients.entries()) {
    try {
      client.res.write(`data: ${JSON.stringify(roomState(room, pid))}\n\n`);
    } catch (_error) {
      unregisterSseClient(code, pid, client);
    }
  }
}

async function pushState(code) {
  await broadcastRoomState(code);
  await saveRoom(code);
}

app.get('/', (_req, res) => {
  res.sendFile(path.join(staticFolder, 'index.html'));
});

app.get('/game/:code', (_req, res) => {
  res.sendFile(path.join(staticFolder, 'game.html'));
});

app.get('/api/events/:code/:pid', (req, res) => {
  const code = parseRoomCode(req.params.code);
  const pid = parsePid(req.params.pid);

  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  if (typeof res.flushHeaders === 'function') {
    res.flushHeaders();
  }

  const client = { res, heartbeat: null };
  registerSseClient(code, pid, client);

  const room = rooms.get(code);
  if (!room) {
    res.write(`data: ${JSON.stringify({ error: 'Room not found' })}\n\n`);
    unregisterSseClient(code, pid, client);
    res.end();
    return;
  }

  res.write(`data: ${JSON.stringify(roomState(room, pid))}\n\n`);

  client.heartbeat = setInterval(() => {
    try {
      res.write(': heartbeat\n\n');
    } catch (_error) {
      // no-op
    }
  }, HEARTBEAT_INTERVAL_MS);

  req.on('close', () => {
    if (client.heartbeat) {
      clearInterval(client.heartbeat);
    }
    unregisterSseClient(code, pid, client);
  });
});

app.post('/api/create', async (req, res) => {
  const payload = req.body || {};
  const pid = parsePid(payload.pid, randomPid);
  const name = parsePlayerName(payload.name);
  const aiCount = parseAiCount(payload.aiCount);

  if (aiCount === null) {
    return errorResponse(res, 'Invalid AI player count');
  }

  const members = [{ pid, name, isAi: false }];
  for (let i = 0; i < aiCount; i += 1) {
    members.push({ pid: `ai-${i}`, name: `AI ${i + 1}`, isAi: true });
  }

  const code = generateUniqueCode();

  rooms.set(code, createRoom({ code, status: 'waiting', members }));
  await saveRoom(code);

  console.log(
    `[Server] Game created code=${code} creator=${name} players=${members.length} ai=${aiCount}`,
  );
  return res.json({ code, pid });
});

app.post('/api/join', async (req, res) => {
  const payload = req.body || {};
  const code = parseRoomCode(payload.code);
  const pid = parsePid(payload.pid, randomPid);
  const name = parsePlayerName(payload.name);

  const room = rooms.get(code);
  if (!room) {
    return errorResponse(res, 'Room not found', 404);
  }
  if (room.status !== 'waiting') {
    return errorResponse(res, 'Game already started');
  }
  if (room.members.filter((member) => !member.isAi).length >= 4) {
    return errorResponse(res, 'Room is full');
  }

  if (!room.members.some((member) => member.pid === pid)) {
    room.members.push({ pid, name, isAi: false });
  }

  await pushState(code);
  return res.json({ code, pid });
});

app.post('/api/leave', async (req, res) => {
  const payload = req.body || {};
  const code = parseRoomCode(payload.code);
  const pid = parsePid(payload.pid);

  const room = rooms.get(code);
  if (!room) {
    return errorResponse(res, 'Room not found', 404);
  }
  if (room.status !== 'waiting') {
    return errorResponse(res, 'Cannot leave after game has started');
  }

  room.members = room.members.filter((member) => member.pid !== pid);
  await pushState(code);
  return res.json({ ok: true });
});

app.get('/api/room/:code', (req, res) => {
  const code = parseRoomCode(req.params.code);
  const pid = parsePid(req.query.pid);

  const room = rooms.get(code);
  if (!room) {
    return errorResponse(res, 'Not found', 404);
  }
  return res.json(roomState(room, pid));
});

app.post('/api/options', async (req, res) => {
  const payload = req.body || {};
  const code = parseRoomCode(payload.code);
  const pid = parsePid(payload.pid);
  const requestedSlamdowns = parseSlamdownsAllowed(payload);

  const room = rooms.get(code);
  if (!room) {
    return errorResponse(res, 'Room not found', 404);
  }
  if (room.status !== 'waiting') {
    return errorResponse(res, 'Options can only be changed while waiting');
  }

  const member = room.members.find((entry) => entry.pid === pid);
  if (!member) {
    return errorResponse(res, 'Not a member of this game');
  }

  const creator = room.members.find((entry) => !entry.isAi);
  if (!creator || creator.pid !== pid) {
    return errorResponse(res, 'Only the room creator can change options');
  }

  const hasAiPlayers = room.members.some((entry) => entry.isAi);
  room.options = applySlamdownPolicy(
    {
      ...normalizeRoomOptions(room.options),
      slamdownsAllowed: requestedSlamdowns,
    },
    hasAiPlayers,
  );

  await pushState(code);
  return res.json({ ok: true, options: toWireRoomOptions(room.options) });
});

app.post('/api/start', async (req, res) => {
  const payload = req.body || {};
  const code = parseRoomCode(payload.code);

  const room = rooms.get(code);
  if (!room || room.status !== 'waiting') {
    return errorResponse(res, 'Cannot start');
  }
  if (room.members.length < 2) {
    return errorResponse(res, 'Need at least 2 players');
  }

  const hasAiPlayers = room.members.some((entry) => entry.isAi);
  const requestedSlamdowns = parseSlamdownsAllowed(payload);
  const explicitlySetSlamdowns =
    Object.prototype.hasOwnProperty.call(payload, 'slamdownsAllowed');

  room.options = applySlamdownPolicy(
    {
      ...normalizeRoomOptions(room.options),
      slamdownsAllowed: explicitlySetSlamdowns
        ? requestedSlamdowns
        : Boolean(room.options?.slamdownsAllowed),
    },
    hasAiPlayers,
  );

  const players = room.members.map((member) => (
    member.isAi ? new AIPlayer(member.name) : new Player(member.name)
  ));
  const game = new YanivGame(players);
  game.startGame();

  room.game = game;
  room.status = 'playing';
  room.lastRound = null;
  room.lastTurn = null;

  console.log(
    `[Server] Game started code=${code} players=${room.members.map((m) => m.name).join(',')} slamdowns=${room.options.slamdownsAllowed}`,
  );

  await pushState(code);
  startAiWorker(code);
  return res.json({ ok: true });
});

app.post('/api/action', async (req, res) => {
  const payload = req.body || {};
  const code = parseRoomCode(payload.code);
  const pid = parsePid(payload.pid);

  const room = rooms.get(code);
  if (!room || room.status !== 'playing') {
    return errorResponse(res, 'Game not active');
  }

  const game = room.game;
  const [currentPlayer, drawOptions] = game.startTurn();
  const member = room.members.find((entry) => entry.pid === pid);
  if (!member) {
    return errorResponse(res, 'Not a member of this game');
  }

  if (payload.declareSlamdown) {
    if (!room.options?.slamdownsAllowed) {
      return errorResponse(res, 'Slamdowns not enabled in this game');
    }
    if (game.slamdownPlayer !== member.name) {
      return errorResponse(res, 'Slamdown no longer available');
    }

    const slammer = game.players.find((player) => player.name === member.name);
    if (!slammer) {
      return errorResponse(res, 'Player not found');
    }

    let slammedCard;
    try {
      slammedCard = game.performSlamdown(slammer);
    } catch (error) {
      return errorResponse(res, error.message || String(error));
    }

    room.lastTurn = makeLastTurnSlamdown(member.name, slammedCard);
    await pushState(code);
    return res.json({ ok: true });
  }

  if (currentPlayer.name !== member.name) {
    return errorResponse(res, 'Not your turn');
  }

  let shouldKickAi = false;
  if (payload.declareYaniv) {
    if (!game.canDeclareYaniv(currentPlayer)) {
      return errorResponse(res, 'Cannot declare Yaniv');
    }

    const winner = applyYanivOutcome(room, game, currentPlayer);
    await pushState(code);
    shouldKickAi = !winner;
  } else {
    const cardIds = payload.discard || [];
    if (!Array.isArray(cardIds)) {
      return errorResponse(res, 'Discard must be a list of card IDs');
    }

    const discardCards = [];
    const handCopy = [...currentPlayer.hand];
    for (const cardId of cardIds) {
      const numericCardId = Number(cardId);
      const index = handCopy.findIndex((card) => card.id === numericCardId);
      if (index === -1) {
        return errorResponse(res, 'Card not in hand');
      }
      discardCards.push(handCopy[index]);
      handCopy.splice(index, 1);
    }
    if (discardCards.length === 0) {
      return errorResponse(res, 'Must discard at least one card');
    }

    const parsedDraw = parseDrawAction(payload.draw);
    if (!parsedDraw.ok) {
      return errorResponse(res, parsedDraw.error);
    }

    const drawAction = parsedDraw.drawAction;
    const drawOptionsBefore = [...drawOptions];
    try {
      game.playTurn(currentPlayer, { discard: discardCards, draw: drawAction });
    } catch (error) {
      return errorResponse(res, error.message || String(error));
    }

    applyTurnOutcome(
      room,
      currentPlayer.name,
      discardCards,
      drawAction,
      drawOptionsBefore,
    );
    await pushState(code);
    shouldKickAi = true;
  }

  if (shouldKickAi) {
    startAiWorker(code);
  }
  return res.json({ ok: true });
});

app.post('/api/playAgain', async (req, res) => {
  const payload = req.body || {};
  const code = parseRoomCode(payload.code);

  const room = rooms.get(code);
  if (!room || room.status !== 'finished') {
    return errorResponse(res, 'Game not finished');
  }
  if (room.nextRoom) {
    return res.json({ nextRoom: room.nextRoom });
  }

  const members = room.members.map((member) => ({ ...member }));
  const options = normalizeRoomOptions(room.options);

  const players = members.map((member) => (
    member.isAi ? new AIPlayer(member.name) : new Player(member.name)
  ));
  const game = new YanivGame(players);
  game.startGame();

  const newCode = generateUniqueCode();

  rooms.set(newCode, createRoom({
    code: newCode,
    status: 'playing',
    members,
    game,
    options,
  }));
  room.nextRoom = newCode;

  console.log(
    `[Server] Game started code=${newCode} rematchOf=${code} players=${members.map((m) => m.name).join(',')} slamdowns=${options.slamdownsAllowed}`,
  );

  await saveRoom(newCode);
  await pushState(code);
  startAiWorker(newCode);
  return res.json({ nextRoom: newCode });
});

async function initDb() {
  if (!hasPg) {
    console.log('[DB] pg not installed — running without persistence');
    return;
  }

  try {
    pool = new Pool({
      connectionString: DB_URL,
      max: 10,
    });
    await ensureSchema();
    await cleanupStaleRooms();
    await loadRooms();

    console.log(`[DB] Initialised — ${rooms.size} room(s) restored`);
    for (const [code, room] of rooms.entries()) {
      if (room.status === 'playing' && room.game) {
        const currentPlayer = room.game.getCurrentPlayer();
        if (currentPlayer instanceof AIPlayer) {
          startAiWorker(code);
        }
      }
    }
  } catch (error) {
    console.log(`[DB] Init failed — running without persistence: ${error.message || error}`);
    pool = null;
  }
}

async function startServer(port = DEFAULT_PORT) {
  await initDb();

  return new Promise((resolve) => {
    const server = app.listen(port, '0.0.0.0', () => {
      console.log(`[Server] Listening on 0.0.0.0:${port}`);
      resolve(server);
    });
  });
}

if (require.main === module) {
  const port = Number.parseInt(process.env.PORT || String(DEFAULT_PORT), 10);
  startServer(port).catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

module.exports = {
  app,
  startServer,
  rooms,
  sseClients,
  initDb,
  loadRooms,
  saveRoom,
  pushState,
  applyYanivOutcome,
  registerSseClient,
  unregisterSseClient,
  roomState,
};
