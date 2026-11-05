#!/usr/bin/env python3
"""RQ3: cross-graph inductive transfer (DBLP -> MAG-History / MAG-Geology).

FIXED after audit: the earlier run computed a 10% subset but trained on the
FULL target edges, so its "few-shot" label was wrong. This version trains on
what it says.

Settings per target graph (all evaluated against the SAME full-train adjacency
for structural baselines, so AA/CN are never artificially weakened):
  zero-shot    : source weights, empty target memory, no target training
  few-shot 10% : source weights, memory updated on 10% of target edges
  few-shot 30% : source weights, memory updated on 30% of target edges
  full-init    : source weights, memory updated on ALL target edges
  retrain      : target-only training from scratch on ALL edges (upper bound)

Task: future collaboration, target split train<=2010 / test>=2016,
200 random distractors, 1 positive per query.
"""
import os
import math
import random
from collections import defaultdict

import numpy as np
import torch
import torch.nn as nn

ROOT = "/workspace/03_data/research_tkgr"
D = 64
TD = 16
DEV = "cuda:0" if torch.cuda.is_available() else "cpu"
BATCH = 4096
EPOCHS_SRC = int(os.environ.get("EPOCHS_SRC", "3"))
EPOCHS_TGT = int(os.environ.get("EPOCHS_TGT", "3"))
N_QUERY = int(os.environ.get("N_QUERY", "3000"))
K = int(os.environ.get("K", "200"))


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


def load_simplices(base, name):
    times, nverts, ids = [], [], []
    with open(f"{base}/{name}/{name}-times.txt") as f:
        times = [int(l) for l in f]
    with open(f"{base}/{name}/{name}-nverts.txt") as f:
        nverts = [int(l) for l in f]
    with open(f"{base}/{name}/{name}-simplices.txt") as f:
        ids = [int(l) for l in f]
    papers, p = [], 0
    for t, nv in zip(times, nverts):
        papers.append((t, ids[p:p + nv])); p += nv
    return papers


def to_edges(papers, max_auth=15):
    edges = set()
    for t, auth in papers:
        if len(auth) < 2 or len(auth) > max_auth:
            continue
        a = sorted(auth)
        for i in range(len(a)):
            for j in range(i + 1, len(a)):
                edges.add((a[i], a[j], t))
    return edges


def train_tgn(train_edges, node_space_edges, model=None, epochs=3, lr=3e-3, tag=""):
    """Train on train_edges but build the node/adjacency space from node_space_edges."""
    train_edges = sorted(train_edges, key=lambda x: x[2])
    ids = {}
    for a, b, t in node_space_edges:
        ids.setdefault(a, len(ids)); ids.setdefault(b, len(ids))
    adj = defaultdict(set)
    for a, b, t in node_space_edges:
        adj[a].add(b); adj[b].add(a)
    N = len(ids)
    if model is None:
        model = TGNLite(N, D, TD).to(DEV)
    else:
        old = model
        model = TGNLite(N, D, TD).to(DEV)
        for attr in ("msg", "gru", "sc", "te"):
            getattr(model, attr).load_state_dict(getattr(old, attr).state_dict())
    opt = torch.optim.Adam(model.parameters(), lr=lr)
    idx = torch.tensor([(ids[a], ids[b], t) for a, b, t in train_edges if a in ids and b in ids],
                       device=DEV)
    if len(idx) == 0:
        return model, ids, adj
    for ep in range(epochs):
        model.train(); model.mem.zero_()
        tot = nb = 0; psum = 0.0
        for i in range(0, len(idx), BATCH):
            b = idx[i:i + BATCH]
            u, v, t = b[:, 0], b[:, 1], b[:, 2]
            mu, mv = model.mem[u], model.mem[v]
            m = model.msg(torch.cat([mu, mv, model.te(t)], -1))
            pos = model.score(mu, mv)
            neg = torch.randint(0, N, (len(b),), device=DEV)
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
            tot += loss.item(); nb += 1; psum += float(pos.mean())
        print(f"    [{tag}] ep {ep+1}/{epochs} loss {tot/max(nb,1):.4f} pos {psum/max(nb,1):.4f}", flush=True)
    return model, ids, adj


def evaluate(model, ids, adj, test_edges, tag):
    model.eval(); mem = model.mem.detach(); nodes = list(ids)
    deg = {u: len(v) for u, v in adj.items()}

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
    pos = [(a, b) for a, b, t in test_edges if a in ids and b in ids and a != b]
    random.shuffle(pos); pos = pos[:N_QUERY]
    res = {m: {"mrr": 0.0, "h1": 0, "h10": 0} for m in methods}
    n = 0
    for a, b in pos:
        rng = random.Random(hash((a, b)) & 0xffffffff)
        cand = [x for x in rng.sample(nodes, min(len(nodes), 4000)) if x != a and x != b and x not in adj[a]]
        cand = rng.sample(cand, min(K, len(cand))) + [b]
        n += 1
        for m, fn in methods.items():
            sc = fn(a, set(cand))
            ranked = sorted(cand, key=lambda x: -sc[x])
            rk = ranked.index(b) + 1
            res[m]["mrr"] += 1.0 / rk
            res[m]["h1"] += 1 if rk <= 1 else 0
            res[m]["h10"] += 1 if rk <= 10 else 0
    out = {m: {"MRR": round(res[m]["mrr"]/max(n,1), 4), "H@1": round(res[m]["h1"]/max(n,1), 4),
               "H@10": round(res[m]["h10"]/max(n,1), 4)} for m in methods}
    print(f"--- {tag} (n={n})", flush=True)
    for m in methods:
        print(f"    {m:17s} {out[m]}", flush=True)
    return out


def main():
    random.seed(0); np.random.seed(0); torch.manual_seed(0)
    print("=== loading source DBLP ===", flush=True)
    dblp = to_edges(load_simplices(f"{ROOT}/coauth", "coauth-DBLP"))
    dblp_tr = {e for e in dblp if e[2] <= 2010}
    print(f"DBLP train edges={len(dblp_tr)}", flush=True)
    src_model, _, _ = train_tgn(dblp_tr, dblp_tr, epochs=EPOCHS_SRC, tag="src")
    print("source model trained", flush=True)

    out = {}
    for name in ["coauth-MAG-History", "coauth-MAG-Geology"]:
        print(f"\n=== target {name} ===", flush=True)
        papers = load_simplices(f"{ROOT}/mag", name)
        edges = to_edges(papers)
        tr = {e for e in edges if e[2] <= 2010}
        te = {e for e in edges if e[2] >= 2016}
        print(f"edges={len(edges)} train={len(tr)} test={len(te)}", flush=True)
        if not tr or not te:
            print("  insufficient split, skipped", flush=True); continue
        trl = sorted(tr, key=lambda x: x[2])

        # zero-shot: source weights, empty memory, no target training
        m0, ids0, adj0 = train_tgn([], trl, model=src_model, epochs=0, tag="zero")
        out[f"{name}/zero-shot"] = evaluate(m0, ids0, adj0, te, f"{name} zero-shot")

        rng = random.Random(1)
        for frac in (0.1, 0.3):
            sub = [e for e in trl if rng.random() < frac]
            m, ids_, adj_ = train_tgn(sub, trl, model=src_model, epochs=EPOCHS_TGT, lr=1e-3,
                                     tag=f"few{int(frac*100)}")
            out[f"{name}/few-shot({int(frac*100)}%)"] = evaluate(
                m, ids_, adj_, te, f"{name} few-shot {int(frac*100)}% ({len(sub)} edges)")

        # full-init: source weights + ALL target edges (what the buggy run actually did)
        m2, ids2, adj2 = train_tgn(trl, trl, model=src_model, epochs=EPOCHS_TGT, lr=1e-3, tag="fullinit")
        out[f"{name}/full-init"] = evaluate(m2, ids2, adj2, te, f"{name} full-init (source init, all edges)")

        # retrain: from scratch, all edges
        m3, ids3, adj3 = train_tgn(trl, trl, model=None, epochs=EPOCHS_TGT, tag="retrain")
        out[f"{name}/retrain"] = evaluate(m3, ids3, adj3, te, f"{name} retrain (target-only)")

    import json
    with open(f"{ROOT}/cross_graph_result_v2.json", "w") as f:
        json.dump(out, f, ensure_ascii=False, indent=2)


if __name__ == "__main__":
    main()
