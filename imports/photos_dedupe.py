#!/usr/bin/env python3
"""Photos that are in the Apple Photos library more than once, byte for byte the same file (an export imported twice: a
Facebook photo in "Profile pictures" and again in "Photos from 2008"), down to one:

  uv run --with osxphotos --with 'pyobjc<13' python imports/photos_dedupe.py            # what it would do
  uv run --with osxphotos --with 'pyobjc<13' python imports/photos_dedupe.py --apply    # do it
  uv run --with osxphotos --with 'pyobjc<13' --with pillow --with pillow-heif python imports/photos_dedupe.py --similar

--similar finds the same picture in files that differ (resized, recompressed: a Facebook or Google copy beside the
original) by a perceptual hash of each photo (256-bit difference hash, kept in data/photo_phash.json so a run reads only
new photos): two photos with the same shape, at most --distance bits apart, and nowhere more than --block grey levels
apart on average in any 8x8 block of the two at 64x64 (a burst of shots differs where someone moved: those are not
copies) are copies. Of such a set the largest picture stays (the original, with its own date), and takes the place of a
smaller copy when it has none (in Photos, or in Cairn).

Of each set of copies one stays: the one with a place (in Photos, or given in Cairn: data/photo_places.json), else the one
in the most albums, else the first imported. It is added to every album the others are in, and takes a favourite mark,
title and caption it lacks from them. The others go to the album "To delete: older copies (Cairn)", which Cairn's pages
leave out; deleting them is done by hand in Photos (select all in that album, Delete: they wait 30 days in Recently
Deleted), as Photos cannot delete by script. A copy you took out of Cairn takes the one kept out too; a dropped copy you had placed in Cairn too loses that place there (the one kept has one). Copies already in that album are left alone. Only files of the same size are
read (a hash of each). Waits for nothing: when another job drives Photos it stops.
"""
import argparse
import hashlib
import json
import os
import subprocess
import sys
import time
from collections import defaultdict
from pathlib import Path

TO_DELETE = "To delete: older copies (Cairn)"
CAIRN = Path(__file__).resolve().parent.parent


def busy():
    """Another job driving Photos: two at once make AppleScript hang."""
    r = subprocess.run(["pgrep", "-f", "osxphotos import|photos-after.py|photos-laptop-import|photos_place.py"], capture_output=True, text=True)
    return bool(r.stdout.strip())


def digest(path):
    h = hashlib.sha1()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def copies(photos):
    """The sets of photos whose files are byte for byte the same: [[photo, ...], ...]"""
    by_size = defaultdict(list)
    for p in photos:
        try:
            by_size[os.path.getsize(p.path)].append(p)
        except OSError:
            pass
    out = []
    for group in by_size.values():
        if len(group) < 2:
            continue
        by_hash = defaultdict(list)
        for p in group:
            try:
                by_hash[digest(p.path)].append(p)
            except OSError:
                pass
        out += [same for same in by_hash.values() if len(same) > 1]
    return out


PHASH = CAIRN / "data/photo_phash.json"


def phash(path):
    """(256-bit difference hash as an int, width / height) of a picture, or None when it cannot be read"""
    from PIL import Image
    try:
        import pillow_heif
        pillow_heif.register_heif_opener()
    except ImportError:
        pass
    try:
        with Image.open(path) as im:
            im.draft("L", (128, 128))
            ratio = im.width / im.height
            g = im.convert("L").resize((17, 16), Image.LANCZOS)
            px = list(g.getdata())
    except Exception:
        return None
    bits = 0
    for y in range(16):
        for x in range(16):
            bits = (bits << 1) | (px[y * 17 + x] > px[y * 17 + x + 1])
    return bits, ratio


def small(path):
    """The picture at 64x64 in grey, its levels stretched (a copy may be a little lighter), or None"""
    from PIL import Image, ImageOps
    try:
        import pillow_heif
        pillow_heif.register_heif_opener()
    except ImportError:
        pass
    try:
        with Image.open(path) as im:
            im.draft("L", (256, 256))
            return list(ImageOps.autocontrast(im.convert("L").resize((64, 64), Image.BOX)).getdata())
    except Exception:
        return None


def worst_block(pair):
    """The largest mean difference in grey levels over the 8x8 blocks of two pictures at 64x64 (999: one unreadable)"""
    a, b = small(pair[0]), small(pair[1])
    if not a or not b:
        return 999
    m = 0
    for by in range(8):
        for bx in range(8):
            m = max(m, sum(abs(a[i] - b[i]) for y in range(8) for i in range((by * 8 + y) * 64 + bx * 8, (by * 8 + y) * 64 + bx * 8 + 8)) / 64)
    return m


def similar(photos, distance, block=8):
    """The sets of photos that show the same picture (perceptual hashes at most distance bits apart, the same shape)"""
    from multiprocessing import Pool
    cache = json.loads(PHASH.read_text()) if PHASH.exists() else {}
    pics = [p for p in photos if not p.ismovie]
    todo = []
    for p in pics:
        try:
            st = os.stat(p.path)
        except OSError:
            continue
        c = cache.get(p.path)
        if not c or c[0] != st.st_size:
            todo.append((p.path, st.st_size))
    if todo:
        print(f"hashing {len(todo)} pictures...", flush=True)
        with Pool(max(1, (os.cpu_count() or 2) - 1)) as pool:
            for i, ((path, size), h) in enumerate(zip(todo, pool.imap(phash, [t[0] for t in todo], chunksize=32))):
                cache[path] = [size, f"{h[0]:064x}", round(h[1], 4)] if h else [size, None, None]
                if i % 5000 == 4999:
                    print(f"  {i + 1} of {len(todo)}", flush=True)
                    PHASH.write_text(json.dumps(cache))
        PHASH.write_text(json.dumps(cache))
    known = [(p, int(cache[p.path][1], 16), cache[p.path][2]) for p in pics if cache.get(p.path, [0, None])[1]]
    # pairs at most distance apart share at least one of distance + 1 bands exactly (pigeonhole)
    bands = distance + 1
    width = 256 // bands
    parent = list(range(len(known)))

    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i
    seen, edges = set(), []
    for b in range(bands):
        buckets = defaultdict(list)
        for i, (_, h, _) in enumerate(known):
            buckets[(h >> (b * width)) & ((1 << width) - 1)].append(i)
        for group in buckets.values():
            if len(group) < 2 or len(group) > 200:  # a flat band (a blank sky) matches everything: no evidence
                continue
            for x in range(len(group)):
                for y in range(x + 1, len(group)):
                    i, j = group[x], group[y]
                    if (i, j) in seen:
                        continue
                    seen.add((i, j))
                    (_, hi, ri), (_, hj, rj) = known[i], known[j]
                    if bin(hi ^ hj).count("1") <= distance and abs(ri - rj) <= 0.02 * max(ri, rj):
                        edges.append((i, j))
    print(f"{len(edges)} pairs alike by their hashes; comparing them block by block...", flush=True)
    with Pool(max(1, (os.cpu_count() or 2) - 1)) as pool:
        worst = pool.map(worst_block, [(known[i][0].path, known[j][0].path) for i, j in edges], chunksize=16)
    for (i, j), w in zip(edges, worst):
        if w < block:
            parent[find(i)] = find(j)
    sets = defaultdict(list)
    for i in range(len(known)):
        sets[find(i)].append(known[i][0])
    return [v for v in sets.values() if len(v) > 1]


def plan(photos, cairn_places, groups=None, by_size=False):
    """[(keep, [others], {album uuid: name} to add keep to)] for each set of copies"""
    def albums(p):
        return {a.uuid: a.title for a in p.album_info if a.title != TO_DELETE}

    def rank(p):
        placed = p.location[0] is not None or p.path in cairn_places
        big = -(p.width or 0) * (p.height or 0)
        if by_size:  # the best picture, which takes a place from the others (below)
            return (big, not placed, -len(albums(p)), p.date_added.timestamp() if p.date_added else 0)
        return (not placed, -len(albums(p)), p.date_added.timestamp() if p.date_added else 0)

    out = []
    for same in (groups if groups is not None else copies(photos)):
        same.sort(key=rank)
        keep, others = same[0], same[1:]
        mine = albums(keep)
        add = {u: t for o in others for u, t in albums(o).items() if u not in mine}
        out.append((keep, others, add))
    return out


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--library", default=str(Path("~/Pictures/Photos Library.photoslibrary").expanduser()))
    ap.add_argument("--apply", action="store_true", help="do it (without: only say what it would do)")
    ap.add_argument("--similar", action="store_true", help="the same picture in files that differ (needs pillow)")
    ap.add_argument("--distance", type=int, default=12, help="--similar: bits of 256 two copies may differ by (12)")
    ap.add_argument("--block", type=float, default=8, help="--similar: grey levels any 8x8 block of two copies may differ by (8)")
    ap.add_argument("--pairs", metavar="FILE", help="--similar: write each set's files with their distance, to look at")
    args = ap.parse_args(argv)
    import osxphotos
    db = osxphotos.PhotosDB(dbfile=args.library)
    photos = [p for p in db.photos(images=True, movies=True) if p.path and TO_DELETE not in p.albums]
    cairn_places = json.loads((CAIRN / "data/photo_places.json").read_text()) if (CAIRN / "data/photo_places.json").exists() else {}
    if args.similar:
        groups = similar(photos, args.distance, args.block)
        if args.pairs:
            cache = json.loads(PHASH.read_text())
            d = lambda a, b: bin(int(cache[a.path][1], 16) ^ int(cache[b.path][1], 16)).count("1")
            Path(args.pairs).write_text(json.dumps([[[p.path, p.original_filename, d(g[0], p)] for p in g] for g in groups]))
        sets = plan(photos, cairn_places, groups, by_size=True)
    else:
        sets = plan(photos, cairn_places)
    extra = sum(len(o) for _, o, _ in sets)
    print(f"{len(photos)} photos and videos; {len(sets)} with copies, {extra} extra copies, "
          f"{sum(1 for _, _, a in sets if a)} to be added to the albums of their copies", flush=True)
    for keep, others, add in sets[:15]:
        print(f"  keep {keep.original_filename} {sorted(keep.albums)}; drop {[(o.original_filename, sorted(o.albums)) for o in others]}"
              f"{'; add to ' + str(sorted(add.values())) if add else ''}", flush=True)
    if not args.apply or not sets:
        return 0
    if busy():
        sys.exit("another job drives Photos: try again when it is done")
    import photoscript
    lib = photoscript.PhotosLibrary()
    to_add = defaultdict(list)
    for keep, others, add in sets:
        for u in add:
            to_add[u].append(keep.uuid)
        k = None
        for o in others:  # what the copies have that the one kept lacks
            for attr in ("favorite", "title", "description"):
                if getattr(o, attr) and not getattr(keep, attr):
                    k = k or photoscript.Photo(keep.uuid)
                    setattr(k, attr, getattr(o, attr))
    # a place only a copy has: to the one kept (in Photos; one given in Cairn is moved in data/photo_places.json below)
    moved = 0
    for keep, others, _ in sets:
        if keep.location[0] is None and keep.path not in cairn_places:
            o = next((o for o in others if o.location[0] is not None), None)
            if o:
                photoscript.Photo(keep.uuid).location = o.location
                moved += 1
    if moved:
        print(f"{moved} places of copies set on the photos kept", flush=True)
    done = 0
    for u, uuids in to_add.items():
        album = photoscript.Album(u)
        for i in range(0, len(uuids), 25):
            album.add([photoscript.Photo(x) for x in uuids[i:i + 25]])
        done += 1
    print(f"{sum(len(v) for v in to_add.values())} kept photos added to {done} albums", flush=True)
    album = lib.album(TO_DELETE) or lib.create_album(TO_DELETE)
    drop = [o.uuid for _, others, _ in sets for o in others]
    for i in range(0, len(drop), 25):
        album.add([photoscript.Photo(x) for x in drop[i:i + 25]])
        if i % 500 == 0:
            print(f"  {i + 25 if i + 25 < len(drop) else len(drop)} of {len(drop)} in {TO_DELETE!r}", flush=True)
    print(f"{len(drop)} extra copies in the album {TO_DELETE!r}: delete them there in Photos", flush=True)
    # a copy you placed in Cairn as well as the one kept (both of a pair placed): out of Cairn, so not twice on the map
    places_file = CAIRN / "data/photo_places.json"
    if places_file.exists():
        places = json.loads(places_file.read_text())
        gone = [o.path for _, others, _ in sets for o in others if o.path in places]
        if gone:
            backups = CAIRN / "data/backups"
            backups.mkdir(exist_ok=True)
            (backups / f"photo_places.before-dedupe.{time.strftime('%Y-%m-%dT%H-%M-%S')}.json").write_text(json.dumps(places))
            places = json.loads(places_file.read_text())  # read again: you may have placed more meanwhile
            for keep, others, _ in sets:  # the one kept has no place of its own: it takes the copy's
                if keep.location[0] is None and keep.path not in places:
                    o = next((o for o in others if o.path in places and not places[o.path].get("auto")), None) \
                        or next((o for o in others if o.path in places), None)
                    if o:
                        places[keep.path] = {k: v for k, v in places[o.path].items() if k != "written"}
            for f in gone:
                places.pop(f, None)
            places_file.write_text(json.dumps(places))
            print(f"{len(gone)} copies you had placed in Cairn as well taken out of Cairn", flush=True)
    # a copy you took out of Cairn (#place-photos): the one kept is out too
    removed_file = CAIRN / "data/photo_removed.json"
    removed = json.loads(removed_file.read_text()) if removed_file.exists() else {}
    more = {k.path: removed[o.path] for k, others, _ in sets for o in others if o.path in removed and k.path not in removed}
    if more:
        removed_file.write_text(json.dumps({**removed, **more}))
        print(f"{len(more)} kept photos taken out of Cairn, as a copy of each was", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
