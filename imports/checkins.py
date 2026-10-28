#!/usr/bin/env python3
"""Places you were at a known time, from data downloads, into Cairn: check-ins and posts with a place (Facebook), posts
and photos with a place (Instagram), photos and posts with a place (VK, where its archive gives one), your Google Maps
reviews, and your Uber and Bolt rides (where they picked you up and dropped you off). Cairn counts them for your towns,
countries and trips, and shows them as the 📍 Check-ins layer.

Give it the downloads as they came (zip files or unpacked folders), any number and mixed; it finds what each holds:

  python imports/checkins.py ~/Downloads/facebook-*.zip ~/Downloads/instagram-*.zip
  python imports/checkins.py ~/Downloads/takeout-*.zip ~/Downloads/Uber\\ Data --send mini:repos/contrail/data/checkins.json

Writes data/checkins.json: [{"t": unix time, "lat", "lon", "name", "source", "kind"}], sorted by time. What was in it
from sources this run did not read is kept (Facebook today, Uber next week). Standard library only, no network.
"""
import argparse
import csv
import io
import json
import re
import subprocess
import sys
import zipfile
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent


# --- reading the downloads: (name, bytes) of every file in zips and folders ---

def files(paths):
    for p in map(Path, paths):
        if p.is_dir():
            for f in sorted(p.rglob("*")):
                if f.is_file() and f.suffix.lower() in (".json", ".csv", ".html", ".htm"):
                    yield str(f), f.read_bytes()
        elif zipfile.is_zipfile(p):
            with zipfile.ZipFile(p) as z:
                for n in z.namelist():
                    if n.lower().endswith((".json", ".csv", ".html", ".htm")):
                        yield n, z.read(n)
        elif p.is_file():
            yield str(p), p.read_bytes()


def fix_text(s):
    """Facebook and Instagram write UTF-8 as if it were Latin-1 ("ZÃ¼rich"): undone where it was."""
    if not isinstance(s, str):
        return s
    try:
        return s.encode("latin-1").decode("utf-8")
    except (UnicodeEncodeError, UnicodeDecodeError):
        return s


def number(v):
    try:
        x = float(v)
        return x if x == x else None
    except (TypeError, ValueError):
        return None


def place_in(o):
    """The first place with coordinates anywhere inside o: (lat, lon, name) or None."""
    if isinstance(o, dict):
        for la, lo in (("latitude", "longitude"), ("lat", "lng"), ("lat", "lon")):
            lat, lon = number(o.get(la)), number(o.get(lo))
            if lat is not None and lon is not None and (lat, lon) != (0, 0) and -90 <= lat <= 90 and -180 <= lon <= 180:
                return lat, lon, fix_text(o.get("name") or "")
        if isinstance(o.get("coordinate"), dict):
            got = place_in(o["coordinate"])
            if got:
                return got[0], got[1], fix_text(o.get("name") or got[2])
        for k, v in o.items():
            got = place_in(v)
            if got:
                name = got[2] or (fix_text(o.get("name")) if k in ("coordinate", "place", "location") else "")
                return got[0], got[1], name
    elif isinstance(o, list):
        for v in o:
            got = place_in(v)
            if got:
                return got
    return None


def time_in(o):
    """When an item happened: a photo's own time first (anywhere inside it), else its post's (unix seconds), or None."""
    def find(o, key):
        if isinstance(o, dict):
            t = number(o.get(key))
            if t and t > 1e8:
                return int(t)
            o = list(o.values())
        if isinstance(o, list):
            for v in o:
                t = find(v, key)
                if t:
                    return t
        return None
    for key in ("taken_timestamp", "timestamp", "creation_timestamp"):
        t = find(o, key) if key != "timestamp" else (int(o["timestamp"]) if isinstance(o, dict) and number(o.get("timestamp")) else None)
        if t:
            return t
    return find(o, "timestamp")


def items(doc):
    """The posts (or media) of a Facebook or Instagram JSON file: its top-level list, or the list it wraps."""
    if isinstance(doc, list):
        return doc
    if isinstance(doc, dict):
        for v in doc.values():
            if isinstance(v, list) and v and isinstance(v[0], dict):
                return v
    return []


def from_meta(name, data, source):
    """Facebook and Instagram JSON: every post, check-in or photo with a place and a time."""
    try:
        doc = json.loads(data)
    except ValueError:
        return []
    out = []
    for it in items(doc):
        got, t = place_in(it), time_in(it)
        if got and t:
            kind = "check-in" if "check" in json.dumps(it)[:2000].lower() and source == "facebook" else "post"
            out.append({"t": t, "lat": got[0], "lon": got[1], "name": got[2], "source": source, "kind": kind})
    return out


def from_reviews(data):
    """Google Takeout's Maps reviews (Reviews.json, GeoJSON): each review's place and day."""
    try:
        doc = json.loads(data)
    except ValueError:
        return []
    out = []
    for f in doc.get("features", []):
        lon, lat = ((f.get("geometry") or {}).get("coordinates") or [None, None])[:2]
        p = f.get("properties") or {}
        when = p.get("date") or p.get("Published") or ""
        if lat is None or not when:
            continue
        try:
            t = int(datetime.fromisoformat(when.replace("Z", "+00:00")).timestamp())
        except ValueError:
            continue
        loc = p.get("location") or p.get("Location") or {}
        out.append({"t": t, "lat": lat, "lon": lon, "name": loc.get("name") or loc.get("Business Name") or "", "source": "google reviews", "kind": "review"})
    return out


def parse_time(s):
    """'2019-09-16 12:34:56 +0000 UTC', '2019-09-16T12:34:56Z', '16.09.2019 12:34' -> unix seconds, or None."""
    s = (s or "").strip().replace(" UTC", "")
    for fmt in ("%Y-%m-%d %H:%M:%S %z", "%Y-%m-%d %H:%M:%S", "%Y-%m-%dT%H:%M:%S%z", "%Y-%m-%dT%H:%M:%S.%f%z", "%Y-%m-%dT%H:%M:%S",
                "%Y-%m-%d %H:%M", "%d.%m.%Y %H:%M", "%d/%m/%Y %H:%M", "%m/%d/%Y %H:%M"):
        try:
            d = datetime.strptime(s.replace("Z", "+0000"), fmt)
            return int((d if d.tzinfo else d.replace(tzinfo=timezone.utc)).timestamp())
        except ValueError:
            continue
    return None


def from_rides(name, data, source):
    """Uber's trips_data.csv or a Bolt (or other) ride CSV: where each completed ride began and ended, and when.
    Columns are found by their names: a time, and the pick-up and drop-off latitude and longitude."""
    text = data.decode("utf-8-sig", "replace")
    rows = list(csv.DictReader(io.StringIO(text)))
    if not rows:
        return []
    cols = [c for c in rows[0].keys() if c]
    low = {c: c.lower() for c in cols}
    find = lambda *words, no=(): next((c for c in cols if all(w in low[c] for w in words) and not any(n in low[c] for n in no)), None)  # noqa: E731
    begin = (find("begin", "lat") or find("pickup", "lat") or find("pick-up", "lat") or find("start", "lat") or find("origin", "lat"),
             find("begin", "lng") or find("begin", "lon") or find("pickup", "lng") or find("pickup", "lon") or find("pick-up", "lon")
             or find("start", "lng") or find("start", "lon") or find("origin", "lng") or find("origin", "lon"))
    end = (find("dropoff", "lat") or find("drop-off", "lat") or find("destination", "lat") or find("end", "lat"),
           find("dropoff", "lng") or find("dropoff", "lon") or find("drop-off", "lon") or find("destination", "lng") or find("destination", "lon")
           or find("end", "lng") or find("end", "lon"))
    t0, t1 = find("begin", "time") or find("request", "time") or find("created") or find("date", no=("dropoff",)), find("dropoff", "time") or find("end", "time")
    status = find("status")
    addr0, addr1 = find("begin", "address") or find("pickup", "address"), find("dropoff", "address") or find("destination", "address")
    if not (begin[0] and begin[1] and t0):
        return []
    out = []
    for r in rows:
        if status and r.get(status) and not re.search(r"complet|finish|done", r[status], re.I):
            continue
        a = parse_time(r.get(t0))
        for (la, lo), t, addr in ((begin, a, addr0), (end, parse_time(r.get(t1)) if t1 else a, addr1)):
            lat, lon = number(r.get(la)) if la else None, number(r.get(lo)) if lo else None
            if lat is not None and lon is not None and t and (lat, lon) != (0, 0):
                out.append({"t": t, "lat": lat, "lon": lon, "name": (r.get(addr) or "").strip() if addr else "", "source": source, "kind": "ride"})
    return out


VK_DATE = re.compile(r"(\d{1,2}) (jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|янв|фев|мар|апр|мая|июн|июл|авг|сен|окт|ноя|дек)\w* (\d{4})(?: (?:at|в) (\d{1,2}):(\d{2}))?", re.I)
VK_GEO = re.compile(r"(?:q=|ll=|geo=|center=)(-?\d{1,2}\.\d{3,})[,%2C]+(-?\d{1,3}\.\d{3,})")
MONTHS = {m: i + 1 for i, m in enumerate("jan feb mar apr may jun jul aug sep oct nov dec".split())}
MONTHS.update({m: i + 1 for i, m in enumerate("янв фев мар апр мая июн июл авг сен окт ноя дек".split())})


def from_vk(name, data):
    """VK's archive (HTML pages): a post or photo whose block has a map link with coordinates, and a date."""
    html = data.decode("utf-8", "replace")
    out = []
    for block in re.split(r'<div class="item"', html)[1:]:
        g, d = VK_GEO.search(block), VK_DATE.search(block)
        if not (g and d):
            continue
        day, mon, year, hh, mm = d.groups()
        t = int(datetime(int(year), MONTHS[mon.lower()[:3]], int(day), int(hh or 12), int(mm or 0), tzinfo=timezone.utc).timestamp())
        out.append({"t": t, "lat": float(g.group(1)), "lon": float(g.group(2)), "name": "", "source": "vk", "kind": "post"})
    return out


def read(paths):
    """Everything the downloads hold, and the sources found: (list, set of sources)."""
    out, seen = [], set()
    for name, data in files(paths):
        n = name.replace("\\", "/").lower()
        got = []
        if n.endswith(".json") and ("reviews" in n.split("/")[-1]):
            got = from_reviews(data)
        elif n.endswith(".json") and ("instagram" in n or "/media/" in n or n.split("/")[-1].startswith(("posts_", "stories", "media"))) and "facebook" not in n:
            got = from_meta(name, data, "instagram")
        elif n.endswith(".json") and ("facebook" in n or "your_posts" in n or "check" in n or "your_activity_across_facebook" in n or "/posts/" in n):
            got = from_meta(name, data, "facebook")
        elif n.endswith(".csv") and ("uber" in n or "trips_data" in n):
            got = from_rides(name, data, "uber")
        elif n.endswith(".csv") and ("bolt" in n or "ride" in n):
            got = from_rides(name, data, "bolt")
        elif n.endswith((".html", ".htm")) and ("vk" in n or "/wall" in n or "/photos" in n):
            got = from_vk(name, data)
        for c in got:
            seen.add(c["source"])
        out.extend(got)
    # one per place and minute (a photo set of one post is one check-in)
    unique = {(c["source"], c["t"] // 60, round(c["lat"], 4), round(c["lon"], 4)): c for c in out}
    return sorted(unique.values(), key=lambda c: c["t"]), seen


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("paths", nargs="+", help="data downloads: zip files or unpacked folders")
    data_dir = HERE.parent / "data"
    ap.add_argument("--out", default=str(data_dir / "checkins.json" if data_dir.is_dir() else "checkins.json"))
    ap.add_argument("--send", metavar="HOST:PATH", help="also copy the result there with scp")
    args = ap.parse_args(argv)
    found, sources = read(args.paths)
    out = Path(args.out)
    try:
        kept = [c for c in json.loads(out.read_text()) if c.get("source") not in sources]
    except (OSError, ValueError):
        kept = []
    every = sorted(kept + found, key=lambda c: c["t"])
    out.write_text(json.dumps(every, ensure_ascii=False))
    by = {s: sum(1 for c in found if c["source"] == s) for s in sorted(sources)}
    print(f"{len(found)} places from {', '.join(f'{s} ({n})' for s, n in by.items()) or 'nothing found'}; {len(every)} in {out}")
    if args.send:
        subprocess.run(["scp", "-q", str(out), args.send], check=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
