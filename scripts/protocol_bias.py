#!/usr/bin/env python3
"""Protocol-bias test: same models, same ranker, only the CANDIDATE SET changes.

Two candidate sets, both of size 201 (1 true positive + 200 distractors):
  hop2  : distractors sampled from u's 2-hop neighbourhood (current protocol)
  rand  : distractors sampled uniformly from all authors (OGB-style)
  mixed : 100 from 2-hop + 100 random

If Adamic-Adar's lead over popularity/embedding vanishes under `rand`, the
earlier negative result was a property of the candidate construction, not of
the domain.

Methods: popularity, common_neighbors, adamic_adar, static DistMult dot.
"""
import os
import math
import random
from collections import defaultdict

import numpy as np
import torch
import torch.nn as nn

BASE = "/workspace/03_data/research_tkgr/coauth_cites"
N_POS = int(os.environ.get("N_POS", "3000"))
K = int(os.environ.get("K", "200"))
DIM = 64
EPOCHS = int(os.environ.get("EPOCHS", "3"))
DEV = "cuda:0" if torch.cuda.is_available() else "cpu"


def load(p):
    rows = []
    for line in open(p, encoding="utf-8"):
        q = line.rstrip("\n").split("\t")
        if len(q) >= 4:
            rows.append((int(q[0][2:]), int(q[2][2:])))
    return rows


def main():
    random.seed(0); np.random.seed(0); torch.manual_seed(0)
    tr = load(f"{BASE}/train.tsv")
    te = load(f"{BASE}/test.tsv")
    adj = defaultdict(set)
    for a, b in tr:
        adj[a].add(b); adj[b].add(a)
    nodes = list(adj)
    deg = {u: len(v) for u, v in adj.items()}
    print(f"train_edges={len(tr)} nodes={len(nodes)} test_edges={len(te)}", flush=True)

    # embedding
    ids = {u: i for i, u in enumerate(nodes)}
    N = len(ids)
    E = nn.Embedding(N, DIM).to(DEV)
    nn.init.xavier_uniform_(E.weight)
    opt = torch.optim.Adam(E.parameters(), lr=2e-2)
    trt = torch.tensor([(ids[a], ids[b]) for a, b in tr], device=DEV)
    for ep in range(EPOCHS):
        perm = torch.randperm(len(trt), device=DEV)
        for i in range(0, len(trt), 8192):
            b = trt[perm[i:i + 8192]]
            s, o = b[:, 0], b[:, 1]
            pos = (E(s) * E(o)).sum(-1)
            neg = torch.randint(0, N, (len(b) * 2,), device=DEV)
            ss = s.repeat_interleave(2)
            negs = (E(ss) * E(neg)).sum(-1)
            loss = -torch.nn.functional.logsigmoid(pos).mean() - torch.nn.functional.logsigmoid(-negs).mean()
            opt.zero_grad(); loss.backward(); opt.step()
        print(f"  emb ep {ep+1}/{EPOCHS}", flush=True)
    Ew = E.weight.detach().cpu().numpy()

    # positives: test pairs whose two ends are both in train graph
    pos_pairs = [(a, b) for a, b in te if a in adj and b in adj and a != b]
    random.shuffle(pos_pairs)
    pos_pairs = pos_pairs[:N_POS]
    print(f"positives used={len(pos_pairs)}", flush=True)

    def sc_pop(u, cand): return {v: deg.get(v, 0) for v in cand}
    def sc_cn(u, cand):
        nu = adj[u]; return {v: len(nu & adj[v]) for v in cand}
    def sc_aa(u, cand):
        nu = adj[u]; out = {}
        for v in cand:
            s = 0.0
            for w in (nu & adj[v]):
                d = deg.get(w, 0)
                if d > 1: s += 1.0 / math.log(d)
            out[v] = s
        return out
    def sc_emb(u, cand):
        if u not in ids: return {v: 0.0 for v in cand}
        eu = Ew[ids[u]]
        return {v: float(eu @ Ew[ids[v]]) if v in ids else -1e9 for v in cand}
    methods = {"popularity": sc_pop, "common_neighbors": sc_cn,
               "adamic_adar": sc_aa, "emb_dot": sc_emb}

    def build_cands(u, v, mode, rng):
        two = set()
        for w in adj[u]:
            two |= adj[w]
        two.discard(u); two -= adj[u]; two.discard(v)
        two.discard(v)
        two = [x for x in two if x != v]
        rnd = [x for x in rng.sample(nodes, min(len(nodes), 4000)) if x != u and x != v and x not in adj[u]]
        if mode == "hop2":
            pick = rng.sample(two, min(K, len(two))) if two else []
        elif mode == "rand":
            pick = rng.sample(rnd, min(K, len(rnd)))
        else:  # mixed
            pick = (rng.sample(two, min(K // 2, len(two))) if two else []) + rng.sample(rnd, min(K // 2, len(rnd)))
        cand = set(pick) | {v}
        return cand

    print(f"\n=== Protocol bias: {K} distractors, {len(pos_pairs)} positives ===")
    out = {}
    for mode in ["hop2", "rand", "mixed"]:
        res = {m: {"mrr": 0.0, "h1": 0, "h10": 0} for m in methods}
        n = 0
        for a, b in pos_pairs:
            rng = random.Random(hash((a, b)) & 0xffffffff)
            cand = build_cands(a, b, mode, rng)
            if b not in cand:
                continue
            n += 1
            for m, fn in methods.items():
                sc = fn(a, cand)
                ranked = sorted(cand, key=lambda x: -sc[x])
                rk = ranked.index(b) + 1
                res[m]["mrr"] += 1.0 / rk
                res[m]["h1"] += 1 if rk <= 1 else 0
                res[m]["h10"] += 1 if rk <= 10 else 0
        row = {}
        for m in methods:
            row[m] = {"MRR": round(res[m]["mrr"] / n, 4),
                      "H@1": round(res[m]["h1"] / n, 4),
                      "H@10": round(res[m]["h10"] / n, 4)}
        out[mode] = row
        print(f"--- {mode} (n={n})")
        for m in methods:
            print(f"    {m:17s} MRR={row[m]['MRR']:.4f} H@1={row[m]['H@1']:.4f} H@10={row[m]['H@10']:.4f}", flush=True)

    import json
    with open("/workspace/03_data/research_tkgr/protocol_bias.json", "w") as f:
        json.dump(out, f, ensure_ascii=False, indent=2)


if __name__ == "__main__":
    main()
