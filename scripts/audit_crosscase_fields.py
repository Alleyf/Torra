"""Field audit: which data can support a task whose signal CANNOT come from
within-case history (i.e. genuinely needs cross-entity / cross-case relations)?

Two sources are audited:
  A) DataJud raw JSONL  -> full key inventory, fill rates, any case-link field
  B) CourtListener dockets.csv.bz2 -> appeal_from_id / parent_docket_id /
     originating_court_information_id (real case->case links we never used;
     last round we only used cites + court/judge/nature)
"""
import bz2
import csv
import json
import sys
from collections import Counter

csv.field_size_limit(sys.maxsize)

print("=" * 70)
print("A) DataJud raw fields")
print("=" * 70)
p = "/workspace/03_data/case_valid_prep/datajud/raw/tjsp_2022.jsonl"
keys = Counter()
filled = Counter()
n = 0
sample = None
for line in open(p, encoding="utf-8"):
    d = json.loads(line)
    if sample is None:
        sample = d
    n += 1
    for k, v in d.items():
        keys[k] += 1
        if v not in (None, "", [], {}, 0):
            filled[k] += 1
    if n >= 3000:
        break
print("sampled:", n)
for k in sorted(keys, key=lambda x: -filled[x]):
    print(f"  {k:34s} present={keys[k]:5d} nonempty={filled[k]:5d} ({100*filled[k]/n:5.1f}%)")
print("\nkeys that look like cross-case links:")
link = [k for k in keys if any(s in k.lower() for s in
        ("relac", "conex", "orig", "sup", "vinc", "anteced", "origin", "refer", "apens"))]
print(" ", link or "NONE")
print("\nkeys that look like outcome/disposition:")
out = [k for k in keys if any(s in k.lower() for s in
       ("julg", "dispos", "senten", "resultado", "decis", "situacao", "status"))]
print(" ", out or "NONE")
print("\ntop-level keys of one record:", list(sample.keys()))

print()
print("=" * 70)
print("B) CourtListener dockets: cross-case link fill rate")
print("=" * 70)
f = "/workspace/03_data/case_valid_prep/courtlistener/dockets.csv.bz2"
cols = ["id", "court_id", "appeal_from_id", "parent_docket_id",
        "originating_court_information_id", "date_filed", "nature_of_suit",
        "assigned_to_id", "jury_demand", "cause"]
tot = Counter()
rows = 0
TARGET = {"scotus", "ca1", "ca2", "ca3", "ca4", "ca5", "ca6", "ca7", "ca8",
          "ca9", "ca10", "ca11", "ny", "cal"}
tgt_rows = 0
tgt_links = Counter()
with bz2.open(f, "rt", encoding="utf-8", errors="ignore") as fh:
    r = csv.reader(fh)
    h = next(r)
    idx = {c: h.index(c) for c in cols if c in h}
    for row in r:
        rows += 1
        if rows % 2000000 == 0:
            print(f"  scanned {rows} dockets ...", flush=True)
        for c, i in idx.items():
            v = row[i] if len(row) > i else ""
            if v and v not in ("", "null", "None"):
                tot[c] += 1
        cid = row[idx["court_id"]] if len(row) > idx["court_id"] else ""
        if cid in TARGET:
            tgt_rows += 1
            for c in ("appeal_from_id", "parent_docket_id",
                      "originating_court_information_id", "assigned_to_id"):
                i = idx.get(c)
                if i is not None and len(row) > i and row[i] not in ("", "null", "None"):
                    tgt_links[c] += 1

print("total dockets:", rows)
for c in cols:
    print(f"  {c:36s} nonempty={tot[c]:8d} ({100*tot[c]/rows:5.1f}%)")
print(f"\nTARGET-COURT dockets: {tgt_rows}")
for c, v in tgt_links.items():
    print(f"  {c:36s} nonempty={v:8d} ({100*v/max(tgt_rows,1):5.1f}%)")
