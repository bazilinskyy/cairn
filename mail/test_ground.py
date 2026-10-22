"""Tests for ground.py (trains, buses, ferries). Run: python mail/test_ground.py (no pytest needed)."""
import sys
from datetime import datetime as D
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import ground  # noqa: E402
import parse  # noqa: E402
import test_parse  # noqa: E402

# GeoNames cities1000 rows: id, name, asciiname, alternatenames, lat, lon, class, code, country, cc2,
# admin1-4, population, elevation, dem, timezone, modified
CITIES = [("Breda", "", 180000, "Europe/Amsterdam"), ("Brussels", "Bruxelles,Brussel", 1019022, "Europe/Brussels"),
          ("Chambéry", "", 59000, "Europe/Paris"), ("Grenoble", "", 158000, "Europe/Paris"),
          ("Madurai", "", 909908, "Asia/Kolkata"), ("Chennai", "Madras", 4681087, "Asia/Kolkata"),
          ("Lisbon", "Lisboa", 517802, "Europe/Lisbon"), ("Porto", "", 249633, "Europe/Lisbon"),
          ("Beja", "", 21000, "Europe/Lisbon"), ("Évora", "Evora", 56000, "Europe/Lisbon"),
          ("Kuala Lumpur", "", 1453975, "Asia/Kuala_Lumpur"), ("Porto", "", 800, "America/Sao_Paulo")]


def cities(tmp=HERE / ".test_cities.txt"):
    tmp.write_text("\n".join("\t".join([str(i), n, n, alt, "0", "0", "P", "PPL", "XX", "", "", "", "", "", str(pop), "", "0", tz, "2026-01-01"])
                             for i, (n, alt, pop, tz) in enumerate(CITIES)), encoding="utf-8")
    try:
        return ground.load_cities(tmp)
    finally:
        tmp.unlink()


def parsed(name):
    return parse.parse_email(test_parse.fixture(name), test_parse.airports(), test_parse.airlines(), cities())


def legs(p):
    return [(l.mode, l.flight, l.dep, l.arr, l.dep_local, l.arr_local) for l in p.legs]


def test_station_tz():
    c = cities()
    assert ground.station_tz("Bruxelles Midi", c, "Europe/Amsterdam") == "Europe/Brussels"
    assert ground.station_tz("Lisboa (Sete Rios)", c, "Europe/Amsterdam") == "Europe/Lisbon"
    assert ground.station_tz("Porto (Campanhã)", c, "Europe/Amsterdam") == "Europe/Lisbon"  # the bigger Porto wins
    assert ground.station_tz("Evora", c, "x") == "Europe/Lisbon"
    assert ground.station_tz("Nowhere Halt", c, "Europe/Amsterdam") == "Europe/Amsterdam"


def test_ns_international_train():
    p = parsed("ns_train")
    assert p.kind == "booking"
    assert legs(p) == [("train", "EC9236", "Breda", "Bruxelles Midi", D(2026, 12, 14, 13, 42), D(2026, 12, 14, 15, 17)),
                       ("train", "EC9255", "Bruxelles Midi", "Breda", D(2026, 12, 15, 16, 44), D(2026, 12, 15, 18, 19))]
    l = p.legs[0]
    assert (l.dep_tz, l.arr_tz, l.codes, l.arr_guess) == ("Europe/Amsterdam", "Europe/Brussels", ("TRAIN12",), False)


def test_sncf_journey_without_arrival():
    p = parsed("sncf_ground")
    assert legs(p) == [("train", "", "Chambéry", "Grenoble", D(2026, 12, 11, 9, 14), D(2026, 12, 11, 10, 14))]
    assert p.legs[0].arr_guess and p.legs[0].codes == ("TRN123", "TRN456") and p.legs[0].dep_tz == "Europe/Paris"


def test_redbus_twelve_hour_times():
    p = parsed("redbus_ground")
    assert legs(p) == [("bus", "", "Madurai", "Chennai", D(2027, 1, 14, 21, 45), D(2027, 1, 14, 23, 35))]
    assert p.legs[0].codes[0] == "FRE0000000" and p.legs[0].dep_tz == "Asia/Kolkata"


def test_flix_markup():
    p = parsed("flix_bus")
    assert legs(p) == [("bus", "", "Lisboa (Oriente)", "Porto (Campanhã)", D(2026, 11, 21, 9, 30), D(2026, 11, 21, 13, 0))]
    assert p.legs[0].codes == ("3000000001",) and p.legs[0].dep_tz == "Europe/Lisbon"


def test_flix_cancel_by_code():
    p = parsed("flix_cancel")
    assert p.kind == "cancel" and p.legs == [] and "3000000001" in p.codes


def test_twelvego_markup_keeps_clock_time():
    p = parsed("twelvego_bus")
    assert legs(p) == [("bus", "", "Kuala Lumpur (KL Sentral)", "Kuala Lumpur (Klia1)", D(2026, 12, 5, 18, 0), D(2026, 12, 5, 19, 0))]
    assert p.legs[0].dep_tz == "Asia/Kuala_Lumpur"


def test_repeated_markup_counts_once():
    msg = test_parse.fixture("twelvego_bus")
    html = msg.get_payload(decode=True).decode()
    block = html[html.index("<script"):html.index("</script>") + 9]
    twice = html.replace(block, block + block)
    found = ground.legs("x@b.12go.asia", "", twice, parse.html_to_text(twice).split("\n"), D(2026, 10, 20), cities(),
                        "Europe/Amsterdam", "bus")
    assert len(found) == 1


def test_rede_expressos():
    p = parsed("rne_bus")
    assert legs(p) == [("bus", "", "Lisboa (Sete Rios)", "Beja", D(2026, 11, 28, 8, 0), D(2026, 11, 28, 12, 45))]
    assert p.legs[0].codes[0] == "1R00TESTX"


def test_ground_instants_use_station_zones():
    l = parsed("ns_train").legs[0]
    dep, arr = l.instants({})
    assert dep.utcoffset().total_seconds() == 3600 and str(arr.tzinfo) == "Europe/Brussels"


def test_flights_unchanged():
    assert parsed("klm_nl_booking").legs[0].mode == "flight"
    assert parsed("hotel_booking").legs == []


if __name__ == "__main__":
    tests = [f for n, f in sorted(globals().items()) if n.startswith("test_") and callable(f) and hasattr(f, "__code__")]
    for t in tests:
        t()
    print(f"OK {len(tests)} tests")
