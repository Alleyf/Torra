#!/usr/bin/env python3
"""RQ1 BM25 baseline over LePaRD passage texts.

Query  : destination_context of a test row (the citing opinion's surrounding text)
Pool   : the precedent passage library (passage_dict.json, id -> text)
Truth  : precedents actually quoted by that citing case

BM25 is LePaRD's original main task, so this number is the real bar any
graph/embedding method must clear.

Also reports the same four perturbations as lepard_retrieval.py so the
robustness column is comparable.
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
        self.k1 = k1
        self.b = b
        self.ids = list(docs)
        self.tf = {}
        self.dl = {}
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
        # inverted index
        self.inv = defaultdict(list)
        for i, c in self.tf.items():
            for w in c:
                self.inv[w].append(i)

    def score(self, query):
        q = tok(query)
        s = Counter()
        for w in q:
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


def perturb(edges, mode, rng):
    if mode == "clean":
        return edges
    if mode.startswith("sparse"):
        frac = int(mode.replace("sparse", "")) / 100.0
        return [e for e in edges if rng.random() > frac]
    if mode.startswith("noisy"):
        frac = int(mode.replace("noisy", "")) / 100.0
        allp = sorted({p for _, p in edges})
        return [(d, rng.choice(allp) if rng.random() < frac else p) for d, p in edges]
    return edges


def main():
    random.seed(0)
    print("loading passages ...", flush=True)
    blob = json.load(open(PASSAGES))
    passages = blob["data"]
    print(f"passages={len(passages)}", flush=True)

    # test queries + their truth, plus per-case query text
    ctx = defaultdict(str)
    truth = defaultdict(set)
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
                if len(ctx[di]) < 400:
                    ctx[di] = (ctx[di] + " " + row[12])[:800]

    pool = [p for p in passages if p in {q for s in truth.values() for q in s} or True]
    # restrict to passages that actually appear in the data (keeps pool realistic)
    used = {p for s in truth.values() for p in s}
    pool = [p for p in used if p in passages]
    print(f"queries={len(truth)} pool={len(pool)}", flush=True)

    items = [(d, truth[d] & set(pool)) for d in truth if truth[d] & set(pool)]
    random.shuffle(items)
    items = items[:N_QUERY]
    print(f"eval queries={len(items)} avg_truth={sum(len(t) for _,t in items)/max(len(items),1):.2f}", flush=True)

    bm = BM25({p: passages[p] for p in pool})

    def run(tag):
        agg = defaultdict(float)
        for d, t in items:
            sc = bm.score(ctx[d])
            ranked = sorted(pool, key=lambda p: -sc.get(p, 0.0))
            for k, v in metrics(ranked, t).items():
                agg[k] += v
        n = len(items)
        res = {k: round(v / n, 4) for k, v in agg.items()}
        print(f"--- BM25 {tag} (n={n}) {res}", flush=True)
        return res

    out = {"clean": run("clean")}
    # perturbations do not change BM25 (it uses text, not the citation graph).
    # Document that explicitly rather than fabricating differences.
    print("note: BM25 reads passage text only; graph perturbations (sparse/noisy) do not affect it.", flush=True)

    with open("/workspace/03_data/legal_tkgr/lepard_bm25.json", "w") as f:
        json.dump(out, f, ensure_ascii=False, indent=2)


if __name__ == "__main__":
    main()
