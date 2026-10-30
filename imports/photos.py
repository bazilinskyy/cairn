#!/usr/bin/env python3
"""Where your photos were taken, for Cairn's map: rounded to about 1 km, counted per place and year.
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
copies it there with scp, for example to the Mac that runs Cairn: --send mini:repos/contrail/data/photos.json
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
    moment to the second and about the same place, or the same file name on the same day. shots: (lat, lon, day, unix
    time or None[, file path, file name])."""
    seen = set()
    for shot in shots:
        lat, lon, day, stamp = shot[:4]
        name = shot[5] if len(shot) > 5 else None
        keys = []
        if stamp is not None and lat is not None and lon is not None:
            keys.append((stamp, round(lat, 3), round(lon, 3)))
        if name and day:
            keys.append((Path(name).stem.lower().split("(")[0], day))
        if any(k in seen for k in keys):
            continue
        seen.update(keys)
        yield shot


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
        db = library_db(path or (str(usual) if usual.exists() else None))
    except FileNotFoundError:
        sys.exit("no Photos library found: name it with --library")
    for p in db.photos():
        lat, lon = p.location
        yield (lat, lon, p.date.strftime("%Y-%m-%d") if p.date else "", int(p.date.timestamp()) if p.date else None,
               p.path, p.original_filename)


_dbs = {}


def library_db(path):
    """The library's osxphotos database, read once per run (it takes a while)."""
    import osxphotos
    if path not in _dbs:
        _dbs[path] = osxphotos.PhotosDB(dbfile=path)
    return _dbs[path]


def library_albums(path, out):
    """The albums of an Apple Photos library with their photos, for Cairn's album suggestions (albums.js), which read it
    instead of a Google Takeout folder: [{"album", "photos": [[file name, file path, unix time or 0, has a place]]}]."""
    db = library_db(path)
    albums = {}
    for p in db.photos():
        if not p.path:
            continue
        lat, _ = p.location
        row = [p.original_filename, p.path, int(p.date.timestamp()) if p.date else 0, lat is not None]
        for a in p.albums:
            albums.setdefault(a, []).append(row)
    Path(out).write_text(json.dumps([{"album": a, "photos": rows} for a, rows in sorted(albums.items())], separators=(",", ":")))
    print(f"{len(albums)} albums written to {out}")


def library_unplaced(path, out):
    """The photos and videos of an Apple Photos library that have no place, for Cairn's page to place them by hand
    (#place-photos): [[unix time or 0, file path, file name, [album, ...], 1 for a video else 0]], by time."""
    rows = []
    for p in library_db(path).photos(images=True, movies=True):
        lat, _ = p.location
        if lat is not None or not p.path:
            continue
        rows.append([int(p.date.timestamp()) if p.date else 0, p.path, p.original_filename, sorted(p.albums), 1 if p.ismovie else 0])
    rows.sort(key=lambda r: r[0])
    Path(out).write_text(json.dumps(rows, separators=(",", ":"), ensure_ascii=False))
    print(f"{len(rows)} photos with no place written to {out}")


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
    def docs():  # (read, the photo's file when it is on disk)
        for p in map(Path, paths):
            if p.is_dir():
                for f in p.rglob("*.json"):
                    yield f.read_bytes, media_of(f)
            elif zipfile.is_zipfile(p):
                with zipfile.ZipFile(p) as z:
                    for name in z.namelist():
                        if name.endswith(".json"):
                            yield (lambda name=name, z=z: z.read(name)), None
    seen = set()
    for read, media in docs():
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
        yield geo.get("latitude"), geo.get("longitude"), day, int(taken), str(media) if media else None, d.get("title")


def media_of(sidecar):
    """The photo a Takeout .json belongs to: IMG_1.jpg.supplemental-metadata.json -> IMG_1.jpg; Google numbers
    duplicates on the .json's end: 2020-09-29.jpg.supplemental-metadata(786).json -> 2020-09-29(786).jpg."""
    import re
    m = re.match(r"(.+?)(\.[^.]+)\.(?:supplemental-metadata|supplemental-metad|supplemental-me|supplemental|suppl)?[^.]*?(\(\d+\))?\.json$", sidecar.name)
    if not m:
        return None
    f = sidecar.with_name(m.group(1) + (m.group(3) or "") + m.group(2))
    return f if f.exists() else None


def from_sidecars(folder):
    """An osxphotos export (osxphotos export --sidecar json): each photo with a .json beside it holding its EXIF (local
    time, no time zone: matched to other sources by file name and day)."""
    for f in Path(folder).rglob("*.json"):
        try:
            d = json.loads(f.read_text())
        except (ValueError, OSError):
            continue
        d = d[0] if isinstance(d, list) and d else d
        if not isinstance(d, dict):
            continue
        lat, lon = d.get("EXIF:GPSLatitude"), d.get("EXIF:GPSLongitude")
        if lat is not None and str(d.get("EXIF:GPSLatitudeRef", "N")).upper().startswith("S"):
            lat = -abs(lat)
        if lon is not None and str(d.get("EXIF:GPSLongitudeRef", "E")).upper().startswith("W"):
            lon = -abs(lon)
        when = str(d.get("EXIF:DateTimeOriginal") or d.get("EXIF:CreateDate") or d.get("QuickTime:CreateDate") or "")
        try:
            t = datetime.strptime(when[:19], "%Y:%m:%d %H:%M:%S")
        except ValueError:
            continue
        media = f.with_suffix("")  # IMG_1.jpeg.json -> IMG_1.jpeg
        yield lat, lon, t.strftime("%Y-%m-%d"), int(t.replace(tzinfo=timezone.utc).timestamp()), str(media) if media.exists() else None, media.name


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--library", action="append", help="an Apple Photos library (default, with no other source: "
                    "~/Pictures/Photos Library.photoslibrary); may be given more than once")
    ap.add_argument("--folder", action="append", help="a folder of photos and videos (needs exiftool)")
    ap.add_argument("--takeout", nargs="+", metavar="ZIP_OR_FOLDER", help="Google Photos from Google Takeout")
    ap.add_argument("--sidecars", action="append", help="an osxphotos export folder (photos with .json sidecars)")
    ap.add_argument("--points", metavar="FILE", help="also every photo with its exact place, time and file, for Cairn's "
                    "photo layer and trips (on the Mac that runs Cairn: data/photo_points.json)")
    data = Path(__file__).resolve().parent.parent / "data"  # Cairn's data folder in a checkout, else here
    ap.add_argument("--albums", metavar="FILE", help="also the library's albums with their photos, for Cairn's album "
                    "suggestions (on the Mac that runs Cairn: data/photo_albums.json)")
    ap.add_argument("--unplaced", metavar="FILE", help="also the library's photos with no place, for Cairn's page to place "
                    "them by hand (on the Mac that runs Cairn: data/photo_unplaced.json)")
    ap.add_argument("--out", default=str(data / "photos.json" if data.is_dir() else Path("photos.json")))
    ap.add_argument("--send", metavar="HOST:PATH", help="also copy the result there with scp")
    args = ap.parse_args(argv)
    sources = [from_library(lib) for lib in args.library or []] + [from_folder(f) for f in args.folder or []]
    if args.takeout:
        sources.append(from_takeout(args.takeout))
    sources += [from_sidecars(f) for f in args.sidecars or []]
    shots = list(unique(shot for source in (sources or [from_library(None)]) for shot in source))
    result = cells(shots)
    if args.points:  # [[unix time, lat, lon, file path or ""], ...] by time, the ones with a place
        pts = sorted([s[3], round(s[0], 6), round(s[1], 6), (s[4] if len(s) > 4 else None) or ""] for s in shots
                     if s[3] is not None and s[0] is not None and s[1] is not None and not (s[0] == 0 and s[1] == 0))
        Path(args.points).write_text(json.dumps(pts, separators=(",", ":")))
        print(f"{len(pts)} photos with a place and time, written to {args.points}")
    library = (args.library or [None])[0] or str(Path("~/Pictures/Photos Library.photoslibrary").expanduser())
    if args.albums:
        library_albums(library, args.albums)
    if args.unplaced:
        library_unplaced(library, args.unplaced)
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(result, separators=(",", ":")))
    print(f"{sum(c['count'] for c in result)} photos with a place, in {len(result)} places and years, written to {out}")
    if args.send:
        subprocess.run(["scp", "-q", str(out), args.send], check=True)
        print(f"sent to {args.send}")


if __name__ == "__main__":
    main()
