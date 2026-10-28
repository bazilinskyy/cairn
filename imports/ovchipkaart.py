#!/usr/bin/env python3
"""Your OV-chipkaart journeys (Dutch trains, buses, trams and metros) into Cairn's trains and buses.

On ov-chipkaart.nl, Mijn OV-chip > your card > Reishistorie: choose the period (up to 18 months back) and download it
as CSV; do so for each card. Then:

  python imports/ovchipkaart.py ~/Downloads/reizen*.csv
  python imports/ovchipkaart.py ~/Downloads/reizen*.csv --cairn http://127.0.0.1:3000 --dry-run

Each check-out is a journey from where you checked in to where you checked out. The journeys are counted per route
and year, so a daily commute is one line ("Leiden -> Haarlem, 2024, x180"), not 180: each becomes a trip of that
year in Cairn (known to the year, so it makes no day of its own) with how many times you took it. A station's name
alone ("Leiden") is a train; a stop with its town ("Leiden, Station") a bus, tram or metro. Sending the same file again
updates the counts, it adds nothing twice. Standard library only.
"""
import argparse
import csv
import io
import json
import re
import sys
import urllib.request
from collections import Counter
from pathlib import Path

HERE = Path(__file__).resolve().parent


def rows(data):
    text = data.decode("utf-8-sig", "replace")
    delim = ";" if text[:2000].count(";") > text[:2000].count(",") else ","
    return list(csv.DictReader(io.StringIO(text), delimiter=delim))


def journeys(paths):
    """(year, from, to, mode) of every check-out."""
    out = []
    for p in map(Path, paths):
        for r in rows(p.read_bytes()):
            r = {(k or "").strip().lower(): (v or "").strip() for k, v in r.items()}
            kind, a, b, when = r.get("transactie", ""), r.get("vertrek", ""), r.get("bestemming", ""), r.get("datum", "")
            if not re.search(r"check-?uit|check-?out", kind, re.I) or not a or not b or a == b:
                continue
            m = re.search(r"(\d{4})", when if re.match(r"\d{4}", when) else when[-4:])
            if not m:
                continue
            mode = "bus" if ("," in a or "," in b) else "train"
            out.append((m.group(1), a, b, mode))
    return out


def legs(paths):
    return [{"mode": mode, "from": a, "to": b, "date": f"{year}-01-01 12:00:00", "approx": "year", "times": n,
             "source": "ov-chipkaart", "service": "OV-chipkaart", "event_id": f"ov|{year}|{mode}|{a}|{b}"}
            for (year, a, b, mode), n in sorted(Counter(journeys(paths)).items())]


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("paths", nargs="+", help="Reishistorie CSV files")
    ap.add_argument("--cairn", default="http://127.0.0.1:3000", help="Cairn's address (on the Mac that runs it)")
    ap.add_argument("--dry-run", action="store_true", help="list the routes, send nothing")
    args = ap.parse_args(argv)
    found = legs(args.paths)
    for leg in found:
        print(f"{leg['date'][:4]} {leg['mode']:5} {leg['from']} -> {leg['to']} x{leg['times']}")
        if not args.dry_run:
            req = urllib.request.Request(args.cairn.rstrip("/") + "/api/ground", json.dumps(leg).encode(),
                                         {"Content-Type": "application/json"}, method="POST")
            urllib.request.urlopen(req, timeout=30).read()
    print(f"{len(found)} routes, {sum(x['times'] for x in found)} journeys{' (dry run: nothing sent)' if args.dry_run else ' sent to Cairn'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
