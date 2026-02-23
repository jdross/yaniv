import sys, os, uuid, random, string, queue, threading, json
from contextlib import contextmanager
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from dotenv import load_dotenv
load_dotenv()

from flask import Flask, request, jsonify, send_from_directory, Response, stream_with_context

try:
    import psycopg2
    from psycopg2.pool import ThreadedConnectionPool
    HAS_PSYCOPG2 = True
except ImportError:
    HAS_PSYCOPG2 = False

from yaniv import YanivGame
from player import Player
from aiplayer import AIPlayer

app = Flask(__name__,
            static_folder=os.path.join(os.path.dirname(os.path.dirname(__file__)), 'static'),
            static_url_path='')
app.secret_key = 'yaniv-secret-key-change-in-prod'

rooms = {}
sse_clients = {}   # code -> {pid: queue.Queue}
sse_lock = threading.Lock()
room_locks = {}    # code -> threading.RLock
room_locks_guard = threading.Lock()
rooms_guard = threading.Lock()


def error_response(message, status=400):
    return jsonify({'error': message}), status


def _get_room_lock(code):
    with room_locks_guard:
        lock = room_locks.get(code)
        if lock is None:
            lock = threading.RLock()
            room_locks[code] = lock
        return lock


@contextmanager
def _with_room_lock(code):
    lock = _get_room_lock(code)
    lock.acquire()
    try:
        yield
    finally:
        lock.release()

# ── Database ───────────────────────────────────────────────────────────────────

DB_URL = os.getenv('DATABASE_URL', 'postgresql://jdross@localhost/yaniv')
_pool  = None   # ThreadedConnectionPool, set by _init_db()

# All schema in one idempotent migration block
_MIGRATION_SQL = """
CREATE TABLE IF NOT EXISTS schema_version (
    version INTEGER NOT NULL
);

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

ALTER TABLE game_state ADD COLUMN IF NOT EXISTS options JSONB NOT NULL DEFAULT '{}';
"""

_SCHEMA_VERSION = 2


@contextmanager
def _get_db():
    """Yield a psycopg2 connection from the pool, committing on success."""
    if _pool is None:
        raise RuntimeError('DB pool not initialised')
    conn = _pool.getconn()
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        _pool.putconn(conn)


def _run_migrations():
    with _get_db() as conn:
        with conn.cursor() as cur:
            cur.execute(_MIGRATION_SQL)
            cur.execute('SELECT COUNT(*) FROM schema_version')
            if cur.fetchone()[0] == 0:
                cur.execute('INSERT INTO schema_version VALUES (%s)', (_SCHEMA_VERSION,))
            else:
                cur.execute('UPDATE schema_version SET version = %s', (_SCHEMA_VERSION,))


def _cleanup_stale_rooms():
    """On startup: mark old playing rooms as finished; delete stale waiting rooms (and CASCADE)."""
    with _get_db() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                UPDATE rooms
                SET status = 'finished'
                WHERE status = 'playing' AND created_at < now() - interval '7 days'
                """
            )
            finished = cur.rowcount
            cur.execute(
                """
                DELETE FROM rooms
                WHERE status = 'waiting' AND created_at < now() - interval '12 hours'
                """
            )
            deleted = cur.rowcount
    if finished or deleted:
        print(f'[DB] Cleanup: {finished} room(s) marked finished, {deleted} stale waiting room(s) deleted')


def _init_db():
    """Connect to Postgres, migrate, and load existing rooms into memory."""
    global _pool
    if not HAS_PSYCOPG2:
        print('[DB] psycopg2 not installed — running without persistence')
        return
    try:
        _pool = ThreadedConnectionPool(2, 10, DB_URL)
        _run_migrations()
        _cleanup_stale_rooms()
        _load_rooms()
        print(f'[DB] Initialised — {len(rooms)} room(s) restored')
        # Resume any AI turns that were in progress when the server last stopped
        for code, room in list(rooms.items()):
            if room['status'] == 'playing' and room['game']:
                cp = room['game']._get_player()
                if isinstance(cp, AIPlayer):
                    start_ai_worker(code)
    except Exception as exc:
        print(f'[DB] Init failed — running without persistence: {exc}')
        _pool = None


# ── Serialisation helpers ──────────────────────────────────────────────────────

def game_to_json(game):
    return game.to_dict()


def game_from_json(data):
    return YanivGame.from_dict(data)


# ── Persistence helpers ────────────────────────────────────────────────────────

def _as_json(val):
    """Return a JSON string for a non-None value, else None."""
    return json.dumps(val) if val is not None else None


def _parse_jsonish(val):
    if val is None:
        return None
    return val if isinstance(val, (dict, list)) else json.loads(val)


def _new_room(code, status, members, game=None, winner=None, options=None):
    return {
        'code':                    code,
        'status':                  status,
        'members':                 members,
        'game':                    game,
        'winner':                  winner,
        'last_round':              None,
        'last_turn':               None,
        'round_banner_turns_left': 0,
        'options':                 options or {'slamdowns_allowed': False},
        'ai_worker_active':        False,
    }


def save_room(code):
    """Write the current in-memory room state to the database."""
    if _pool is None:
        return
    with _with_room_lock(code):
        room = rooms.get(code)
        if not room:
            return
        try:
            with _get_db() as conn:
                with conn.cursor() as cur:
                    # Upsert room row
                    cur.execute(
                        """
                        INSERT INTO rooms (code, status, winner)
                        VALUES (%s, %s, %s)
                        ON CONFLICT (code) DO UPDATE SET
                            status = EXCLUDED.status,
                            winner = EXCLUDED.winner
                        """,
                        (code, room['status'], room.get('winner')),
                    )

                    # Insert any new members (existing rows are left untouched)
                    for m in room['members']:
                        cur.execute(
                            """
                            INSERT INTO members (code, pid, name, is_ai)
                            VALUES (%s, %s, %s, %s)
                            ON CONFLICT (code, pid) DO NOTHING
                            """,
                            (code, m['pid'], m['name'], m['is_ai']),
                        )

                    # Upsert game state
                    game_json = _as_json(game_to_json(room['game'])) if room['game'] else None
                    cur.execute(
                        """
                        INSERT INTO game_state
                            (code, game_json, last_round, last_turn, round_banner_turns_left, options, updated_at)
                        VALUES (%s, %s::jsonb, %s::jsonb, %s::jsonb, %s, %s::jsonb, now())
                        ON CONFLICT (code) DO UPDATE SET
                            game_json               = EXCLUDED.game_json,
                            last_round              = EXCLUDED.last_round,
                            last_turn               = EXCLUDED.last_turn,
                            round_banner_turns_left = EXCLUDED.round_banner_turns_left,
                            options                 = EXCLUDED.options,
                            updated_at              = now()
                        """,
                        (
                            code,
                            game_json,
                            _as_json(room.get('last_round')),
                            _as_json(room.get('last_turn')),
                            room.get('round_banner_turns_left', 0),
                            _as_json(room.get('options', {})),
                        ),
                    )
        except Exception as exc:
            print(f'[DB] save_room error for {code}: {exc}')


def _load_rooms():
    """Rebuild the in-memory rooms dict from the database on startup (only playing or waiting)."""
    with _get_db() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT code, status, winner FROM rooms WHERE status IN ('playing', 'waiting')"
            )
            for code, status, winner in cur.fetchall():
                # Members
                cur.execute(
                    'SELECT pid, name, is_ai FROM members WHERE code = %s', (code,)
                )
                members = [
                    {'pid': r[0], 'name': r[1], 'is_ai': r[2]}
                    for r in cur.fetchall()
                ]

                # Game state
                cur.execute(
                    """
                    SELECT game_json, last_round, last_turn, round_banner_turns_left, options
                    FROM game_state WHERE code = %s
                    """,
                    (code,),
                )
                gs = cur.fetchone()

                game = None
                if gs and gs[0] is not None:
                    try:
                        game = game_from_json(_parse_jsonish(gs[0]))
                    except Exception as exc:
                        print(f'[DB] Could not restore game {code}: {exc}')
                room = _new_room(
                    code=code,
                    status=status,
                    members=members,
                    game=game,
                    winner=winner,
                    options=_parse_jsonish(gs[4]) if gs and gs[4] else {'slamdowns_allowed': False},
                )
                room['last_round'] = _parse_jsonish(gs[1]) if gs else None
                room['last_turn'] = _parse_jsonish(gs[2]) if gs else None
                room['round_banner_turns_left'] = gs[3] if gs else 0
                rooms[code] = room


# ── Misc helpers ───────────────────────────────────────────────────────────────

def gen_code():
    return ''.join(random.choices(string.ascii_lowercase, k=5))


def card_to_dict(c):
    return {
        'id':    c._card,
        'rank':  c.rank,
        'suit':  c.suit if c.rank != 'Joker' else None,
        'value': c.value,
    }


def room_state(room, pid=None):
    players_out = [{'pid': m['pid'], 'name': m['name'], 'is_ai': m['is_ai']}
                   for m in room['members']]

    game_out = None
    if room['game']:
        g = room['game']

        if room['status'] == 'finished':
            # Game over — only expose scores; calling start_turn() is unsafe
            # (player list may have shrunk after elimination).
            gplayers = [
                {
                    'name':       gp.name,
                    'score':      gp.score,
                    'hand_count': len(gp.hand),
                    'is_ai':      isinstance(gp, AIPlayer),
                    'is_current': False,
                    'pid':        next(
                        (m['pid'] for m in room['members']
                         if m['name'] == gp.name and not m['is_ai']),
                        None,
                    ),
                }
                for gp in g.players
            ]
            game_out = {
                'players':             gplayers,
                'discard_top':         [],
                'draw_options':        [],
                'current_player_name': '',
                'is_my_turn':          False,
                'deck_size':           0,
                'can_slamdown':        False,
                'slamdown_card':       None,
                'slamdowns_allowed':   room.get('options', {}).get('slamdowns_allowed', False),
            }
        else:
            current_player, draw_options = g.start_turn()
            gplayers = []
            for gp in g.players:
                gpd = {
                    'name':       gp.name,
                    'score':      gp.score,
                    'hand_count': len(gp.hand),
                    'is_ai':      isinstance(gp, AIPlayer),
                    'is_current': gp is current_player,
                }
                mem = next((m for m in room['members'] if m['name'] == gp.name and not m['is_ai']), None)
                if mem:
                    gpd['pid'] = mem['pid']
                    if pid and mem['pid'] == pid:
                        gpd['hand']      = [card_to_dict(c) for c in gp.hand]
                        gpd['is_self']   = True
                        gpd['can_yaniv'] = g.can_declare_yaniv(gp)
                else:
                    gpd['pid'] = None
                gplayers.append(gpd)

            is_my_turn      = False
            my_draw_options = []
            my_slamdown_card = None
            if pid:
                cur_mem = next((m for m in room['members'] if m['pid'] == pid), None)
                if cur_mem and current_player.name == cur_mem['name']:
                    is_my_turn      = True
                    my_draw_options = [card_to_dict(c) for c in draw_options]
                if cur_mem and g.slamdown_player == cur_mem['name'] and g.slamdown_card:
                    my_slamdown_card = card_to_dict(g.slamdown_card)

            game_out = {
                'players':             gplayers,
                'discard_top':         [card_to_dict(c) for c in g.last_discard],
                'draw_options':        my_draw_options,
                'current_player_name': current_player.name,
                'is_my_turn':          is_my_turn,
                'deck_size':           len(g.deck),
                'can_slamdown':        my_slamdown_card is not None,
                'slamdown_card':       my_slamdown_card,
                'slamdowns_allowed':   room.get('options', {}).get('slamdowns_allowed', False),
            }

    return {
        'code':       room['code'],
        'status':     room['status'],
        'members':    players_out,
        'game':       game_out,
        'winner':     room.get('winner'),
        'last_round': room.get('last_round'),
        'last_turn':  room.get('last_turn'),
        'next_room':  room.get('next_room'),
        'options':    room.get('options', {'slamdowns_allowed': False}),
    }


def push_state(code):
    """Broadcast current room state to all SSE clients and persist to DB."""
    with _with_room_lock(code):
        room = rooms.get(code)
        if not room:
            return
        with sse_lock:
            clients = sse_clients.get(code, {})
            for pid, q in list(clients.items()):
                try:
                    q.put_nowait(room_state(room, pid))
                except queue.Full:
                    pass
    save_room(code)


def format_round_result(update_info, eliminated, declarer_name,
                        all_players_before, scores_before, declarer_hand_value=0):
    reset_names = set(p.name for p in update_info.get('reset_players', []))
    elim_names  = set(p.name for p in eliminated)

    result = {
        'declarer':             declarer_name,
        'declarer_hand_value':  declarer_hand_value,
        'assaf':                None,
        'resets':               list(reset_names),
        'eliminated':           list(elim_names),
        'score_changes':        [],
    }

    if 'assaf' in update_info:
        result['assaf'] = {
            'assafed': update_info['assaf']['assafed'].name,
            'by':      update_info['assaf']['assafed_by'].name,
        }

    for p in all_players_before:
        old   = scores_before[p.name]
        net   = p.score - old
        added = net + 50 if p.name in reset_names else net
        result['score_changes'].append({
            'name':       p.name,
            'added':      added,
            'new_score':  p.score,
            'reset':      p.name in reset_names,
            'eliminated': p.name in elim_names,
        })

    return result


def make_last_turn(player_name, discard_cards, draw_action, draw_opts_before):
    drawn_card = None
    drawn_from = 'deck'
    if draw_action != 'deck':
        drawn_from = 'pile'
        if draw_action < len(draw_opts_before):
            drawn_card = card_to_dict(draw_opts_before[draw_action])
    return {
        'player':      player_name,
        'discarded':   [card_to_dict(c) for c in discard_cards],
        'drawn_from':  drawn_from,
        'drawn_card':  drawn_card,
        'is_slamdown': False,
    }


def make_last_turn_slamdown(player_name, slammed_card):
    return {
        'player':      player_name,
        'discarded':   [card_to_dict(slammed_card)],
        'drawn_from':  'slamdown',
        'drawn_card':  None,
        'is_slamdown': True,
    }


def _advance_round_banner(room):
    left = room.get('round_banner_turns_left', 0)
    if left > 0:
        room['round_banner_turns_left'] = left - 1
        if left - 1 == 0:
            room['last_round'] = None
    else:
        room['last_round'] = None


def _apply_turn_outcome(room, player_name, discard_cards, draw_action, draw_opts_before):
    _advance_round_banner(room)
    room['last_turn'] = make_last_turn(player_name, discard_cards, draw_action, draw_opts_before)


def _apply_yaniv_outcome(room, game, declarer):
    hand_val = sum(c.value for c in declarer.hand)
    all_before = list(game.players)
    scores_before = {p.name: p.score for p in game.players}
    update_info, eliminated, winner = game.declare_yaniv(declarer)
    room['last_round'] = format_round_result(
        update_info, eliminated, declarer.name, all_before, scores_before, hand_val
    )
    room['round_banner_turns_left'] = len(game.players)
    room['last_turn'] = None
    if winner:
        room['status'] = 'finished'
        room['winner'] = winner.name
    return winner


def _ai_worker_loop(code):
    try:
        process_ai_turns(code)
    finally:
        with _with_room_lock(code):
            room = rooms.get(code)
            if room is not None:
                room['ai_worker_active'] = False


def start_ai_worker(code):
    with _with_room_lock(code):
        room = rooms.get(code)
        if not room or room.get('ai_worker_active'):
            return
        room['ai_worker_active'] = True
    threading.Thread(target=_ai_worker_loop, args=(code,), daemon=True).start()


def process_ai_turns(code):
    while True:
        with _with_room_lock(code):
            room = rooms.get(code)
            if not room or room['status'] != 'playing' or not room.get('game'):
                return
            game = room['game']
            current_player, draw_opts_before = game.start_turn()
            if not isinstance(current_player, AIPlayer):
                return

            if game.can_declare_yaniv(current_player) and current_player.should_declare_yaniv():
                winner = _apply_yaniv_outcome(room, game, current_player)
                push_state(code)
                if winner:
                    return
                continue

            action = game.play_turn(current_player)
            _apply_turn_outcome(
                room,
                current_player.name,
                action['discard'],
                action['draw'],
                draw_opts_before,
            )
            push_state(code)


# ── Static pages ───────────────────────────────────────────────────────────────

@app.route('/')
def index():
    return send_from_directory(app.static_folder, 'index.html')


@app.route('/game/<code>')
def game_page(code):
    return send_from_directory(app.static_folder, 'game.html')


# ── SSE stream ─────────────────────────────────────────────────────────────────

@app.route('/api/events/<code_>/<pid>')
def sse_stream(code_, pid):
    q = queue.Queue(maxsize=50)
    with sse_lock:
        sse_clients.setdefault(code_, {})[pid] = q

    def generate():
        try:
            with _with_room_lock(code_):
                room = rooms.get(code_)
                if not room:
                    yield f"data: {json.dumps({'error': 'Room not found'})}\n\n"
                    return
                snapshot = room_state(room, pid)
            yield f"data: {json.dumps(snapshot)}\n\n"
            while True:
                try:
                    state = q.get(timeout=25)
                    yield f"data: {json.dumps(state)}\n\n"
                except queue.Empty:
                    yield ': heartbeat\n\n'
        finally:
            with sse_lock:
                if code_ in sse_clients:
                    sse_clients[code_].pop(pid, None)

    return Response(
        stream_with_context(generate()),
        content_type='text/event-stream',
        headers={'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no'},
    )


# ── REST API ───────────────────────────────────────────────────────────────────

@app.route('/api/create', methods=['POST'])
def create_game():
    data     = request.json or {}
    pid      = data.get('pid') or str(uuid.uuid4())
    name     = (data.get('name') or 'Player').strip()[:20] or 'Player'
    try:
        ai_count = max(0, min(3, int(data.get('ai_count', 0))))
    except (TypeError, ValueError):
        return error_response('Invalid AI player count')

    members = [{'pid': pid, 'name': name, 'is_ai': False}]
    for i in range(ai_count):
        members.append({'pid': f'ai-{i}', 'name': f'AI {i+1}', 'is_ai': True})

    with rooms_guard:
        code = gen_code()
        while code in rooms:
            code = gen_code()
        rooms[code] = _new_room(code=code, status='waiting', members=members)

    save_room(code)   # persist immediately (no SSE clients yet)
    return jsonify({'code': code, 'pid': pid})


@app.route('/api/join', methods=['POST'])
def join_game():
    data = request.json or {}
    pid  = data.get('pid') or str(uuid.uuid4())
    code = (data.get('code') or '').strip().lower()
    name = (data.get('name') or 'Player').strip()[:20] or 'Player'

    with _with_room_lock(code):
        room = rooms.get(code)
        if not room:
            return error_response('Room not found', 404)
        if room['status'] != 'waiting':
            return error_response('Game already started')
        if sum(1 for m in room['members'] if not m['is_ai']) >= 4:
            return error_response('Room is full')

        if not any(m['pid'] == pid for m in room['members']):
            room['members'].append({'pid': pid, 'name': name, 'is_ai': False})

    push_state(code)   # broadcasts and saves
    return jsonify({'code': code, 'pid': pid})


@app.route('/api/leave', methods=['POST'])
def leave_game():
    data = request.json or {}
    pid  = data.get('pid', '')
    code = (data.get('code') or '').strip().lower()

    with _with_room_lock(code):
        room = rooms.get(code)
        if not room:
            return error_response('Room not found', 404)
        if room['status'] != 'waiting':
            return error_response('Cannot leave after game has started')

        room['members'] = [m for m in room['members'] if m['pid'] != pid]

    push_state(code)
    return jsonify({'ok': True})


@app.route('/api/room/<code>')
def get_room(code):
    pid  = request.args.get('pid', '')
    with _with_room_lock(code):
        room = rooms.get(code)
        if not room:
            return error_response('Not found', 404)
        state = room_state(room, pid)
    return jsonify(state)


@app.route('/api/start', methods=['POST'])
def start_game():
    data = request.json or {}
    code = (data.get('code') or '').lower()
    with _with_room_lock(code):
        room = rooms.get(code)
        if not room or room['status'] != 'waiting':
            return error_response('Cannot start')
        if len(room['members']) < 2:
            return error_response('Need at least 2 players')

        has_ai = any(m['is_ai'] for m in room['members'])
        room['options'] = {
            # Slamdowns are only allowed in human-only games
            'slamdowns_allowed': bool(data.get('slamdowns_allowed', False)) and not has_ai,
        }

        players = [AIPlayer(m['name']) if m['is_ai'] else Player(m['name'])
                   for m in room['members']]
        game = YanivGame(players)
        game.start_game()
        room['game'] = game
        room['status'] = 'playing'
        room['last_round'] = None
        room['last_turn'] = None

    push_state(code)
    start_ai_worker(code)
    return jsonify({'ok': True})


@app.route('/api/action', methods=['POST'])
def do_action():
    data = request.json or {}
    code = (data.get('code') or '').lower()
    pid  = data.get('pid', '')
    kick_ai = False

    with _with_room_lock(code):
        room = rooms.get(code)
        if not room or room['status'] != 'playing':
            return error_response('Game not active')

        game = room['game']
        current_player, draw_options = game.start_turn()

        mem = next((m for m in room['members'] if m['pid'] == pid), None)
        if not mem:
            return error_response('Not a member of this game')

        # Slamdown — handled before the "not your turn" check since the slammer
        # is not the current player (turn has already advanced to the next player).
        if data.get('declare_slamdown'):
            if not room.get('options', {}).get('slamdowns_allowed'):
                return error_response('Slamdowns not enabled in this game')
            if game.slamdown_player != mem['name']:
                return error_response('Slamdown no longer available')

            slammer = next((p for p in game.players if p.name == mem['name']), None)
            if not slammer:
                return error_response('Player not found')
            try:
                slammed_card = game.perform_slamdown(slammer)
            except ValueError as e:
                return error_response(str(e))
            room['last_turn'] = make_last_turn_slamdown(mem['name'], slammed_card)
            push_state(code)
            return jsonify({'ok': True})

        if current_player.name != mem['name']:
            return error_response('Not your turn')

        if data.get('declare_yaniv'):
            if not game.can_declare_yaniv(current_player):
                return error_response('Cannot declare Yaniv')
            winner = _apply_yaniv_outcome(room, game, current_player)
            push_state(code)
            if not winner:
                kick_ai = True
        else:
            card_ids = data.get('discard', [])
            if not isinstance(card_ids, list):
                return error_response('Discard must be a list of card IDs')

            discard_cards = []
            hand_copy = list(current_player.hand)
            for cid in card_ids:
                match = next((c for c in hand_copy if c._card == cid), None)
                if not match:
                    return error_response('Card not in hand')
                discard_cards.append(match)
                hand_copy.remove(match)

            if not discard_cards:
                return error_response('Must discard at least one card')

            draw = data.get('draw')
            if draw == 'deck':
                draw_action = 'deck'
            else:
                try:
                    draw_action = int(draw)
                except (TypeError, ValueError):
                    return error_response("Invalid 'draw' action. Must be 'deck' or a valid index of a card in discard pile.")

            draw_opts_before = list(draw_options)
            try:
                game.play_turn(current_player, {'discard': discard_cards, 'draw': draw_action})
            except ValueError as e:
                return error_response(str(e))

            _apply_turn_outcome(
                room,
                current_player.name,
                discard_cards,
                draw_action,
                draw_opts_before,
            )
            push_state(code)
            kick_ai = True

    if kick_ai:
        start_ai_worker(code)
    return jsonify({'ok': True})


@app.route('/api/play_again', methods=['POST'])
def play_again():
    data = request.json or {}
    code = (data.get('code') or '').lower()
    with _with_room_lock(code):
        room = rooms.get(code)
        if not room or room['status'] != 'finished':
            return error_response('Game not finished')

        # Idempotent: if a rematch room already exists, return it
        if room.get('next_room'):
            return jsonify({'next_room': room['next_room']})

        members = [dict(m) for m in room['members']]
        options = dict(room.get('options', {'slamdowns_allowed': False}))

        players = [AIPlayer(m['name']) if m['is_ai'] else Player(m['name']) for m in members]
        game = YanivGame(players)
        game.start_game()

        with rooms_guard:
            new_code = gen_code()
            while new_code in rooms:
                new_code = gen_code()
            rooms[new_code] = _new_room(
                code=new_code,
                status='playing',
                members=members,
                game=game,
                options=options,
            )

        # Mark old room so all polling/SSE clients redirect automatically
        room['next_room'] = new_code

    save_room(new_code)
    push_state(code)
    start_ai_worker(new_code)
    return jsonify({'next_room': new_code})


# ── Boot ───────────────────────────────────────────────────────────────────────

_init_db()

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=5174, debug=True, threaded=True)
