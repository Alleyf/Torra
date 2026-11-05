#!/usr/bin/env python3
"""TGN-lite vs structural baselines (coauth), plus a zero-common-neighbour niche test.

Protocols (both 200 distractors, 1 true positive):
  hop2 : distractors from u's 2-hop neighbourhood
  rand : uniformly random distractors
Niche: positives with ZERO common neighbours -- the only regime where CN/AA are
blind, so a learned temporal model could in principle win.
"""
import os
import math
import random
from collections import defaultdict

import numpy as np
import torch
import torch.nn as nn

BASE = "/workspace/03_data/research_tkgr/coauth_cites"
N_POS = int(os.environ.get("N_POS", "2000"))
K = int(os.environ.get("K", "200"))
EPOCHS = int(os.environ.get("EPOCHS", "6"))
D = 64
TD = 16
BATCH = 2048
DEV = "cuda:0" if torch.cuda.is_available() else "cpu"


def load_edges(p):
    rows = []
    for line in open(p, encoding="utf-8"):
        q = line.rstrip("\n").split("\t")
        if len(q) >= 4:
            rows.append((int(q[0][2:]), int(q[2][2:]), int(q[3])))
    return rows


class TimeEnc(nn.Module):
    def __init__(self, dim):
        super().__init__()
        self.w = nn.Parameter(torch.randn(dim // 2) * 0.1)

    def forward(self, t):
        x = ((t.float() - 1930.0) / 100.0).unsqueeze(-1)
        return torch.cat([torch.sin(x * self.w), torch.cos(x * self.w)], dim=-1)


class TGNLite(nn.Module):
    def __init__(self, n, d, td):
        super().__init__()
        self.te = TimeEnc(td)
        self.msg = nn.Sequential(nn.Linear(2 * d + td, 2 * d), nn.ReLU(), nn.Linear(2 * d, d))
        self.gru = nn.GRUCell(d, d)
        self.sc = nn.Sequential(nn.Linear(2 * d, d), nn.ReLU(), nn.Linear(d, 1))
        self.register_buffer("mem", torch.zeros(n, d))

    def score(self, mu, mv):
        return self.sc(torch.cat([mu, mv], -1)).squeeze(-1)


def main():
    random.seed(0); np.random.seed(0); torch.manual_seed(0)
    tr = load_edges(f"{BASE}/train.tsv")
    te = load_edges(f"{BASE}/test.tsv")
    tr.sort(key=lambda x: x[2])
    ids = {}
    for a, b, t in tr:
        ids.setdefault(a, len(ids)); ids.setdefault(b, len(ids))
    adj = defaultdict(set)
    for a, b, t in tr:
        adj[a].add(b); adj[b].add(a)
    deg = {u: len(v) for u, v in adj.items()}
    N = len(ids)
    print(f"train={len(tr)} test={len(te)} nodes={N} dev={DEV}", flush=True)

    model = TGNLite(N, D, TD).to(DEV)
    opt = torch.optim.Adam(model.parameters(), lr=3e-3)
    idx = torch.tensor([(ids[a], ids[b], t) for a, b, t in tr], device=DEV)

    for ep in range(EPOCHS):
        model.train(); model.mem.zero_()
        tot = psum = nsum = 0.0; nb = 0
        for i in range(0, len(idx), BATCH):
            b = idx[i:i + BATCH]
            u = b[:, 0]; v = b[:, 1]; t = b[:, 2]
            mu = model.mem[u]; mv = model.mem[v]
            m = model.msg(torch.cat([mu, mv, model.te(t)], -1))
            pos = model.score(mu, mv)
            neg = torch.randint(0, N, (len(b),), device=DEV)
            hard = torch.rand(len(b), device=DEV) < 0.5
            if hard.any():
                hn = []
                for x in u[hard].tolist():
                    nx = list(adj.get(x, ()))
                    if nx:
                        w = random.choice(nx)
                        cands = [y for y in adj.get(w, ()) if y not in adj.get(x, ())] or list(adj.get(w, ()))
                        hn.append(ids.get(random.choice(cands), random.randint(0, N - 1)))
                    else:
                        hn.append(random.randint(0, N - 1))
                neg[hard] = torch.tensor(hn, device=DEV)
            npos = model.score(mu, model.mem[neg])
            loss = (torch.nn.functional.binary_cross_entropy_with_logits(pos, torch.ones_like(pos))
                    + torch.nn.functional.binary_cross_entropy_with_logits(npos, torch.zeros_like(npos)))
            opt.zero_grad(); loss.backward(); opt.step()
            with torch.no_grad():
                U = torch.cat([u, v]); M = torch.cat([m, m])
                uniq, inv = torch.unique(U, return_inverse=True)
                agg = torch.zeros(len(uniq), D, device=DEV).index_add_(0, inv, M)
                cnt = torch.zeros(len(uniq), device=DEV).index_add_(0, inv, torch.ones_like(inv, dtype=torch.float))
                model.mem[uniq] = model.gru(agg / cnt.unsqueeze(-1), model.mem[uniq])
            tot += loss.item(); psum += float(pos.mean()); nsum += float(npos.mean()); nb += 1
        print(f"  ep {ep+1}/{EPOCHS} loss {tot/max(nb,1):.4f} pos {psum/max(nb,1):.4f} neg {nsum/max(nb,1):.4f}", flush=True)

    model.eval(); mem = model.mem.detach(); nodes = list(ids)

    def sc_pop(u, cand): return {x: deg.get(x, 0) for x in cand}
    def sc_cn(u, cand):
        nu = adj[u]; return {x: len(nu & adj[x]) for x in cand}
    def sc_aa(u, cand):
        nu = adj[u]; out = {}
        for x in cand:
            s = 0.0
            for w in (nu & adj[x]):
                dd = deg.get(w, 0)
                if dd > 1: s += 1.0 / math.log(dd)
            out[x] = s
        return out
    def sc_tgn(u, cand):
        ui = ids.get(u)
        if ui is None: return {x: 0.0 for x in cand}
        with torch.no_grad():
            mu = mem[ui].expand(len(cand), D)
            cid = torch.tensor([ids[x] for x in cand], device=DEV)
            s = model.score(mu, mem[cid]).cpu().numpy()
        return {x: float(s[i]) for i, x in enumerate(cand)}

    methods = {"popularity": sc_pop, "common_neighbors": sc_cn, "adamic_adar": sc_aa, "tgn": sc_tgn}
    pos_pairs = [(a, b) for a, b, t in te if a in ids and b in ids and a != b]
    random.shuffle(pos_pairs); pos_pairs = pos_pairs[:N_POS]

    def build(u, v, mode, rng):
        two = set()
        for w in adj[u]:
            two |= adj[w]
        two.discard(u); two -= adj[u]; two.discard(v)
        two = [x for x in two if x in ids and x != v]
        rnd = [x for x in rng.sample(nodes, min(len(nodes), 4000)) if x != u and x != v and x not in adj[u]]
        pick = rng.sample(two, min(K, len(two))) if mode == "hop2" and two else rng.sample(rnd, min(K, len(rnd)))
        return set(pick) | {v}

    def run(pairs, mode):
        res = {m: {"mrr": 0.0, "h1": 0, "h10": 0} for m in methods}
        n = 0
        for a, b in pairs:
            rng = random.Random(hash((a, b)) & 0xffffffff)
            cand = build(a, b, mode, rng)
            if b not in cand: continue
            n += 1
            for m, fn in methods.items():
                sc = fn(a, cand)
                ranked = sorted(cand, key=lambda x: -sc[x])
                rk = ranked.index(b) + 1
                res[m]["mrr"] += 1.0 / rk
                res[m]["h1"] += 1 if rk <= 1 else 0
                res[m]["h10"] += 1 if rk <= 10 else 0
        return {m: {"MRR": round(res[m]["mrr"]/max(n,1), 4), "H@1": round(res[m]["h1"]/max(n,1), 4),
                    "H@10": round(res[m]["h10"]/max(n,1), 4)} for m in methods}, n

    out = {}
    for mode in ["hop2", "rand"]:
        row, n = run(pos_pairs, mode)
        out[mode] = row
        print(f"--- {mode} (n={n})")
        for m in methods:
            print(f"    {m:17s} {row[m]}", flush=True)

    cold = [(a, b) for a, b in pos_pairs if not (adj[a] & adj[b])]
    row, n = run(cold, "rand")
    out["niche_zero_cn"] = row
    print(f"--- niche zero-common-neighbour + random candidates (n={n})")
    for m in methods:
        print(f"    {m:17s} {row[m]}", flush=True)

    import json
    with open("/workspace/03_data/research_tkgr/tgn_result_final.json", "w") as f:
        json.dump(out, f, ensure_ascii=False, indent=2)


if __name__ == "__main__":
    main()
