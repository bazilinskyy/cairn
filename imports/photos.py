#!/usr/bin/env python3
"""Where your photos were taken, for Contrail's map: rounded to about 1 km, counted per place and year.

Only the rounded places, counts and days leave the library: no file names, no pictures, no exact positions.
  - Apple Photos library (macOS), through osxphotos, which needs no install with uv:
      uv run --with osxphotos python imports/photos.py
      uv run --with osxphotos python imports/photos.py --library ~/Pictures/Other.photoslibrary
  - a folder of photos and videos, through exiftool (brew install exiftool):
      python imports/photos.py --folder ~/Pictures/Exports
Writes data/photos.json: [{"lat", "lon", "year", "count", "days": ["YYYY-MM-DD", ...]}]; --send HOST:PATH also copies
it there with scp, for example to the Mac that runs Contrail: --send mini:repos/contrail/data/photos.json
"""
import argparse
import json
import subprocess
import sys
from collections import defaultdict
from datetime import datetime
from pathlib import Path

CELL = 0.01  # degrees: about 1 km


def cells(shots):
    """shots: (lat, lon, date) -> one entry per rounded place and year."""
    agg = defaultdict(lambda: [0, set()])
    for lat, lon, day in shots:
        if lat is None or lon is None or not day or (lat == 0 and lon == 0):
            continue
        key = (round(round(lat / CELL) * CELL, 4), round(round(lon / CELL) * CELL, 4), int(day[:4]))
        agg[key][0] += 1
        agg[key][1].add(day)
    return [{"lat": lat, "lon": lon, "year": year, "count": n, "days": sorted(days)}
            for (lat, lon, year), (n, days) in sorted(agg.items(), key=lambda kv: (kv[0][2], kv[0][0], kv[0][1]))]


def from_library(path):
    try:
        import osxphotos
    except ImportError:
        sys.exit("osxphotos is missing: run this with  uv run --with osxphotos python imports/photos.py")
    usual = Path("~/Pictures/Photos Library.photoslibrary").expanduser()
    try:
        db = osxphotos.PhotosDB(dbfile=path or (str(usual) if usual.exists() else None))
    except FileNotFoundError:
        sys.exit("no Photos library found: name it with --library")
    for p in db.photos():
        lat, lon = p.location
        yield lat, lon, p.date.strftime("%Y-%m-%d") if p.date else ""


def from_folder(folder):
    try:
        r = subprocess.run(["exiftool", "-n", "-json", "-r", "-q", "-GPSLatitude", "-GPSLongitude", "-DateTimeOriginal",
                            "-CreateDate", str(folder)], capture_output=True, text=True)
    except FileNotFoundError:
        sys.exit("exiftool is missing: brew install exiftool")
    for f in json.loads(r.stdout or "[]"):
        t = str(f.get("DateTimeOriginal") or f.get("CreateDate") or "")
        day = t[:10].replace(":", "-") if len(t) >= 10 else ""
        try:
            datetime.strptime(day, "%Y-%m-%d")
        except ValueError:
            day = ""
        yield f.get("GPSLatitude"), f.get("GPSLongitude"), day


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    src = ap.add_mutually_exclusive_group()
    src.add_argument("--library", help="an Apple Photos library (default: ~/Pictures/Photos Library.photoslibrary)")
    src.add_argument("--folder", help="a folder of photos and videos (needs exiftool)")
    data = Path(__file__).resolve().parent.parent / "data"  # Contrail's data folder in a checkout, else here
    ap.add_argument("--out", default=str(data / "photos.json" if data.is_dir() else Path("photos.json")))
    ap.add_argument("--send", metavar="HOST:PATH", help="also copy the result there with scp")
    args = ap.parse_args(argv)
    result = cells(from_folder(args.folder) if args.folder else from_library(args.library))
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(result, separators=(",", ":")))
    print(f"{sum(c['count'] for c in result)} photos with a place, in {len(result)} places and years, written to {out}")
    if args.send:
        subprocess.run(["scp", "-q", str(out), args.send], check=True)
        print(f"sent to {args.send}")


if __name__ == "__main__":
    main()
