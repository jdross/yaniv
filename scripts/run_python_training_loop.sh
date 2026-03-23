#!/bin/zsh
set -euo pipefail

ROOT="/Users/jdross/Code/yaniv"
OUT="$ROOT/metrics/learned-ai"

for i in $(seq 1 20); do
  node "$ROOT/scripts/learned_ai_python.js" run \
    --games 48 \
    --eval-games-2p 16 \
    --eval-games-3p 16 \
    --max-turns 500 \
    --rollout-samples 16 \
    --epochs 12 \
    --mode v3-curriculum \
    --seed $((1000 + i)) \
    --output-root "$OUT"
done
