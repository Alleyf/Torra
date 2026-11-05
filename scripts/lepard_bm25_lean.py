#!/usr/bin/env python3
"""RQ1 BM25 baseline over LePaRD passage texts (memory-lean).

Key change vs the first attempt: we index ONLY the passage pool that the
evaluation actually scores against (the precedents cited by test-window cases),
not all 3.97M passages. Same protocol as lepard_retrieval.py, so the numbers are
directly comparable to popularity / co_citation / embedding.

Query : destination_context of a test row (text preceding the quotation)
Pool  : precedents cited by test-window cases (same pool as the graph run)
Truth : precedents actually quoted by that citing case
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
CUT_TRAIN = 20131231
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


class BM25:
    def __init__(self, docs, k1=1.5, b=0.75):
        self.k1, self.b = k1, b
        self.ids = list(docs)
        self.tf, self.dl = {}, {}
        df = Counter()
        for i in self.ids:
            t = tok(docs[i])
            self.dl[i] = len(t)
            c = Counter(t)
            self.tf[i] = c
            for w in c:
                df[w] += 1
        self.N = len(self.ids)
        self.avgdl = sum(self.dl.values()) / max(self.N, 1)
        self.idf = {w: math.log(1 + (self.N - d + 0.5) / (d + 0.5)) for w, d in df.items()}
        self.inv = defaultdict(list)
        for i, c in self.tf.items():
            for w in c:
                self.inv[w].append(i)

    def score(self, query):
        s = Counter()
        for w in tok(query):
            if w not in self.idf:
                continue
            idf = self.idf[w]
            for i in self.inv[w]:
                f = self.tf[i][w]
                denom = f + self.k1 * (1 - self.b + self.b * self.dl[i] / self.avgdl)
                s[i] += idf * (f * (self.k1 + 1)) / denom
        return s


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
    print("pass 1: collect test queries + cited precedent ids ...", flush=True)
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
    print(f"test cases={len(truth)} needed precedents={len(needed)}", flush=True)

    print("pass 2: aggregate passage texts by precedent id ...", flush=True)
    # passage_dict keys are passage_id ("11781059_7"); the pool is precedent id
    # (source_id). Aggregate every passage whose prefix matches a needed precedent.
    docs = {}
    blob = json.load(open(PASSAGES))
    data = blob["data"]
    for k, v in data.items():
        pref = k.split("_", 1)[0]
        if pref in needed:
            docs[pref] = (docs.get(pref, "") + " " + (v or ""))[:6000]
    del blob, data
    miss = len(needed) - len(docs)
    print(f"pool={len(docs)} missing_text={miss}", flush=True)
    if not docs:
        print("ERROR: no passage text available", flush=True)
        return

    pool = list(docs)
    items = [(d, truth[d] & set(pool)) for d in truth if truth[d] & set(pool)]
    random.shuffle(items)
    items = items[:N_QUERY]
    print(f"eval queries={len(items)} avg_truth={sum(len(t) for _,t in items)/max(len(items),1):.2f}", flush=True)

    bm = BM25(docs)
    print("bm25 index built", flush=True)

    agg = defaultdict(float)
    for d, t in items:
        sc = bm.score(ctx[d])
        ranked = sorted(pool, key=lambda p: -sc.get(p, 0.0))
        for k, v in metrics(ranked, t).items():
            agg[k] += v
    n = len(items)
    res = {k: round(v / n, 4) for k, v in agg.items()}
    print(f"--- BM25 clean (n={n}) {res}", flush=True)
    print("note: BM25 reads passage text only; citation-graph perturbations do not affect it.", flush=True)

    with open("/workspace/03_data/legal_tkgr/lepard_bm25.json", "w") as f:
        json.dump({"clean": res}, f, ensure_ascii=False, indent=2)


if __name__ == "__main__":
    main()
