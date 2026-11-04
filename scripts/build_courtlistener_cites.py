#!/usr/bin/env python3
"""Build a TIME-SLICED case->case CITATION graph from local CourtListener bulk files.

Memory-safe version: nodes are restricted to 14 target courts, so we never load
the full opinion->cluster map (100M+) — we keep only opinions whose cluster is a
target-court cluster.

edge = (citing_cluster, cites, cited_cluster, year_of_citing)

Inputs (already on disk):
  dockets.csv.bz2          docket_id -> court_id
  opinion-clusters.csv.bz2 cluster_id -> date_filed, docket_id
  opinion_cluster.tsv      opinion_id -> cluster_id (from extract_opinion_cluster.py)
  citation-map.csv.bz2     cited_opinion_id, citing_opinion_id

Output: train/valid/test TSV + build_stats.json
"""
import bz2
import csv
import json
import os
import sys

BASE = "/workspace/03_data/case_valid_prep/courtlistener"
OUT = os.environ.get("CL_CIT_OUT", "/workspace/03_data/case_valid_prep/courtlistener_cites")
OPINION_CLUSTER = os.path.join(BASE, "opinion_cluster.tsv")

TARGET_COURTS = {
    "scotus",
    "ca1", "ca2", "ca3", "ca4", "ca5", "ca6",
    "ca7", "ca8", "ca9", "ca10", "ca11",
    "ny", "cal",
}
YEAR_MIN, YEAR_MAX = 1990, 2020
SPLIT_VALID = 2011   # train: <=2010 | valid: 2011-2015 | test: 2016-2020
SPLIT_TEST = 2016

csv.field_size_limit(sys.maxsize)


def docket_court_map():
    """Only dockets of target courts (keeps the dict small)."""
    m = {}
    with bz2.open(os.path.join(BASE, "dockets.csv.bz2"), "rt", encoding="utf-8", errors="ignore") as f:
        r = csv.reader(f)
        h = next(r)
        i_id, i_court = h.index("id"), h.index("court_id")
        need = max(i_id, i_court)
        n = 0
        for row in r:
            n += 1
            if n % 5000000 == 0:
                print(f"  dockets scanned {n} kept {len(m)}", flush=True)
            if len(row) <= need:
                continue
            if row[i_court] in TARGET_COURTS:
                m[row[i_id]] = row[i_court]
    return m


def cluster_year_map(dk_court):
    """cluster_id -> year, for target-court clusters in [YEAR_MIN, YEAR_MAX]."""
    m = {}
    with bz2.open(os.path.join(BASE, "opinion-clusters.csv.bz2"), "rt", encoding="utf-8", errors="ignore") as f:
        r = csv.reader(f)
        h = next(r)
        i_id, i_date, i_dk = h.index("id"), h.index("date_filed"), h.index("docket_id")
        need = max(i_id, i_date, i_dk)
        n = 0
        for row in r:
            n += 1
            if n % 5000000 == 0:
                print(f"  clusters scanned {n} kept {len(m)}", flush=True)
            if len(row) <= need:
                continue
            if row[i_dk] not in dk_court:
                continue
            d = row[i_date]
            if len(d) < 4:
                continue
            try:
                y = int(d[:4])
            except ValueError:
                continue
            if YEAR_MIN <= y <= YEAR_MAX:
                m[row[i_id]] = y
    return m


def opinion_to_cluster(cluster_year):
    """opinion_id -> cluster_id, only for target clusters."""
    if not os.path.exists(OPINION_CLUSTER):
        print(f"ERROR: missing {OPINION_CLUSTER}", file=sys.stderr)
        sys.exit(2)
    m = {}
    n = 0
    with open(OPINION_CLUSTER, encoding="utf-8", errors="ignore") as f:
        for line in f:
            n += 1
            if n % 10000000 == 0:
                print(f"  opinion_cluster scanned {n} kept {len(m)}", flush=True)
            p = line.rstrip("\n").split("\t")
            if len(p) != 2:
                continue
            if p[1] in cluster_year:
                m[p[0]] = p[1]
    return m


def main():
    os.makedirs(OUT, exist_ok=True)

    print("STEP 1: dockets of target courts", flush=True)
    dk = docket_court_map()
    print(f"  target-court dockets: {len(dk)}", flush=True)

    print("STEP 2: cluster -> year (target courts, 1990-2020)", flush=True)
    cy = cluster_year_map(dk)
    print(f"  target clusters: {len(cy)}", flush=True)

    print("STEP 3: opinion -> cluster (filtered)", flush=True)
    oc = opinion_to_cluster(cy)
    print(f"  opinions kept: {len(oc)}", flush=True)

    print("STEP 4: stream citation-map -> dated case->case edges", flush=True)
    edges = set()
    rows = 0
    with bz2.open(os.path.join(BASE, "citation-map.csv.bz2"), "rt", encoding="utf-8", errors="ignore") as f:
        r = csv.reader(f)
        h = next(r)
        i_cited, i_citing = h.index("cited_opinion_id"), h.index("citing_opinion_id")
        need = max(i_cited, i_citing)
        for row in r:
            rows += 1
            if rows % 10000000 == 0:
                print(f"  citation rows {rows} edges {len(edges)}", flush=True)
            if len(row) <= need:
                continue
            cc = oc.get(row[i_citing])
            if cc is None:
                continue
            cd = oc.get(row[i_cited])
            if cd is None or cd == cc:
                continue
            edges.add((cc, cd, cy[cc]))
    print(f"  citation rows {rows} | kept edges {len(edges)}", flush=True)

    tr, va, te = [], [], []
    for s, o, t in edges:
        if t <= SPLIT_VALID - 1:
            tr.append((s, "cites", o, t))
        elif t < SPLIT_TEST:
            va.append((s, "cites", o, t))
        else:
            te.append((s, "cites", o, t))

    for name, rs in (("train", tr), ("valid", va), ("test", te)):
        with open(os.path.join(OUT, f"{name}.tsv"), "w", encoding="utf-8") as f:
            for s, r_, o, t in rs:
                f.write(f"{s}\t{r_}\t{o}\t{t}\n")
        print(f"  {name}: {len(rs)} rows", flush=True)

    ents, times, train_subj = set(), set(), {s for s, _, _, _ in tr}
    for rs in (tr, va, te):
        for s, _, o, t in rs:
            ents.add(s); ents.add(o); times.add(t)

    def unk(rs):
        return None if not rs else sum(1 for s, _, _, _ in rs if s not in train_subj) / len(rs)

    stats = {
        "n_ent": len(ents), "n_rel": 1,
        "n_train": len(tr), "n_valid": len(va), "n_test": len(te),
        "timesteps": len(times),
        "time_range": [min(times) if times else None, max(times) if times else None],
        "valid_subj_unknown": unk(va), "test_subj_unknown": unk(te),
        "protocol": "case->case citation; year=citing case date_filed; nodes=14 target courts; split train<=2010/valid2011-15/test2016-20",
    }
    with open(os.path.join(OUT, "build_stats.json"), "w", encoding="utf-8") as f:
        json.dump(stats, f, ensure_ascii=False, indent=2)
    print(json.dumps(stats, ensure_ascii=False, indent=2), flush=True)


if __name__ == "__main__":
    main()
