#!/usr/bin/env python3
"""Places for photos with no place, from the landmark they show, found by Google's Cloud Vision API (landmark
detection): "the Colosseum" at its latitude and longitude. A few at a time, within the free 1,000 a month:

  python imports/photos_landmarks.py --rank          # which photos most likely show a landmark (CLIP, on this Mac)
  python imports/photos_landmarks.py                 # send this month's share and place what comes back
  python imports/photos_landmarks.py --dry-run       # say what it would send
  python imports/photos_landmarks.py --place-only    # place again from the answers kept (after Take them back)

Needs "google_vision_key" in config (or GOOGLE_VISION_KEY); torch, open_clip, Pillow and requests (the crowd env has
them). Run monthly by the LaunchAgent nl.tue.cairn-landmarks, which ranks the new photos first.

- Each photo is sent once: the answers are kept in data/photo_landmarks.json, and how many went in each calendar
  month in data/vision_usage.json; a month never goes over --month (950: 50 under the free 1,000 for retries).
- The photos most likely to show a landmark go first: data/photo_landmark_rank.json, from CLIP comparing each with
  "a famous landmark" and with what is not one (a face, a meal, a screenshot).
- A photo is placed at its landmark when Google is sure enough (--min, 0.5) and its time is when it was taken, by
  Cairn's own rule: not one of 40 or more within an hour or of a run of ten each within 30 s (an upload), nor in an
  album named for another year or of profile pictures. The others' landmarks are kept, not placed: a place on the
  wrong day would count for that day.
- Placed as Cairn's own guesses ("auto": "landmark" in data/photo_places.json): on the map as placed by Cairn, not
  written into Photos, taken back with Take them back.
"""
import argparse, base64, io, json, os, re, subprocess, sys, tempfile, time
from pathlib import Path

CAIRN = Path(__file__).resolve().parent.parent
DATA = CAIRN / "data"
UNPLACED, PLACES, REMOVED = DATA / "photo_unplaced.json", DATA / "photo_places.json", DATA / "photo_removed.json"
ANSWERS, USAGE, RANK = DATA / "photo_landmarks.json", DATA / "vision_usage.json", DATA / "photo_landmark_rank.json"
URL = "https://vision.googleapis.com/v1/images:annotate"
BURST, RUN, RUN_S = 40, 10, 30  # as app.js
REPOSTED = re.compile(r"(profile pictures|cover photos|instagram photos|bitstrips photos|mobile uploads|timeline photos)$", re.I)
LANDMARK = ["a famous landmark", "a historic building", "a monument or statue in a city square", "a cathedral or church",
            "a castle", "a famous bridge", "a city skyline", "a famous tourist sight"]
OTHER = ["a selfie or a portrait of a person", "people at a table eating", "a plate of food", "a screenshot",
         "a document or a ticket", "the inside of a room", "an animal", "a car", "a beach", "a forest or a field",
         "a group photo of friends"]


def load(p, empty):
    return json.loads(p.read_text()) if p.exists() else empty


def save(p, obj):
    tmp = p.with_suffix(".tmp")
    tmp.write_text(json.dumps(obj, ensure_ascii=False))
    tmp.replace(p)


def candidates():
    """The photos with no place: [(t, file, albums)], and the set of files whose time is not when they were taken"""
    rows = load(UNPLACED, [])
    places, removed = load(PLACES, {}), load(REMOVED, {})
    seen, keep = set(), []
    for t, f, name, albs, video in rows:
        if f in seen or not t or removed.get(f) or any(a.startswith("To delete") for a in albs):
            continue
        seen.add(f)
        keep.append((t, f, albs, video))
    times = sorted(t for t, *_ in keep)
    burst, i = set(), 0
    for j in range(len(times)):
        while times[j] - times[i] > 3600:
            i += 1
        if j - i + 1 >= BURST:
            burst.update(times[i:j + 1])
    i = 0
    for j in range(1, len(times) + 1):
        if j < len(times) and times[j] - times[j - 1] <= RUN_S:
            continue
        if j - i >= RUN:
            burst.update(times[i:j])
        i = j
    untimed = set()
    for t, f, albs, video in keep:
        y = time.gmtime(t).tm_year
        named = [int(x) for a in albs for x in re.findall(r"\b(?:19|20)\d\d\b", a)]
        if t in burst or (named and y not in named) or any(REPOSTED.search(a) for a in albs):
            untimed.add(f)
    return [(t, f, albs) for t, f, albs, video in keep if not video and f not in places], untimed


def picture(f, size):
    """The photo as a JPEG at most size pixels across (HEIC through sips), or None"""
    from PIL import Image
    try:
        im = Image.open(f)
    except Exception:
        with tempfile.TemporaryDirectory() as d:
            out = Path(d) / "p.jpg"
            if subprocess.run(["sips", "-s", "format", "jpeg", "-Z", str(size), f, "--out", str(out)],
                              capture_output=True).returncode:
                return None
            im = Image.open(out)
            im.load()
    im.draft("RGB", (size, size))
    im = im.convert("RGB")
    im.thumbnail((size, size))
    return im


def rank(files):
    """CLIP's likelihood that each photo shows a landmark, for those not ranked yet"""
    import torch, open_clip
    model, _, prep = open_clip.create_model_and_transforms("ViT-B-32", pretrained="laion2b_s34b_b79k")
    tok = open_clip.get_tokenizer("ViT-B-32")
    model.eval()
    ranks = load(RANK, {})
    todo = [f for f in files if f not in ranks]
    print(f"ranking {len(todo)} photos", flush=True)
    with torch.no_grad():
        tf = model.encode_text(tok([f"a photo of {x}" for x in LANDMARK + OTHER]))
        tf = tf / tf.norm(dim=-1, keepdim=True)
        for k in range(0, len(todo), 32):
            batch = [(f, picture(f, 448)) for f in todo[k:k + 32]]
            ok = [(f, im) for f, im in batch if im is not None]
            for f, im in batch:
                if im is None:
                    ranks[f] = 0.0
            if ok:
                imf = model.encode_image(torch.stack([prep(im) for _, im in ok]))
                imf = imf / imf.norm(dim=-1, keepdim=True)
                p = (100 * imf @ tf.T).softmax(dim=-1)
                for (f, _), row in zip(ok, p):
                    ranks[f] = round(float(row[:len(LANDMARK)].sum()), 4)
            if (k // 32) % 10 == 0:
                print(f"  {min(k + 32, len(todo))} of {len(todo)}", flush=True)
                save(RANK, ranks)
    save(RANK, ranks)
    return ranks


def key():
    k = os.environ.get("GOOGLE_VISION_KEY")
    if not k and (CAIRN / "config").exists():
        k = json.loads((CAIRN / "config").read_text()).get("google_vision_key")
    return k


def send(files, k):
    """Google's landmarks for each photo: {file: {sent, landmarks: [{name, score, at}]} or {sent, error}}"""
    import requests
    out, now = {}, time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    for i in range(0, len(files), 16):
        chunk, reqs = [], []
        for f in files[i:i + 16]:
            im = picture(f, 1024)
            if im is None:
                out[f] = {"sent": now, "error": "could not be read"}
                continue
            buf = io.BytesIO()
            im.save(buf, "JPEG", quality=85)
            chunk.append(f)
            reqs.append({"image": {"content": base64.b64encode(buf.getvalue()).decode()},
                         "features": [{"type": "LANDMARK_DETECTION", "maxResults": 3}]})
        if not reqs:
            continue
        yield len(reqs)  # counted before it goes: a request that fails may still be charged
        r = requests.post(URL, params={"key": k}, json={"requests": reqs}, timeout=120)
        if r.status_code != 200:
            raise SystemExit(f"Cloud Vision: HTTP {r.status_code}: {r.text[:300]}")
        for f, res in zip(chunk, r.json().get("responses", [])):
            if "error" in res:
                out[f] = {"sent": now, "error": res["error"].get("message", "")}
                continue
            out[f] = {"sent": now, "landmarks": [
                {"name": a.get("description", ""), "score": round(a.get("score", 0), 3),
                 "at": [a["locations"][0]["latLng"]["latitude"], a["locations"][0]["latLng"]["longitude"]]}
                for a in res.get("landmarkAnnotations", []) if a.get("locations")]}
        yield out
        out = {}


def place(answers, untimed, rows, least):
    """Each photo Google is sure of, at its landmark, if its time can be trusted; how many"""
    when = {f: t for t, f, _ in rows}
    places = load(PLACES, {})
    new = {}
    for f, a in answers.items():
        best = max(a.get("landmarks") or [], key=lambda x: x["score"], default=None)
        if f in places or f not in when or f in untimed or not best or best["score"] < least:
            continue
        new[f] = {"lat": round(best["at"][0], 6), "lon": round(best["at"][1], 6), "t": when[f], "name": best["name"],
                  "at": time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime()), "auto": "landmark"}
    if new:
        (DATA / "backups").mkdir(exist_ok=True)
        (DATA / "backups" / f"photo_places.before-landmarks.{time.strftime('%Y-%m-%dT%H-%M-%S')}.json").write_text(json.dumps(places))
        places = load(PLACES, {})  # read again: you may have placed more meanwhile
        places.update({f: v for f, v in new.items() if f not in places})
        save(PLACES, places)
    return len(new)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--rank", action="store_true", help="rank the photos not ranked yet (CLIP), then stop")
    ap.add_argument("--month", type=int, default=950, help="photos sent in a calendar month at most (950)")
    ap.add_argument("--limit", type=int, help="this run at most")
    ap.add_argument("--min", type=float, default=0.5, help="Google's score a landmark needs to be placed (0.5)")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--place-only", action="store_true")
    a = ap.parse_args()
    rows, untimed = candidates()
    answers = load(ANSWERS, {})
    print(time.strftime("%Y-%m-%d %H:%M"), f"{len(rows)} photos with no place, {len(untimed & {f for _, f, _ in rows})} "
          f"of them not when taken; {len(answers)} sent before", flush=True)
    if a.rank:
        rank([f for _, f, _ in rows])
        return
    if a.place_only:
        print(f"{place(answers, untimed, rows, a.min)} placed")
        return
    ranks = load(RANK, {})
    month = time.strftime("%Y-%m")
    usage = load(USAGE, {})
    left = max(0, a.month - usage.get(month, 0))
    if a.limit is not None:
        left = min(left, a.limit)
    # timed photos first (they can be placed), then by how likely a landmark; unranked last
    todo = sorted((r for r in rows if r[1] not in answers), key=lambda r: (r[1] in untimed, -ranks.get(r[1], -1)))
    todo = [f for _, f, _ in todo][:left]
    print(f"{usage.get(month, 0)} sent this month ({month}), {left} more allowed; sending {len(todo)}", flush=True)
    if a.dry_run or not todo:
        for f in todo[:10]:
            print(f"  {ranks.get(f, '-')} {'untimed' if f in untimed else 'timed'} {f}")
        return
    k = key()
    if not k:
        raise SystemExit('no key: add "google_vision_key" to config')
    for step in send(todo, k):
        if isinstance(step, int):
            usage[month] = usage.get(month, 0) + step
            save(USAGE, usage)
        else:
            answers.update(step)
            save(ANSWERS, answers)
    found = sum(1 for f in todo if answers.get(f, {}).get("landmarks"))
    print(f"{found} of {len(todo)} show a landmark; {place(answers, untimed, rows, a.min)} placed", flush=True)


if __name__ == "__main__":
    main()
