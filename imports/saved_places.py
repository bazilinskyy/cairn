#!/usr/bin/env python3
"""Your saved places in Google Maps, for Cairn's wish list: the places you starred, want to go to or put in a list.

Export them with Google Takeout (takeout.google.com: "Maps (your places)" and "Saved"), then, with the zip(s) as they
came or the unpacked folder:

  python imports/saved_places.py ~/Downloads/takeout-*.zip
  python imports/saved_places.py ~/Downloads/Takeout --send mini:repos/contrail/data/saved_places.json

Reads "Maps (your places)/Saved Places.json" (each place with its position) and the lists of "Saved/*.csv" (a title, a
note and a Google Maps link each; a link that holds the position gives it, the others are kept without one). Writes
data/saved_places.json: [{"name", "lat", "lon", "list", "note", "url", "address", "saved"}], one per place.
"""
import argparse
import csv
import io
import json
import re
import subprocess
import sys
import zipfile
from pathlib import Path

HERE = Path(__file__).resolve().parent


def files(paths):
    """(name, bytes) of every Saved Places.json and Saved/*.csv in these zips and folders."""
    wanted = lambda n: n.endswith("Saved Places.json") or ("/Saved/" in n.replace("\\", "/") and n.endswith(".csv"))  # noqa: E731
    for p in map(Path, paths):
        if p.is_dir():
            for f in p.rglob("*"):
                if f.is_file() and wanted(str(f)):
                    yield str(f), f.read_bytes()
        elif zipfile.is_zipfile(p):
            with zipfile.ZipFile(p) as z:
                for n in z.namelist():
                    if wanted(n):
                        yield n, z.read(n)


def at_of(url):
    """The position a Google Maps link holds (…/@52.37,4.89,… or ?q=52.37,4.89), or None."""
    m = re.search(r"@(-?\d+\.\d+),(-?\d+\.\d+)", url or "") or re.search(r"[?&](?:q|ll|query)=(-?\d+\.\d+),\s*(-?\d+\.\d+)", url or "")
    return (float(m.group(1)), float(m.group(2))) if m else None


def read(paths):
    places = {}
    for name, data in files(paths):
        if name.endswith(".json"):
            for f in json.loads(data).get("features", []):
                lon, lat = (f.get("geometry") or {}).get("coordinates", [None, None])[:2]
                p = f.get("properties") or {}
                loc = p.get("location") or p.get("Location") or {}
                title = p.get("Title") or loc.get("name") or loc.get("Business Name") or p.get("name") or ""
                if lat in (None, 0) and lon in (None, 0):
                    continue
                url = p.get("google_maps_url") or p.get("Google Maps URL") or ""
                key = url or f"{lat},{lon}"
                place = {"name": title, "lat": lat, "lon": lon, "list": "Starred", "note": p.get("Comment", ""),
                         "url": url, "address": loc.get("address") or loc.get("Address") or "", "saved": (p.get("date") or p.get("Published") or "")[:10]}
                old = places.get(key)
                if old:  # read from a list first: the list's name and note stay, the position and address come from here
                    place.update(list=old["list"], note=old["note"] or place["note"])
                places[key] = place
        else:
            lst = Path(name).stem
            for row in csv.DictReader(io.StringIO(data.decode("utf-8-sig"))):
                url = row.get("URL") or row.get("Url") or ""
                title = row.get("Title") or row.get("Name") or ""
                if not title and not url:
                    continue
                pos = at_of(url)
                key = url or f"{lst}|{title}"
                old = places.get(key)
                if old:  # a starred place also in a list: the list is the better name for it
                    old["list"] = lst if old["list"] == "Starred" else old["list"]
                    old["note"] = old["note"] or row.get("Note") or ""
                    continue
                places[key] = {"name": title, "lat": pos[0] if pos else None, "lon": pos[1] if pos else None, "list": lst,
                               "note": row.get("Note") or row.get("Comment") or "", "url": url, "address": "", "saved": ""}
    return list(places.values())


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("paths", nargs="+", help="Google Takeout zip(s) or the unpacked folder")
    data_dir = HERE.parent / "data"
    ap.add_argument("--out", default=str(data_dir / "saved_places.json" if data_dir.is_dir() else "saved_places.json"))
    ap.add_argument("--send", metavar="HOST:PATH", help="also copy the result there with scp")
    args = ap.parse_args(argv)
    places = read(args.paths)
    out = Path(args.out)
    out.write_text(json.dumps(places, ensure_ascii=False, indent=1))
    placed = sum(1 for p in places if p["lat"] is not None)
    print(f"{len(places)} saved places ({placed} with a position) in {out}")
    if args.send:
        subprocess.run(["scp", "-q", str(out), args.send], check=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
