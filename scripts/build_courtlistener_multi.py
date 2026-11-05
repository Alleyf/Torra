#!/usr/bin/env python3
"""Build a MULTI-RELATION CourtListener case graph.

Nodes: CASE:{cluster}, COURT:{court_id}, JUDGE:{person_id}, NATURE:{nature_of_suit}
Edges (time = the case's own date_filed year):
  CASE cites CASE
  CASE case_filed_in_court COURT
  CASE case_has_nature NATURE
  CASE case_authored_by JUDGE        (from panel.csv)

Why: the pure citation graph left future cases isolated (99.5%), so no
subgraph method could use them. Attribute edges (court/nature/judge) let a new
case attach to known structure -> real inductive signal.

Reuses the already-built citation edges in courtlistener_cites/ so we never
re-scan the 55GB opinions bulk.
"""
import bz2
import csv
import os
import sys
from collections import defaultdict

BASE = "/workspace/03_data/case_valid_prep/courtlistener"
CITES = "/workspace/03_data/case_valid_prep/courtlistener_cites"
OUT = "/workspace/03_data/case_valid_prep/courtlistener_multi"

YEAR_MIN, YEAR_MAX = 1990, 2020
SPLIT_VALID = 2011   # train <=2010 | valid 2011-2015 | test 2016-2020
SPLIT_TEST = 2016

csv.field_size_limit(sys.maxsize)


def main():
    os.makedirs(OUT, exist_ok=True)

    # ---- 1. citation edges + case set ----
    print("STEP 1: load citation edges", flush=True)
    cites_tr, cites_va, cites_te = [], [], []
    case_ids = set()
    for split, acc in (("train", cites_tr), ("valid", cites_va), ("test", cites_te)):
        for line in open(os.path.join(CITES, f"{split}.tsv"), encoding="utf-8"):
            p = line.rstrip("\n").split("\t")
            if len(p) < 4:
                continue
            s, r, o, t = p
            acc.append((s, o, int(t)))
            case_ids.add(s); case_ids.add(o)
    print(f"  citation edges: {len(cites_tr)+len(cites_va)+len(cites_te)} | cases: {len(case_ids)}", flush=True)

    # ---- 2. cluster -> (year, docket) for those cases ----
    print("STEP 2: cluster -> year/docket", flush=True)
    case_year = {}
    case_docket = {}
    with bz2.open(os.path.join(BASE, "opinion-clusters.csv.bz2"), "rt", encoding="utf-8", errors="ignore") as f:
        r = csv.reader(f)
        h = next(r)
        i_id, i_date, i_dk = h.index("id"), h.index("date_filed"), h.index("docket_id")
        need = max(i_id, i_date, i_dk)
        n = 0
        for row in r:
            n += 1
            if n % 5000000 == 0:
                print(f"  clusters scanned {n} kept {len(case_year)}", flush=True)
            if len(row) <= need:
                continue
            cid = row[i_id]
            if cid not in case_ids:
                continue
            d = row[i_date]
            if len(d) < 4:
                continue
            try:
                y = int(d[:4])
            except ValueError:
                continue
            case_year[cid] = y
            case_docket[cid] = row[i_dk]
    print(f"  cases with year: {len(case_year)}", flush=True)

    # ---- 3. docket -> (court, nature) for needed dockets ----
    print("STEP 3: docket -> court/nature", flush=True)
    need_dockets = set(case_docket.values())
    dk_court = {}
    dk_nature = {}
    with bz2.open(os.path.join(BASE, "dockets.csv.bz2"), "rt", encoding="utf-8", errors="ignore") as f:
        r = csv.reader(f)
        h = next(r)
        i_id, i_court, i_nature = h.index("id"), h.index("court_id"), h.index("nature_of_suit")
        need = max(i_id, i_court, i_nature)
        n = 0
        for row in r:
            n += 1
            if n % 5000000 == 0:
                print(f"  dockets scanned {n} kept {len(dk_court)}", flush=True)
            if len(row) <= need:
                continue
            did = row[i_id]
            if did not in need_dockets:
                continue
            dk_court[did] = row[i_court]
            if row[i_nature]:
                dk_nature[did] = row[i_nature]
    print(f"  dockets matched: {len(dk_court)}", flush=True)

    # ---- 4. panel: cluster -> judges ----
    print("STEP 4: panel -> judges", flush=True)
    case_judges = defaultdict(set)
    with bz2.open(os.path.join(BASE, "panel.csv.bz2"), "rt", encoding="utf-8", errors="ignore") as f:
        r = csv.reader(f)
        h = next(r)
        i_cl, i_p = h.index("opinioncluster_id"), h.index("person_id")
        need = max(i_cl, i_p)
        for row in r:
            if len(row) <= need:
                continue
            cid = row[i_cl]
            if cid in case_ids:
                case_judges[cid].add(row[i_p])
    print(f"  cases with judge: {len(case_judges)}", flush=True)

    # ---- 5. assemble edges, time-split by case year ----
    print("STEP 5: assemble + split", flush=True)
    out = {"train": [], "valid": [], "test": []}

    def put(y, s, r, o):
        if y <= SPLIT_VALID - 1:
            out["train"].append((s, r, o, y))
        elif y < SPLIT_TEST:
            out["valid"].append((s, r, o, y))
        else:
            out["test"].append((s, r, o, y))

    # citation edges
    for split, acc in (("train", cites_tr), ("valid", cites_va), ("test", cites_te)):
        for s, o, y in acc:
            put(y, f"CASE:{s}", "cites", f"CASE:{o}")

    # attribute edges, one per case (case's own year)
    for cid, y in case_year.items():
        c = f"CASE:{cid}"
        did = case_docket.get(cid)
        if did and did in dk_court:
            put(y, c, "case_filed_in_court", f"COURT:{dk_court[did]}")
        if did and did in dk_nature:
            put(y, c, "case_has_nature", f"NATURE:{dk_nature[did]}")
        for p in case_judges.get(cid, ()):  # noqa: E501
            put(y, c, "case_authored_by", f"JUDGE:{p}")

    for name in ("train", "valid", "test"):
        with open(os.path.join(OUT, f"{name}.tsv"), "w", encoding="utf-8") as f:
            for s, r, o, t in out[name]:
                f.write(f"{s}\t{r}\t{o}\t{t}\n")
        print(f"  {name}: {len(out[name])} edges", flush=True)

    # ---- stats ----
    ents, rels, times = set(), set(), set()
    for name in ("train", "valid", "test"):
        for s, r, o, t in out[name]:
            ents.add(s); ents.add(o); rels.add(r); times.add(t)
    train_subj = {s for s, r, o, t in out["train"]}
    va_unk = sum(1 for s, r, o, t in out["valid"] if s not in train_subj) / max(len(out["valid"]), 1)
    te_unk = sum(1 for s, r, o, t in out["test"] if s not in train_subj) / max(len(out["test"]), 1)
    import json
    stats = {
        "n_ent": len(ents), "n_rel": len(rels), "relations": sorted(rels),
        "n_train": len(out["train"]), "n_valid": len(out["valid"]), "n_test": len(out["test"]),
        "timesteps": len(times), "time_range": [min(times), max(times)],
        "valid_subj_unknown": va_unk, "test_subj_unknown": te_unk,
        "protocol": "multi-rel case graph; time=case date_filed; train<=2010/valid2011-15/test2016-20",
    }
    with open(os.path.join(OUT, "build_stats.json"), "w", encoding="utf-8") as f:
        json.dump(stats, f, ensure_ascii=False, indent=2)
    print(json.dumps(stats, ensure_ascii=False, indent=2), flush=True)


if __name__ == "__main__":
    main()
