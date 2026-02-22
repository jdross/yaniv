import sys, os, uuid, random, string, queue, threading, json
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from flask import Flask, request, jsonify, send_from_directory, Response, stream_with_context

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


def gen_code():
    return ''.join(random.choices(string.ascii_lowercase, k=5))


def card_to_dict(c):
    return {
        'id': c._card,
        'rank': c.rank,
        'suit': c.suit if c.rank != 'Joker' else None,
        'value': c.value,
    }


def room_state(room, pid=None):
    players_out = [{'pid': m['pid'], 'name': m['name'], 'is_ai': m['is_ai']}
                   for m in room['members']]

    game_out = None
    if room['game']:
        g = room['game']
        current_player, draw_options = g.start_turn()
        gplayers = []
        for gp in g.players:
            gpd = {
                'name': gp.name,
                'score': gp.score,
                'hand_count': len(gp.hand),
                'is_ai': isinstance(gp, AIPlayer),
                'is_current': gp is current_player,
            }
            mem = next((m for m in room['members'] if m['name'] == gp.name and not m['is_ai']), None)
            if mem:
                gpd['pid'] = mem['pid']
                if pid and mem['pid'] == pid:
                    gpd['hand'] = [card_to_dict(c) for c in gp.hand]
                    gpd['is_self'] = True
                    gpd['can_yaniv'] = g.can_declare_yaniv(gp)
            else:
                gpd['pid'] = None
            gplayers.append(gpd)

        is_my_turn = False
        my_draw_options = []
        if pid:
            cur_mem = next((m for m in room['members'] if m['pid'] == pid), None)
            if cur_mem and current_player.name == cur_mem['name']:
                is_my_turn = True
                my_draw_options = [card_to_dict(c) for c in draw_options]

        game_out = {
            'players': gplayers,
            'discard_top': [card_to_dict(c) for c in g.last_discard],
            'draw_options': my_draw_options,
            'current_player_name': current_player.name,
            'is_my_turn': is_my_turn,
            'deck_size': len(g.deck),
        }

    return {
        'code': room['code'],
        'status': room['status'],
        'members': players_out,
        'game': game_out,
        'winner': room.get('winner'),
        'last_round': room.get('last_round'),
        'last_turn': room.get('last_turn'),
    }


def push_state(code):
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


def format_round_result(update_info, eliminated, declarer_name,
                        all_players_before, scores_before, declarer_hand_value=0):
    reset_names = set(p.name for p in update_info.get('reset_players', []))
    elim_names  = set(p.name for p in eliminated)

    result = {
        'declarer': declarer_name,
        'declarer_hand_value': declarer_hand_value,
        'assaf': None,
        'resets': list(reset_names),
        'eliminated': list(elim_names),
        'score_changes': [],
    }

    if 'assaf' in update_info:
        result['assaf'] = {
            'assafed': update_info['assaf']['assafed'].name,
            'by':      update_info['assaf']['assafed_by'].name,
        }

    # Per-player score details (all players, including eliminated)
    for p in all_players_before:
        old  = scores_before[p.name]
        net  = p.score - old
        # Gross points added before any reset (reset subtracts 50 at exactly 50/100)
        added = net + 50 if p.name in reset_names else net
        result['score_changes'].append({
            'name':      p.name,
            'added':     added,
            'new_score': p.score,
            'reset':     p.name in reset_names,
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
        'player': player_name,
        'discarded': [card_to_dict(c) for c in discard_cards],
        'drawn_from': drawn_from,
        'drawn_card': drawn_card,
    }


def process_ai_turns(code):
    room = rooms.get(code)
    if not room or room['status'] != 'playing':
        return
    g = room['game']
    while True:
        current_player, draw_opts_before = g.start_turn()
        if not isinstance(current_player, AIPlayer):
            break
        if g.can_declare_yaniv(current_player) and current_player.should_declare_yaniv():
            hand_val = sum(c.value for c in current_player.hand)
            all_before = list(g.players)
            scores_before = {p.name: p.score for p in g.players}
            update_info, eliminated, winner = g.declare_yaniv(current_player)
            room['last_round'] = format_round_result(
                update_info, eliminated, current_player.name,
                all_before, scores_before, hand_val,
            )
            room['round_banner_turns_left'] = len(g.players)
            room['last_turn'] = None
            if winner:
                room['status'] = 'finished'
                room['winner'] = winner.name
                push_state(code)
                return
            push_state(code)
            continue
        action = g.play_turn(current_player)
        # Persist the round banner for one full lap after a Yaniv
        left = room.get('round_banner_turns_left', 0)
        if left > 0:
            room['round_banner_turns_left'] = left - 1
            if left - 1 == 0:
                room['last_round'] = None
        else:
            room['last_round'] = None
        room['last_turn'] = make_last_turn(
            current_player.name, action['discard'], action['draw'], draw_opts_before
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
            room = rooms.get(code_)
            if not room:
                yield f"data: {json.dumps({'error': 'Room not found'})}\n\n"
                return
            yield f"data: {json.dumps(room_state(room, pid))}\n\n"
            while True:
                try:
                    state = q.get(timeout=25)
                    yield f"data: {json.dumps(state)}\n\n"
                except queue.Empty:
                    yield ": heartbeat\n\n"
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
    data = request.json or {}
    pid = data.get('pid') or str(uuid.uuid4())
    name = (data.get('name') or 'Player').strip()[:20] or 'Player'
    ai_count = max(0, min(3, int(data.get('ai_count', 0))))

    code = gen_code()
    while code in rooms:
        code = gen_code()

    members = [{'pid': pid, 'name': name, 'is_ai': False}]
    for i in range(ai_count):
        members.append({'pid': f'ai-{i}', 'name': f'AI {i+1}', 'is_ai': True})

    rooms[code] = {
        'code': code,
        'status': 'waiting',
        'members': members,
        'game': None,
        'winner': None,
        'last_round': None,
        'last_turn': None,
    }
    return jsonify({'code': code, 'pid': pid})


@app.route('/api/join', methods=['POST'])
def join_game():
    data = request.json or {}
    pid = data.get('pid') or str(uuid.uuid4())
    code = (data.get('code') or '').strip().lower()
    name = (data.get('name') or 'Player').strip()[:20] or 'Player'

    room = rooms.get(code)
    if not room:
        return jsonify({'error': 'Room not found'}), 404
    if room['status'] != 'waiting':
        return jsonify({'error': 'Game already started'}), 400
    if sum(1 for m in room['members'] if not m['is_ai']) >= 4:
        return jsonify({'error': 'Room is full'}), 400

    if not any(m['pid'] == pid for m in room['members']):
        room['members'].append({'pid': pid, 'name': name, 'is_ai': False})

    push_state(code)
    return jsonify({'code': code, 'pid': pid})


@app.route('/api/room/<code>')
def get_room(code):
    pid = request.args.get('pid', '')
    room = rooms.get(code)
    if not room:
        return jsonify({'error': 'Not found'}), 404
    return jsonify(room_state(room, pid))


@app.route('/api/start', methods=['POST'])
def start_game():
    data = request.json or {}
    code = (data.get('code') or '').lower()
    room = rooms.get(code)
    if not room or room['status'] != 'waiting':
        return jsonify({'error': 'Cannot start'}), 400
    if len(room['members']) < 2:
        return jsonify({'error': 'Need at least 2 players'}), 400

    players = [AIPlayer(m['name']) if m['is_ai'] else Player(m['name'])
               for m in room['members']]
    g = YanivGame(players)
    g.start_game()
    room['game'] = g
    room['status'] = 'playing'
    room['last_round'] = None
    room['last_turn'] = None

    push_state(code)
    # Run AI turns in a background thread so the HTTP response returns immediately
    threading.Thread(target=process_ai_turns, args=(code,), daemon=True).start()
    return jsonify({'ok': True})


@app.route('/api/action', methods=['POST'])
def do_action():
    data = request.json or {}
    code = (data.get('code') or '').lower()
    pid = data.get('pid', '')
    room = rooms.get(code)

    if not room or room['status'] != 'playing':
        return jsonify({'error': 'Game not active'}), 400

    g = room['game']
    current_player, draw_options = g.start_turn()

    mem = next((m for m in room['members'] if m['pid'] == pid), None)
    if not mem or current_player.name != mem['name']:
        return jsonify({'error': 'Not your turn'}), 400

    if data.get('declare_yaniv'):
        if not g.can_declare_yaniv(current_player):
            return jsonify({'error': 'Cannot declare Yaniv'}), 400
        hand_val = sum(c.value for c in current_player.hand)
        all_before = list(g.players)
        scores_before = {p.name: p.score for p in g.players}
        update_info, eliminated, winner = g.declare_yaniv(current_player)
        room['last_round'] = format_round_result(
            update_info, eliminated, current_player.name,
            all_before, scores_before, hand_val,
        )
        room['round_banner_turns_left'] = len(g.players)
        room['last_turn'] = None
        if winner:
            room['status'] = 'finished'
            room['winner'] = winner.name
            push_state(code)
            return jsonify({'ok': True})
        push_state(code)
        threading.Thread(target=process_ai_turns, args=(code,), daemon=True).start()
        return jsonify({'ok': True})

    card_ids = data.get('discard', [])
    draw = data.get('draw')

    discard_cards = []
    hand_copy = list(current_player.hand)
    for cid in card_ids:
        match = next((c for c in hand_copy if c._card == cid), None)
        if not match:
            return jsonify({'error': 'Card not in hand'}), 400
        discard_cards.append(match)
        hand_copy.remove(match)

    if not discard_cards:
        return jsonify({'error': 'Must discard at least one card'}), 400

    draw_action = 'deck' if draw == 'deck' else int(draw)
    draw_opts_before = list(draw_options)

    try:
        g.play_turn(current_player, {'discard': discard_cards, 'draw': draw_action})
    except ValueError as e:
        return jsonify({'error': str(e)}), 400

    # Persist the round banner for one full lap after a Yaniv
    left = room.get('round_banner_turns_left', 0)
    if left > 0:
        room['round_banner_turns_left'] = left - 1
        if left - 1 == 0:
            room['last_round'] = None
    else:
        room['last_round'] = None
    room['last_turn'] = make_last_turn(
        current_player.name, discard_cards, draw_action, draw_opts_before
    )
    push_state(code)
    threading.Thread(target=process_ai_turns, args=(code,), daemon=True).start()
    return jsonify({'ok': True})


if __name__ == '__main__':
    app.run(host='0.0.0.0', port=5174, debug=True, threaded=True)
