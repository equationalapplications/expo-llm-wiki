#!/usr/bin/env bash
# Builds one store (unless it already exists) and runs the named legs in order.
# Usage: bench/issue280/run.sh <entries> <out-dir> <leg[:budgetMs]>...
# Example: bench/issue280/run.sh 1000000 bench/issue280/results warm normalize gate window reclaim:15000
set -euo pipefail

cd "$(dirname "$0")/../.."
entries="$1"
out="$2"
shift 2

dir="${ISSUE280_STORE_DIR:-$HOME/issue280-stores}"
store="$dir/issue280-$entries.db"

if [ ! -f "$store" ]; then
  echo "[$(date -u +%FT%TZ)] building $store"
  node bench/issue280/makeStore.ts --entries "$entries" --out "$store"
fi

for item in "$@"; do
  leg="${item%%:*}"
  budget=1500
  if [ "$item" != "$leg" ]; then budget="${item##*:}"; fi
  echo "[$(date -u +%FT%TZ)] leg $leg budget ${budget}ms"
  node bench/issue280/profileSetup.ts --store "$store" --leg "$leg" --budget "$budget" --out "$out"
done
echo "[$(date -u +%FT%TZ)] done $entries"
