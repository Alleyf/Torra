#!/usr/bin/env python3
"""Inspect raw DataJud JSONL: case counts, movement stats, date spans, keys."""
import json
import glob
import os
import statistics
from collections import Counter, defaultdict

RAW = "/workspace/03_data/case_valid_prep/datajud/raw"

files = sorted(glob.glob(os.path.join(RAW, "*.jsonl")))
print("files:", len(files))

all_keys = Counter()
mov_keys = Counter()
n_cases = 0
mov_per_case = []
span_days = []
file_year = defaultdict(lambda: {"cases": 0, "movs": 0})
mov_types = Counter()
dates_year = Counter()
orgao_seen = 0
ajuiz_years = Counter()

for fp in files:
    base = os.path.basename(fp)
    for line in open(fp, encoding="utf-8", errors="ignore"):
        line = line.strip()
        if not line:
            continue
        try:
            d = json.loads(line)
        except Exception:
            continue
        n_cases += 1
        file_year[base]["cases"] += 1
        for k in d.keys():
            all_keys[k] += 1
        if d.get("orgaoJulgador"):
            orgao_seen += 1
        y = str(d.get("dataAjuizamento") or "")[:4]
        if y:
            ajuiz_years[y] += 1
        movs = d.get("movimentos") or []
        mov_per_case.append(len(movs))
        file_year[base]["movs"] += len(movs)
        ds = []
        for m in movs:
            if isinstance(m, dict):
                for k in m.keys():
                    mov_keys[k] += 1
                c = m.get("codigo")
                if c is not None:
                    mov_types[str(c)] += 1
                dh = m.get("dataHora")
                if dh:
                    ds.append(str(dh)[:10])
                    dates_year[str(dh)[:4]] += 1
        if len(ds) >= 2:
            try:
                from datetime import date
                d0 = date.fromisoformat(min(ds))
                d1 = date.fromisoformat(max(ds))
                span_days.append((d1 - d0).days)
            except Exception:
                pass

print(f"\ncases: {n_cases}")
print(f"movimentos per case: median={statistics.median(mov_per_case)} mean={sum(mov_per_case)/len(mov_per_case):.1f} max={max(mov_per_case)} zeros={sum(1 for x in mov_per_case if x==0)}")
if span_days:
    ss = sorted(span_days)
    print(f"date span days: median={ss[len(ss)//2]} p90={ss[int(len(ss)*0.9)]} max={max(ss)} | n_with_span={len(ss)}")
print(f"orgaoJulgador present: {orgao_seen} ({100*orgao_seen/max(n_cases,1):.1f}%)")
print(f"\ncase keys: {dict(all_keys)}")
print(f"\nmovement keys: {dict(mov_keys)}")
print(f"\ndistinct movement types: {len(mov_types)}")
print("top movement types:", mov_types.most_common(15))
print("\nfiling years:", dict(sorted(ajuiz_years.items())))
print("\nmovement event years (top):", dates_year.most_common(15))
print("\nper-file:")
for b, v in sorted(file_year.items()):
    print(f"  {b}: cases={v['cases']} movs={v['movs']} avg={v['movs']/max(v['cases'],1):.1f}")
