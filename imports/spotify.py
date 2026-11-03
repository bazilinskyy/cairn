#!/usr/bin/env python3
"""What you played on Spotify, and the country you played it in, from Spotify's "Extended streaming history" (Account
→ Privacy → Download your data → Extended streaming history; it comes in up to 30 days as my_spotify_data.zip).

Every play there has the country your phone or computer was connected from (conn_country): a country for each day you
played anything, back to when you started using Spotify, also for the days nothing else in Cairn has a place for.
Cairn lists the days abroad no trip explains (+ Add → 💡 To check) and adds the songs to towns' and trips' pages,
on the days Last.fm has nothing.

Give it the zip as it came (or the unpacked folder, or its Streaming_History_Audio_*.json / endsong_*.json files):

  python imports/spotify.py ~/Downloads/my_spotify_data.zip --send mini:repos/contrail/data/spotify.json

Writes data/spotify.json: {"plays": [[unix time, artist, track, album], ...] (songs played 30 s or more),
"countries": {"YYYY-MM-DD": {"NL": plays, ...}}} (UTC days; plays made offline are left out of the countries: their
country is where the phone was when it came online again). Replaces what was there. Standard library only.
"""
import argparse
import json
import re
import subprocess
import sys
import zipfile
from datetime import datetime, timezone
from pathlib import Path

MIN_MS = 30_000  # shorter: skipped, not played (Spotify itself counts a stream from 30 s)
HISTORY = re.compile(r"(Streaming_History_Audio|endsong)[^/\\]*\.json$", re.I)


def files(paths):
    for p in map(Path, paths):
        if p.is_dir():
            for f in sorted(p.rglob("*.json")):
                if HISTORY.search(f.name):
                    yield f.name, f.read_bytes()
        elif zipfile.is_zipfile(p):
            with zipfile.ZipFile(p) as z:
                for n in sorted(z.namelist()):
                    if HISTORY.search(n):
                        yield n, z.read(n)
        elif p.is_file():
            yield p.name, p.read_bytes()


def when(s):
    """Spotify's "2019-03-01T10:22:33Z" as unix time."""
    return int(datetime.strptime(s, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc).timestamp())


def load(paths):
    plays, countries, seen = [], {}, set()
    for _, data in files(paths):
        try:
            rows = json.loads(data)
        except ValueError:
            continue
        for r in rows if isinstance(rows, list) else []:
            if not isinstance(r, dict) or not r.get("ts"):
                continue
            t = when(r["ts"])
            key = (t, r.get("spotify_track_uri") or r.get("spotify_episode_uri"))
            if key in seen:  # the same play in two files (a download given twice)
                continue
            seen.add(key)
            cc = (r.get("conn_country") or "").upper()
            if re.fullmatch(r"[A-Z]{2}", cc) and cc != "ZZ" and not r.get("offline") and not r.get("incognito_mode"):
                day = datetime.fromtimestamp(t, timezone.utc).strftime("%Y-%m-%d")
                countries.setdefault(day, {})
                countries[day][cc] = countries[day].get(cc, 0) + 1
            artist, track = r.get("master_metadata_album_artist_name"), r.get("master_metadata_track_name")
            if artist and track and (r.get("ms_played") or 0) >= MIN_MS:
                # an offline play is written when the phone comes online again; offline_timestamp is when it was played
                off = r.get("offline_timestamp") or 0
                if r.get("offline") and off:
                    off = off / 1000 if off > 1e11 else off
                    if 0 < t - off < 90 * 86400:
                        t = int(off)
                plays.append([t, artist, track, r.get("master_metadata_album_album_name") or ""])
    plays.sort(key=lambda p: p[0])
    return {"plays": plays, "countries": dict(sorted(countries.items()))}


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("paths", nargs="+", help="my_spotify_data.zip, its folder, or its Streaming_History_Audio_*.json files")
    ap.add_argument("--out", default=str(Path(__file__).resolve().parent.parent / "data" / "spotify.json"))
    ap.add_argument("--send", help="also copy the result there with scp (host:path)")
    a = ap.parse_args(argv)
    doc = load(a.paths)
    if not doc["plays"] and not doc["countries"]:
        sys.exit("No streaming history in these files: Spotify's Extended streaming history is needed (Streaming_History_Audio_*.json)")
    Path(a.out).write_text(json.dumps(doc, ensure_ascii=False, separators=(",", ":")))
    if a.send:
        subprocess.run(["scp", a.out, a.send], check=True)
    days = list(doc["countries"])
    print(f"{len(doc['plays'])} songs played, {len(days)} days with a country" + (f" ({days[0]} – {days[-1]})" if days else ""))


if __name__ == "__main__":
    main()
