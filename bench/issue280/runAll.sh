#!/usr/bin/env bash
# The full #318 measurement set, in order: the 1M legs, then gate scale two ways.
# The spec's "4.7 GB, 1M x 4.2" assumed 1.12 GB per 1M rows; this generator's rows
# come to 3.5 GB per 1M (FTS index included). So 4.2M matches the row count (14.8 GB)
# and 1.333M matches the file size (4.7 GB).
# Reclaim uses a 15 s budget per quantum to shorten the run; per-step transaction
# times do not depend on the budget, only how many steps fit in a quantum.
set -euo pipefail

here="$(dirname "$0")"
out="bench/issue280/results"
bash "$here/run.sh" 1000000 "$out" warm crash normalize gate window reclaim:15000
bash "$here/run.sh" 4200000 "$out" warm crash gate migration
bash "$here/run.sh" 1333000 "$out" warm crash gate migration
