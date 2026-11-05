#!/usr/bin/env python3
"""ReCaRe -> (s,r,o,t) temporal legal KG.

Source: metadata-en_dataset.jsonl. Only rows where BOTH a before-revision and an
after-revision exist are real amendment events (6,091 of 91,361).

Nodes : LAW:{law_id}  AMLAW:{amendment_law_id}  ART:{article_id}  TYPE:{type}
Edges : (all time = YYYYMMDD parsed from revision_id_after)
  AMLAW amends_article ART_after
  AMLAW amends_law     LAW
  ART_after part_of    LAW
  ART_before part_of   LAW
  ART_after has_change_type TYPE

Split by event date (strict temporal): train <=2020 / valid 2021-2023 / test >=2024
"""
import json
import os
import re
from collections import Counter

SRC = "/workspace/03_data/legal_tkgr/recae/metadata-en_dataset.jsonl"
OUT = "/workspace/03_data/legal_tkgr/recae_cites"


def dint(s):
    if not s:
        return None
    m = re.search(r"_(\d{8})_", s)
    if not m:
        return None
    v = m.group(1)
    return int(v) if v.startswith("20") else None


def main():
    os.makedirs(OUT, exist_ok=True)
    tr, va, te = [], [], []
    n_rows = n_pair = 0
    for line in open(SRC, encoding="utf-8"):
        try:
            d = json.loads(line)
        except Exception:
            continue
        n_rows += 1
        rb, ra = d.get("revision_id_before"), d.get("revision_id_after")
        if not (rb and ra):
            continue
        t = dint(ra)
        if t is None:
            continue
        n_pair += 1
        law = d.get("law_id")
        amlaw = d.get("amendment_law_id")
        ab, aa = d.get("article_id_before"), d.get("article_id_after")
        typ = d.get("type_of_change")
        rows = []
        if amlaw and aa:
            rows.append((f"AMLAW:{amlaw}", "amends_article", f"ART:{aa}", t))
        if amlaw and law:
            rows.append((f"AMLAW:{amlaw}", "amends_law", f"LAW:{law}", t))
        if aa and law:
            rows.append((f"ART:{aa}", "part_of", f"LAW:{law}", t))
        if ab and law:
            rows.append((f"ART:{ab}", "part_of", f"LAW:{law}", t))
        if aa and typ:
            rows.append((f"ART:{aa}", "has_change_type", f"TYPE:{typ}", t))
        if t <= 20201231:
            tr.extend(rows)
        elif t <= 20231231:
            va.extend(rows)
        else:
            te.extend(rows)

    def dedup(rows):
        seen = set(); out = []
        for r in rows:
            if r[:3] in seen:
                continue
            seen.add(r[:3]); out.append(r)
        return out

    tr, va, te = dedup(tr), dedup(va), dedup(te)
    for n, rs in (("train", tr), ("valid", va), ("test", te)):
        with open(os.path.join(OUT, f"{n}.tsv"), "w", encoding="utf-8") as f:
            for s, r, o, t in rs:
                f.write(f"{s}\t{r}\t{o}\t{t}\n")
        print(f"{n}: {len(rs)}", flush=True)

    print(f"rows={n_rows} paired={n_pair}", flush=True)
    print("train rel:", dict(Counter(r for _, r, _, _ in tr)), flush=True)
    ents = set()
    for rs in (tr, va, te):
        for s, r, o, t in rs:
            ents.add(s); ents.add(o)
    print("entities:", len(ents), flush=True)
    tr_subj = {s for s, _, _, _ in tr}
    for n, rs in (("valid", va), ("test", te)):
        subs = {s for s, _, _, _ in rs}
        print(f"{n}: subjects={len(subs)} unseen_subj={sum(1 for s in subs if s not in tr_subj)}", flush=True)


if __name__ == "__main__":
    main()
