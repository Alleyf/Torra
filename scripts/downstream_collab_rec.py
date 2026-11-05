#!/usr/bin/env python3
"""Downstream task: collaborator recommendation on coauth-DBLP.

Design (follows the thesis plan):
  cutoff t=2010 : graph built ONLY from collaborations <= 2010 (no leakage)
  test window   : new collaborations 2016-2018
  candidates    : 2-hop neighbourhood in the train graph, EXCLUDING existing
                  collaborators -> every recommended pair is a *novel* pair
  positives     : test-window collaborators that appear in the candidate set

  The SAME ranker (score sort + top-K) is used for every method; only the
  scoring function changes. That isolates the contribution of the graph signal.

Methods
  random            : uniform
  popularity        : train degree of candidate
  common_neighbors  : |N(u) ∩ N(v)|
  adamic_adar       : sum 1/log(deg(w)) over common neighbours
  emb_dot           : DistMult dot product (static embedding trained on train edges)

Metrics: Recall@10/50, NDCG@10, MRR (over positives), coverage.
"""
import os
import random
import math
import time
from collections import defaultdict, Counter

import numpy as np
import torch
import torch.nn as nn

BASE = "/workspace/03_data/research_tkgr/coauth_cites"
N_USERS = int(os.environ.get("N_USERS", "2000"))
MAX_CAND = int(os.environ.get("MAX_CAND", "800"))
EPOCHS = int(os.environ.get("EPOCHS", "3"))
DIM = 64
DEV = "cuda:1" if torch.cuda.is_available() else "cpu"


def load(p):
    rows = []
    for line in open(p, encoding="utf-8"):
        q = line.rstrip("\n").split("\t")
        if len(q) >= 4:
            a = int(q[0][2:]); b = int(q[2][2:])
            rows.append((a, b))
    return rows


def main():
    random.seed(0); np.random.seed(0); torch.manual_seed(0)
    tr = load(f"{BASE}/train.tsv")
    te = load(f"{BASE}/test.tsv")
    print(f"train edges={len(tr)} test edges={len(te)}", flush=True)

    adj = defaultdict(set)
    for a, b in tr:
        adj[a].add(b); adj[b].add(a)
    deg = {u: len(v) for u, v in adj.items()}
    print(f"nodes with edges={len(adj)}", flush=True)

    # test positives per author
    pos = defaultdict(set)
    for a, b in te:
        pos[a].add(b); pos[b].add(a)

    # sample evaluation users: have new links and >=1 reachable positive
    rng = random.Random(0)
    users = [u for u in pos if u in adj]
    rng.shuffle(users)
    evals = []
    for u in users:
        if len(evals) >= N_USERS:
            break
        cand = set()
        for w in adj[u]:
            cand |= adj[w]
        cand.discard(u)
        cand -= adj[u]
        if not cand:
            continue
        p = pos[u] & cand
        if not p:
            continue
        if len(cand) > MAX_CAND:
            cand = set(rng.sample(sorted(cand), MAX_CAND))
            p = pos[u] & cand
            if not p:
                continue
        evals.append((u, cand, p))
    print(f"eval users={len(evals)} avg_cand={np.mean([len(c) for _,c,_ in evals]):.1f} "
          f"avg_pos={np.mean([len(p) for _,_,p in evals]):.1f}", flush=True)

    # ---- static embedding (DistMult on train edges) ----
    ids = {u: i for i, u in enumerate(adj)}
    N = len(ids)
    E = nn.Embedding(N, DIM).to(DEV)
    nn.init.xavier_uniform_(E.weight)
    opt = torch.optim.Adam(E.parameters(), lr=2e-2)
    trt = torch.tensor([(ids[a], ids[b]) for a, b in tr if a in ids and b in ids], device=DEV)
    print(f"embedding: N={N} edges={len(trt)} dev={DEV}", flush=True)
    t0 = time.time()
    for ep in range(EPOCHS):
        perm = torch.randperm(len(trt), device=DEV)
        tot = 0.0; nb = 0
        for i in range(0, len(trt), 4096):
            b = trt[perm[i:i + 4096]]
            s, o = b[:, 0], b[:, 1]
            pos_s = (E(s) * E(o)).sum(-1)
            neg = torch.randint(0, N, (len(b) * 2,), device=DEV)
            ss = s.repeat_interleave(2)
            neg_s = (E(ss) * E(neg)).sum(-1)
            loss = -torch.nn.functional.logsigmoid(pos_s).mean() - torch.nn.functional.logsigmoid(-neg_s).mean()
            opt.zero_grad(); loss.backward(); opt.step()
            tot += loss.item(); nb += 1
        print(f"  ep {ep+1}/{EPOCHS} loss {tot/max(nb,1):.4f}", flush=True)
    Ew = E.weight.detach().cpu().numpy()
    print(f"  embedding trained in {time.time()-t0:.0f}s", flush=True)

    def score_random(u, cand):
        return {v: rng.random() for v in cand}
    def score_pop(u, cand):
        return {v: deg.get(v, 0) for v in cand}
    def score_cn(u, cand):
        nu = adj[u]
        return {v: len(nu & adj[v]) for v in cand}
    def score_aa(u, cand):
        nu = adj[u]
        out = {}
        for v in cand:
            s = 0.0
            for w in (nu & adj[v]):
                d = deg.get(w, 0)
                if d > 1:
                    s += 1.0 / math.log(d)
            out[v] = s
        return out
    def score_emb(u, cand):
        if u not in ids:
            return {v: 0.0 for v in cand}
        eu = Ew[ids[u]]
        return {v: float(eu @ Ew[ids[v]]) if v in ids else -1e9 for v in cand}

    methods = {"random": score_random, "popularity": score_pop, "common_neighbors": score_cn,
               "adamic_adar": score_aa, "emb_dot": score_emb}

    def ndcg(ranked, positives, k):
        dcg = 0.0
        for i, v in enumerate(ranked[:k]):
            if v in positives:
                dcg += 1.0 / math.log2(i + 2)
        ideal = sum(1.0 / math.log2(i + 2) for i in range(min(len(positives), k)))
        return dcg / ideal if ideal > 0 else 0.0

    results = {}
    for name, fn in methods.items():
        R10 = R50 = 0.0; N10 = 0.0; mrr = 0.0; covered = set()
        for u, cand, p in evals:
            sc = fn(u, cand)
            ranked = sorted(cand, key=lambda v: -sc[v])
            covered.update(ranked[:50])
            R10 += len(set(ranked[:10]) & p) / len(p)
            R50 += len(set(ranked[:50]) & p) / len(p)
            N10 += ndcg(ranked, p, 10)
            first = next((i for i, v in enumerate(ranked) if v in p), None)
            mrr += (1.0 / (first + 1)) if first is not None else 0.0
        n = len(evals)
        results[name] = {"Recall@10": round(R10/n, 4), "Recall@50": round(R50/n, 4),
                         "NDCG@10": round(N10/n, 4), "MRR": round(mrr/n, 4),
                         "coverage@50": round(len(covered)/max(len(adj),1), 4)}
        print(name, results[name], flush=True)

    print("\n=== SUMMARY (novel pairs only, no temporal leakage) ===")
    for k, v in results.items():
        print(f"{k:18s} R@10={v['Recall@10']:.4f} R@50={v['Recall@50']:.4f} "
              f"NDCG@10={v['NDCG@10']:.4f} MRR={v['MRR']:.4f}")


if __name__ == "__main__":
    main()
