#!/usr/bin/env python3
"""DataJud EVENT-STREAM graph -> InGram inductive protocol.

train.txt        tab-separated h r t   (attr edges + event edges <=2022)
kg_inference.txt space-separated h r t (event edges 2023 / >=2024)

Then run vendor val_test.py to slice kg_inference into msg/valid/test.

Caps keep InGram subgraph extraction tractable; the event tail space is small
(378 types) so a fair control is that popularity is not a degenerate guess.
"""
import os
import random

random.seed(0)

SRC = "/workspace/03_data/case_valid_prep/datajud_events"
OUT = "/workspace/03_data/case_valid_prep/datajud_events/ingram/DATAJUD_EVENTS"

TRAIN_EVENT_CAP = 120000   # sample event edges if train is larger
KG_CAP = {"valid": 15000, "test": 15000}

os.makedirs(OUT, exist_ok=True)


def load(p):
    rows = []
    with open(p, encoding="utf-8") as f:
        for l in f:
            parts = l.rstrip("\n").split("\t")
            if len(parts) >= 4:
                rows.append((parts[0], parts[1], parts[2]))
    return rows


def fold(rows):
    seen = set(); out = []
    for h, r, t in rows:
        if (h, r, t) not in seen:
            seen.add((h, r, t)); out.append((h, r, t))
    return out


tr = load(f"{SRC}/train.tsv")
va = load(f"{SRC}/valid.tsv")
te = load(f"{SRC}/test.tsv")
print(f"raw: train={len(tr)} valid={len(va)} test={len(te)}", flush=True)

train_tri = fold(tr)
if len(train_tri) > TRAIN_EVENT_CAP + 80000:
    # keep all attr edges, subsample event edges
    attr = [x for x in train_tri if x[1] != "case_first_event"]
    ev = [x for x in train_tri if x[1] == "case_first_event"]
    random.shuffle(ev)
    ev = ev[:TRAIN_EVENT_CAP]
    train_tri = attr + ev
    random.shuffle(train_tri)
    print(f"train subsampled (all attr + {len(ev)} events) -> {len(train_tri)}", flush=True)

kg = fold(va + te)
if len(kg) > sum(KG_CAP.values()):
    random.shuffle(kg)
    kg = kg[:sum(KG_CAP.values())]
    print(f"kg_inference capped -> {len(kg)}", flush=True)

with open(f"{OUT}/train.txt", "w", encoding="utf-8") as f:
    for h, r, t in train_tri:
        f.write(f"{h}\t{r}\t{t}\n")
with open(f"{OUT}/kg_inference.txt", "w", encoding="utf-8") as f:
    for h, r, t in kg:
        f.write(f"{h} {r} {t}\n")

tr_ent = set()
for h, r, t in train_tri:
    tr_ent.add(h); tr_ent.add(t)
kg_ent = set()
for h, r, t in kg:
    kg_ent.add(h); kg_ent.add(t)
print(f"train ents={len(tr_ent)} kg ents={len(kg_ent)} new-ents={len(kg_ent - tr_ent)}", flush=True)
# connectivity: how many kg subjects appear in train graph at all
print(f"kg subjects present in train ents: {sum(1 for h, r, t in kg if h in tr_ent)}/{len(kg)}", flush=True)
print(f"written: {OUT}", flush=True)
