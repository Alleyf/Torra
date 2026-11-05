#!/usr/bin/env python3
"""Rebuild DataJud as a REAL event-stream graph (not type x year collapsed).

What the old build destroyed (build_datajud.py):
  - dataHora truncated to year
  - deduped by (codigo, year)  -> one edge per type per year
  - capped at 6 movements per case (median case has 31)
  - tail = type only, no timing

This build:
  tail  = MOV:{codigo}      (program activity type)
  time  = YYYYMMDD of the FIRST occurrence of (case, type)  [day-level]
  split = event edges by their own date: <=20221231 train / 2023 valid / >=2024 test
  attr  = case_filed_in_court / case_has_classe / case_has_assunto
          ALWAYS in train: at filing time the court/class/subject of a new case
          are known. This is the cold-start setting and is what gives an unseen
          case neighbours in the training graph (the pure citation graph failed
          precisely because it had none).

Eval queries are event edges only.
"""
import json
import glob
import os
import sys
from collections import defaultdict

RAW = "/workspace/03_data/case_valid_prep/datajud/raw/*.jsonl"
OUT = "/workspace/03_data/case_valid_prep/datajud_events"

YEAR_OK_LO, YEAR_OK_HI = 2015, 2026
SPLIT_TRAIN_END = 20221231
SPLIT_VALID_END = 20231231


def to_int_date(s):
    """'2022-02-22T11:03:42.000Z' -> 20220222, or None."""
    if not s or len(s) < 10:
        return None
    try:
        y, m, d = int(s[0:4]), int(s[5:7]), int(s[8:10])
    except ValueError:
        return None
    if not (YEAR_OK_LO <= y <= YEAR_OK_HI):
        return None
    return y * 10000 + m * 100 + d


def flatten(x):
    if isinstance(x, list):
        for it in x:
            yield from flatten(it)
    elif isinstance(x, dict):
        yield x


def main():
    os.makedirs(OUT, exist_ok=True)
    attr = []                       # (s, r, o, t) always train
    first_event = {}                # (case, mov) -> min date
    n_cases = n_skip_nomov = n_skip_badtime = 0
    mov_seen = set()

    for fp in sorted(glob.glob(RAW)):
        with open(fp, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    d = json.loads(line)
                except Exception:
                    continue
                n_cases += 1
                np_ = d.get("numeroProcesso")
                if not np_:
                    continue
                if d.get("nivelSigilo", 0) != 0:
                    continue
                case = f"CASE:{np_}"
                aju = to_int_date(d.get("dataAjuizamento"))
                if aju is None:
                    n_skip_badtime += 1
                    continue
                ay = aju // 10000
                at = ay * 10000 + 101   # attribute edges dated at filing year start

                court = d.get("tribunal")
                if court:
                    attr.append((case, "case_filed_in_court", f"COURT:{court}", at))
                cl = d.get("classe") or {}
                if isinstance(cl, dict) and cl.get("codigo") is not None:
                    attr.append((case, "case_has_classe", f"CLASSE:{cl['codigo']}", at))
                for asu in flatten(d.get("assuntos") or []):
                    if asu.get("codigo") is not None:
                        attr.append((case, "case_has_assunto", f"ASSUNTO:{asu['codigo']}", at))

                movs = list(flatten(d.get("movimentos") or []))
                if not movs:
                    n_skip_nomov += 1
                for m in movs:
                    code = m.get("codigo")
                    dt = to_int_date(m.get("dataHora"))
                    if code is None or dt is None:
                        continue
                    mov_seen.add(code)
                    key = (case, f"MOV:{code}")
                    cur = first_event.get(key)
                    if cur is None or dt < cur:
                        first_event[key] = dt

    print(f"cases={n_cases} skip_badtime={n_skip_badtime} no_movs={n_skip_nomov} "
          f"attr_edges={len(attr)} unique_(case,mov)={len(first_event)} mov_types={len(mov_seen)}",
          flush=True)

    tr = list(attr)
    va, te = [], []
    n_ev_tr = 0
    for (case, mov), dt in first_event.items():
        row = (case, "case_first_event", mov, dt)
        if dt <= SPLIT_TRAIN_END:
            tr.append(row); n_ev_tr += 1
        elif dt <= SPLIT_VALID_END:
            va.append(row)
        else:
            te.append(row)

    print(f"event edges: train={n_ev_tr} valid={len(va)} test={len(te)}", flush=True)

    def write(name, rows):
        with open(os.path.join(OUT, f"{name}.tsv"), "w", encoding="utf-8") as f:
            for s, r, o, t in rows:
                f.write(f"{s}\t{r}\t{o}\t{t}\n")
        print(f"  {name}: {len(rows)}", flush=True)

    write("train", tr); write("valid", va); write("test", te)

    # stats + cold-start connectivity check
    ents = set(); rels = set()
    for rows in (tr, va, te):
        for s, r, o, t in rows:
            ents.add(s); ents.add(o); rels.add(r)
    train_nodes = set()
    for s, r, o, t in tr:
        train_nodes.add(s); train_nodes.add(o)
    train_subj = {s for s, _, _, _ in tr}

    def frac_connected(rows):
        if not rows:
            return 0.0, 0.0
        subs = {s for s, _, _, _ in rows}
        subj_in_train = sum(1 for s in subs if s in train_subj) / len(subs)
        # a query case is usable if it appears in the training graph at all (as subject or object)
        connected = sum(1 for s in subs if s in train_nodes) / len(subs)
        return subj_in_train, connected

    vc, vconn = frac_connected(va)
    tc, tconn = frac_connected(te)
    import json as _j
    stats = {
        "n_ent": len(ents), "n_rel": len(rels), "relations": sorted(rels),
        "n_train": len(tr), "n_valid": len(va), "n_test": len(te),
        "n_attr_train": len(attr), "n_event_train": n_ev_tr,
        "n_mov_types": len(mov_seen),
        "valid_subj_in_train": round(vc, 4), "valid_case_connected": round(vconn, 4),
        "test_subj_in_train": round(tc, 4), "test_case_connected": round(tconn, 4),
        "protocol": "first-occurrence event edges day-level; attr edges train-only (cold-start known metadata); split <=2022/2023/>=2024",
    }
    with open(os.path.join(OUT, "build_stats.json"), "w", encoding="utf-8") as f:
        _j.dump(stats, f, ensure_ascii=False, indent=2)
    print(_j.dumps(stats, ensure_ascii=False, indent=2), flush=True)


if __name__ == "__main__":
    main()
