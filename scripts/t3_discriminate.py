"""Decisive discriminator: is the learnable signal SEQUENTIAL (order) or
RELATIONAL/GRAPH (attributes + set of activities that occurred)?

Sequences are ordered CHRONOLOGICALLY (date, original index) -- never by type
code, which would make "next" near-deterministic and fake the number up.

  unigram        P(next)                              no history at all
  attr_only      P(next | classe)                     graph side, NO history
  set_of_past    P(next | union of past bigram rows)  content, order-free
  bigram         P(next | immediately previous)       order only
  trigram        P(next | last two)                   order

set_of_past ~ bigram  -> membership drives it, a graph frame is defensible
bigram >> set_of_past -> immediate predecessor drives it: process mining,
                         TKGR is the wrong tool
"""
import json
import glob
import random
from collections import defaultdict, Counter

LO, HI = 2015, 2026


def dint(s):
    if not s or len(s) < 10:
        return None
    try:
        y, m, d = int(s[0:4]), int(s[5:7]), int(s[8:10])
    except ValueError:
        return None
    return y * 10000 + m * 100 + d if LO <= y <= HI else None


def flat(x):
    if isinstance(x, list):
        for i in x:
            yield from flat(i)
    elif isinstance(x, dict):
        yield x


cases = []
for fp in sorted(glob.glob("/workspace/03_data/case_valid_prep/datajud/raw/*.jsonl")):
    for line in open(fp, encoding="utf-8"):
        try:
            d = json.loads(line)
        except Exception:
            continue
        np_ = d.get("numeroProcesso")
        if not np_ or d.get("nivelSigilo", 0) != 0:
            continue
        aj = dint(d.get("dataAjuizamento"))
        if aj is None:
            continue
        ev = []
        for idx, m in enumerate(flat(d.get("movimentos") or [])):
            c = m.get("codigo")
            dt = dint(m.get("dataHora"))
            if c is None or dt is None:
                continue
            ev.append((dt, idx, int(c)))
        if len(ev) < 3:
            continue
        ev.sort()  # chronological
        cl = d.get("classe") or {}
        classe = int(cl["codigo"]) if isinstance(cl, dict) and cl.get("codigo") is not None else None
        cases.append({"aj": aj, "seq": [c for _, _, c in ev], "classe": classe})

tr = [c for c in cases if c["aj"] <= 20221231]
va = [c for c in cases if 20230101 <= c["aj"] <= 20231231]
te = [c for c in cases if c["aj"] >= 20240101]
print("cases train/valid/test:", len(tr), len(va), len(te))

uni = Counter()
bi = defaultdict(Counter)
tri = defaultdict(Counter)
attr = defaultdict(Counter)
for c in tr:
    seq = c["seq"]
    for i in range(1, len(seq)):
        nxt = seq[i]
        uni[nxt] += 1
        bi[seq[i - 1]][nxt] += 1
        if i >= 2:
            tri[(seq[i - 2], seq[i - 1])][nxt] += 1
        if c["classe"] is not None:
            attr[c["classe"]][nxt] += 1


def mrr_of(pairs):
    ranks = []
    for dist, tgt in pairs:
        if not dist:
            continue
        ts = dist.get(tgt, 0)
        better = sum(1 for v in dist.values() if v > ts)
        ties = sum(1 for v in dist.values() if v == ts) - 1
        ranks.append(better + 1 + ties / 2.0)
    n = len(ranks)
    if not n:
        return None
    return {"n": n,
            "mrr": round(sum(1 / r for r in ranks) / n, 4),
            "h1": round(sum(1 for r in ranks if r <= 1) / n, 4),
            "h3": round(sum(1 for r in ranks if r <= 3) / n, 4),
            "h10": round(sum(1 for r in ranks if r <= 10) / n, 4)}


def q(rows, k=4000, seed=0):
    out = []
    for c in rows:
        for i in range(2, len(c["seq"])):
            out.append((c, i))
    random.Random(seed).shuffle(out)
    return out[:k]


def set_of_past_dist(seq, i):
    """Union of bigram rows for every past type. Order-free by construction."""
    acc = Counter()
    for j in range(i):
        acc.update(bi.get(seq[j], {}))
    return acc or uni


for nm, rows in (("valid", va), ("test", te)):
    Q = q(rows)
    print("---", nm, "n=", len(Q))
    print("  unigram        :", mrr_of([(uni, c["seq"][i]) for c, i in Q]))
    print("  attr_only      :", mrr_of([(attr.get(c["classe"], uni) if c["classe"] is not None else uni,
                                          c["seq"][i]) for c, i in Q]))
    print("  set_of_past    :", mrr_of([(set_of_past_dist(c["seq"], i), c["seq"][i]) for c, i in Q]))
    print("  bigram         :", mrr_of([(bi.get(c["seq"][i - 1], uni), c["seq"][i]) for c, i in Q]))
    print("  trigram        :", mrr_of([(tri.get((c["seq"][i - 2], c["seq"][i - 1]),
                                                   bi.get(c["seq"][i - 1], uni)), c["seq"][i]) for c, i in Q]))
