#!/usr/bin/env python3
"""Build InGram inputs from the multi-relation CourtListener graph.

Multi-rel graph is ~322万 train edges / 66万 entities; InGram subgraph extraction
is too slow at that size, so we stratified-sample per relation:
  train.txt        h\t r\t t   (training graph)
  kg_inference.txt h r t       (valid U test edges; val_test.py slices it)

Valid/test after val_test.py are mixed-relation (cites dominates), same protocol
as the DataJud InGram run, so results are comparable.
"""
import os
import random

random.seed(0)

SRC = "/workspace/03_data/case_valid_prep/courtlistener_multi"
OUT = "/workspace/03_data/case_valid_prep/courtlistener_multi/ingram/COURTLISTENER_MULTI"

TRAIN_CAP = {
    "cites": 120000,
    "case_filed_in_court": 40000,
    "case_authored_by": 30000,
    "case_has_nature": 1000000,   # keep all (~2.5k)
}
KG_CAP = {
    "cites": 15000,
    "case_filed_in_court": 8000,
    "case_authored_by": 3000,
    "case_has_nature": 1000,
}

os.makedirs(OUT, exist_ok=True)


def load(p):
    rows = []
    with open(p, encoding="utf-8") as f:
        for l in f:
            parts = l.rstrip("\n").split("\t")
            if len(parts) >= 4:
                rows.append((sanitize(parts[0]), sanitize(parts[1]), sanitize(parts[2])))
    return rows


def sanitize(e):
    # val_test.py splits kg_inference on whitespace; NATURE: entities carry free
    # text with spaces. Normalize any whitespace inside entity names.
    return "_".join(e.split())


def strat_sample(rows, caps):
    by_rel = {}
    for h, r, t in rows:
        by_rel.setdefault(r, []).append((h, r, t))
    out = []
    for r, lst in by_rel.items():
        cap = caps.get(r, 5000)
        if len(lst) > cap:
            random.shuffle(lst)
            lst = lst[:cap]
        out.extend(lst)
    random.shuffle(out)
    return out


tr = load(f"{SRC}/train.tsv")
va = load(f"{SRC}/valid.tsv")
te = load(f"{SRC}/test.tsv")
print(f"raw: train={len(tr)} valid={len(va)} test={len(te)}", flush=True)

tr_s = strat_sample(tr, TRAIN_CAP)
kg_s = strat_sample(va + te, KG_CAP)
print(f"sampled: train={len(tr_s)} kg_inference={len(kg_s)}", flush=True)

# fold-dedup
seen = set(); tr_f = []
for h, r, t in tr_s:
    if (h, r, t) not in seen:
        seen.add((h, r, t)); tr_f.append((h, r, t))
seen = set(); kg_f = []
for h, r, t in kg_s:
    if (h, r, t) not in seen:
        seen.add((h, r, t)); kg_f.append((h, r, t))

with open(f"{OUT}/train.txt", "w", encoding="utf-8") as f:
    for h, r, t in tr_f:
        f.write(f"{h}\t{r}\t{t}\n")
with open(f"{OUT}/kg_inference.txt", "w", encoding="utf-8") as f:
    for h, r, t in kg_f:
        f.write(f"{h} {r} {t}\n")

from collections import Counter
print("train rel dist:", dict(Counter(r for _, r, _ in tr_f)), flush=True)
print("kg rel dist:", dict(Counter(r for _, r, _ in kg_f)), flush=True)
print(f"written -> {OUT}", flush=True)
