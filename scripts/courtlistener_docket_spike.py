#!/usr/bin/env python3
"""CourtListener docket-entries API availability spike.

Purpose: decide, with evidence, whether RECAP docket entries can be pulled at
scale and cheaply normalized — BEFORE committing to it as a dataset.

Reads COURTLISTENER_TOKEN from env (never hard-coded). Samples N docket ids from
the local dockets.csv.bz2 and fetches their docket entries from API v4.

Outputs JSON stats only; no model, no writes to the graph.
"""
import bz2
import csv
import json
import os
import sys
import time
import random
import urllib.request
import urllib.error
from collections import Counter

BASE = "/workspace/03_data/case_valid_prep/courtlistener"
DOCKETS = os.path.join(BASE, "dockets.csv.bz2")
API = "https://www.courtlistener.com/api/rest/v4/docket-entries/"
N_DOCKETS = int(os.environ.get("SPIKE_N", "100"))
PAGE_SIZE = 100
TOKEN = os.environ.get("COURTLISTENER_TOKEN", "").strip()
OUT = os.environ.get("SPIKE_OUT", "/workspace/03_data/case_valid_prep/courtlistener/docket_spike.json")


def sample_docket_ids(n):
    """Reservoir-sample n docket ids from the (possibly huge) dockets csv."""
    ids, seen = [], 0
    with bz2.open(DOCKETS, "rt", encoding="utf-8", errors="ignore") as f:
        r = csv.reader(f)
        header = next(r)
        i_id = header.index("id")
        for row in r:
            seen += 1
            if len(row) <= i_id:
                continue
            try:
                did = int(row[i_id])
            except ValueError:
                continue
            if len(ids) < n:
                ids.append(did)
            else:
                j = random.randint(0, seen - 1)
                if j < n:
                    ids[j] = did
    return ids


def fetch_entries(docket_id):
    url = f"{API}?docket={docket_id}&page_size={PAGE_SIZE}"
    req = urllib.request.Request(url, headers={
        "Authorization": f"Token {TOKEN}",
        "User-Agent": "torra-recAP-spike/0.1",
    })
    out = []
    while url:
        with urllib.request.urlopen(req, timeout=40) as resp:
            body = json.loads(resp.read().decode("utf-8"))
        out.extend(body.get("results", []))
        url = body.get("next")
        if url:
            req = urllib.request.Request(url, headers={
                "Authorization": f"Token {TOKEN}",
                "User-Agent": "torra-recAP-spike/0.1",
            })
        time.sleep(0.2)  # be polite to the API
    return out


def main():
    if not TOKEN:
        print("ERROR: COURTLISTENER_TOKEN not set. Configure it, then re-run.", file=sys.stderr)
        sys.exit(2)
    random.seed(0)
    ids = sample_docket_ids(N_DOCKETS)
    print(f"sampled {len(ids)} docket ids", flush=True)

    per_case, spans, desc_counter = [], [], Counter()
    ok, empty, err = 0, 0, 0
    for k, did in enumerate(ids):
        try:
            ents = fetch_entries(did)
        except urllib.error.HTTPError as e:
            err += 1
            print(f"  docket {did}: HTTP {e.code}", flush=True)
            if e.code in (401, 403):
                print("auth/rate problem — aborting", file=sys.stderr)
                break
            continue
        except Exception as e:
            err += 1
            print(f"  docket {did}: {e}", flush=True)
            continue
        ok += 1
        dates = []
        for e in ents:
            d = e.get("date_filed")
            if d:
                dates.append(d)
            desc = (e.get("description") or "").strip()
            if desc:
                # crude normalization probe: first 3 words lowercased
                desc_counter[" ".join(desc.lower().split()[:3])] += 1
        per_case.append(len(ents))
        if not ents:
            empty += 1
        elif len(dates) >= 2:
            try:
                d0 = min(dates)
                d1 = max(dates)
                spans.append(d1 + "|" + d0)
            except Exception:
                pass
        if (k + 1) % 10 == 0:
            print(f"  {k+1}/{len(ids)} done", flush=True)

    def stats(xs):
        if not xs:
            return {"n": 0}
        xs = sorted(xs)
        return {
            "n": len(xs),
            "min": xs[0],
            "median": xs[len(xs) // 2],
            "mean": round(sum(xs) / len(xs), 2),
            "max": xs[-1],
        }

    # span in days
    span_days = []
    for s in spans:
        try:
            d1, d0 = s.split("|")
            y1, m1, dd1 = map(int, d1.split("-"))
            y0, m0, dd0 = map(int, d0.split("-"))
            import datetime
            span_days.append((datetime.date(y1, m1, dd1) - datetime.date(y0, m0, dd0)).days)
        except Exception:
            pass

    result = {
        "api": API,
        "sampled_dockets": len(ids),
        "fetched_ok": ok,
        "empty_dockets": empty,
        "errors": err,
        "events_per_case": stats(per_case),
        "span_days_per_case": stats(span_days),
        "distinct_desc_prefix_top3words": len(desc_counter),
        "top_desc_prefixes": desc_counter.most_common(20),
        "normalization_note": "distinct prefixes = crude lower bound on free-text event types; high count => normalization is a real NLP subtask",
    }
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, indent=2)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    print(f"written: {OUT}")


if __name__ == "__main__":
    main()
