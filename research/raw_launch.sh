#!/usr/bin/env bash
# raw_launch.sh — gate + launch MEM-RAW (E3 with the memory content stripped of its
# frozen write projection). Waits for strictly idle cards, one seed per card.
set -uo pipefail
source /workspace/miniconda3/etc/profile.d/conda.sh
conda activate transfir
LOG=/workspace/_scripts/raw_launch.log
say() { echo "[$(date -u +%Y-%m-%dT%H:%M:%S+00:00)] $*" >> "$LOG"; }

PENDING="${1:-42}"
# pre-create READMEs for every pending seed so the RD-SEED check sees a 3-seed family
for s in $PENDING; do
  D=/workspace/02_runs/tkgr/adatkg/raw_clean/icews14_RAW_full_seed$s
  mkdir -p "$D"
  [ -f "$D/README.md" ] || sed "s/{SEED}/$s/g" /workspace/_scripts/raw_readme.tpl > "$D/README.md"
done

for attempt in $(seq 1 240); do
  TAKEN=" "
  for s in $PENDING; do
    D=/workspace/02_runs/tkgr/adatkg/raw_clean/icews14_RAW_full_seed$s
    for g in 0 1 2 3; do
      case "$TAKEN" in *" $g "*) continue;; esac
      used=$(nvidia-smi --query-gpu=memory.used --format=csv,noheader,nounits -i "$g" 2>/dev/null | tr -d ' ')
      apps=$(nvidia-smi --query-compute-apps=pid --format=csv,noheader -i "$g" 2>/dev/null | grep -c . || true)
      [ -n "$used" ] || continue
      if [ "$used" -lt 500 ] && [ "$apps" -eq 0 ]; then
        CMD="python main_enhanced.py --dataset ICEWS14 --max_length 10 --num_layers 3 --hidden_dim 768 --num_code 100 --word_embedding_path data --enhancement ema --seed $s --epochs 60 --y_mode off --z_mode off --chain_dropout 0.15 --cand_mem_read on --mem_content raw"
        if bash /workspace/_scripts/gate.sh open tkgr/adatkg/raw_clean/icews14_RAW_full_seed$s \
             --protocol icews14_p1_fcs_raw --variant mem_raw --gpu "$g" \
             --env transfir --cmd "$CMD" >> "$LOG" 2>&1; then
          tmux new -ds icews14_RAW_full_seed$s "export CUDA_VISIBLE_DEVICES=$g; bash $D/launch.sh"
          say "seed$s started on gpu$g (attempt $attempt)"
          PENDING=$(echo $PENDING | tr ' ' '\n' | grep -v "^$s$" | tr '\n' ' ')
          TAKEN="$TAKEN$g "
        else
          say "gate failed seed$s gpu$g (attempt $attempt)"
        fi
        break
      fi
    done
  done
  [ -z "${PENDING// }" ] && { say "all seeds launched"; exit 0; }
  sleep 60
done
say "timeout, still pending: $PENDING"
exit 1
