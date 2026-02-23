import importlib
import os
import sys
import unittest
import uuid

sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from aiplayer import AIPlayer
from player import Player
from yaniv import YanivGame


class TestDatabaseIntegration(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        try:
            import psycopg2  # noqa: F401
        except ImportError as exc:
            raise unittest.SkipTest(f"psycopg2 is not installed: {exc}")

        db_url = os.environ.get("YANIV_DB_TEST_URL") or os.environ.get("DATABASE_URL")
        if not db_url:
            raise unittest.SkipTest("Set YANIV_DB_TEST_URL (or DATABASE_URL) to run DB integration tests")

        cls.db_url = db_url
        os.environ["DATABASE_URL"] = db_url

        try:
            import psycopg2

            conn = psycopg2.connect(db_url)
            conn.close()
        except Exception as exc:
            raise unittest.SkipTest(f"Cannot connect to Postgres at {db_url}: {exc}")

        from application import server as server_module

        cls.server = importlib.reload(server_module)
        if cls.server._pool is None:
            raise unittest.SkipTest("Server DB pool was not initialised")

    def setUp(self):
        self.server.rooms.clear()
        self.server.sse_clients.clear()
        self.created_codes = set()

    def tearDown(self):
        self.server.rooms.clear()
        self.server.sse_clients.clear()
        if self.created_codes:
            with self.server._get_db() as conn:
                with conn.cursor() as cur:
                    cur.execute(
                        "DELETE FROM rooms WHERE code = ANY(%s)",
                        (list(self.created_codes),),
                    )

    def _new_code(self):
        code = f"u{uuid.uuid4().hex[:4]}"
        self.created_codes.add(code)
        return code

    def test_save_and_load_room_roundtrip(self):
        code = self._new_code()

        members = [
            {"pid": "pid-1", "name": "P1", "is_ai": False},
            {"pid": "ai-1", "name": "AI 1", "is_ai": True},
        ]
        players = [Player("P1"), AIPlayer("AI 1")]
        game = YanivGame(players)
        game.start_game()

        room = self.server._new_room(
            code=code,
            status="playing",
            members=members,
            game=game,
            options={"slamdowns_allowed": False},
        )
        room["last_turn"] = {
            "player": "P1",
            "discarded": [],
            "drawn_from": "deck",
            "drawn_card": None,
            "is_slamdown": False,
        }
        room["last_round"] = {"declarer": "P1", "score_changes": []}
        room["round_banner_turns_left"] = 2
        self.server.rooms[code] = room

        self.server.save_room(code)
        self.server.rooms.clear()
        self.server._load_rooms()

        loaded = self.server.rooms.get(code)
        self.assertIsNotNone(loaded)
        self.assertEqual(loaded["status"], "playing")
        self.assertEqual(len(loaded["members"]), 2)
        self.assertIsNotNone(loaded["game"])
        self.assertEqual(loaded["game"].players[0].name, "P1")
        self.assertTrue(isinstance(loaded["game"].players[1], AIPlayer))
        self.assertEqual(loaded["last_turn"]["player"], "P1")
        self.assertEqual(loaded["round_banner_turns_left"], 2)

    def test_push_state_persists_room_updates(self):
        code = self._new_code()
        room = self.server._new_room(
            code=code,
            status="waiting",
            members=[{"pid": "pid-1", "name": "P1", "is_ai": False}],
        )
        self.server.rooms[code] = room

        self.server.push_state(code)

        with self.server._get_db() as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT status, winner FROM rooms WHERE code = %s", (code,))
                row = cur.fetchone()
        self.assertEqual(row, ("waiting", None))

        room["status"] = "finished"
        room["winner"] = "P1"
        self.server.push_state(code)

        with self.server._get_db() as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT status, winner FROM rooms WHERE code = %s", (code,))
                row = cur.fetchone()
        self.assertEqual(row, ("finished", "P1"))


if __name__ == "__main__":
    unittest.main()
