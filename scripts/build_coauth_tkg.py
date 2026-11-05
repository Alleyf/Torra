#!/usr/bin/env python3
"""coauth-DBLP -> temporal dyadic coauthorship KG.

Each paper (simplex) with k>=2 authors yields k(k-1)/2 pairs; edge = (a, coauthor, b, year).
Pairs are canonicalised a<b, and deduped per (a,b,year).

Split strictly by publication year: train <=2010 / valid 2011-2015 / test 2016-2018.
"""
import os
from collections import Counter

BASE = "/workspace/03_data/research_tkgr/coauth/coauth-DBLP"
OUT = "/workspace/03_data/research_tkgr/coauth_cites"
MAX_AUTHORS_PER_PAPER = 30   # skip mega-author papers (rare, super-hub)


def main():
    os.makedirs(OUT, exist_ok=True)
    tr, va, te = set(), set(), set()
    years = Counter()
    n_papers = n_skip = 0
    with open(f"{BASE}/coauth-DBLP-nverts.txt") as fn, \
            open(f"{BASE}/coauth-DBLP-times.txt") as ft, \
            open(f"{BASE}/coauth-DBLP-simplices.txt") as fs:
        for nv_line, t_line in zip(fn, ft):
            nv = int(nv_line); t = int(t_line)
            auth = [int(next(fs)) for _ in range(nv)]
            n_papers += 1
            years[t] += 1
            if nv < 2 or nv > MAX_AUTHORS_PER_PAPER:
                n_skip += 1
                continue
            auth.sort()
            for i in range(nv):
                for j in range(i + 1, nv):
                    e = (auth[i], auth[j], t)
                    if t <= 2010:
                        tr.add(e)
                    elif t <= 2015:
                        va.add(e)
                    else:
                        te.add(e)
    print(f"papers={n_papers} skipped={n_skip}", flush=True)
    print(f"unique edges train={len(tr)} valid={len(va)} test={len(te)}", flush=True)

    for name, s in (("train", tr), ("valid", va), ("test", te)):
        with open(f"{OUT}/{name}.tsv", "w", encoding="utf-8") as f:
            for a, b, t in s:
                f.write(f"A:{a}\tcoauthor\tA:{b}\t{t}\n")
        print(f"  {name}: {len(s)}", flush=True)

    tr_subj = {a for a, b, t in tr}
    va_subj = {a for a, b, t in va}
    te_subj = {a for a, b, t in te}
    tr_ent = set()
    for a, b, t in tr:
        tr_ent.add(a); tr_ent.add(b)
    print("train ents:", len(tr_ent), flush=True)
    print("valid subj unseen:", sum(1 for a in va_subj if a not in tr_ent), "/", len(va_subj), flush=True)
    print("test  subj unseen:", sum(1 for a in te_subj if a not in tr_ent), "/", len(te_subj), flush=True)


if __name__ == "__main__":
    main()
