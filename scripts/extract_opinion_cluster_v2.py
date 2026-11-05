#!/usr/bin/env python3
"""Extract opinion_id -> cluster_id from the opinions bulk CSV.

The bulk CSV is non-standard: html/plain_text fields contain literal backslash
quotes (\") and embedded newlines, which break csv.reader. But id (col 0) and
cluster_id (last col) are always plain quoted numbers at the record start/end.

We stream physical lines and match:
  id      : ^"(\d+)",        (record start)
  cluster_id: ,"(\d+)"\n$   (record end)
and pair them, ignoring the middle text entirely.

Usage:
  lbzip2 -dc opinions.csv.bz2 | python3 extract_opinion_cluster_v2.py > out.tsv
"""
import re
import sys

id_pat = re.compile(rb'^"(\d+)",')
cl_pat = re.compile(rb',"(\d+)"\n$')

OUT = sys.argv[1] if len(sys.argv) > 1 else "opinion_cluster.tsv"

current_id = None
out = open(OUT, "wb")
n = 0

for line in sys.stdin.buffer:
    mid = id_pat.match(line)
    mcl = cl_pat.search(line)
    if mid and mcl:
        # single-line record
        out.write(mid.group(1) + b"\t" + mcl.group(1) + b"\n")
        n += 1
    elif mid:
        current_id = mid.group(1)
    elif mcl and current_id:
        out.write(current_id + b"\t" + mcl.group(1) + b"\n")
        n += 1
        current_id = None
    # else skip (middle text lines)

out.close()
print(f"DONE extracted {n} pairs -> {OUT}", flush=True)
