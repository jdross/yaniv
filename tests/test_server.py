import unittest
import sys
import os

sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from application import server


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


if __name__ == "__main__":
    unittest.main()
