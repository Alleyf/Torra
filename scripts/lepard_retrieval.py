#!/usr/bin/env python3
"""RQ1 as RETRIEVAL: precedent retrieval with noise/sparsity robustness.

query  = citing opinion published >= 2014 (no training edges -> unseen entity)
pool   = precedent library (all cited opinions)
truth  = precedents actually quoted
output = ranked Top-K

Methods (same ranker, only scoring changes):
  random        : floor
  popularity    : precedent citation count in the training window (needs no query embedding)
  co_citation   : item-item co-citation similarity from the query's own history
  recency_pop   : popularity weighted by citation recency
  emb_dot       : DistMult over (case, cites, precedent); query case is unseen ->
                  its embedding stays at init, which is exactly the induction test

Robustness: perturb the TRAINING graph, score against the SAME clean truth.
  clean / sparse30 / sparse50 / noisy30
"""
import os
import csv
import gzip
import math
import random
from collections import Counter, defaultdict

import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F

DATA = "/workspace/03_data/legal_tkgr/lepard/lepard_top10k.csv.gz"
CUT_TRAIN = 20131231
CUT_TEST = 20140101
N_QUERY = int(os.environ.get("N_QUERY", "3000"))
TOPK = (10, 50)
DIM = 64
EPOCHS = int(os.environ.get("EPOCHS", "10"))
DEV = "cuda:0" if torch.cuda.is_available() else "cpu"


def pdate(s):
    if not s:
        return None
    try:
        y, m, d = s.split("-")
        return int(y) * 10000 + int(m) * 100 + int(d)
    except Exception:
        return None


def load():
    train_cases = defaultdict(set)
    test_cases = defaultdict(set)
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
            if dd <= CUT_TRAIN:
                train_cases[di].add(si)
            elif dd >= CUT_TEST:
                test_cases[di].add(si)
    return train_cases, test_cases


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
    random.seed(0); np.random.seed(0); torch.manual_seed(0)
    train_cases, test_cases = load()
    pool = sorted({p for s in train_cases.values() for p in s} | {p for s in test_cases.values() for p in s})
    pool_set = set(pool)
    print(f"train_cases={len(train_cases)} test_cases={len(test_cases)} pool={len(pool)}", flush=True)

    tr_edges = [(d, p) for d, ps in train_cases.items() for p in ps]
    te_items = [(d, ps & pool_set) for d, ps in test_cases.items() if ps & pool_set]
    random.shuffle(te_items); te_items = te_items[:N_QUERY]
    print(f"queries={len(te_items)} avg_truth={np.mean([len(p) for _, p in te_items]):.2f}", flush=True)

    ids = {p: i for i, p in enumerate(pool)}
    case_ids = {c: len(pool) + i for i, c in enumerate(train_cases)}
    N = len(pool) + len(case_ids)

    def run(edges, tag):
        pop = Counter(p for _, p in edges)
        case_items = defaultdict(set)
        for d, p in edges:
            case_items[d].add(p)
        co = defaultdict(Counter)
        for items in case_items.values():
            for a in items:
                for b in items:
                    if a != b:
                        co[a][b] += 1
        recency = Counter()
        # build embedding over case+precedent
        E = nn.Embedding(N, DIM).to(DEV)
        nn.init.xavier_uniform_(E.weight)
        opt = torch.optim.Adam(E.parameters(), lr=1e-3)
        pairs = [(case_ids[d], ids[p]) for d, p in edges if d in case_ids and p in ids]
        pt = torch.tensor(pairs, device=DEV)
        for ep in range(EPOCHS):
            perm = torch.randperm(len(pt), device=DEV)
            for i in range(0, len(pt), 2048):
                b = pt[perm[i:i + 2048]]
                s, o = b[:, 0], b[:, 1]
                pos = (E(s) * E(o)).sum(-1)
                neg = torch.randint(0, N, (len(b),), device=DEV)
                nsc = (E(s) * E(neg)).sum(-1)
                loss = -F.logsigmoid(pos).mean() - F.logsigmoid(-nsc).mean()
                opt.zero_grad(); loss.backward(); opt.step()
        Ew = E.weight.detach().cpu().numpy()

        def sc_rand(q): return {p: random.random() for p in pool}
        def sc_pop(q): return {p: pop.get(p, 0) for p in pool}
        def sc_coc(q):
            agg = Counter()
            for p in q:
                for c, v in co.get(p, {}).items():
                    agg[c] += v
            return {p: agg.get(p, 0) for p in pool}
        def sc_emb(q):
            cid = case_ids.get(cur_case[0])
            if cid is None:
                return {p: 0.0 for p in pool}
            v = Ew[cid]
            return {p: float(v @ Ew[ids[p]]) for p in pool}

        methods = {"random": sc_rand, "popularity": sc_pop, "co_citation": sc_coc, "emb_dot": sc_emb}
        agg = {m: defaultdict(float) for m in methods}
        cur_case = [None]
        for d, truth in te_items:
            cur_case[0] = d
            q = train_cases.get(d, set())
            for m, fn in methods.items():
                sc = fn(q)
                ranked = sorted(pool, key=lambda p: -sc[p])
                mm = metrics(ranked, truth)
                for k, v in mm.items():
                    agg[m][k] += v
        n = len(te_items)
        res = {m: {k: round(v / n, 4) for k, v in agg[m].items()} for m in methods}
        print(f"--- {tag} (n={n}, edges={len(edges)})", flush=True)
        for m in methods:
            print(f"    {m:12s} {res[m]}", flush=True)
        return res

    out = {}
    rng = random.Random(7)
    for mode in ["clean", "sparse30", "sparse50", "noisy30"]:
        out[mode] = run(perturb(tr_edges, mode, rng), mode)

    import json
    with open("/workspace/03_data/legal_tkgr/lepard_retrieval.json", "w") as f:
        json.dump(out, f, ensure_ascii=False, indent=2)


if __name__ == "__main__":
    main()
