#!/usr/bin/env python3
"""RQ2 four-condition test on PreScience (proxy for the unavailable SciSciNet-v2).

The plan requires four conditions:
  1. seen authors      : both ends have >=3 train papers
  2. unseen authors    : at least one end has 0 train papers (appears only after cutoff)
  3. few-shot authors  : at least one end has 1-2 train papers
  4. few-shot relation : restricted to the rarest relation type

Graph: papers <= CUT build the graph; new coauthorships >= CUT_TEST are the truth.
Relations available in PreScience: coauthor (R1), author-category (R2),
author-cited-paper (R3). SciSciNet would add institution + grant; those are absent
here and that limitation is reported.

Methods: popularity, common_neighbors, adamic_adar, cat_jaccard(R2), cocite(R3),
         combo. Same ranker for all, 200 random distractors.
"""
import os
import math
import random
from collections import defaultdict, Counter

import pyarrow.parquet as pq

PATH = "/workspace/03_data/research_tkgr/prescience/train.parquet"
CUT = "2024-03-31"
CUT_TEST = "2024-04-01"
N_QUERY = int(os.environ.get("N_QUERY", "3000"))
K = int(os.environ.get("K", "200"))
MAX_AUTH = 15


def main():
    random.seed(0)
    tr_pairs = set()
    te_pairs = set()
    author_cats = defaultdict(set)
    author_cited = defaultdict(set)
    author_papers = Counter()
    paper_cats = {}

    f = pq.ParquetFile(PATH)
    for batch in f.iter_batches(batch_size=8000,
                                columns=["authors", "categories", "key_references", "date"]):
        d = batch.to_pydict()
        for auth, cats, refs, dt in zip(d["authors"], d["categories"],
                                        d["key_references"], d["date"]):
            if not auth or not dt:
                continue
            ids = [a["author_id"] for a in auth if a.get("author_id")]
            if len(ids) < 2 or len(ids) > MAX_AUTH:
                continue
            cats = cats or []
            refs = refs or []
            is_train = dt <= CUT
            for i in range(len(ids)):
                for j in range(i + 1, len(ids)):
                    a, b = ids[i], ids[j]
                    if a > b:
                        a, b = b, a
                    (tr_pairs if is_train else te_pairs).add((a, b))
            if is_train:
                for a in ids:
                    author_papers[a] += 1
                    author_cats[a].update(cats)
                    for ref in refs[:50]:
                        rid = ref.get("corpus_id") if isinstance(ref, dict) else None
                        if rid and len(author_cited[a]) < 300:
                            author_cited[a].add(rid)
            else:
                paper_cats[frozenset(ids)] = set(cats)

    print(f"train_pairs={len(tr_pairs)} test_pairs={len(te_pairs)} "
          f"authors_in_train={len(author_papers)}", flush=True)

    adj = defaultdict(set)
    for a, b in tr_pairs:
        adj[a].add(b); adj[b].add(a)
    deg = {u: len(v) for u, v in adj.items()}
    nodes = list(adj)
    print(f"nodes={len(nodes)}", flush=True)

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
    def sc_cat(u, cand):
        cu = author_cats.get(u, set()); out = {}
        for x in cand:
            cv = author_cats.get(x, set())
            out[x] = (len(cu & cv) / len(cu | cv)) if (cu and cv) else 0.0
        return out
    def sc_coc(u, cand):
        ru = author_cited.get(u, set()); out = {}
        for x in cand:
            rv = author_cited.get(x, set())
            out[x] = len(ru & rv) if (ru and rv) else 0
        return out
    def sc_combo(u, cand):
        a = sc_aa(u, cand); c = sc_cat(u, cand); k = sc_coc(u, cand)
        ma = max(a.values()) or 1; mc = max(c.values()) or 1; mk = max(k.values()) or 1
        return {x: a[x]/ma + c[x]/mc + k[x]/mk for x in cand}

    methods = {"popularity": sc_pop, "common_neighbors": sc_cn, "adamic_adar": sc_aa,
               "cat_jaccard": sc_cat, "cocite": sc_coc, "combo": sc_combo}

    # candidate positives: test pairs where the *query* side exists in train graph
    pos_all = [(a, b) for a, b in te_pairs if a in adj or b in adj]
    random.shuffle(pos_all)

    def bucket(a, b):
        """Classify by how much train history the weaker endpoint has."""
        pa = author_papers.get(a, 0)
        pb = author_papers.get(b, 0)
        weak = min(pa, pb) if (pa or pb) else 0
        strong = max(pa, pb)
        if strong == 0:
            return "unseen_both"
        if weak == 0:
            return "unseen_one"
        if weak <= 2:
            return "few_shot"
        return "seen"

    strata = defaultdict(list)
    for a, b in pos_all:
        strata[bucket(a, b)].append((a, b))
        if sum(len(v) for v in strata.values()) >= N_QUERY * 4:
            break

    print("\nstrata sizes:", {k: len(v) for k, v in strata.items()}, flush=True)

    def evaluate(pairs, tag, seed=0):
        rng = random.Random(seed)
        if not pairs:
            print(f"--- {tag}: no samples", flush=True); return None
        pairs = pairs[:N_QUERY]
        res = {m: {"mrr": 0.0, "h1": 0, "h10": 0} for m in methods}
        n = 0
        for a, b in pairs:
            # query side: pick whichever endpoint exists in the train graph
            q = a if a in adj else b
            tgt = b if q == a else a
            cand = [x for x in rng.sample(nodes, min(len(nodes), 4000))
                    if x != q and x != tgt and x not in adj.get(q, set())]
            cand = rng.sample(cand, min(K, len(cand))) + [tgt]
            n += 1
            for m, fn in methods.items():
                sc = fn(q, set(cand))
                ranked = sorted(cand, key=lambda x: -sc[x])
                rk = ranked.index(tgt) + 1
                res[m]["mrr"] += 1.0 / rk
                res[m]["h1"] += 1 if rk <= 1 else 0
                res[m]["h10"] += 1 if rk <= 10 else 0
        out = {m: {"MRR": round(res[m]["mrr"]/max(n,1), 4),
                   "H@1": round(res[m]["h1"]/max(n,1), 4),
                   "H@10": round(res[m]["h10"]/max(n,1), 4)} for m in methods}
        print(f"--- {tag} (n={n})", flush=True)
        for m in methods:
            print(f"    {m:17s} {out[m]}", flush=True)
        return out

    result = {}
    for name in ["seen", "few_shot", "unseen_one", "unseen_both"]:
        if name in strata:
            result[name] = evaluate(strata[name], f"{name} (train-paper count: "
                                                   f"{'>=3' if name=='seen' else '1-2' if name=='few_shot' else '0'})")

    # condition 4: rare-relation slice -> categories appearing in < 1% of train papers
    cat_freq = Counter()
    for a, cs in author_cats.items():
        for c in cs:
            cat_freq[c] += 1
    rare = {c for c, n in cat_freq.items() if n < max(50, int(0.01 * len(author_cats)))}
    rare_pairs = [(a, b) for a, b in strata.get("seen", [])
                  if (author_cats.get(a, set()) | author_cats.get(b, set())) & rare]
    if rare_pairs:
        result["rare_relation"] = evaluate(rare_pairs, f"rare_relation (cats in <1% papers, {len(rare)} rare cats)")

    import json
    with open("/workspace/03_data/research_tkgr/rq2_conditions.json", "w") as fh:
        json.dump(result, fh, ensure_ascii=False, indent=2)


if __name__ == "__main__":
    main()
