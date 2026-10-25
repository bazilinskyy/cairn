"""Tests for the import scripts, on small made-up exports. Run: python imports/test_imports.py (no pytest needed)."""
import json
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import photos  # noqa: E402
import timeline  # noqa: E402


def decode(s):
    pts, i, lat, lon = [], 0, 0, 0
    while i < len(s):
        vals = []
        for _ in range(2):
            shift = result = 0
            while True:
                b = ord(s[i]) - 63
                i += 1
                result |= (b & 0x1f) << shift
                shift += 5
                if b < 0x20:
                    break
            vals.append(~(result >> 1) if result & 1 else result >> 1)
        lat, lon = lat + vals[0], lon + vals[1]
        pts.append((lat / 1e6, lon / 1e6))
    return pts


def run(doc):
    with tempfile.TemporaryDirectory() as d:
        f = Path(d) / "export.json"
        f.write_text(json.dumps(doc))
        return timeline.load([f])


def test_android_export():
    r = run({"semanticSegments": [
        {"startTime": "2024-06-01T09:00:00.000+02:00", "endTime": "2024-06-01T11:00:00.000+02:00",
         "visit": {"topCandidate": {"placeLocation": {"latLng": "51.4416°, 5.4697°"}, "semanticType": "HOME"}}},
        {"startTime": "2024-06-01T11:00:00.000+02:00", "endTime": "2024-06-01T12:00:00.000+02:00",
         "timelinePath": [{"point": "51.4416°, 5.4697°", "time": "2024-06-01T11:00:00.000+02:00"},
                          {"point": "51.50°, 5.40°", "time": "2024-06-01T11:20:00.000+02:00"},
                          {"point": "51.58°, 5.30°", "time": "2024-06-01T11:40:00.000+02:00"}]},
        {"startTime": "2024-06-01T12:00:00.000+02:00", "endTime": "2024-06-01T13:00:00.000+02:00",
         "activity": {"start": {"latLng": "51.58°, 5.30°"}, "end": {"latLng": "51.59°, 4.78°"}, "topCandidate": {"type": "IN_TRAIN"}}}],
        "rawSignals": [], "userLocationProfile": {}})
    assert r["visits"] == [{"lat": 51.4416, "lon": 5.4697, "start": "2024-06-01 09:00", "end": "2024-06-01 11:00", "name": "Home"}]
    assert len(r["paths"]) == 1 and r["paths"][0]["date"] == "2024-06-01"
    pts = decode(r["paths"][0]["path"])
    assert pts[0] == (51.4416, 5.4697) and pts[-1] == (51.59, 4.78)


def test_ios_export():
    r = run([{"startTime": "2023-12-24T10:00:00.000+00:00", "endTime": "2023-12-24T12:00:00.000+00:00",
              "visit": {"topCandidate": {"placeLocation": "geo:27.808,-17.915", "semanticType": "Unknown"}}},
             {"startTime": "2023-12-24T12:00:00.000+00:00", "endTime": "2023-12-24T12:30:00.000+00:00",
              "timelinePath": [{"point": "geo:27.808,-17.915", "durationMinutesOffsetFromStartTime": "0"},
                               {"point": "geo:27.79,-17.93", "durationMinutesOffsetFromStartTime": "10"},
                               {"point": "geo:27.771,-17.956", "durationMinutesOffsetFromStartTime": "20"}]}])
    assert r["visits"][0]["start"] == "2023-12-24 10:00" and r["visits"][0]["name"] == ""
    assert decode(r["paths"][0]["path"])[-1] == (27.771, -17.956)


def test_takeout_semantic_history():
    r = run({"timelineObjects": [
        {"placeVisit": {"location": {"latitudeE7": 386934000, "longitudeE7": -93700000, "name": "Lisboa Oriente"},
                        "duration": {"startTimestamp": "2023-05-16T12:00:00Z", "endTimestamp": "2023-05-16T13:55:00Z"}}},
        {"activitySegment": {"startLocation": {"latitudeE7": 387679000, "longitudeE7": -90997000},
                             "endLocation": {"latitudeE7": 371021000, "longitudeE7": -86742000},
                             "waypointPath": {"waypoints": [{"latE7": 384000000, "lngE7": -89000000},
                                                            {"latE7": 380000000, "lngE7": -87500000},
                                                            {"latE7": 376000000, "lngE7": -87000000}]},
                             "duration": {"startTimestamp": "2023-05-16T13:00:00Z", "endTimestamp": "2023-05-16T17:00:00Z"}}}]})
    assert r["visits"][0]["name"] == "Lisboa Oriente" and r["visits"][0]["lat"] == 38.6934
    assert len(r["paths"]) == 1 and r["paths"][0]["date"] == "2023-05-16"
    assert [len(p) for p in [decode(r["paths"][0]["path"])]] == [5] and decode(r["paths"][0]["path"])[-1] == (37.1021, -8.6742)


def test_records_cut_at_jumps_and_gaps():
    pts = [(52.0, 4.36, "2022-06-13T05:00:00Z"), (51.9, 4.45, "2022-06-13T05:10:00Z"), (51.85, 4.5, "2022-06-13T05:20:00Z"),
           (51.84, 4.51, "2022-06-13T09:00:00Z"), (51.83, 4.52, "2022-06-13T09:05:00Z"),   # four hours later: new path
           (40.0, 4.0, "2022-06-13T09:30:00Z")]                                           # far away: not joined
    r = run({"locations": [{"latitudeE7": int(a * 1e7), "longitudeE7": int(b * 1e7), "timestamp": t} for a, b, t in pts]})
    assert [len(decode(p["path"])) for p in r["paths"]] == [3, 2]


def test_photo_cells():
    shots = [(51.4416, 5.4697, "2024-06-01"), (51.4449, 5.4712, "2024-06-02"), (51.4416, 5.4697, "2023-01-05"),
             (None, None, "2024-06-01"), (0.0, 0.0, "2024-06-01"), (38.7, -9.1, "")]
    assert photos.cells(shots) == [
        {"lat": 51.44, "lon": 5.47, "year": 2023, "count": 1, "days": ["2023-01-05"]},
        {"lat": 51.44, "lon": 5.47, "year": 2024, "count": 2, "days": ["2024-06-01", "2024-06-02"]}]


def test_google_takeout_zip_and_folder():
    import zipfile
    meta = {"title": "IMG_1.jpg", "photoTakenTime": {"timestamp": "1717225200"},  # 2024-06-01 07:00 UTC
            "geoData": {"latitude": 51.4416, "longitude": 5.4697, "altitude": 0.0}}
    no_place = {"title": "IMG_2.jpg", "photoTakenTime": {"timestamp": "1717225300"},
                "geoData": {"latitude": 0.0, "longitude": 0.0}, "geoDataExif": {"latitude": 38.71, "longitude": -9.14}}
    nowhere = {"title": "IMG_3.jpg", "photoTakenTime": {"timestamp": "1717225400"}, "geoData": {"latitude": 0.0, "longitude": 0.0}}
    with tempfile.TemporaryDirectory() as d:
        z = Path(d) / "takeout-1.zip"
        with zipfile.ZipFile(z, "w") as f:
            f.writestr("Takeout/Google Photos/Photos from 2024/IMG_1.jpg.supplemental-metadata.json", json.dumps(meta))
            f.writestr("Takeout/Google Photos/Holiday/IMG_1.jpg.json", json.dumps(meta))  # the same photo in an album
            f.writestr("Takeout/Google Photos/Holiday/metadata.json", json.dumps({"title": "Holiday"}))
            f.writestr("Takeout/Google Photos/Photos from 2024/IMG_2.jpg.json", json.dumps(no_place))
            f.writestr("Takeout/Google Photos/Photos from 2024/IMG_3.jpg.json", json.dumps(nowhere))
            f.writestr("Takeout/Google Photos/Photos from 2024/IMG_1.jpg", b"not read")
        assert photos.cells(photos.from_takeout([z])) == [
            {"lat": 38.71, "lon": -9.14, "year": 2024, "count": 1, "days": ["2024-06-01"]},
            {"lat": 51.44, "lon": 5.47, "year": 2024, "count": 1, "days": ["2024-06-01"]}]
        folder = Path(d) / "unpacked"
        zipfile.ZipFile(z).extractall(folder)
        assert sum(c["count"] for c in photos.cells(photos.from_takeout([folder]))) == 2


def test_same_photo_from_two_sources_counts_once():
    apple = [(51.44161, 5.46972, "2024-06-01", 1717225200), (38.7, -9.14, "2024-06-03", 1717400000), (None, None, "2024-06-04", None)]
    google = [(51.44162, 5.46971, "2024-06-01", 1717225200),   # the same photo, its place rounded a little otherwise
              (51.44162, 5.46971, "2024-06-01", 1717225201)]   # a second later: another photo
    assert sum(c["count"] for c in photos.cells(photos.unique(apple + google))) == 3


if __name__ == "__main__":
    tests = [f for n, f in sorted(globals().items()) if n.startswith("test_") and callable(f)]
    for t in tests:
        t()
    print(f"OK {len(tests)} tests")
