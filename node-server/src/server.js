const path = require('node:path');
const crypto = require('node:crypto');

const dotenv = require('dotenv');
const express = require('express');

const { YanivGame } = require('./yaniv');
const { Player } = require('./player');
const { AIPlayer } = require('./aiplayer');

let Pool = null;
let HAS_PG = false;
try {
  ({ Pool } = require('pg'));
  HAS_PG = true;
} catch (_err) {
  HAS_PG = false;
}

dotenv.config();

const app = express();
app.use(express.json());

const staticFolder = path.join(__dirname, '..', '..', 'static');
app.use(express.static(staticFolder));

const rooms = {};
const sse_clients = {};

const DB_URL = process.env.DATABASE_URL || 'postgresql://jdross@localhost/yaniv';
let _pool = null;

const _SCHEMA_SQL = `
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

function _register_sse_client(code, pid, client) {
  if (!sse_clients[code]) {
    sse_clients[code] = {};
  }
  sse_clients[code][pid] = client;
}

function _unregister_sse_client(code, pid, client) {
  const clients = sse_clients[code];
  if (!clients) {
    return;
  }
  if (clients[pid] === client) {
    delete clients[pid];
    if (Object.keys(clients).length === 0) {
      delete sse_clients[code];
    }
  }
}

function error_response(res, message, status = 400) {
  return res.status(status).json({ error: message });
}

function _as_json(val) {
  return val === null || val === undefined ? null : JSON.stringify(val);
}

function _parse_jsonish(val) {
  if (val === null || val === undefined) {
    return null;
  }
  if (typeof val === 'string') {
    return JSON.parse(val);
  }
  return val;
}

function _new_room(code, status, members, game = null, winner = null, options = null) {
  return {
    code,
    status,
    members,
    game,
    winner,
    last_round: null,
    last_turn: null,
    round_banner_turns_left: 0,
    options: options || { slamdowns_allowed: false },
    ai_worker_active: false,
  };
}

async function withDb(fn) {
  if (_pool === null) {
    throw new Error('DB pool not initialised');
  }

  const client = await _pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function _ensure_schema() {
  await withDb(async (client) => {
    await client.query(_SCHEMA_SQL);
  });
}

async function _cleanup_stale_rooms() {
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

async function save_room(code) {
  if (_pool === null) {
    return;
  }

  const room = rooms[code];
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

      for (const member of room.members) {
        await client.query(
          `
          INSERT INTO members (code, pid, name, is_ai)
          VALUES ($1, $2, $3, $4)
          ON CONFLICT (code, pid) DO NOTHING
          `,
          [code, member.pid, member.name, member.is_ai],
        );
      }

      const game_json = room.game ? _as_json(room.game.to_dict()) : null;
      await client.query(
        `
        INSERT INTO game_state
          (code, game_json, last_round, last_turn, round_banner_turns_left, options, updated_at)
        VALUES ($1, $2::jsonb, $3::jsonb, $4::jsonb, $5, $6::jsonb, now())
        ON CONFLICT (code) DO UPDATE SET
          game_json               = EXCLUDED.game_json,
          last_round              = EXCLUDED.last_round,
          last_turn               = EXCLUDED.last_turn,
          round_banner_turns_left = EXCLUDED.round_banner_turns_left,
          options                 = EXCLUDED.options,
          updated_at              = now()
        `,
        [
          code,
          game_json,
          _as_json(room.last_round),
          _as_json(room.last_turn),
          room.round_banner_turns_left || 0,
          _as_json(room.options || {}),
        ],
      );
    });
  } catch (exc) {
    console.log(`[DB] save_room error for ${code}: ${exc.message || exc}`);
  }
}

async function _load_rooms() {
  if (_pool === null) {
    return;
  }

  const client = await _pool.connect();
  try {
    const roomRows = await client.query(
      "SELECT code, status, winner FROM rooms WHERE status IN ('playing', 'waiting')",
    );

    for (const row of roomRows.rows) {
      const code = row.code;
      const status = row.status;
      const winner = row.winner;

      const membersResult = await client.query(
        'SELECT pid, name, is_ai FROM members WHERE code = $1',
        [code],
      );
      const members = membersResult.rows.map((memberRow) => ({
        pid: memberRow.pid,
        name: memberRow.name,
        is_ai: memberRow.is_ai,
      }));

      const gameStateResult = await client.query(
        `
        SELECT game_json, last_round, last_turn, round_banner_turns_left, options
        FROM game_state
        WHERE code = $1
        `,
        [code],
      );
      const gs = gameStateResult.rows[0];

      let game = null;
      if (gs && gs.game_json !== null) {
        try {
          game = YanivGame.from_dict(_parse_jsonish(gs.game_json));
        } catch (exc) {
          console.log(`[DB] Could not restore game ${code}: ${exc.message || exc}`);
        }
      }

      const room = _new_room(
        code,
        status,
        members,
        game,
        winner,
        gs && gs.options ? _parse_jsonish(gs.options) : { slamdowns_allowed: false },
      );
      room.last_round = gs ? _parse_jsonish(gs.last_round) : null;
      room.last_turn = gs ? _parse_jsonish(gs.last_turn) : null;
      room.round_banner_turns_left = gs ? gs.round_banner_turns_left : 0;
      rooms[code] = room;
    }
  } finally {
    client.release();
  }
}

function gen_code() {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz';
  let out = '';
  for (let i = 0; i < 5; i += 1) {
    out += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return out;
}

function card_to_dict(c) {
  return {
    id: c._card,
    rank: c.rank,
    suit: c.rank !== 'Joker' ? c.suit : null,
    value: c.value,
  };
}

function room_state(room, pid = null) {
  const players_out = room.members.map((member) => ({
    pid: member.pid,
    name: member.name,
    is_ai: member.is_ai,
  }));

  let game_out = null;

  if (room.game) {
    const g = room.game;

    if (room.status === 'finished') {
      const gplayers = g.players.map((gp) => ({
        name: gp.name,
        score: gp.score,
        hand_count: gp.hand.length,
        is_ai: gp instanceof AIPlayer,
        is_current: false,
        pid: (() => {
          const member = room.members.find((m) => m.name === gp.name && !m.is_ai);
          return member ? member.pid : null;
        })(),
      }));

      game_out = {
        players: gplayers,
        discard_top: [],
        draw_options: [],
        current_player_name: '',
        is_my_turn: false,
        deck_size: 0,
        can_slamdown: false,
        slamdown_card: null,
        slamdowns_allowed: room.options?.slamdowns_allowed || false,
      };
    } else {
      const [current_player, draw_options] = g.start_turn();
      const gplayers = [];

      for (const gp of g.players) {
        const gpd = {
          name: gp.name,
          score: gp.score,
          hand_count: gp.hand.length,
          is_ai: gp instanceof AIPlayer,
          is_current: gp === current_player,
        };

        const mem = room.members.find((m) => m.name === gp.name && !m.is_ai);
        if (mem) {
          gpd.pid = mem.pid;
          if (pid && mem.pid === pid) {
            gpd.hand = gp.hand.map((card) => card_to_dict(card));
            gpd.is_self = true;
            gpd.can_yaniv = g.can_declare_yaniv(gp);
          }
        } else {
          gpd.pid = null;
        }

        gplayers.push(gpd);
      }

      let is_my_turn = false;
      let my_draw_options = [];
      let my_slamdown_card = null;

      if (pid) {
        const cur_mem = room.members.find((m) => m.pid === pid);
        if (cur_mem && current_player.name === cur_mem.name) {
          is_my_turn = true;
          my_draw_options = draw_options.map((card) => card_to_dict(card));
        }

        if (cur_mem && g.slamdown_player === cur_mem.name && g.slamdown_card) {
          my_slamdown_card = card_to_dict(g.slamdown_card);
        }
      }

      game_out = {
        players: gplayers,
        discard_top: g.last_discard.map((card) => card_to_dict(card)),
        draw_options: my_draw_options,
        current_player_name: current_player.name,
        is_my_turn,
        deck_size: g.deck.length,
        can_slamdown: my_slamdown_card !== null,
        slamdown_card: my_slamdown_card,
        slamdowns_allowed: room.options?.slamdowns_allowed || false,
      };
    }
  }

  return {
    code: room.code,
    status: room.status,
    members: players_out,
    game: game_out,
    winner: room.winner,
    last_round: room.last_round,
    last_turn: room.last_turn,
    next_room: room.next_room,
    options: room.options || { slamdowns_allowed: false },
  };
}

async function push_state(code) {
  const room = rooms[code];
  if (!room) {
    return;
  }

  const clients = sse_clients[code] || {};
  for (const [pid, client] of Object.entries(clients)) {
    try {
      client.res.write(`data: ${JSON.stringify(room_state(room, pid))}\n\n`);
    } catch (_err) {
      _unregister_sse_client(code, pid, client);
    }
  }

  await save_room(code);
}

function format_round_result(
  update_info,
  eliminated,
  declarer_name,
  all_players_before,
  scores_before,
  final_hands_by_name,
  declarer_hand_value = 0,
) {
  const reset_names = new Set((update_info.reset_players || []).map((p) => p.name));
  const elim_names = new Set((eliminated || []).map((p) => p.name));

  const result = {
    declarer: declarer_name,
    declarer_hand_value,
    assaf: null,
    resets: [...reset_names],
    eliminated: [...elim_names],
    score_changes: [],
  };

  if (update_info.assaf) {
    result.assaf = {
      assafed: update_info.assaf.assafed.name,
      by: update_info.assaf.assafed_by.name,
    };
  }

  for (const player of all_players_before) {
    const oldScore = scores_before[player.name];
    const net = player.score - oldScore;
    const added = reset_names.has(player.name) ? net + 50 : net;

    result.score_changes.push({
      name: player.name,
      added,
      new_score: player.score,
      reset: reset_names.has(player.name),
      eliminated: elim_names.has(player.name),
      final_hand: final_hands_by_name[player.name] || [],
    });
  }

  return result;
}

function make_last_turn(player_name, discard_cards, draw_action, draw_opts_before) {
  let drawn_card = null;
  let drawn_from = 'deck';

  if (draw_action !== 'deck') {
    drawn_from = 'pile';
    if (draw_action < draw_opts_before.length) {
      drawn_card = card_to_dict(draw_opts_before[draw_action]);
    }
  }

  return {
    player: player_name,
    discarded: discard_cards.map((card) => card_to_dict(card)),
    drawn_from,
    drawn_card,
    is_slamdown: false,
  };
}

function make_last_turn_slamdown(player_name, slammed_card) {
  return {
    player: player_name,
    discarded: [card_to_dict(slammed_card)],
    drawn_from: 'slamdown',
    drawn_card: null,
    is_slamdown: true,
  };
}

function _advance_round_banner(room) {
  const left = room.round_banner_turns_left || 0;
  if (left > 0) {
    room.round_banner_turns_left = left - 1;
    if (left - 1 === 0) {
      room.last_round = null;
    }
  } else {
    room.last_round = null;
  }
}

function _apply_turn_outcome(room, player_name, discard_cards, draw_action, draw_opts_before) {
  _advance_round_banner(room);
  room.last_turn = make_last_turn(player_name, discard_cards, draw_action, draw_opts_before);
}

function _apply_yaniv_outcome(room, game, declarer) {
  const hand_val = declarer.hand.reduce((sum, card) => sum + card.value, 0);
  const all_before = [...game.players];
  const scores_before = {};
  const final_hands_by_name = {};

  for (const player of game.players) {
    scores_before[player.name] = player.score;
    final_hands_by_name[player.name] = player.hand.map((card) => card_to_dict(card));
  }

  const [update_info, eliminated, winner] = game.declare_yaniv(declarer);
  room.last_round = format_round_result(
    update_info,
    eliminated,
    declarer.name,
    all_before,
    scores_before,
    final_hands_by_name,
    hand_val,
  );
  room.round_banner_turns_left = game.players.length;
  room.last_turn = null;

  if (winner) {
    room.status = 'finished';
    room.winner = winner.name;
  }

  return winner;
}

async function process_ai_turns(code) {
  while (true) {
    const room = rooms[code];
    if (!room || room.status !== 'playing' || !room.game) {
      return;
    }

    const game = room.game;
    const [current_player, draw_opts_before] = game.start_turn();

    if (!(current_player instanceof AIPlayer)) {
      return;
    }

    if (game.can_declare_yaniv(current_player) && current_player.should_declare_yaniv()) {
      const winner = _apply_yaniv_outcome(room, game, current_player);
      await push_state(code);
      if (winner) {
        return;
      }
      continue;
    }

    const action = game.play_turn(current_player);
    _apply_turn_outcome(
      room,
      current_player.name,
      action.discard,
      action.draw,
      draw_opts_before,
    );
    await push_state(code);
  }
}

async function _ai_worker_loop(code) {
  try {
    await process_ai_turns(code);
  } finally {
    const room = rooms[code];
    if (room) {
      room.ai_worker_active = false;
    }
  }
}

function start_ai_worker(code) {
  const room = rooms[code];
  if (!room || room.ai_worker_active) {
    return;
  }
  room.ai_worker_active = true;

  setImmediate(() => {
    _ai_worker_loop(code).catch((err) => {
      console.error(`[AI] worker error for ${code}:`, err);
      const workerRoom = rooms[code];
      if (workerRoom) {
        workerRoom.ai_worker_active = false;
      }
    });
  });
}

app.get('/', (_req, res) => {
  res.sendFile(path.join(staticFolder, 'index.html'));
});

app.get('/game/:code', (_req, res) => {
  res.sendFile(path.join(staticFolder, 'game.html'));
});

app.get('/api/events/:code_/:pid', (req, res) => {
  const code_ = String(req.params.code_ || '').toLowerCase();
  const pid = String(req.params.pid || '');

  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  if (typeof res.flushHeaders === 'function') {
    res.flushHeaders();
  }

  const client = {
    res,
    heartbeat: null,
  };

  _register_sse_client(code_, pid, client);

  const room = rooms[code_];
  if (!room) {
    res.write(`data: ${JSON.stringify({ error: 'Room not found' })}\n\n`);
    _unregister_sse_client(code_, pid, client);
    res.end();
    return;
  }

  res.write(`data: ${JSON.stringify(room_state(room, pid))}\n\n`);

  client.heartbeat = setInterval(() => {
    try {
      res.write(': heartbeat\n\n');
    } catch (_err) {
      // no-op
    }
  }, 25000);

  req.on('close', () => {
    if (client.heartbeat) {
      clearInterval(client.heartbeat);
    }
    _unregister_sse_client(code_, pid, client);
  });
});

app.post('/api/create', async (req, res) => {
  const data = req.body || {};
  const pid = data.pid || randomPid();
  const rawName = typeof data.name === 'string' ? data.name : 'Player';
  const name = (rawName.trim().slice(0, 20) || 'Player');

  let ai_count;
  try {
    ai_count = Number.parseInt(data.ai_count ?? 0, 10);
    ai_count = Math.max(0, Math.min(3, ai_count));
  } catch (_err) {
    return error_response(res, 'Invalid AI player count');
  }
  if (Number.isNaN(ai_count)) {
    return error_response(res, 'Invalid AI player count');
  }

  const members = [{ pid, name, is_ai: false }];
  for (let i = 0; i < ai_count; i += 1) {
    members.push({ pid: `ai-${i}`, name: `AI ${i + 1}`, is_ai: true });
  }

  let code = gen_code();
  while (rooms[code]) {
    code = gen_code();
  }
  rooms[code] = _new_room(code, 'waiting', members);

  await save_room(code);
  return res.json({ code, pid });
});

app.post('/api/join', async (req, res) => {
  const data = req.body || {};
  const pid = data.pid || randomPid();
  const code = String(data.code || '').trim().toLowerCase();
  const rawName = typeof data.name === 'string' ? data.name : 'Player';
  const name = (rawName.trim().slice(0, 20) || 'Player');

  const room = rooms[code];
  if (!room) {
    return error_response(res, 'Room not found', 404);
  }
  if (room.status !== 'waiting') {
    return error_response(res, 'Game already started');
  }
  if (room.members.filter((member) => !member.is_ai).length >= 4) {
    return error_response(res, 'Room is full');
  }

  if (!room.members.some((member) => member.pid === pid)) {
    room.members.push({ pid, name, is_ai: false });
  }

  await push_state(code);
  return res.json({ code, pid });
});

app.post('/api/leave', async (req, res) => {
  const data = req.body || {};
  const pid = String(data.pid || '');
  const code = String(data.code || '').trim().toLowerCase();

  const room = rooms[code];
  if (!room) {
    return error_response(res, 'Room not found', 404);
  }
  if (room.status !== 'waiting') {
    return error_response(res, 'Cannot leave after game has started');
  }

  room.members = room.members.filter((member) => member.pid !== pid);
  await push_state(code);
  return res.json({ ok: true });
});

app.get('/api/room/:code', (req, res) => {
  const code = String(req.params.code || '').toLowerCase();
  const pid = String(req.query.pid || '');

  const room = rooms[code];
  if (!room) {
    return error_response(res, 'Not found', 404);
  }

  return res.json(room_state(room, pid));
});

app.post('/api/options', async (req, res) => {
  const data = req.body || {};
  const code = String(data.code || '').toLowerCase();
  const pid = String(data.pid || '');
  const requested = Boolean(data.slamdowns_allowed || false);

  const room = rooms[code];
  if (!room) {
    return error_response(res, 'Room not found', 404);
  }
  if (room.status !== 'waiting') {
    return error_response(res, 'Options can only be changed while waiting');
  }

  const member = room.members.find((m) => m.pid === pid);
  if (!member) {
    return error_response(res, 'Not a member of this game');
  }

  const first_human = room.members.find((m) => !m.is_ai);
  if (!first_human || first_human.pid !== pid) {
    return error_response(res, 'Only the room creator can change options');
  }

  const has_ai = room.members.some((m) => m.is_ai);
  const room_options = { ...(room.options || {}) };
  room_options.slamdowns_allowed = requested && !has_ai;
  room.options = room_options;

  await push_state(code);
  return res.json({ ok: true, options: { ...room_options } });
});

app.post('/api/start', async (req, res) => {
  const data = req.body || {};
  const code = String(data.code || '').toLowerCase();

  const room = rooms[code];
  if (!room || room.status !== 'waiting') {
    return error_response(res, 'Cannot start');
  }
  if (room.members.length < 2) {
    return error_response(res, 'Need at least 2 players');
  }

  const has_ai = room.members.some((m) => m.is_ai);
  const room_options = { ...(room.options || {}) };
  let selected = room_options.slamdowns_allowed || false;
  if (Object.prototype.hasOwnProperty.call(data, 'slamdowns_allowed')) {
    selected = Boolean(data.slamdowns_allowed || false);
  }
  room_options.slamdowns_allowed = Boolean(selected) && !has_ai;
  room.options = room_options;

  const players = room.members.map((member) => (member.is_ai ? new AIPlayer(member.name) : new Player(member.name)));
  const game = new YanivGame(players);
  game.start_game();

  room.game = game;
  room.status = 'playing';
  room.last_round = null;
  room.last_turn = null;

  await push_state(code);
  start_ai_worker(code);
  return res.json({ ok: true });
});

app.post('/api/action', async (req, res) => {
  const data = req.body || {};
  const code = String(data.code || '').toLowerCase();
  const pid = String(data.pid || '');

  let kick_ai = false;

  const room = rooms[code];
  if (!room || room.status !== 'playing') {
    return error_response(res, 'Game not active');
  }

  const game = room.game;
  const [current_player, draw_options] = game.start_turn();

  const mem = room.members.find((member) => member.pid === pid);
  if (!mem) {
    return error_response(res, 'Not a member of this game');
  }

  if (data.declare_slamdown) {
    if (!room.options?.slamdowns_allowed) {
      return error_response(res, 'Slamdowns not enabled in this game');
    }
    if (game.slamdown_player !== mem.name) {
      return error_response(res, 'Slamdown no longer available');
    }

    const slammer = game.players.find((player) => player.name === mem.name);
    if (!slammer) {
      return error_response(res, 'Player not found');
    }

    let slammed_card;
    try {
      slammed_card = game.perform_slamdown(slammer);
    } catch (err) {
      return error_response(res, err.message || String(err));
    }

    room.last_turn = make_last_turn_slamdown(mem.name, slammed_card);
    await push_state(code);
    return res.json({ ok: true });
  }

  if (current_player.name !== mem.name) {
    return error_response(res, 'Not your turn');
  }

  if (data.declare_yaniv) {
    if (!game.can_declare_yaniv(current_player)) {
      return error_response(res, 'Cannot declare Yaniv');
    }

    const winner = _apply_yaniv_outcome(room, game, current_player);
    await push_state(code);
    if (!winner) {
      kick_ai = true;
    }
  } else {
    const card_ids = data.discard || [];
    if (!Array.isArray(card_ids)) {
      return error_response(res, 'Discard must be a list of card IDs');
    }

    const discard_cards = [];
    const hand_copy = [...current_player.hand];

    for (const cid of card_ids) {
      const numericCid = Number(cid);
      const idx = hand_copy.findIndex((card) => card._card === numericCid);
      if (idx === -1) {
        return error_response(res, 'Card not in hand');
      }
      discard_cards.push(hand_copy[idx]);
      hand_copy.splice(idx, 1);
    }

    if (discard_cards.length === 0) {
      return error_response(res, 'Must discard at least one card');
    }

    let draw_action;
    if (data.draw === 'deck') {
      draw_action = 'deck';
    } else {
      const parsed = Number.parseInt(data.draw, 10);
      if (Number.isNaN(parsed)) {
        return error_response(
          res,
          "Invalid 'draw' action. Must be 'deck' or a valid index of a card in discard pile.",
        );
      }
      draw_action = parsed;
    }

    const draw_opts_before = [...draw_options];

    try {
      game.play_turn(current_player, { discard: discard_cards, draw: draw_action });
    } catch (err) {
      return error_response(res, err.message || String(err));
    }

    _apply_turn_outcome(
      room,
      current_player.name,
      discard_cards,
      draw_action,
      draw_opts_before,
    );
    await push_state(code);
    kick_ai = true;
  }

  if (kick_ai) {
    start_ai_worker(code);
  }

  return res.json({ ok: true });
});

app.post('/api/play_again', async (req, res) => {
  const data = req.body || {};
  const code = String(data.code || '').toLowerCase();

  const room = rooms[code];
  if (!room || room.status !== 'finished') {
    return error_response(res, 'Game not finished');
  }

  if (room.next_room) {
    return res.json({ next_room: room.next_room });
  }

  const members = room.members.map((member) => ({ ...member }));
  const options = { ...(room.options || { slamdowns_allowed: false }) };

  const players = members.map((member) => (member.is_ai ? new AIPlayer(member.name) : new Player(member.name)));
  const game = new YanivGame(players);
  game.start_game();

  let new_code = gen_code();
  while (rooms[new_code]) {
    new_code = gen_code();
  }

  rooms[new_code] = _new_room(new_code, 'playing', members, game, null, options);
  room.next_room = new_code;

  await save_room(new_code);
  await push_state(code);
  start_ai_worker(new_code);
  return res.json({ next_room: new_code });
});

async function _init_db() {
  if (!HAS_PG) {
    console.log('[DB] pg not installed — running without persistence');
    return;
  }

  try {
    _pool = new Pool({
      connectionString: DB_URL,
      max: 10,
    });

    await _ensure_schema();
    await _cleanup_stale_rooms();
    await _load_rooms();

    console.log(`[DB] Initialised — ${Object.keys(rooms).length} room(s) restored`);

    for (const [code, room] of Object.entries(rooms)) {
      if (room.status === 'playing' && room.game) {
        const currentPlayer = room.game._get_player();
        if (currentPlayer instanceof AIPlayer) {
          start_ai_worker(code);
        }
      }
    }
  } catch (exc) {
    console.log(`[DB] Init failed — running without persistence: ${exc.message || exc}`);
    _pool = null;
  }
}

async function startServer(port = 5174) {
  await _init_db();

  return new Promise((resolve) => {
    const server = app.listen(port, '0.0.0.0', () => {
      console.log(`[NodeServer] Listening on 0.0.0.0:${port}`);
      resolve(server);
    });
  });
}

if (require.main === module) {
  const port = Number.parseInt(process.env.PORT || '5174', 10);
  startServer(port).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = {
  app,
  startServer,
  rooms,
  sse_clients,
  _init_db,
  _load_rooms,
  save_room,
  push_state,
  _apply_yaniv_outcome,
  _register_sse_client,
  _unregister_sse_client,
  room_state,
};
