#!/usr/bin/env bash
# B8 @1M measurement legs (issue #280, plan B8 Step 1). Kurt approved 2026-10-14.
set -euo pipefail
cd /tmp/elw-pr284
export ISSUE280_STORE_DIR=$HOME/issue280-stores
TSX=node_modules/.bin/tsx
SCRATCH=$HOME/.hermes/cache/scratch/issue280
mkdir -p "$SCRATCH"

echo "=== generating @1M stores (bulk) ==="
$TSX bench/issue280/makeStore.ts --rows 1000000 --out b8-1m-window-r2.db --bulk --wal-checkpoint
$TSX bench/issue280/makeStore.ts --rows 1000000 --out b8-1m-reclaim-r2.db --bulk --wal-checkpoint

echo "=== window leg @1M ==="
$TSX bench/issue280/profileSetup.ts --store "$ISSUE280_STORE_DIR/b8-1m-window-r2.db" \
  --budget 1500 --leg window --json "$SCRATCH/b8-1m-window.json"

echo "=== reclaim leg @1M ==="
$TSX bench/issue280/profileSetup.ts --store "$ISSUE280_STORE_DIR/b8-1m-reclaim-r2.db" \
  --budget 1500 --leg reclaim --json "$SCRATCH/b8-1m-reclaim.json"

echo "=== B8 @1M legs complete ==="
