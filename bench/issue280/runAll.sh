#!/usr/bin/env bash
# The full #318 measurement set, in order: the 1M legs, then the ~4.2M gate-scale legs.
# Reclaim uses a 15 s budget per quantum to shorten the run; per-step transaction
# times do not depend on the budget, only how many steps fit in a quantum.
set -euo pipefail

here="$(dirname "$0")"
out="bench/issue280/results"
bash "$here/run.sh" 1000000 "$out" warm crash normalize gate window reclaim:15000
bash "$here/run.sh" 4200000 "$out" warm crash gate migration
