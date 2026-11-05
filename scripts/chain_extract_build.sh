#!/bin/bash
# Full v2 extraction -> build chain.
set -u
BASE=/workspace/03_data/case_valid_prep/courtlistener
SCRIPTS=/workspace/03_data/case_valid_prep/scripts
LOG=$BASE/extract_v2.log

rm -f "$BASE/opinion_cluster.tsv"

echo "EXTRACT_START $(date '+%F %T')" >> "$LOG"
lbzip2 -dc "$BASE/opinions.csv.bz2" | python3 "$SCRIPTS/extract_opinion_cluster_v2.py" "$BASE/opinion_cluster.tsv" >> "$LOG" 2>&1
rc=$?
echo "EXTRACT_RC=$rc $(date '+%F %T')" >> "$LOG"
if [ $rc -ne 0 ]; then echo "EXTRACT_FAILED" >> "$LOG"; exit 1; fi
echo "EXTRACT_DONE" >> "$LOG"

echo "BUILD_START $(date '+%F %T')" >> "$LOG"
python3 "$SCRIPTS/build_courtlistener_cites.py" >> "$LOG" 2>&1
rc2=$?
echo "BUILD_RC=$rc2 $(date '+%F %T')" >> "$LOG"
if [ $rc2 -eq 0 ]; then echo "BUILD_DONE" >> "$LOG"; else echo "BUILD_FAILED" >> "$LOG"; fi
