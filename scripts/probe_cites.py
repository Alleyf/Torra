#!/usr/bin/env python3
"""Temporal citation-graph probe: DistMult + shuffled-tail control.

Why a custom probe (not tkg_probe.py):
  tkg_probe evaluates every valid/test row against all 663k entities with a
  per-row python loop -> days. Here we sample rows and vectorize the rank.

Two evaluations, both on the same sampled rows:
  raw      : real (citing, cites, cited, year)
  shuffled : tail replaced by a random *seen* tail (same relation) -> if raw
             MRR ~= shuffled MRR, the score is a hub artifact, not signal.
"""
import os
import sys
import json
import time
import random
import argparse
from collections import Counter, defaultdict

import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F


def load_quad(fn):
    rows = []
    with open(fn) as f:
        for line in f:
            p = line.rstrip("\n").split("\t")
            if len(p) >= 4:
                try:
                    rows.append((p[0], p[1], p[2], int(float(p[3]))))
                except ValueError:
                    pass
    return rows


def to_ids(rows, ent2id):
    out = []
    for s, r, o, t in rows:
        if s not in ent2id:
            ent2id[s] = len(ent2id)
        if o not in ent2id:
            ent2id[o] = len(ent2id)
        out.append((ent2id[s], 0, ent2id[o], t))
    return out


class DistMult(nn.Module):
    def __init__(self, n_ent, dim):
        super().__init__()
        self.E = nn.Embedding(n_ent, dim)
        nn.init.xavier_uniform_(self.E.weight)

    def forward(self, s, o):
        return (self.E(s) * self.E(o)).sum(dim=1)

    def rank_scores(self, o):
        return torch.sigmoid(self.E.weight @ self.E(o).t())  # (n_ent, B)


def evaluate(model, rows, filter_dict, seen_tails, device, N, shuffled=False, rng=None):
    model.eval()
    ranks = []
    h1 = h3 = h10 = 0
    tot = 0
    with torch.no_grad():
        for i in range(0, len(rows), 128):
            b = rows[i:i + 128]
            o_ids = [x[2] for x in b]
            if shuffled:
                o_ids = [rng.choice(seen_tails) for _ in b]
            o = torch.tensor(o_ids, device=device)
            sc = model.rank_scores(o).t()  # (B, N)
            for j, (s, r, true_o, t) in enumerate(b):
                tgt = o_ids[j]
                row = sc[j]
                # filtered: mask training tails for this subject
                f = filter_dict.get(s)
                if f:
                    row = row.clone()
                    idx = torch.tensor(list(f), device=device)
                    row[idx] = -1e9
                true_score = row[tgt]
                rank = int((row > true_score).sum().item()) + 1
                ranks.append(rank)
                tot += 1
                if rank <= 1:
                    h1 += 1
                if rank <= 3:
                    h3 += 1
                if rank <= 10:
                    h10 += 1
    mrr = float(np.mean([1.0 / r for r in ranks])) if ranks else 0.0
    return {"mrr": mrr, "hits1": h1 / tot, "hits3": h3 / tot, "hits10": h10 / tot, "n": tot}


def evaluate_popularity(rows, tail_degree, N):
    """Score = training in-degree of the tail. No model, no subject info."""
    order = sorted(range(N), key=lambda i: -tail_degree.get(i, 0))
    rank_of = {e: i + 1 for i, e in enumerate(order)}
    ranks = []
    h1 = h3 = h10 = 0
    for s, r, o, t in rows:
        rk = rank_of[o]
        ranks.append(rk)
        if rk <= 1:
            h1 += 1
        if rk <= 3:
            h3 += 1
        if rk <= 10:
            h10 += 1
    tot = len(rows)
    return {"mrr": float(np.mean([1.0 / r for r in ranks])) if ranks else 0.0,
            "hits1": h1 / tot if tot else 0, "hits3": h3 / tot if tot else 0,
            "hits10": h10 / tot if tot else 0, "n": tot}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", required=True)
    ap.add_argument("--name", default="cites")
    ap.add_argument("--epochs", type=int, default=30)
    ap.add_argument("--dim", type=int, default=64)
    ap.add_argument("--lr", type=float, default=1e-3)
    ap.add_argument("--eval-sample", type=int, default=20000)
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--gpu", type=int, default=0)
    ap.add_argument("--out", default="")
    args = ap.parse_args()

    random.seed(args.seed); np.random.seed(args.seed); torch.manual_seed(args.seed)
    device = torch.device("cuda:%d" % args.gpu if args.gpu >= 0 and torch.cuda.is_available() else "cpu")
    t0 = time.time()

    train = load_quad(os.path.join(args.data, "train.tsv"))
    valid = load_quad(os.path.join(args.data, "valid.tsv"))
    test = load_quad(os.path.join(args.data, "test.tsv"))
    ent2id = {}
    tr = to_ids(train, ent2id)
    va = to_ids(valid, ent2id)
    te = to_ids(test, ent2id)
    N = len(ent2id)

    rng = random.Random(args.seed + 1)
    va_s = rng.sample(va, min(args.eval_sample, len(va)))
    te_s = rng.sample(te, min(args.eval_sample, len(te)))

    # filter + seen tails (for shuffle)
    filt = defaultdict(set)
    seen_tails = set()
    for s, r, o, t in tr:
        filt[s].add(o)
        seen_tails.add(o)
    seen_tails = sorted(seen_tails)
    tail_degree = Counter(o for s, r, o, t in tr)

    print(f"[{args.name}] ents={N} train={len(tr)} valid={len(va)} test={len(te)} eval_sample={len(va_s)}/{len(te_s)} dev={device}", flush=True)

    model = DistMult(N, args.dim).to(device)
    opt = torch.optim.Adam(model.parameters(), lr=args.lr)
    tr_t = torch.tensor(tr, device=device)
    model.train()
    for ep in range(args.epochs):
        perm = torch.randperm(len(tr_t), device=device)
        totl = 0.0; nb = 0
        for i in range(0, len(tr_t), 1024):
            b = tr_t[perm[i:i + 1024]]
            s, o = b[:, 0], b[:, 2]
            pos = model(s, o)
            neg = torch.randint(0, N, (len(b),), device=device)
            nsc = model(s, neg)
            loss = -F.logsigmoid(pos).mean() - F.logsigmoid(-nsc).mean()
            opt.zero_grad(); loss.backward(); opt.step()
            totl += loss.item(); nb += 1
        if (ep + 1) % 5 == 0 or ep == args.epochs - 1:
            ev = evaluate(model, va_s, filt, seen_tails, device, N)
            print(f"  ep {ep+1}/{args.epochs} loss {totl/max(nb,1):.4f} valid MRR {ev['mrr']:.4f} H@10 {ev['hits10']:.4f}", flush=True)

    ev_raw = evaluate(model, va_s, filt, seen_tails, device, N, shuffled=False)
    ev_shuf = evaluate(model, va_s, filt, seen_tails, device, N, shuffled=True, rng=random.Random(args.seed + 2))
    te_raw = evaluate(model, te_s, filt, seen_tails, device, N, shuffled=False)
    te_shuf = evaluate(model, te_s, filt, seen_tails, device, N, shuffled=True, rng=random.Random(args.seed + 3))
    va_pop = evaluate_popularity(va_s, tail_degree, N)
    te_pop = evaluate_popularity(te_s, tail_degree, N)
    # random-subject control: keep true tail, replace subject with a random entity.
    # If MRR stays high, the model is not using subject info at all (global tail bias).
    rng_s = random.Random(args.seed + 9)
    va_rs = [(rng_s.randint(0, N - 1), r, o, t) for s, r, o, t in va_s]
    te_rs = [(rng_s.randint(0, N - 1), r, o, t) for s, r, o, t in te_s]
    va_randsub = evaluate(model, va_rs, filt, seen_tails, device, N)
    te_randsub = evaluate(model, te_rs, filt, seen_tails, device, N)

    res = {
        "name": args.name,
        "n_ent": N, "n_train": len(tr), "n_valid": len(va), "n_test": len(te),
        "eval_sample": len(va_s),
        "random_mrr": 1.0 / N,
        "valid_raw": ev_raw, "valid_shuffled": ev_shuf, "valid_popularity": va_pop, "valid_random_subject": va_randsub,
        "test_raw": te_raw, "test_shuffled": te_shuf, "test_popularity": te_pop, "test_random_subject": te_randsub,
        "artifact_check": "raw vs popularity vs random_subject; raw<=popularity OR raw~=random_subject => artifact",
        "elapsed_s": round(time.time() - t0, 1),
    }
    print(json.dumps(res, ensure_ascii=False, indent=1), flush=True)
    if args.out:
        with open(args.out, "w") as f:
            json.dump(res, f, ensure_ascii=False, indent=1)


if __name__ == "__main__":
    main()
