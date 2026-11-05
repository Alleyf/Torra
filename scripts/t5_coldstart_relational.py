"""题型二: early-stage prediction for a NEW case with almost no own history.

Why this is the right test of "relations are indispensable":
  In 题型一 the case accumulates events, so its own prefix does most of the work
  (trigram 0.62) and cross-case structure added only +0.018.
  At filing time a case has 0-1 events. Whatever predicts its next step then
  CANNOT come from its own history -- it must come from other cases sharing
  entities (classe / assunto / court / orgaoJulgador). That is a 2-hop
  relational aggregate, exactly what a graph gives you and a transfer table
  of one's own history cannot.

Protocol
  train: cases filed <=2022 ; valid 2023 ; test >=2024   (unseen cases)
  queries: for each test case, position i where i <= MAX_KNOWN (own history all
           from the case itself, <= MAX_KNOWN events). i=1 is the hardest.
  comparison (all inductive, all on unseen cases):
    unigram            P(next)
    own-bigram         P(next | last own event)
    attr               P(next | classe)
    neigh-3key         P(next | court+classe+orgao)      <- relational aggregate
    attr+own (blend)   own-bigram blended with attr
    neigh+own (blend)  own-bigram blended with neigh-3key
  Stratified by i (1 / 2 / 3+) so the "history is thin" regime is visible.
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


def codigo(v):
    if isinstance(v, dict) and v.get("codigo") is not None:
        try:
            return int(v["codigo"])
        except (TypeError, ValueError):
            return None
    return None


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
        ev.sort()
        cases.append({
            "aj": aj,
            "seq": [c for _, _, c in ev],
            "classe": codigo(d.get("classe")),
            "orgao": codigo(d.get("orgaoJulgador")),
            "court": d.get("tribunal"),
            "assuntos": tuple(sorted({a for a in (codigo(x) for x in flat(d.get("assuntos") or [])) if a is not None})),
        })

tr = [c for c in cases if c["aj"] <= 20221231]
va = [c for c in cases if 20230101 <= c["aj"] <= 20231231]
te = [c for c in cases if c["aj"] >= 20240101]
print("cases train/valid/test:", len(tr), len(va), len(te))

uni = Counter()
own_bi = defaultdict(Counter)
attr = defaultdict(Counter)
neigh3 = defaultdict(Counter)
neigh4 = defaultdict(Counter)
for c in tr:
    seq = c["seq"]
    for i in range(1, len(seq)):
        nxt = seq[i]
        uni[nxt] += 1
        own_bi[seq[i - 1]][nxt] += 1
        if c["classe"] is not None:
            attr[c["classe"]][nxt] += 1
        if c["court"] and c["classe"] is not None and c["orgao"] is not None:
            neigh3[(c["court"], c["classe"], c["orgao"])][nxt] += 1
            if c["assuntos"]:
                neigh4[(c["court"], c["classe"], c["orgao"], c["assuntos"][0])][nxt] += 1

print("neigh3 keys:", len(neigh3), "| neigh4 keys:", len(neigh4))


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


def blend(d1, d2):
    if not d1:
        return d2
    if not d2:
        return d1
    m1 = max(d1.values()) or 1
    m2 = max(d2.values()) or 1
    r = Counter()
    for k, v in d1.items():
        r[k] += v / m1
    for k, v in d2.items():
        r[k] += v / m2
    return r


def pick(rows, max_known, k, seed=0):
    out = []
    for c in rows:
        for i in range(1, min(len(c["seq"]), max_known + 1)):
            out.append((c, i))
    random.Random(seed).shuffle(out)
    return out[:k]


for MAXK in (1, 2):
    print()
    print("=" * 66)
    print(f"own history capped at {MAXK} event(s)  [the cold-start regime]")
    print("=" * 66)
    for nm, rows in (("valid", va), ("test", te)):
        Q = pick(rows, MAXK, 4000)
        print(f"--- {nm}  n={len(Q)}")
        print("  unigram        :", mrr_of([(uni, c["seq"][i]) for c, i in Q]))
        print("  own-bigram     :", mrr_of([(own_bi.get(c["seq"][i - 1], uni), c["seq"][i]) for c, i in Q]))
        print("  attr(classe)   :", mrr_of([(attr.get(c["classe"], uni) if c["classe"] is not None else uni,
                                             c["seq"][i]) for c, i in Q]))
        print("  neigh3         :", mrr_of([(neigh3.get((c["court"], c["classe"], c["orgao"]), uni)
                                             if (c["court"] and c["classe"] is not None and c["orgao"] is not None) else uni,
                                             c["seq"][i]) for c, i in Q]))
        print("  neigh4         :", mrr_of([(neigh4.get((c["court"], c["classe"], c["orgao"], c["assuntos"][0]), uni)
                                             if (c["court"] and c["classe"] is not None and c["orgao"] is not None and c["assuntos"]) else uni,
                                             c["seq"][i]) for c, i in Q]))
        print("  own+attr blend :", mrr_of([(blend(own_bi.get(c["seq"][i - 1]),
                                                    attr.get(c["classe"]) if c["classe"] is not None else None),
                                             c["seq"][i]) for c, i in Q]))
        print("  own+neigh blend:", mrr_of([(blend(own_bi.get(c["seq"][i - 1]),
                                                    neigh3.get((c["court"], c["classe"], c["orgao"]))
                                                    if (c["court"] and c["classe"] is not None and c["orgao"] is not None) else None),
                                             c["seq"][i]) for c, i in Q]))
        hit = sum(1 for c, i in Q if (c["court"], c["classe"], c["orgao"]) in neigh3)
        print(f"  neigh3 coverage: {100*hit/len(Q):.1f}%")
