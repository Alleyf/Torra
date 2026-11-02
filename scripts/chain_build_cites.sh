#!/bin/bash
# Wait for opinion extraction to finish, then build the citation graph.
set -u
BASE=/workspace/03_data/case_valid_prep/courtlistener
SCRIPTS=/workspace/03_data/case_valid_prep/scripts
LOG=$BASE/build_cites.log

until grep -q EXTRACT_DONE "$BASE/extract.log" 2>/dev/null; do
  sleep 120
done

echo "BUILD_START $(date '+%F %T')" >> "$LOG"
python3 "$SCRIPTS/build_courtlistener_cites.py" >> "$LOG" 2>&1
rc=$?
echo "BUILD_RC=$rc $(date '+%F %T')" >> "$LOG"
if [ $rc -eq 0 ]; then echo "BUILD_DONE" >> "$LOG"; else echo "BUILD_FAILED" >> "$LOG"; fi
