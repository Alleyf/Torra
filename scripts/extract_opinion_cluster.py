#!/usr/bin/env python3
"""Stream the 55GB opinions bulk and emit opinion_id -> cluster_id TSV.

Only two columns are kept (id = col 1, cluster_id = last col). Uses the csv
module (not line splitting) because plain_text/html fields contain commas and
newlines inside quotes. Output is consumed by build_courtlistener_cites.py.
"""
import bz2
import csv
import os
import sys

BASE = "/workspace/03_data/case_valid_prep/courtlistener"
INP = os.path.join(BASE, "opinions.csv.bz2")
OUT = os.path.join(BASE, "opinion_cluster.tsv")

csv.field_size_limit(sys.maxsize)


def main():
    if not os.path.exists(INP):
        print(f"ERROR: {INP} not found", file=sys.stderr)
        sys.exit(2)
    n = 0
    with bz2.open(INP, "rt", encoding="utf-8", errors="ignore") as f, \
            open(OUT, "w", encoding="utf-8") as g:
        r = csv.reader(f)
        h = next(r)
        i_id, i_cl = h.index("id"), h.index("cluster_id")
        need = max(i_id, i_cl)
        for row in r:
            if len(row) <= need:
                continue
            g.write(row[i_id] + "\t" + row[i_cl] + "\n")
            n += 1
            if n % 1000000 == 0:
                print(f"  extracted {n} rows", flush=True)
    print(f"DONE extracted {n} rows -> {OUT}", flush=True)


if __name__ == "__main__":
    main()
