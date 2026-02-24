import unittest
import sys
import os
import queue

sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from application import server
from card import Card


class TestServerApi(unittest.TestCase):
    def setUp(self):
        server.rooms.clear()
        server.sse_clients.clear()
        self.client = server.app.test_client()

    def tearDown(self):
        server.rooms.clear()
        server.sse_clients.clear()

    def _create_started_game(self):
        create = self.client.post(
            "/api/create",
            json={"name": "P1", "pid": "pid-1", "ai_count": 0},
        )
        self.assertEqual(create.status_code, 200)
        code = create.get_json()["code"]

        join = self.client.post(
            "/api/join",
            json={"name": "P2", "pid": "pid-2", "code": code},
        )
        self.assertEqual(join.status_code, 200)

        start = self.client.post("/api/start", json={"code": code, "pid": "pid-1"})
        self.assertEqual(start.status_code, 200)
        return code

    def _current_turn_identity(self, code):
        room = server.rooms[code]
        current_name = room["game"]._get_player().name
        current_pid = next(
            m["pid"] for m in room["members"] if not m["is_ai"] and m["name"] == current_name
        )
        return current_name, current_pid

    def test_action_with_non_integer_draw_returns_400(self):
        code = self._create_started_game()
        _, current_pid = self._current_turn_identity(code)

        room_view = self.client.get(f"/api/room/{code}?pid={current_pid}")
        self.assertEqual(room_view.status_code, 200)
        state = room_view.get_json()
        me = next(p for p in state["game"]["players"] if p.get("is_self"))
        first_card = me["hand"][0]["id"]

        action = self.client.post(
            "/api/action",
            json={
                "code": code,
                "pid": current_pid,
                "discard": [first_card],
                "draw": "not-a-number",
            },
        )

        self.assertEqual(action.status_code, 400)
        body = action.get_json()
        self.assertIn("error", body)

    def test_valid_action_sets_last_turn(self):
        code = self._create_started_game()
        _, current_pid = self._current_turn_identity(code)

        room_view = self.client.get(f"/api/room/{code}?pid={current_pid}")
        state = room_view.get_json()
        me = next(p for p in state["game"]["players"] if p.get("is_self"))
        first_card = me["hand"][0]["id"]

        action = self.client.post(
            "/api/action",
            json={
                "code": code,
                "pid": current_pid,
                "discard": [first_card],
                "draw": "deck",
            },
        )

        self.assertEqual(action.status_code, 200)
        self.assertEqual(action.get_json(), {"ok": True})

        room = server.rooms[code]
        self.assertIsNotNone(room["last_turn"])
        self.assertIn(room["last_turn"]["player"], ["P1", "P2"])
        self.assertIn("discarded", room["last_turn"])

    def test_waiting_room_options_persist_across_join_and_start(self):
        create = self.client.post(
            "/api/create",
            json={"name": "P1", "pid": "pid-1", "ai_count": 0},
        )
        code = create.get_json()["code"]

        opt = self.client.post(
            "/api/options",
            json={"code": code, "pid": "pid-1", "slamdowns_allowed": True},
        )
        self.assertEqual(opt.status_code, 200)
        self.assertTrue(opt.get_json()["options"]["slamdowns_allowed"])

        join = self.client.post(
            "/api/join",
            json={"name": "P2", "pid": "pid-2", "code": code},
        )
        self.assertEqual(join.status_code, 200)

        state = self.client.get(f"/api/room/{code}?pid=pid-2").get_json()
        self.assertTrue(state["options"]["slamdowns_allowed"])

        start = self.client.post("/api/start", json={"code": code, "pid": "pid-1"})
        self.assertEqual(start.status_code, 200)
        self.assertTrue(server.rooms[code]["options"]["slamdowns_allowed"])

    def test_only_creator_can_change_waiting_options(self):
        create = self.client.post(
            "/api/create",
            json={"name": "P1", "pid": "pid-1", "ai_count": 0},
        )
        code = create.get_json()["code"]

        join = self.client.post(
            "/api/join",
            json={"name": "P2", "pid": "pid-2", "code": code},
        )
        self.assertEqual(join.status_code, 200)

        opt = self.client.post(
            "/api/options",
            json={"code": code, "pid": "pid-2", "slamdowns_allowed": True},
        )
        self.assertEqual(opt.status_code, 400)
        self.assertIn("error", opt.get_json())

    def test_sse_unregister_old_stream_keeps_new_reconnect(self):
        code = "abcde"
        pid = "pid-1"
        old_q = queue.Queue()
        new_q = queue.Queue()

        server._register_sse_client(code, pid, old_q)
        server._register_sse_client(code, pid, new_q)
        server._unregister_sse_client(code, pid, old_q)

        self.assertIn(code, server.sse_clients)
        self.assertIs(server.sse_clients[code][pid], new_q)

    def test_sse_unregister_current_stream_removes_client(self):
        code = "vwxyz"
        pid = "pid-2"
        q = queue.Queue()

        server._register_sse_client(code, pid, q)
        server._unregister_sse_client(code, pid, q)

        self.assertNotIn(code, server.sse_clients)

    def test_yaniv_round_payload_includes_final_hands_before_redeal(self):
        code = self._create_started_game()
        room = server.rooms[code]
        game = room["game"]
        declarer = game._get_player()
        opponent = next(p for p in game.players if p is not declarer)

        declarer.hand = [Card("A", "Clubs")]
        opponent.hand = [Card("K", "Spades"), Card("Q", "Spades")]

        server._apply_yaniv_outcome(room, game, declarer)
        last_round = room["last_round"]

        changes = {sc["name"]: sc for sc in last_round["score_changes"]}
        declarer_change = changes[declarer.name]
        opponent_change = changes[opponent.name]

        self.assertEqual([c["rank"] for c in declarer_change["final_hand"]], ["A"])
        self.assertEqual([c["rank"] for c in opponent_change["final_hand"]], ["K", "Q"])


if __name__ == "__main__":
    unittest.main()
