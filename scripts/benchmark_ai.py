#!/usr/bin/env python3
import argparse
import json
import math
import random
import statistics
import sys
import time
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from aiplayer import AIPlayer
from player import Player
from yaniv import YanivGame


class RandomPolicyPlayer(Player):
    pass


class TimedAIPlayer(AIPlayer):
    def __init__(self, name, policy='v1', rollout_samples=24):
        super().__init__(name=name, policy=policy, rollout_samples=rollout_samples)
        self.decision_times_ms = []

    def decide_action(self):
        start = time.perf_counter()
        action = super().decide_action()
        self.decision_times_ms.append((time.perf_counter() - start) * 1000)
        return action


_HELPER_AI = AIPlayer('helper')


def _percentile(values, p):
    if not values:
        return 0.0
    if len(values) == 1:
        return float(values[0])
    idx = max(0, min(len(values) - 1, int(math.ceil(p * len(values))) - 1))
    return float(sorted(values)[idx])


def _random_discard_options(hand):
    return _HELPER_AI._get_discard_options(hand)


def _random_action(player, draw_options, rng):
    discard_options = _random_discard_options(player.hand)
    discard = rng.choice(discard_options)

    draw = 'deck'
    if draw_options and rng.random() < 0.45:
        draw = rng.randrange(len(draw_options))

    return {'discard': discard, 'draw': draw}


def _random_should_declare(player, rng):
    hand_value = sum(card.value for card in player.hand)
    if hand_value <= 2:
        return True
    if hand_value >= 5:
        return False
    return rng.random() < 0.25


def _build_players(scenario, total_players, rollout_samples):
    players = []
    label_by_name = {}

    if scenario == 'v2_vs_v1':
        ai_v2 = TimedAIPlayer('AI-v2', policy='v2', rollout_samples=rollout_samples)
        ai_v1 = TimedAIPlayer('AI-v1', policy='v1', rollout_samples=rollout_samples)
        players.extend([ai_v2, ai_v1])
        label_by_name[ai_v2.name] = 'v2'
        label_by_name[ai_v1.name] = 'v1'
    else:
        raise ValueError(f'Unsupported scenario: {scenario}')

    while len(players) < total_players:
        idx = len(players)
        rp = RandomPolicyPlayer(f'R{idx}')
        players.append(rp)
        label_by_name[rp.name] = 'random'

    return players, label_by_name


def _run_single_game(scenario, total_players, max_turns, seed, rollout_samples):
    rng = random.Random(seed)
    players, label_by_name = _build_players(scenario, total_players, rollout_samples)
    game = YanivGame(players)

    try:
        game.start_game()
    except Exception as exc:
        return {
            'winner': None,
            'winner_label': None,
            'turns': 0,
            'error': f'{type(exc).__name__}: {exc}',
            'ai_decision_ms': {
                p.name: list(p.decision_times_ms)
                for p in players
                if isinstance(p, TimedAIPlayer)
            },
        }

    turns = 0
    winner = None
    error = None

    while turns < max_turns:
        if len(game.players) <= 1:
            winner = game.players[0] if game.players else None
            break

        turns += 1

        try:
            current_player, draw_options = game.start_turn()

            if game.can_declare_yaniv(current_player):
                if isinstance(current_player, AIPlayer):
                    should_declare = current_player.should_declare_yaniv()
                else:
                    should_declare = _random_should_declare(current_player, rng)

                if should_declare:
                    _update_info, _eliminated, winner = game.declare_yaniv(current_player)
                    if winner is not None:
                        break
                    continue

            if isinstance(current_player, AIPlayer):
                game.play_turn(current_player)
            else:
                action = _random_action(current_player, draw_options, rng)
                game.play_turn(current_player, action)

        except Exception as exc:
            error = f'{type(exc).__name__}: {exc}'
            break

    if winner is None and error is None and len(game.players) == 1:
        winner = game.players[0]

    ai_decision_ms = {
        p.name: list(p.decision_times_ms)
        for p in players
        if isinstance(p, TimedAIPlayer)
    }

    return {
        'winner': winner.name if winner else None,
        'winner_label': label_by_name.get(winner.name) if winner else None,
        'turns': turns,
        'error': error,
        'ai_decision_ms': ai_decision_ms,
    }


def _summarize_results(raw_games):
    wins = Counter()
    errors = Counter()
    turns = []
    ai_latency = {}

    for result in raw_games:
        turns.append(result['turns'])
        if result['winner_label'] is not None:
            wins[result['winner_label']] += 1
        if result['error']:
            errors[result['error']] += 1

        for player_name, values in result['ai_decision_ms'].items():
            key = 'v2' if 'v2' in player_name.lower() else 'v1'
            ai_latency.setdefault(key, []).extend(values)

    latency_summary = {}
    for key, values in ai_latency.items():
        latency_summary[key] = {
            'count': len(values),
            'avg_ms': round(statistics.mean(values), 4) if values else 0.0,
            'p95_ms': round(_percentile(values, 0.95), 4),
            'max_ms': round(max(values), 4) if values else 0.0,
        }

    game_count = len(raw_games)
    win_rates = {
        label: round(count / game_count, 4)
        for label, count in sorted(wins.items())
    }

    return {
        'games': game_count,
        'wins': dict(sorted(wins.items())),
        'win_rates': win_rates,
        'turns': {
            'avg': round(statistics.mean(turns), 3) if turns else 0.0,
            'p95': round(_percentile(turns, 0.95), 3),
            'max': max(turns) if turns else 0,
        },
        'errors': dict(errors),
        'ai_decision_latency_ms': latency_summary,
    }


def run_benchmarks(games, players, max_turns, seed, rollout_samples):
    scenarios = ['v2_vs_v1']
    out = {}

    for scenario in scenarios:
        raw = []
        for i in range(games):
            game_seed = seed + (100_000 * scenarios.index(scenario)) + i
            raw.append(
                _run_single_game(
                    scenario=scenario,
                    total_players=players,
                    max_turns=max_turns,
                    seed=game_seed,
                    rollout_samples=rollout_samples,
                )
            )
        out[scenario] = _summarize_results(raw)

    return out


def parse_args():
    parser = argparse.ArgumentParser(description='Benchmark Yaniv AI policies.')
    parser.add_argument('--games', type=int, default=250, help='Games per scenario')
    parser.add_argument('--players', type=int, default=3, help='Total players per game (2-4)')
    parser.add_argument('--max-turns', type=int, default=2000, help='Turn cap per game')
    parser.add_argument('--seed', type=int, default=7, help='Base RNG seed')
    parser.add_argument('--rollout-samples', type=int, default=24, help='Deck rollout samples for v2')
    parser.add_argument(
        '--output',
        type=str,
        default='',
        help='Output metrics JSON path (default: metrics/ai_benchmark_<timestamp>.json)',
    )
    return parser.parse_args()


def main():
    args = parse_args()
    players = max(2, min(4, args.players))

    started = time.perf_counter()
    results = run_benchmarks(
        games=max(1, args.games),
        players=players,
        max_turns=max(100, args.max_turns),
        seed=args.seed,
        rollout_samples=max(4, args.rollout_samples),
    )

    payload = {
        'created_at': datetime.now(timezone.utc).isoformat(),
        'config': {
            'games_per_scenario': max(1, args.games),
            'players': players,
            'max_turns': max(100, args.max_turns),
            'seed': args.seed,
            'rollout_samples': max(4, args.rollout_samples),
        },
        'runtime_seconds': round(time.perf_counter() - started, 3),
        'results': results,
    }

    if args.output:
        out_path = Path(args.output)
    else:
        ts = datetime.now().strftime('%Y%m%d_%H%M%S')
        out_path = Path('metrics') / f'ai_benchmark_{ts}.json'

    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(payload, indent=2), encoding='utf-8')

    print(json.dumps({'written': str(out_path), 'runtime_seconds': payload['runtime_seconds']}, indent=2))


if __name__ == '__main__':
    main()
