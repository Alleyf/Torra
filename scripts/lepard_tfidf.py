#!/usr/bin/env python3
"""RQ1 dense/text-vector retrieval baseline (TF-IDF cosine).

Completes the baseline ladder required by the plan:
  BM25 | 文本向量检索(this) | 静态KG | 现有TKGR | popularity

Same protocol as lepard_retrieval.py / lepard_bm25_lean.py:
query = destination_context, pool = precedents cited by test-window cases,
truth = precedents actually quoted.
"""
import os
import csv
import gzip
import json
import math
import random
import re
from collections import Counter, defaultdict

DATA = "/workspace/03_data/legal_tkgr/lepard/lepard_top10k.csv.gz"
PASSAGES = "/workspace/03_data/legal_tkgr/lepard/passage_dict.json"
CUT_TEST = 20140101
N_QUERY = int(os.environ.get("N_QUERY", "3000"))
TOPK = (10, 50)
TOKEN = re.compile(r"[a-z0-9]+")


def pdate(s):
    if not s:
        return None
    try:
        y, m, d = s.split("-")
        return int(y) * 10000 + int(m) * 100 + int(d)
    except Exception:
        return None


def tok(s):
    return TOKEN.findall((s or "").lower())


def metrics(ranked, truth):
    out = {}
    for k in TOPK:
        out[f"Recall@{k}"] = len(set(ranked[:k]) & truth) / max(len(truth), 1)
    dcg = sum(1 / math.log2(i + 2) for i, p in enumerate(ranked[:10]) if p in truth)
    ideal = sum(1 / math.log2(i + 2) for i in range(min(len(truth), 10)))
    out["NDCG@10"] = dcg / ideal if ideal else 0.0
    first = next((i for i, p in enumerate(ranked) if p in truth), None)
    out["MRR"] = 1.0 / (first + 1) if first is not None else 0.0
    return out


def main():
    random.seed(0)
    print("pass 1: collect queries + needed precedents ...", flush=True)
    ctx = defaultdict(str)
    truth = defaultdict(set)
    needed = set()
    with gzip.open(DATA, "rt", encoding="utf-8", errors="ignore") as f:
        r = csv.reader(f)
        next(r)
        for row in r:
            if len(row) < 13:
                continue
            si, di = row[1], row[0]
            sd, dd = pdate(row[6]), pdate(row[2])
            if sd is None or dd is None or sd > dd:
                continue
            if dd >= CUT_TEST:
                truth[di].add(si)
                needed.add(si)
                if len(ctx[di]) < 400:
                    ctx[di] = (ctx[di] + " " + row[12])[:800]

    print("pass 2: aggregate passages by precedent ...", flush=True)
    docs = {}
    blob = json.load(open(PASSAGES))
    data = blob["data"]
    for k, v in data.items():
        pref = k.split("_", 1)[0]
        if pref in needed:
            docs[pref] = (docs.get(pref, "") + " " + (v or ""))[:6000]
    del blob, data
    print(f"pool={len(docs)}", flush=True)

    pool = list(docs)
    items = [(d, truth[d] & set(pool)) for d in truth if truth[d] & set(pool)]
    random.shuffle(items)
    items = items[:N_QUERY]
    print(f"queries={len(items)} avg_truth={sum(len(t) for _,t in items)/max(len(items),1):.2f}", flush=True)

    # TF-IDF with L2 norm, sparse dicts
    tf = {}
    df = Counter()
    for p in pool:
        c = Counter(tok(docs[p]))
        tf[p] = c
        for w in c:
            df[w] += 1
    N = len(pool)
    idf = {w: math.log((N + 1) / (d + 1)) + 1 for w, d in df.items()}

    def vec(text):
        c = Counter(tok(text))
        v = {w: (1 + math.log(n)) * idf[w] for w, n in c.items() if w in idf}
        norm = math.sqrt(sum(x * x for x in v.values())) or 1.0
        return {w: x / norm for w, x in v.items()}

    doc_vec = {p: vec(docs[p]) for p in pool}
    # inverted index for speed
    inv = defaultdict(list)
    for p, v in doc_vec.items():
        for w, x in v.items():
            inv[w].append((p, x))

    agg = defaultdict(float)
    for d, t in items:
        qv = vec(ctx[d])
        s = Counter()
        for w, qx in qv.items():
            for p, dx in inv.get(w, ()):
                s[p] += qx * dx
        ranked = sorted(pool, key=lambda p: -s.get(p, 0.0))
        for k, v in metrics(ranked, t).items():
            agg[k] += v
    n = len(items)
    res = {k: round(v / n, 4) for k, v in agg.items()}
    print(f"--- TF-IDF cosine (n={n}) {res}", flush=True)

    with open("/workspace/03_data/legal_tkgr/lepard_tfidf.json", "w") as f:
        json.dump({"clean": res}, f, ensure_ascii=False, indent=2)


if __name__ == "__main__":
    main()
