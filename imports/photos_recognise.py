#!/usr/bin/env python3
"""Places for photos with no place, from what they show: for an album whose dates are not when its photos were taken
(an upload to Facebook: every photo of a trip on one day), the town of the trip each photo shows.

A spec (JSON) lists, for each album, the places of its trip in Cairn with the day you were there and what can be seen
there ("the Colosseum", "an aquarium with sharks"):

  {"albums": ["Italy 2019"], "places": [{"name": "Rome", "at": [41.9, 12.5], "day": "2019-05-22",
                                           "shows": ["the Colosseum", "St Peter's Basilica"]}, ...]}

A place with no "at" takes photos that are nowhere you can place (a cave you do not know). Each photo is compared with
those descriptions by CLIP (open_clip, on this machine; nothing is uploaded), and as the album keeps the order the
photos were taken in, a photo that shows nothing of its own (a meal, a face, a hostel bed) takes the place of the
photos around it: the most likely sequence of places, staying in one for a while (Viterbi).

  python imports/photos_recognise.py SPEC [--sheets DIR]   # what it would place, with contact sheets to look at
  python imports/photos_recognise.py SPEC --apply          # place them

Placed as Cairn's own guesses ("auto": "image" in data/photo_places.json: on the map as placed by Cairn, not written
into Photos, taken back with Take them back), at noon of the place's day rather than the album's date, so they count for
the right day. Needs torch, open_clip and Pillow.
"""
import argparse, json, math, re, sys, time
from pathlib import Path

CAIRN = Path(__file__).resolve().parent.parent
UNPLACED, PLACES = CAIRN / "data/photo_unplaced.json", CAIRN / "data/photo_places.json"
STAY = 0.95  # how likely the next photo is of the same place as this one
TEMP = 4  # CLIP is sure of itself even on a photo of a meal: its scores softened, so the photos around count more


def natural(name):
    return [int(x) if x.isdigit() else x for x in re.split(r"(\d+)", name)]


def photos_of(albums):
    """The album's photos with no place yet, in the order taken: [(t, file, name)]"""
    rows = json.loads(UNPLACED.read_text())
    placed = json.loads(PLACES.read_text()) if PLACES.exists() else {}
    seen, out = set(), []
    for t, f, name, albs, video in rows:
        if video or f in placed or f in seen or not set(albs) & set(albums):
            continue
        seen.add(f)
        out.append((t, f, name))
    return sorted(out, key=lambda r: (r[0], natural(r[2])))


def scores(files, places):
    """Each photo's log-probability of showing each place: [[float]]"""
    import torch, open_clip
    from PIL import Image
    model, _, prep = open_clip.create_model_and_transforms("ViT-B-32", pretrained="laion2b_s34b_b79k")
    tok = open_clip.get_tokenizer("ViT-B-32")
    model.eval()
    with torch.no_grad():
        texts, owner = [], []
        for i, p in enumerate(places):
            for s in p["shows"]:
                texts.append(f"a photo of {s}")
                owner.append(i)
        tf = model.encode_text(tok(texts))
        tf = tf / tf.norm(dim=-1, keepdim=True)
        out = []
        for k in range(0, len(files), 32):
            batch = []
            for f in files[k:k + 32]:
                try:
                    im = Image.open(f)
                    im.draft("RGB", (448, 448))
                    batch.append(prep(im.convert("RGB")))
                except Exception:
                    batch.append(None)
            ok = [b for b in batch if b is not None]
            imf = model.encode_image(torch.stack(ok)) if ok else None
            if imf is not None:
                imf = imf / imf.norm(dim=-1, keepdim=True)
            j = 0
            for b in batch:
                if b is None:
                    out.append([math.log(1 / len(places))] * len(places))
                    continue
                sim = (100 * imf[j] @ tf.T).tolist()
                j += 1
                best = [max(s for s, o in zip(sim, owner) if o == i) for i in range(len(places))]
                m = max(best)
                z = math.log(sum(math.exp(b_ - m) for b_ in best)) + m
                out.append([b_ - z for b_ in best])
            print(f"  {min(k + 32, len(files))} of {len(files)}", file=sys.stderr, flush=True)
    return out


def soften(em):
    out = []
    for e in em:
        s = [x / TEMP for x in e]
        m = max(s)
        z = math.log(sum(math.exp(x - m) for x in s)) + m
        out.append([x - z for x in s])
    return out


def viterbi(em):
    """The most likely place of each photo, staying in a place a while: ([place index], [its own probability])"""
    em = soften(em)
    n = len(em[0])
    stay, move = math.log(STAY), math.log((1 - STAY) / max(1, n - 1))
    v, back = list(em[0]), []
    for e in em[1:]:
        nv, nb = [], []
        for j in range(n):
            i = max(range(n), key=lambda i: v[i] + (stay if i == j else move))
            nv.append(v[i] + (stay if i == j else move) + e[j])
            nb.append(i)
        v, back = nv, back + [nb]
    path = [max(range(n), key=lambda j: v[j])]
    for nb in reversed(back):
        path.append(nb[path[-1]])
    path.reverse()
    return path, [math.exp(e[p]) for e, p in zip(em, path)]


def sheets(rows, path, own, places, out):
    from PIL import Image, ImageDraw
    out.mkdir(parents=True, exist_ok=True)
    for i, p in enumerate(places):
        mine = [(k, r) for k, r in enumerate(rows) if path[k] == i]
        if not mine:
            continue
        W, sz = 10, 150
        sheet = Image.new("RGB", (W * sz, ((len(mine) + W - 1) // W) * sz), "white")
        d = ImageDraw.Draw(sheet)
        for n, (k, r) in enumerate(mine):
            try:
                im = Image.open(r[1])
                im.draft("RGB", (sz * 2, sz * 2))
                im = im.convert("RGB")
                im.thumbnail((sz - 4, sz - 4))
                sheet.paste(im, ((n % W) * sz + 2, (n // W) * sz + 2))
            except Exception:
                pass
            d.text(((n % W) * sz + 4, (n // W) * sz + 4), f"{k} {own[k]:.2f}", fill="yellow")
        sheet.save(out / f"{i:02d} {p['name']}.jpg", quality=80)


def allsheet(rows, path, places, out):
    from PIL import Image, ImageDraw
    W, sz = 14, 128
    sheet = Image.new("RGB", (W * sz, ((len(rows) + W - 1) // W) * sz), "white")
    d = ImageDraw.Draw(sheet)
    for k, r in enumerate(rows):
        try:
            im = Image.open(r[1])
            im.draft("RGB", (sz * 2, sz * 2))
            im = im.convert("RGB")
            im.thumbnail((sz - 4, sz - 4))
            sheet.paste(im, ((k % W) * sz + 2, (k // W) * sz + 2))
        except Exception:
            pass
        d.rectangle(((k % W) * sz + 2, (k // W) * sz + 2, (k % W) * sz + 100, (k // W) * sz + 14), fill="black")
        d.text(((k % W) * sz + 4, (k // W) * sz + 3), f"{k} {places[path[k]]['name'][:10]}", fill="yellow")
    sheet.save(out, quality=82)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("spec")
    ap.add_argument("--sheets", metavar="DIR", help="a contact sheet of each place's photos, to look at")
    ap.add_argument("--fix", metavar="JSON", help='{"12": "Rome", "30-41": "Milan", ...}: what you saw on the sheets (photo numbers)')
    ap.add_argument("--all", metavar="FILE", help="one sheet of every photo, numbered, with its place")
    ap.add_argument("--apply", action="store_true", help="place them (without: only say what it would do)")
    a = ap.parse_args()
    spec = json.loads(Path(a.spec).read_text())
    places = spec["places"]
    rows = photos_of(spec["albums"])
    print(f"{len(rows)} photos with no place in {', '.join(spec['albums'])}", file=sys.stderr)
    if not rows:
        return
    cache = Path(a.spec).with_suffix(".scores.json")
    key = [r[1] for r in rows], [p["shows"] for p in places]
    old = json.loads(cache.read_text()) if cache.exists() else None
    em = old["scores"] if old and old["key"] == [key[0], key[1]] else scores(key[0], places)
    cache.write_text(json.dumps({"key": [key[0], key[1]], "scores": em}))
    path, own = viterbi(em)
    names = {p["name"]: i for i, p in enumerate(places)}
    for k, name in (json.loads(Path(a.fix).read_text()) if a.fix else {}).items():
        lo, _, hi = k.partition("-")
        for j in range(int(lo), int(hi or lo) + 1):
            path[j], own[j] = names[name], 1.0
    if a.all:
        allsheet(rows, path, places, Path(a.all))
    counts = {}
    for i in path:
        counts[places[i]["name"]] = counts.get(places[i]["name"], 0) + 1
    print(json.dumps(counts, ensure_ascii=False))
    if a.sheets:
        sheets(rows, path, own, places, Path(a.sheets))
    if not a.apply:
        return
    placed = json.loads(PLACES.read_text()) if PLACES.exists() else {}
    backups = CAIRN / "data/backups"
    backups.mkdir(exist_ok=True)
    (backups / f"photo_places.before-recognise.{time.strftime('%Y-%m-%dT%H-%M-%S')}.json").write_text(json.dumps(placed))
    now, n = time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime()), 0
    for r, i in zip(rows, path):
        p = places[i]
        if not p.get("at") or r[1] in placed:
            continue
        t = int(time.mktime(time.strptime(p["day"] + " 12", "%Y-%m-%d %H")))
        placed[r[1]] = {"lat": p["at"][0], "lon": p["at"][1], "t": t, "name": p["name"], "at": now, "auto": "image"}
        n += 1
    PLACES.write_text(json.dumps(placed))
    print(f"{n} photos placed (as Cairn's guesses, at the day of each place)", file=sys.stderr)


if __name__ == "__main__":
    main()
