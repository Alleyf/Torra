#!/usr/bin/env python3
"""B: does MULTI-RELATION structure beat single-relation heuristics downstream?

PreScience (no institution field). Relations used:
  R1 coauthor   : author--author  (from co-authored papers)
  R2 topic      : author--category (author's papers' arXiv categories)
  R3 citation   : author--cited-paper (papers the author's work references)

Temporal split inside train.parquet (max date 2024-09-30):
  graph  <= 2024-03-31
  test   : new coauthorships on papers 2024-04-01 .. 2024-09-30

Same downstream ranker for every scorer. Candidates = 2-hop coauthor
neighbours in the train graph, excluding existing collaborators (novel pairs).

Scorers: popularity, common_neighbors, adamic_adar,
         cat_jaccard (R2), cocite (R3), combo (AA+cat+cocite).
The question: does adding R2/R3 beat AA (R1 only)?
"""
import os
import json
import math
import random
from collections import defaultdict

import pyarrow.parquet as pq

PATH = "/workspace/03_data/research_tkgr/prescience/train.parquet"
CUT = "2024-03-31"
N_USERS = int(os.environ.get("N_USERS", "2000"))
MAX_CAND = int(os.environ.get("MAX_CAND", "800"))


def main():
    random.seed(0)
    tr_pairs = set()
    te_pairs = set()
    author_cats = defaultdict(set)
    author_cited = defaultdict(set)
    n_rows = 0

    f = pq.ParquetFile(PATH)
    for batch in f.iter_batches(batch_size=8000,
                                columns=["authors", "categories", "key_references", "date"]):
        d = batch.to_pydict()
        for auth, cats, refs, dt in zip(d["authors"], d["categories"],
                                        d["key_references"], d["date"]):
            if not auth or not dt:
                continue
            n_rows += 1
            ids = [a["author_id"] for a in auth if a.get("author_id")]
            cats = cats or []
            refs = refs or []
            is_train = dt <= CUT
            # coauthor edges
            for i in range(len(ids)):
                for j in range(i + 1, len(ids)):
                    a, b = ids[i], ids[j]
                    if a > b:
                        a, b = b, a
                    (tr_pairs if is_train else te_pairs).add((a, b))
            if is_train:
                for a in ids:
                    author_cats[a].update(cats)
                    for ref in refs:
                        rid = ref.get("corpus_id") if isinstance(ref, dict) else None
                        if rid:
                            author_cited[a].add(rid)

    print(f"rows={n_rows} train_pairs={len(tr_pairs)} test_pairs={len(te_pairs)} "
          f"authors_with_cats={len(author_cats)}", flush=True)

    adj = defaultdict(set)
    for a, b in tr_pairs:
        adj[a].add(b); adj[b].add(a)
    deg = {u: len(v) for u, v in adj.items()}
    print(f"nodes={len(adj)}", flush=True)

    pos = defaultdict(set)
    for a, b in te_pairs:
        if a in adj or b in adj:
            pos[a].add(b); pos[b].add(a)

    rng = random.Random(0)
    users = [u for u in pos if u in adj]
    rng.shuffle(users)
    evals = []
    for u in users:
        cand = set()
        for w in adj[u]:
            cand |= adj[w]
        cand.discard(u); cand -= adj[u]
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
    print(f"eval_users={len(evals)} avg_cand={sum(len(c) for _,c,_ in evals)/max(len(evals),1):.1f}", flush=True)

    def sc_pop(u, cand): return {v: deg.get(v, 0) for v in cand}
    def sc_cn(u, cand):
        nu = adj[u]; return {v: len(nu & adj[v]) for v in cand}
    def sc_aa(u, cand):
        nu = adj[u]; out = {}
        for v in cand:
            s = 0.0
            for w in (nu & adj[v]):
                dd = deg.get(w, 0)
                if dd > 1:
                    s += 1.0 / math.log(dd)
            out[v] = s
        return out
    def sc_cat(u, cand):
        cu = author_cats.get(u, set()); out = {}
        for v in cand:
            cv = author_cats.get(v, set())
            if not cu or not cv:
                out[v] = 0.0
            else:
                out[v] = len(cu & cv) / len(cu | cv)
        return out
    def sc_cocite(u, cand):
        ru = author_cited.get(u, set()); out = {}
        for v in cand:
            rv = author_cited.get(v, set())
            out[v] = len(ru & rv) if (ru and rv) else 0
        return out
    def sc_combo(u, cand):
        a = sc_aa(u, cand); c = sc_cat(u, cand); k = sc_cocite(u, cand)
        ma = max(a.values()) or 1; mc = max(c.values()) or 1; mk = max(k.values()) or 1
        return {v: a[v]/ma + c[v]/mc + k[v]/mk for v in cand}

    methods = {"popularity": sc_pop, "common_neighbors": sc_cn, "adamic_adar": sc_aa,
               "cat_jaccard(R2)": sc_cat, "cocite(R3)": sc_cocite, "combo(R1+R2+R3)": sc_combo}

    def ndcg(ranked, positives, k):
        dcg = 0.0
        for i, v in enumerate(ranked[:k]):
            if v in positives:
                dcg += 1.0 / math.log2(i + 2)
        ideal = sum(1.0 / math.log2(i + 2) for i in range(min(len(positives), k)))
        return dcg / ideal if ideal > 0 else 0.0

    print("\n=== DOWNSTREAM: collaborator rec (novel pairs, temporal holdout) ===")
    out = {}
    for name, fn in methods.items():
        R10 = R50 = N10 = mrr = 0.0
        for u, cand, p in evals:
            sc = fn(u, cand)
            ranked = sorted(cand, key=lambda v: -sc[v])
            R10 += len(set(ranked[:10]) & p) / len(p)
            R50 += len(set(ranked[:50]) & p) / len(p)
            N10 += ndcg(ranked, p, 10)
            first = next((i for i, v in enumerate(ranked) if v in p), None)
            mrr += 1.0/(first+1) if first is not None else 0.0
        n = len(evals)
        out[name] = {"R@10": round(R10/n, 4), "R@50": round(R50/n, 4),
                     "NDCG@10": round(N10/n, 4), "MRR": round(mrr/n, 4)}
        print(f"{name:18s} {out[name]}", flush=True)

    with open("/workspace/03_data/research_tkgr/prescience_multi_downstream.json", "w") as fh:
        json.dump(out, fh, ensure_ascii=False, indent=2)


if __name__ == "__main__":
    main()
