#!/usr/bin/env python3
"""Where your photos were taken, for Contrail's map: rounded to about 1 km, counted per place and year.
From Apple Photos, a folder of files, or Google Photos (through Google Takeout).

Only the rounded places, counts and days leave the library: no file names, no pictures, no exact positions.
  - Apple Photos library (macOS), through osxphotos, which needs no install with uv:
      uv run --with osxphotos python imports/photos.py
      uv run --with osxphotos python imports/photos.py --library ~/Pictures/Other.photoslibrary
  - a folder of photos and videos, through exiftool (brew install exiftool):
      python imports/photos.py --folder ~/Pictures/Exports
  - Google Photos, from a Google Takeout export (takeout.google.com, only Google Photos): the zips as they come, or
    their unpacked folder; only the small .json file beside each photo is read, never the photo itself:
      python imports/photos.py --takeout ~/Downloads/takeout-*.zip
Sources can be combined in one run (each run replaces the file): a photo in two of them, the same moment and place, counts
once. Writes data/photos.json: [{"lat", "lon", "year", "count", "days": ["YYYY-MM-DD", ...]}]; --send HOST:PATH also
copies it there with scp, for example to the Mac that runs Contrail: --send mini:repos/contrail/data/photos.json
"""
import argparse
import json
import subprocess
import sys
import zipfile
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

CELL = 0.01  # degrees: about 1 km


def unique(shots):
    """The same photo from two sources (the laptop's Apple Photos and a Google Takeout of the same pictures) once: same
    moment to the second, about the same place. shots: (lat, lon, day, unix time or None)."""
    seen = set()
    for lat, lon, day, stamp in shots:
        if stamp is not None and lat is not None and lon is not None:
            key = (stamp, round(lat, 3), round(lon, 3))
            if key in seen:
                continue
            seen.add(key)
        yield lat, lon, day, stamp


def cells(shots):
    """shots: (lat, lon, day[, unix time]) -> one entry per rounded place and year."""
    agg = defaultdict(lambda: [0, set()])
    for lat, lon, day, *_ in shots:
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
        yield lat, lon, p.date.strftime("%Y-%m-%d") if p.date else "", int(p.date.timestamp()) if p.date else None


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
        yield f.get("GPSLatitude"), f.get("GPSLongitude"), day, None  # no time zone: cannot be matched to another source


def from_takeout(paths):
    """Google Photos in Takeout: each photo or video has a JSON file beside it (IMG_1.jpg.json, newer exports
    IMG_1.jpg.supplemental-metadata.json, cut short when long) with photoTakenTime and geoData, which Google fills from
    the camera or from a place you set in Google Photos. A photo in an album is there twice: counted once."""
    def docs():
        for p in map(Path, paths):
            if p.is_dir():
                for f in p.rglob("*.json"):
                    yield f.read_bytes
            elif zipfile.is_zipfile(p):
                with zipfile.ZipFile(p) as z:
                    for name in z.namelist():
                        if name.endswith(".json"):
                            yield lambda name=name, z=z: z.read(name)
    seen = set()
    for read in docs():
        try:
            d = json.loads(read())
        except (ValueError, UnicodeDecodeError):
            continue
        taken = (d.get("photoTakenTime") or {}).get("timestamp") if isinstance(d, dict) else None
        if not taken or (d.get("title"), taken) in seen:
            continue  # album metadata, or a copy of a photo already counted
        seen.add((d.get("title"), taken))
        geo = d.get("geoData") or {}
        if not geo.get("latitude") and not geo.get("longitude"):
            geo = d.get("geoDataExif") or {}
        day = datetime.fromtimestamp(int(taken), timezone.utc).strftime("%Y-%m-%d")
        yield geo.get("latitude"), geo.get("longitude"), day, int(taken)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--library", action="append", help="an Apple Photos library (default, with no other source: "
                    "~/Pictures/Photos Library.photoslibrary); may be given more than once")
    ap.add_argument("--folder", action="append", help="a folder of photos and videos (needs exiftool)")
    ap.add_argument("--takeout", nargs="+", metavar="ZIP_OR_FOLDER", help="Google Photos from Google Takeout")
    data = Path(__file__).resolve().parent.parent / "data"  # Contrail's data folder in a checkout, else here
    ap.add_argument("--out", default=str(data / "photos.json" if data.is_dir() else Path("photos.json")))
    ap.add_argument("--send", metavar="HOST:PATH", help="also copy the result there with scp")
    args = ap.parse_args(argv)
    sources = [from_library(lib) for lib in args.library or []] + [from_folder(f) for f in args.folder or []]
    if args.takeout:
        sources.append(from_takeout(args.takeout))
    result = cells(unique(shot for source in (sources or [from_library(None)]) for shot in source))
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(result, separators=(",", ":")))
    print(f"{sum(c['count'] for c in result)} photos with a place, in {len(result)} places and years, written to {out}")
    if args.send:
        subprocess.run(["scp", "-q", str(out), args.send], check=True)
        print(f"sent to {args.send}")


if __name__ == "__main__":
    main()
