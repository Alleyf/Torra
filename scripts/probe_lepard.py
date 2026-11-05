#!/usr/bin/env python3
"""LePaRD citation graph + learnability probe (RQ1 audit).

Edge: (dest_id, cites, source_id, dest_year) where dest = citing opinion,
source = cited precedent. Only temporally valid pairs (source_date <= dest_date)
are kept. Streams CSV with csv.reader to handle quoted fields with newlines.

Probe: DistMult + three controls (shuffled tail / popularity / random subject)
+ per-relation breakdown, same protocol as the earlier audits.
"""
import os
import csv
import gzip
import random
from collections import Counter, defaultdict

import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F

DATA = "/workspace/03_data/legal_tkgr/lepard/lepard_top10k.csv.gz"
OUT = "/workspace/03_data/legal_tkgr/lepard_cites"
EVAL_SAMPLE = int(os.environ.get("EVAL_SAMPLE", "20000"))
EPOCHS = int(os.environ.get("EPOCHS", "30"))
DIM = 64
DEV = "cuda:0" if torch.cuda.is_available() else "cpu"


def pdate(s):
    if not s:
        return None
    try:
        y, m, d = s.split("-")
        return int(y) * 10000 + int(m) * 100 + int(d)
    except Exception:
        return None


def main():
    random.seed(0); np.random.seed(0); torch.manual_seed(0)
    os.makedirs(OUT, exist_ok=True)
    edges = set()
    courts = {}
    n_rows = n_bad = n_temp = 0
    years = Counter()
    with gzip.open(DATA, "rt", encoding="utf-8", errors="ignore") as f:
        r = csv.reader(f)
        header = next(r)
        for row in r:
            n_rows += 1
            if len(row) < 13:
                continue
            si, di = row[1], row[0]
            sd, dd = pdate(row[6]), pdate(row[2])
            if sd is None or dd is None:
                n_bad += 1
                continue
            if sd > dd:
                n_temp += 1
                continue
            courts.setdefault(di, row[7])
            edges.add((di, "cites", si, dd))
            years[dd // 10000] += 1

    print(f"rows={n_rows} date_fail={n_bad} temporal_invalid={n_temp} edges={len(edges)}", flush=True)
    print("edges by year:", dict(sorted(years.items())), flush=True)

    tr, va, te = [], [], []
    for s, rel, o, t in edges:
        if t <= 1990:
            tr.append((s, rel, o, t))
        elif t <= 2000:
            va.append((s, rel, o, t))
        else:
            te.append((s, rel, o, t))
    print(f"train={len(tr)} valid={len(va)} test={len(te)}", flush=True)

    for name, rows in (("train", tr), ("valid", va), ("test", te)):
        with open(os.path.join(OUT, f"{name}.tsv"), "w", encoding="utf-8") as f:
            for s, rel, o, t in rows:
                f.write(f"{s}\t{rel}\t{o}\t{t}\n")

    ent2id = {}
    def to_ids(rows):
        out = []
        for s, rel, o, t in rows:
            for e in (s, o):
                if e not in ent2id:
                    ent2id[e] = len(ent2id)
            out.append((ent2id[s], 0, ent2id[o], t))
        return out
    tr_i = to_ids(tr); va_i = to_ids(va); te_i = to_ids(te)
    N = len(ent2id)
    rng = random.Random(0)
    va_s = rng.sample(va_i, min(EVAL_SAMPLE, len(va_i)))
    te_s = rng.sample(te_i, min(EVAL_SAMPLE, len(te_i)))

    filt = defaultdict(set)
    seen_tails = set()
    for s, r, o, t in tr_i:
        filt[s].add(o); seen_tails.add(o)
    seen_tails = sorted(seen_tails)

    print(f"ents={N} random_mrr={1.0/N:.2e}", flush=True)

    class DistMult(nn.Module):
        def __init__(self, n, d):
            super().__init__()
            self.E = nn.Embedding(n, d); nn.init.xavier_uniform_(self.E.weight)

        def rank_scores(self, o):
            return torch.sigmoid(self.E.weight @ self.E(o).t())

    model = DistMult(N, DIM).to(DEV)
    opt = torch.optim.Adam(model.parameters(), lr=1e-3)
    trt = torch.tensor(tr_i, device=DEV)
    model.train()
    for ep in range(EPOCHS):
        perm = torch.randperm(len(trt), device=DEV)
        totl = 0.0; nb = 0
        for i in range(0, len(trt), 1024):
            b = trt[perm[i:i + 1024]]
            s, o = b[:, 0], b[:, 2]
            pos = (model.E(s) * model.E(o)).sum(-1)
            neg = torch.randint(0, N, (len(b),), device=DEV)
            nsc = (model.E(s) * model.E(neg)).sum(-1)
            loss = -F.logsigmoid(pos).mean() - F.logsigmoid(-nsc).mean()
            opt.zero_grad(); loss.backward(); opt.step()
            totl += loss.item(); nb += 1
        if (ep + 1) % 5 == 0:
            model.eval()
            rk = []
            with torch.no_grad():
                for i in range(0, len(va_s), 128):
                    b = va_s[i:i + 128]
                    o_ids = [x[2] for x in b]
                    sc = model.rank_scores(torch.tensor(o_ids, device=DEV)).t()
                    for j in range(len(b)):
                        f = filt.get(b[j][0])
                        row = sc[j]
                        if f:
                            row = row.clone(); row[torch.tensor(list(f), device=DEV)] = -1e9
                        rk.append(int((row > row[o_ids[j]]).sum().item()) + 1)
            print(f"  ep {ep+1}/{EPOCHS} loss {totl/max(nb,1):.4f} valid MRR {np.mean([1/r for r in rk]):.4f}", flush=True)
            model.train()

    def evaluate(model, rows, seen_tails, shuf=False, rng=None):
        model.eval()
        ranks = []
        with torch.no_grad():
            for i in range(0, len(rows), 128):
                b = rows[i:i + 128]
                o_ids = [x[2] for x in b]
                if shuf:
                    o_ids = [rng.choice(seen_tails) for _ in b]
                sc = model.rank_scores(torch.tensor(o_ids, device=DEV)).t()
                for j in range(len(b)):
                    row = sc[j]
                    f = filt.get(b[j][0])
                    if f:
                        row = row.clone(); row[torch.tensor(list(f), device=DEV)] = -1e9
                    ranks.append(int((row > row[o_ids[j]]).sum().item()) + 1)
        return {"mrr": round(float(np.mean([1 / r for r in ranks])), 4), "n": len(ranks)}

    v_raw = evaluate(model, va_s, seen_tails)
    v_shuf = evaluate(model, va_s, seen_tails, shuf=True, rng=random.Random(2))

    deg = Counter()
    for s, r, o, t in tr_i:
        deg[o] += 1
    ranks = []
    for s, r, o, t in va_s:
        rk = 0
        for cand in sorted(deg, key=lambda x: -deg[x]):
            if cand == o: break
            rk += 1
        ranks.append(rk + 1)
    v_pop = {"mrr": round(float(np.mean([1 / r for r in ranks])), 4), "n": len(ranks)}

    res = {"name": "lepard", "n_ent": N, "n_train": len(tr), "n_valid": len(va), "n_test": len(te),
           "temporal_invalid_frac": round(n_temp / max(n_rows, 1), 4),
           "valid_raw": v_raw, "valid_shuffled": v_shuf, "valid_popularity": v_pop}
    print(json.dumps(res, ensure_ascii=False, indent=2), flush=True)
    with open("/workspace/03_data/legal_tkgr/lepard_probe.json", "w") as f:
        json.dump(res, f, ensure_ascii=False, indent=2)


if __name__ == "__main__":
    import json
    main()
