"""Tests for the import scripts, on small made-up exports. Run: python imports/test_imports.py (no pytest needed)."""
import io
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


def test_garmin_sports_and_tiles():
    import garmin
    assert garmin.sport_of("road_biking") == ("Ride", False) and garmin.sport_of("indoor_cycling") == ("VirtualRide", True)
    assert garmin.sport_of("trail_running") == ("TrailRun", False) and garmin.sport_of("running", "treadmill") == ("Run", True)
    virtual = garmin.to_activity(1, "Zwift", "virtual_ride", garmin.datetime(2024, 6, 1, 7), None, 30000, 3000, 3000, 200, 140,
                                 [(-11.6, 166.9), (-11.7, 167.0)])  # Watopia's coordinates, in the Pacific
    assert (virtual["trainer"], virtual["path"], virtual["at"], virtual["tiles"], virtual["distance"]) == (True, "", None, [], 30.0)
    assert garmin.sport_of("hiking") == ("Hike", False) and garmin.sport_of("strength_training") == ("StrengthTraining", False)
    # the same tiles as Cairn's strava.js: Eindhoven station is 8441/5452, three tiles east to 5.52
    assert garmin.tiles_of([(51.4433, 5.4797), (51.4433, 5.52)]) == [x * 16384 + 5452 for x in (8441, 8442, 8443)]


def test_garmin_export():
    try:
        import fitdecode  # noqa: F401
    except ImportError:
        print("  (skipped test_garmin_export: run with  uv run --with fitdecode python imports/test_imports.py)")
        return
    import zipfile
    import garmin
    fit = (HERE / "fixtures" / "garmin_ride.fit").read_bytes()
    summaries = [{"summarizedActivitiesExport": [  # Garmin's own units: cm and ms
        {"activityId": 12345678901, "name": "Morning Ride", "activityType": "road_biking", "startTimeGmt": 1717225200000,
         "startTimeLocal": 1717232400000, "distance": 1500000.0, "duration": 3000000.0, "movingDuration": 2900000.0, "elevationGain": 4200.0},
        {"activityId": 22222222222, "name": "Treadmill", "activityType": "treadmill_running", "startTimeGmt": 1717311600000,
         "startTimeLocal": 1717318800000, "distance": 1000000.0, "duration": 3000000.0, "movingDuration": 2900000.0, "avgHr": 150.0}]}]
    with tempfile.TemporaryDirectory() as d:
        inner = io.BytesIO()
        with zipfile.ZipFile(inner, "w") as z:
            z.writestr("user@example.com_12345678901.fit", fit)
        export = Path(d) / "export.zip"
        with zipfile.ZipFile(export, "w") as z:
            z.writestr("DI_CONNECT/DI-Connect-Fitness/user@example.com_0_summarizedActivities.json", json.dumps(summaries))
            z.writestr("DI_CONNECT/DI-Connect-Uploaded-Files/UploadedFiles_0-_Part1.zip", inner.getvalue())
        acts = {a["id"]: a for a in garmin.from_export([export], log=lambda m: None)}
    ride, run = acts[12345678901], acts[22222222222]
    assert {k: ride[k] for k in ("name", "sport", "date", "distance", "moving_time", "elapsed_time", "elevation", "heartrate", "trainer", "at")} == {
        "name": "Morning Ride", "sport": "Ride", "date": "2024-06-01 09:00:00", "distance": 15.0, "moving_time": 2900, "elapsed_time": 3000,
        "elevation": 42, "heartrate": 141, "trainer": False, "at": [51.44, 5.47]}
    assert ride["path"] and len(ride["tiles"]) > 5
    # no file: the summary in its own units, measured against the ride's file
    assert {k: run[k] for k in ("sport", "date", "distance", "moving_time", "heartrate", "trainer", "path", "at")} == {
        "sport": "Run", "date": "2024-06-02 09:00:00", "distance": 10.0, "moving_time": 2900, "heartrate": 150, "trainer": True, "path": "", "at": None}




def test_garmin_vehicle_part():
    """A hike whose last part is a car ride is caught; a fast descent on a bike is not."""
    from datetime import datetime, timedelta, timezone
    import garmin
    t0 = datetime(2026, 5, 1, 10, tzinfo=timezone.utc)
    def track(speeds_kmh, alt=lambda i: 100):  # a point every 10 s going north at each speed
        pts, lat = [], 45.0
        for i, v in enumerate(speeds_kmh):
            pts.append((t0 + timedelta(seconds=10 * i), lat, 6.0, alt(i), None, None))
            lat += v / 3.6 * 10 / 111320
        return {"track": pts}
    hike = track([5] * 360 + [80] * 60)  # an hour walking, then 10 minutes at 80 km/h
    v = garmin.vehicle_part(hike, "Hike")
    assert v and v["to_end"] and 4.5 < v["from_km"] < 5.5 and 12 < v["km"] < 14, v
    assert garmin.vehicle_part(track([5] * 400), "Hike") is None
    assert garmin.vehicle_part(track([25] * 200 + [65] * 60, alt=lambda i: 2000 - max(0, i - 200) * 15), "Ride") is None  # descending
    assert garmin.vehicle_part(track([25] * 200 + [90] * 60), "Ride")["to_end"]


def test_garmin_days():
    """A day's sleep and resting heart rate, as the export and Garmin Connect give them."""
    import garmin
    uds = {"calendarDate": "2026-03-24", "restingHeartRate": 46, "totalSteps": 15787,
           "allDayStress": {"aggregatorList": [{"type": "TOTAL", "averageStressLevel": 30}]},
           "bodyBattery": {"bodyBatteryStatList": [{"bodyBatteryStatType": "HIGHEST", "statsValue": 95},
                                                   {"bodyBatteryStatType": "LOWEST", "statsValue": 29}]}}
    sleep = {"sleepStartTimestampGMT": "2026-03-23T19:44:00.0", "sleepEndTimestampGMT": "2026-03-24T03:22:00.0",
             "deepSleepSeconds": 6000, "lightSleepSeconds": 16620, "remSleepSeconds": 4800, "awakeSleepSeconds": 60,
             "sleepScores": {"overallScore": 89}}
    assert garmin._day(uds, sleep) == {"rhr": 46, "steps": 15787, "stress": 30, "bb_max": 95, "bb_min": 29, "sleep": 27420,
                                       "deep": 6000, "light": 16620, "rem": 4800, "awake": 60, "bed": "2026-03-23T19:44",
                                       "wake": "2026-03-24T03:22", "score": 89}
    # Garmin Connect: times in ms, the score nested, the total asleep given
    connect = {"sleepTimeSeconds": 27000, "sleepStartTimestampGMT": 1774295040000, "deepSleepSeconds": 6000,
               "sleepScores": {"overall": {"value": 80}}}
    day = garmin._day({"restingHeartRate": 45, "bodyBatteryHighestValue": 79}, connect)
    assert (day["rhr"], day["bb_max"], day["sleep"], day["score"], day["bed"]) == (45, 79, 27000, 80, "2026-03-23T19:44")
    assert garmin._day(None, {"retro": False}) == {}  # a night not recorded
    # an older watch: no stages, the whole time it lay still "deep" (13.4 hours): not a measured night
    old = {"sleepTimeSeconds": 48240, "deepSleepSeconds": 48240, "lightSleepSeconds": 0, "sleepStartTimestampGMT": 1774295040000}
    assert garmin._day({"restingHeartRate": 45}, old) == {"rhr": 45}


def test_saved_places():
    """Google Maps' saved places from a Takeout: the starred ones with their position, the lists' with theirs when the
    link holds it."""
    import saved_places
    with tempfile.TemporaryDirectory() as d:
        base = Path(d) / "Takeout"
        (base / "Maps (your places)").mkdir(parents=True)
        (base / "Saved").mkdir()
        (base / "Maps (your places)" / "Saved Places.json").write_text(json.dumps({"type": "FeatureCollection", "features": [
            {"geometry": {"coordinates": [-16.25, 28.27]}, "properties": {"date": "2025-01-02T10:00:00Z", "google_maps_url": "http://maps.google.com/?cid=1",
             "location": {"name": "Teide", "address": "Tenerife"}}}]}))
        (base / "Saved" / "Want to go.csv").write_text("Title,Note,URL\nTeide,climb it,http://maps.google.com/?cid=1\n"
                                                         'Roque Nublo,,"https://www.google.com/maps/place/x/@27.96,-15.61,15z"\nSomewhere,,https://www.google.com/maps/search/somewhere\n')
        got = sorted(saved_places.read([str(base)]), key=lambda p: p["name"])
        assert [(p["name"], p["list"], p["lat"]) for p in got] == [("Roque Nublo", "Want to go", 27.96), ("Somewhere", "Want to go", None), ("Teide", "Want to go", 28.27)]
        assert got[2]["address"] == "Tenerife" and got[2]["saved"] == "2025-01-02" and got[2]["note"] == "climb it"


def test_checkins_facebook_instagram_reviews_rides():
    import zipfile
    import checkins
    with tempfile.TemporaryDirectory() as d:
        fb = Path(d, "facebook-me.zip")
        with zipfile.ZipFile(fb, "w") as z:
            z.writestr("your_activity_across_facebook/posts/your_posts__check_ins__photos_and_videos_1.json", json.dumps([
                {"timestamp": 1514122000, "attachments": [{"data": [{"place": {"name": "Church of the Nativity",
                 "coordinate": {"latitude": 31.7043, "longitude": 35.2075}}}]}], "data": [{"post": "Christmas"}]},
                {"timestamp": 1514200000, "data": [{"post": "no place"}]},
                {"timestamp": 1400000000, "attachments": [{"data": [{"media": {"uri": "x.jpg", "creation_timestamp": 1400000100,
                 "media_metadata": {"photo_metadata": {"exif_data": [{"latitude": 50.45, "longitude": 30.52, "taken_timestamp": 1399990000}]}}}}]}]}]))
        ig = Path(d, "instagram")
        (ig / "your_instagram_activity" / "content").mkdir(parents=True)
        (ig / "your_instagram_activity" / "content" / "posts_1.json").write_text(json.dumps([
            {"media": [{"uri": "a.jpg", "creation_timestamp": 1600000000, "title": "ZÃ¼rich",
                        "media_metadata": {"photo_metadata": {"exif_data": [{"latitude": 47.37, "longitude": 8.54}]}}}]}]))
        rv = Path(d, "Reviews.json")
        rv.write_text(json.dumps({"features": [{"geometry": {"type": "Point", "coordinates": [-9.14, 38.71]},
            "properties": {"date": "2023-05-16T10:00:00Z", "location": {"name": "Pasteis de Belem"}}}]}))
        uber = Path(d, "Uber Data", "Rider")
        uber.mkdir(parents=True)
        (uber / "trips_data.csv").write_text(
            "City,Product Type,Trip or Order Status,Request Time,Begin Trip Time,Begin Trip Lat,Begin Trip Lng,Begin Trip Address,Dropoff Time,Dropoff Lat,Dropoff Lng,Dropoff Address\n"
            "Lisbon,UberX,COMPLETED,2023-05-16 08:00:00 +0000 UTC,2023-05-16 08:05:00 +0000 UTC,38.77,-9.13,Airport,2023-05-16 08:30:00 +0000 UTC,38.71,-9.14,Baixa\n"
            "Lisbon,UberX,CANCELED,2023-05-17 08:00:00 +0000 UTC,,38.77,-9.13,,,,,\n")
        got, sources = checkins.read([fb, ig, rv, Path(d, "Uber Data")])
    assert sources == {"facebook", "instagram", "google reviews", "uber"}, sources
    assert [(c["source"], c["name"]) for c in got] == [
        ("facebook", ""), ("facebook", "Church of the Nativity"), ("instagram", ""), ("uber", "Airport"), ("uber", "Baixa"),
        ("google reviews", "Pasteis de Belem")], [(c["source"], c["name"]) for c in got]
    assert got[0]["t"] == 1399990000 and got[0]["lat"] == 50.45  # the photo's own time, not the post's
    assert all(c["kind"] in ("post", "check-in", "review", "ride") for c in got)


def test_calendar_events():
    import calendar_events
    with tempfile.TemporaryDirectory() as d:
        Path(d, "Work.ics").write_text(
            "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nDTSTART;VALUE=DATE:20240310\r\nDTEND;VALUE=DATE:20240313\r\nSUMMARY:CHI 2024 conf\r\n"
            " erence\r\nLOCATION:Honolulu\\, HI\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nDTSTART;TZID=Europe/Amsterdam:20240311T100000\r\n"
            "DTEND;TZID=Europe/Amsterdam:20240311T110000\r\nSUMMARY:Call\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nDTSTART:20240401T090000Z\r\n"
            "DTEND:20240401T170000Z\r\nSUMMARY:Project meeting\r\nLOCATION:Gothenburg\r\nSTATUS:CONFIRMED\r\nEND:VEVENT\r\n"
            "BEGIN:VEVENT\r\nDTSTART:20240402T090000Z\r\nSUMMARY:Off\r\nLOCATION:X\r\nSTATUS:CANCELLED\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n")
        got = calendar_events.read([d])
    assert got == [{"start": "2024-03-10", "end": "2024-03-12", "title": "CHI 2024 conference", "location": "Honolulu, HI", "calendar": "Work"},
                   {"start": "2024-04-01", "end": "2024-04-01", "title": "Project meeting", "location": "Gothenburg", "calendar": "Work"}], got


def test_bank_statements():
    import bank
    with tempfile.TemporaryDirectory() as d:
        Path(d, "revolut.csv").write_text(
            "Type,Product,Started Date,Completed Date,Description,Amount,Fee,Currency,State,Balance\n"
            "CARD_PAYMENT,Current,2019-09-13 10:00:00,2019-09-14 10:00:00,Aroma Espresso Bar,-45.00,0.00,ILS,COMPLETED,100\n"
            "TOPUP,Current,2019-09-01 10:00:00,2019-09-01 10:00:00,Top-Up,100.00,0.00,EUR,COMPLETED,200\n"
            "CARD_PAYMENT,Current,2019-09-14 10:00:00,,Declined,-5.00,0.00,EUR,DECLINED,100\n")
        Path(d, "ing.csv").write_text(
            '"Datum";"Naam / Omschrijving";"Rekening";"Tegenrekening";"Code";"Af Bij";"Bedrag (EUR)";"Mutatiesoort";"Mededelingen"\n'
            '"20240105";"ALBERT HEIJN 1234 LEIDEN NLD";"NL00INGB";"";"BA";"Af";"12,50";"Betaalautomaat";"Pasvolgnr: 001"\n'
            '"20240106";"Salaris";"NL00INGB";"NL11";"GT";"Bij";"3000,00";"Overschrijving";""\n'
            '"20240107";"RESTAURANT X MADRID ESP";"NL00INGB";"";"BA";"Af";"30,00";"Betaalautomaat";"Pasvolgnr: 001 Transactie: 1"\n')
        got = bank.read([d])
    assert [(t["date"], t["amount"], t["currency"], t["country"]) for t in got] == [
        ("2019-09-13", -45.0, "ILS", "IL"), ("2024-01-05", -12.5, "EUR", "NL"), ("2024-01-07", -30.0, "EUR", "ES")], got


def test_ovchipkaart_routes_per_year():
    import ovchipkaart
    with tempfile.TemporaryDirectory() as d:
        Path(d, "reizen.csv").write_text(
            "Datum;Check-in;Vertrek;Check-uit;Bestemming;Bedrag;Transactie;Klasse;Product;Opmerkingen;Naam;Kaartnummer\n"
            "02-01-2024;08:01;Leiden;09:15;Haarlem;14,90;Check-uit;2;;;X;1\n"
            "03-01-2024;08:01;Leiden;09:15;Haarlem;14,90;Check-uit;2;;;X;1\n"
            "03-01-2024;18:01;Haarlem, Station;18:15;Haarlem, Zijlweg;1,90;Check-uit;2;;;X;1\n"
            "04-01-2024;;;;;20,00;Saldo opgeladen;;;;X;1\n")
        got = ovchipkaart.legs([Path(d, "reizen.csv")])
    assert [(x["mode"], x["from"], x["to"], x["times"], x["approx"], x["date"][:4]) for x in got] == [
        ("bus", "Haarlem, Station", "Haarlem, Zijlweg", 1, "year", "2024"), ("train", "Leiden", "Haarlem", 2, "year", "2024")], got


if __name__ == "__main__":
    tests = [f for n, f in sorted(globals().items()) if n.startswith("test_") and callable(f)]
    for t in tests:
        t()
    print(f"OK {len(tests)} tests")
