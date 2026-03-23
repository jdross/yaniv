#!/bin/zsh
set -euo pipefail

ROOT="/Users/jdross/Code/yaniv"
OUT="${YANIV_TRAIN_OUTPUT_ROOT:-$ROOT/metrics/learned-ai}"
SOURCE_MANIFEST="${YANIV_TRAIN_SOURCE_MANIFEST:-$ROOT/server/learned_ai/current_champion.json}"
WORKING_MANIFEST="${YANIV_TRAIN_WORKING_MANIFEST:-$OUT/working_champion.json}"
ITERATIONS="${YANIV_TRAIN_ITERATIONS:-200}"
GAMES="${YANIV_TRAIN_GAMES:-64}"
EVAL_GAMES_2P="${YANIV_TRAIN_EVAL_GAMES_2P:-16}"
EVAL_GAMES_3P="${YANIV_TRAIN_EVAL_GAMES_3P:-16}"
MAX_TURNS="${YANIV_TRAIN_MAX_TURNS:-500}"
ROLLOUT_SAMPLES="${YANIV_TRAIN_ROLLOUT_SAMPLES:-16}"
EPOCHS="${YANIV_TRAIN_EPOCHS:-12}"
MODE="${YANIV_TRAIN_MODE:-v3-curriculum}"
BASE_SEED="${YANIV_TRAIN_BASE_SEED:-5000}"

mkdir -p "$OUT"

if [[ ! -f "$WORKING_MANIFEST" ]]; then
  node - "$SOURCE_MANIFEST" "$WORKING_MANIFEST" <<'EOF'
const fs = require('node:fs');
const path = require('node:path');

const sourceManifestPath = path.resolve(process.argv[2]);
const workingManifestPath = path.resolve(process.argv[3]);
const sourceManifest = JSON.parse(fs.readFileSync(sourceManifestPath, 'utf8'));
const sourceModelPath = path.isAbsolute(sourceManifest.model_path)
  ? sourceManifest.model_path
  : path.resolve(path.dirname(sourceManifestPath), sourceManifest.model_path);
const payload = {
  ...sourceManifest,
  model_path: sourceModelPath,
};
fs.mkdirSync(path.dirname(workingManifestPath), { recursive: true });
fs.writeFileSync(workingManifestPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
EOF
fi

for i in $(seq 1 "$ITERATIONS"); do
  seed=$((BASE_SEED + i))
  echo "[$(date -Iseconds)] iteration=$i/$ITERATIONS seed=$seed output_root=$OUT working_manifest=$WORKING_MANIFEST"
  node "$ROOT/scripts/learned_ai_python.js" run \
    --games "$GAMES" \
    --eval-games-2p "$EVAL_GAMES_2P" \
    --eval-games-3p "$EVAL_GAMES_3P" \
    --max-turns "$MAX_TURNS" \
    --rollout-samples "$ROLLOUT_SAMPLES" \
    --epochs "$EPOCHS" \
    --mode "$MODE" \
    --seed "$seed" \
    --manifest-path "$WORKING_MANIFEST" \
    --promote \
    --output-root "$OUT"
done
