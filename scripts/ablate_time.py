"""Decisive ablation: does TIME carry the signal in a temporal-KG model?

This is the test that decides whether a TKGR framing is defensible on this task.
We train the same architecture twice on the SAME graph and SAME split:

  TIME   : score(s,r,o,t) = <E_s * R_r * E_o> + <P_t * R_r * E_o>
           (a TTransE-style time projection, i.e. the model has a time slot)
  STATIC : score(s,r,o)   = <E_s * R_r * E_o>
           (identical net, time slot deleted -- all timestamps ignored)

Both trained with the same margin ranking loss, same negatives, same epochs,
evaluated with the SAME filtered ranking on unseen cold-start cases.

  TIME >> STATIC  -> temporal structure is essential; TKGR framing is earned.
  TIME ~= STATIC  -> time adds nothing here; it is a plain sequence/relation
                     completion problem and calling it TKGR would be marketing.

Also reports a per-relation breakdown so the event relation can be read alone.
"""
import os
import random
import sys
import time
from collections import Counter, defaultdict

import numpy as np
import torch
import torch.nn as nn

DATA = "/workspace/03_data/case_valid_prep/datajud_events_case"
EPOCHS = int(os.environ.get("EP", "25"))
DIM = 64
NEG = 8
LR = 2e-3
BATCH = 2048
DEV = "cuda:0" if torch.cuda.is_available() else "cpu"
EVAL_N = int(os.environ.get("EVAL_N", "6000"))


def load(p):
    rows = []
    for line in open(p, encoding="utf-8"):
        q = line.rstrip("\n").split("\t")
        if len(q) >= 4:
            try:
                rows.append((q[0], q[1], q[2], int(q[3])))
            except ValueError:
                pass
    return rows


class TemporalKG(nn.Module):
    def __init__(self, ne, nr, nt, dim, use_time):
        super().__init__()
        self.use_time = use_time
        self.E = nn.Embedding(ne, dim)
        self.R = nn.Embedding(nr, dim)
        nn.init.xavier_uniform_(self.E.weight)
        nn.init.xavier_uniform_(self.R.weight)
        if use_time:
            self.P = nn.Embedding(nt, dim)
            nn.init.xavier_uniform_(self.P.weight)
            self.PT = nn.Embedding(nt, dim)
            nn.init.xavier_uniform_(self.PT.weight)

    def score(self, s, r, o, t):
        base = (self.E(s) * self.R(r) * self.E(o)).sum(-1)
        if not self.use_time:
            return base
        return base + (self.P(t) * self.R(r) * self.E(o)).sum(-1) + self.PT(t).sum(-1)


def main():
    random.seed(0)
    np.random.seed(0)
    torch.manual_seed(0)

    tr = load(f"{DATA}/train.tsv")
    va = load(f"{DATA}/valid.tsv")
    te = load(f"{DATA}/test.tsv")
    ents, rels, times = {}, {}, {}
    for rows in (tr, va, te):
        for s, r, o, t in rows:
            ents.setdefault(s, len(ents))
            ents.setdefault(o, len(ents))
            rels.setdefault(r, len(rels))
            times.setdefault(t, len(times))
    NE, NR, NT = len(ents), len(rels), len(times)
    print(f"ents={NE} rels={NR} times={NT} train={len(tr)} valid={len(va)} test={len(te)} dev={DEV}", flush=True)

    def enc(rows):
        return torch.tensor([[ents[s], rels[r], ents[o], times[t]] for s, r, o, t in rows], dtype=torch.long)

    trt = enc(tr)
    # eval only on event queries (the task), filtered
    filt = defaultdict(set)
    for s, r, o, t in tr:
        filt[(ents[s], rels[r])].add(ents[o])
    ev_rel = rels.get("case_first_event")
    va_q = [x for x in va if rels[x[1]] == ev_rel]
    te_q = [x for x in te if rels[x[1]] == ev_rel]
    rng = random.Random(0)
    va_q = rng.sample(va_q, min(EVAL_N, len(va_q)))
    te_q = rng.sample(te_q, min(EVAL_N, len(te_q)))
    print(f"eval event-queries valid={len(va_q)} test={len(te_q)}", flush=True)

    def evaluate(model, qs):
        model.eval()
        outs = []
        with torch.no_grad():
            for i in range(0, len(qs), 256):
                b = qs[i:i + 256]
                s = torch.tensor([ents[x[0]] for x in b], device=DEV)
                r = torch.tensor([rels[x[1]] for x in b], device=DEV)
                o = torch.tensor([ents[x[2]] for x in b], device=DEV)
                t = torch.tensor([times[x[3]] for x in b], device=DEV)
                # score all entities as tail
                Rr = model.R(r)                       # (B,d)
                B = len(b)
                cand = torch.arange(NE, device=DEV)
                Es = model.E(s)                       # (B,d)
                base = (Es.unsqueeze(1) * Rr.unsqueeze(1) * model.E.weight.unsqueeze(0)).sum(-1)
                if model.use_time:
                    sc = (base + (model.P(t).unsqueeze(1) * Rr.unsqueeze(1)
                                  * model.E.weight.unsqueeze(0)).sum(-1)
                          + model.PT(t).sum(-1).unsqueeze(1))
                else:
                    sc = base
                for j in range(B):
                    f = filt.get((s[j].item(), r[j].item()))
                    if f:
                        idx = torch.tensor(sorted(f), device=DEV)
                        sc[j, idx] = -1e9
                tgt = o
                ts = sc.gather(1, tgt.unsqueeze(1)).squeeze(1)
                better = (sc > ts.unsqueeze(1)).sum(1).float()
                ties = (sc == ts.unsqueeze(1)).sum(1).float() - 1
                outs.append((better + 1 + ties / 2).cpu())
        rk = torch.cat(outs).numpy()
        return {"n": int(len(rk)), "mrr": round(float(np.mean(1 / rk)), 4),
                "h1": round(float(np.mean(rk <= 1)), 4),
                "h3": round(float(np.mean(rk <= 3)), 4),
                "h10": round(float(np.mean(rk <= 10)), 4)}

    results = {}
    for use_time in (True, False):
        name = "TIME" if use_time else "STATIC"
        model = TemporalKG(NE, NR, NT, DIM, use_time).to(DEV)
        opt = torch.optim.Adam(model.parameters(), lr=LR)
        t0 = time.time()
        model.train()
        for ep in range(EPOCHS):
            perm = torch.randperm(len(trt))
            tot = 0.0
            nb = 0
            for i in range(0, len(trt), BATCH):
                b = trt[perm[i:i + BATCH]].to(DEV)
                s, r, o, t = b[:, 0], b[:, 1], b[:, 2], b[:, 3]
                pos = model.score(s, r, o, t)
                ne = torch.randint(0, NE, (len(b) * NEG,), device=DEV)
                ss = s.repeat_interleave(NEG)
                rr = r.repeat_interleave(NEG)
                tt = t.repeat_interleave(NEG)
                ng = model.score(ss, rr, ne, tt)
                loss = torch.clamp(1.0 - pos.repeat_interleave(NEG) + ng, min=0).mean()
                opt.zero_grad(); loss.backward(); opt.step()
                tot += loss.item(); nb += 1
            if (ep + 1) % 5 == 0:
                print(f"  [{name}] ep {ep+1}/{EPOCHS} loss {tot/max(nb,1):.4f}", flush=True)
        results[name] = {"valid": evaluate(model, va_q), "test": evaluate(model, te_q),
                         "secs": round(time.time() - t0, 1)}
        print(f"  [{name}] valid={results[name]['valid']} test={results[name]['test']}", flush=True)

    print("\n=== ABLATION ===")
    print("TIME   :", results["TIME"]["valid"], results["TIME"]["test"])
    print("STATIC :", results["STATIC"]["valid"], results["STATIC"]["test"])
    d = results["TIME"]["test"]["mrr"] - results["STATIC"]["test"]["mrr"]
    print(f"test MRR delta (TIME - STATIC) = {d:+.4f}")
    print("verdict:", "time is essential" if d > 0.05 else
          ("time helps marginally" if d > 0.01 else "time adds ~nothing"))


if __name__ == "__main__":
    main()
