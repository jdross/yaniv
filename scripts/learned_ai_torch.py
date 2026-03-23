#!/usr/bin/env python3

from __future__ import annotations

import argparse
import json
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Sequence

import torch
import torch.nn.functional as F


ACTION_FEATURE_NAMES = [
    'threat',
    'yaniv_next_turn_prob',
    'deck_variance',
    'immediate_points',
    'future_score',
    'discard_value',
    'discard_count',
    'draw_value',
    'drew_from_deck',
    'feed_penalty',
    'belief_danger',
    'joker_discard_penalty',
    'composition_bonus',
    'reset_bonus',
    'post_discard_total',
    'hand_total_before',
    'opponent_count',
]

VALUE_FEATURE_NAMES = [
    'resulting_hand_total',
    'resulting_hand_count',
    'threat',
    'yaniv_next_turn_prob',
    'deck_variance',
    'composition_bonus',
    'reset_bonus',
    'feed_penalty',
    'belief_danger',
    'discard_value',
    'drew_from_deck',
    'opponent_count',
]

YANIV_FEATURE_NAMES = [
    'own_hand_value',
    'assaf_risk',
    'reset_penalty',
    'threat',
    'yaniv_next_turn_prob',
    'score_pressure',
    'max_low_card_bias',
    'min_opponent_hand_count',
    'known_low_cards',
    'opponent_count',
]


def now_tag() -> str:
    return datetime.now(timezone.utc).strftime('%Y%m%d_%H%M%S')


def json_load(path: Path):
    return json.loads(path.read_text())


def json_dump(path: Path, payload):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2) + '\n')


def device_for_training() -> torch.device:
    if torch.backends.mps.is_available():
        return torch.device('mps')
    return torch.device('cpu')


def feature_tensor(feature_names: Sequence[str], feature_map: dict) -> torch.Tensor:
    return torch.tensor([float(feature_map.get(name, 0.0)) for name in feature_names], dtype=torch.float32)


def compute_moments(rows: list[torch.Tensor], feature_count: int) -> tuple[torch.Tensor, torch.Tensor]:
    if not rows:
        return torch.zeros(feature_count, dtype=torch.float32), torch.ones(feature_count, dtype=torch.float32)
    matrix = torch.stack(rows, dim=0)
    mean = matrix.mean(dim=0)
    std = torch.sqrt(matrix.var(dim=0, correction=0) + 1e-6)
    std = torch.clamp(std, min=1e-3)
    return mean, std


class SmallMlp(torch.nn.Module):
    def __init__(self, input_size: int, hidden_size: int):
        super().__init__()
        self.fc1 = torch.nn.Linear(input_size, hidden_size)
        self.fc2 = torch.nn.Linear(hidden_size, 1)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        hidden = torch.tanh(self.fc1(x))
        return self.fc2(hidden).squeeze(-1)


@dataclass
class ExportedModel:
    model: SmallMlp
    mean: torch.Tensor
    std: torch.Tensor
    feature_names: Sequence[str]

    def export(self) -> dict:
        fc1 = self.model.fc1
        fc2 = self.model.fc2
        return {
            'model_type': 'mlp',
            'feature_names': list(self.feature_names),
            'hidden_size': int(fc1.out_features),
            'input_mean': [float(v) for v in self.mean.tolist()],
            'input_std': [float(v) for v in self.std.tolist()],
            'w1': [[float(v) for v in row] for row in fc1.weight.detach().cpu().tolist()],
            'b1': [float(v) for v in fc1.bias.detach().cpu().tolist()],
            'w2': [float(v) for v in fc2.weight.detach().cpu().view(-1).tolist()],
            'b2': float(fc2.bias.detach().cpu().item()),
        }


def init_from_existing(existing: dict | None, feature_names: Sequence[str], hidden_size: int) -> SmallMlp:
    model = SmallMlp(len(feature_names), hidden_size)
    if not existing or existing.get('model_type') != 'mlp':
        return model
    if list(existing.get('feature_names', [])) != list(feature_names):
        return model
    if int(existing.get('hidden_size', hidden_size)) != hidden_size:
        return model
    with torch.no_grad():
        model.fc1.weight.copy_(torch.tensor(existing['w1'], dtype=torch.float32))
        model.fc1.bias.copy_(torch.tensor(existing['b1'], dtype=torch.float32))
        model.fc2.weight.copy_(torch.tensor([existing['w2']], dtype=torch.float32))
        model.fc2.bias.copy_(torch.tensor([existing['b2']], dtype=torch.float32))
    return model


def normalize_rows(rows: list[torch.Tensor], mean: torch.Tensor, std: torch.Tensor) -> list[torch.Tensor]:
    return [((row - mean) / std) for row in rows]


def train_policy(samples: list[dict], existing_model: dict | None, lr: float, epochs: int, hidden_size: int, device: torch.device) -> ExportedModel:
    feature_rows = [
        feature_tensor(ACTION_FEATURE_NAMES, candidate)
        for sample in samples
        for candidate in sample.get('candidates', [])
    ]
    mean, std = compute_moments(feature_rows, len(ACTION_FEATURE_NAMES))
    model = init_from_existing(existing_model, ACTION_FEATURE_NAMES, hidden_size).to(device)
    optimizer = torch.optim.AdamW(model.parameters(), lr=lr, weight_decay=1e-4)

    normalized_samples = []
    for sample in samples:
        candidates = sample.get('candidates') or []
        if not candidates:
            continue
        rows = normalize_rows([feature_tensor(ACTION_FEATURE_NAMES, candidate) for candidate in candidates], mean, std)
        target_probs = sample.get('target_probs')
        if not isinstance(target_probs, list) or len(target_probs) != len(rows):
            chosen_index = int(sample.get('chosen_index', 0))
            target_probs = [1.0 if i == chosen_index else 0.0 for i in range(len(rows))]
        total = sum(max(0.0, float(value)) for value in target_probs)
        if total <= 0:
            continue
        target_probs = [float(value) / total for value in target_probs]
        normalized_samples.append({
            'rows': torch.stack(rows).to(device),
            'target': torch.tensor(target_probs, dtype=torch.float32, device=device),
            'weight': float(sample.get('sample_weight', 1.0)),
        })

    model.train()
    for _ in range(max(1, epochs)):
        for sample in normalized_samples:
            optimizer.zero_grad(set_to_none=True)
            logits = model(sample['rows'])
            log_probs = torch.log_softmax(logits, dim=0)
            loss = -(sample['target'] * log_probs).sum() * sample['weight']
            loss.backward()
            optimizer.step()

    return ExportedModel(model=model.cpu(), mean=mean.cpu(), std=std.cpu(), feature_names=ACTION_FEATURE_NAMES)


def train_regression(samples: list[dict], feature_names: Sequence[str], existing_model: dict | None, lr: float, epochs: int, hidden_size: int, device: torch.device) -> ExportedModel:
    rows = [feature_tensor(feature_names, sample['features']) for sample in samples if sample.get('features')]
    mean, std = compute_moments(rows, len(feature_names))
    model = init_from_existing(existing_model, feature_names, hidden_size).to(device)
    optimizer = torch.optim.AdamW(model.parameters(), lr=lr, weight_decay=1e-4)

    if rows:
        x = torch.stack(normalize_rows(rows, mean, std)).to(device)
        y = torch.tensor([float(sample.get('target', 0.0)) for sample in samples if sample.get('features')], dtype=torch.float32, device=device)
        w = torch.tensor([float(sample.get('sample_weight', 1.0)) for sample in samples if sample.get('features')], dtype=torch.float32, device=device)

        model.train()
        for _ in range(max(1, epochs)):
            optimizer.zero_grad(set_to_none=True)
            pred = model(x)
            loss = ((pred - y) ** 2 * w).mean()
            loss.backward()
            optimizer.step()

    return ExportedModel(model=model.cpu(), mean=mean.cpu(), std=std.cpu(), feature_names=feature_names)


def train_binary(samples: list[dict], existing_model: dict | None, lr: float, epochs: int, hidden_size: int, device: torch.device, threshold: float) -> dict:
    rows = [feature_tensor(YANIV_FEATURE_NAMES, sample['features']) for sample in samples if sample.get('features')]
    mean, std = compute_moments(rows, len(YANIV_FEATURE_NAMES))
    model = init_from_existing(existing_model, YANIV_FEATURE_NAMES, hidden_size).to(device)
    optimizer = torch.optim.AdamW(model.parameters(), lr=lr, weight_decay=1e-4)

    if rows:
        x = torch.stack(normalize_rows(rows, mean, std)).to(device)
        y = torch.tensor([1.0 if sample.get('target') else 0.0 for sample in samples if sample.get('features')], dtype=torch.float32, device=device)
        w = torch.tensor([float(sample.get('sample_weight', 1.0)) for sample in samples if sample.get('features')], dtype=torch.float32, device=device)

        model.train()
        for _ in range(max(1, epochs)):
            optimizer.zero_grad(set_to_none=True)
            logits = model(x)
            loss = (F.binary_cross_entropy_with_logits(logits, y, reduction='none') * w).mean()
            loss.backward()
            optimizer.step()

    exported = ExportedModel(model=model.cpu(), mean=mean.cpu(), std=std.cpu(), feature_names=YANIV_FEATURE_NAMES).export()
    exported['threshold'] = float(threshold)
    return exported


def sample_weight(sample: dict) -> float:
    if sample.get('source_kind') == 'teacher':
        return 1.0
    result = float(sample.get('result', 0.0))
    return max(0.2, min(1.4, 0.35 + (result * 0.9)))


def maybe_absolute(base_manifest_path: Path, model_path: str) -> Path:
    model = Path(model_path)
    if model.is_absolute():
        return model
    return (base_manifest_path.parent / model).resolve()


def main():
    parser = argparse.ArgumentParser(description='Train Yaniv learned checkpoints with PyTorch on macOS MPS/CPU.')
    parser.add_argument('--replay-path', required=True)
    parser.add_argument('--manifest-path', required=True)
    parser.add_argument('--output-root', required=True)
    parser.add_argument('--learning-rate', type=float, default=0.0015)
    parser.add_argument('--epochs', type=int, default=10)
    parser.add_argument('--policy-hidden-size', type=int, default=64)
    parser.add_argument('--value-hidden-size', type=int, default=48)
    parser.add_argument('--yaniv-hidden-size', type=int, default=32)
    parser.add_argument('--checkpoint-id', default='')
    args = parser.parse_args()

    replay_path = Path(args.replay_path).resolve()
    manifest_path = Path(args.manifest_path).resolve()
    output_root = Path(args.output_root).resolve()

    replay = json_load(replay_path)
    current_manifest = json_load(manifest_path)
    current_checkpoint_path = maybe_absolute(manifest_path, current_manifest['model_path'])
    existing_checkpoint = json_load(current_checkpoint_path) if current_checkpoint_path.exists() else None

    action_samples = []
    for sample in replay.get('action_samples', []):
        normalized = dict(sample)
        normalized['sample_weight'] = sample_weight(sample)
        action_samples.append(normalized)

    value_samples = []
    for sample in replay.get('action_samples', []):
        chosen_features = sample.get('chosen_value_features')
        if not chosen_features:
            continue
        value_samples.append({
            'features': chosen_features,
            'target': (2.0 * float(sample.get('result', 0.0))) - 1.0,
            'sample_weight': sample_weight(sample),
        })

    yaniv_samples = []
    for sample in replay.get('yaniv_samples', []):
        normalized = dict(sample)
        normalized['sample_weight'] = sample_weight(sample)
        yaniv_samples.append(normalized)

    device = device_for_training()

    action_export = train_policy(
        action_samples,
        existing_checkpoint.get('action_model') if existing_checkpoint else None,
        args.learning_rate,
        args.epochs,
        args.policy_hidden_size,
        device,
    )
    value_export = train_regression(
        value_samples,
        VALUE_FEATURE_NAMES,
        existing_checkpoint.get('value_model') if existing_checkpoint else None,
        args.learning_rate * 0.7,
        args.epochs,
        args.value_hidden_size,
        device,
    )
    yaniv_export = train_binary(
        yaniv_samples,
        existing_checkpoint.get('yaniv_model') if existing_checkpoint else None,
        args.learning_rate * 0.8,
        args.epochs,
        args.yaniv_hidden_size,
        device,
        threshold=float(((existing_checkpoint or {}).get('yaniv_model') or {}).get('threshold', 0.5)),
    )

    checkpoint_id = args.checkpoint_id or f'learned-py-{now_tag()}'
    training_iteration = int(current_manifest.get('training_iteration', 0)) + 1
    created_at = datetime.now(timezone.utc).isoformat()

    checkpoint = {
        'schema_version': 1,
        'checkpoint_id': checkpoint_id,
        'training_iteration': training_iteration,
        'created_at': created_at,
        'trainer': {
            'kind': 'python-torch',
            'device': str(device),
        },
        'action_model': action_export.export(),
        'value_model': value_export.export(),
        'yaniv_model': yaniv_export,
    }

    checkpoint_path = output_root / 'checkpoints' / f'{checkpoint_id}.json'
    json_dump(checkpoint_path, checkpoint)

    manifest = {
        'schema_version': 1,
        'checkpoint_id': checkpoint_id,
        'training_iteration': training_iteration,
        'created_at': created_at,
        'rating_2p': float(current_manifest.get('rating_2p', 1500)),
        'rating_3p': float(current_manifest.get('rating_3p', 1500)),
        'win_rate_vs_v3': 0,
        'latency_summary': {
            'avg_ms': 0,
            'p95_ms': 0,
            'max_ms': 0,
        },
        'model_path': str(checkpoint_path),
    }
    manifest_path_out = output_root / 'manifests' / f'{checkpoint_id}.json'
    json_dump(manifest_path_out, manifest)

    summary = {
        'checkpoint_manifest_path': str(manifest_path_out),
        'checkpoint_path': str(checkpoint_path),
        'device': str(device),
        'action_samples': len(action_samples),
        'value_samples': len(value_samples),
        'yaniv_samples': len(yaniv_samples),
    }
    print(json.dumps(summary))


if __name__ == '__main__':
    main()
