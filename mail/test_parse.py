"""Tests for parse.py. Run: python mail/test_parse.py (no pytest needed)."""
import email
import sys
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import parse  # noqa: E402

AIRPORTS_DAT = "\n".join([
    '580,"Amsterdam Airport Schiphol","Amsterdam","Netherlands","AMS","EHAM",52.3086,4.76389,-11,1,"E","Europe/Amsterdam","airport","OurAirports"',
    '1229,"Adolfo Suárez Madrid–Barajas Airport","Madrid","Spain","MAD","LEMD",40.4719,-3.56264,1998,1,"E","Europe/Madrid","airport","OurAirports"',
    '1638,"Humberto Delgado Airport (Lisbon Portela Airport)","Lisbon","Portugal","LIS","LPPT",38.7813,-9.13592,374,0,"E","Europe/Lisbon","airport","OurAirports"',
    '1636,"João Paulo II Airport","Ponta Delgada","Portugal","PDL","LPPD",37.7412,-25.6979,259,-1,"E","Atlantic/Azores","airport","OurAirports"',
    '1626,"Faro Airport","Faro","Portugal","FAO","LPFR",37.0144,-7.96591,24,0,"E","Europe/Lisbon","airport","OurAirports"',
    '585,"Eindhoven Airport","Eindhoven","Netherlands","EIN","EHEH",51.4501,5.37453,74,1,"E","Europe/Amsterdam","airport","OurAirports"',
    '3797,"John F Kennedy International Airport","New York","United States","JFK","KJFK",40.6398,-73.7789,13,-5,"A","America/New_York","airport","OurAirports"',
    '1678,"Francisco de Sá Carneiro Airport","Porto","Portugal","OPO","LPPR",41.2481,-8.68139,228,0,"E","Europe/Lisbon","airport","OurAirports"',
    '1627,"Santa Maria Airport","Santa Maria Island","Portugal","SMA","LPAZ",36.9714,-25.1706,308,-1,"E","Atlantic/Azores","airport","OurAirports"',
    '1633,"Lajes Airport","Lajes (terceira Island)","Portugal","TER","LPLA",38.7618,-27.0908,180,-1,"E","Atlantic/Azores","airport","OurAirports"',
    '1239,"Alicante International Airport","Alicante","Spain","ALC","LEAL",38.2822,-0.558156,142,1,"E","Europe/Madrid","airport","OurAirports"',
    '1489,"Budapest Liszt Ferenc International Airport","Budapest","Hungary","BUD","LHBP",47.4369,19.2556,495,1,"E","Europe/Budapest","airport","OurAirports"',
    '1526,"Bologna Guglielmo Marconi Airport","Bologna","Italy","BLQ","LIPE",44.5354,11.2887,123,1,"E","Europe/Rome","airport","OurAirports"',
    '1382,"Charles de Gaulle International Airport","Paris","France","CDG","LFPG",49.0128,2.55,392,1,"E","Europe/Paris","airport","OurAirports"',
    '4317,"Kalaleh Airport","Kalaleh","Iran","KLM","OINE",37.3833,55.452,0,3.5,"E","Asia/Tehran","airport","OurAirports"',
    '9999,"No Code Field","Nowhere","Nowhere",\\N,"XXXX",0,0,0,0,"U",\\N,"airport","OurAirports"',
])


def airports(tmp=HERE / ".test_airports.dat"):
    tmp.write_text(AIRPORTS_DAT, encoding="utf-8")
    try:
        return parse.load_airports(tmp)
    finally:
        tmp.unlink()


AIRLINES_DAT = "\n".join([
    '3090,"KLM Royal Dutch Airlines","","KL","KLM","KLM","Netherlands","Y"',
    '4296,"Ryanair","","FR","RYR","RYANAIR","Ireland","Y"',
    '2297,"easyJet","","U2","EZY","EASY","United Kingdom","Y"',
    '5461,"Wizz Air","","W6","WZZ","WIZZ AIR","Hungary","Y"',
    '4254,"SATA International","","S4","RZO","AIR AZORES","Portugal","Y"',
    '4255,"SATA Air Acores","","SP","SAT","SATA","Portugal","Y"',
    '137,"Air France","","AF","AFR","AIRFRANS","France","Y"',
    '4319,"TAP Portugal","","TP","TAP","AIR PORTUGAL","Portugal","Y"',
    '9998,"Defunct Air","","KL","KLX","","Nowhere","N"',
])


def airlines(tmp=HERE / ".test_airlines.dat"):
    tmp.write_text(AIRLINES_DAT, encoding="utf-8")
    try:
        return parse.load_airlines(tmp)
    finally:
        tmp.unlink()


def parsed(name):
    return parse.parse_email(fixture(name), airports(), airlines())


def legs(p):
    return [(l.flight, l.dep, l.arr, l.dep_local, l.arr_local) for l in p.legs]


def fixture(name):
    return email.message_from_bytes((HERE / "fixtures" / f"{name}.eml").read_bytes())


def html_of(msg):
    return next(p.get_payload(decode=True).decode(p.get_content_charset() or "utf-8")
                for p in msg.walk() if p.get_content_type() == "text/html")


def test_load_airports():
    ap = airports()
    assert ap["AMS"].tz == "Europe/Amsterdam"
    assert ap["PDL"].tz == "Atlantic/Azores"
    assert ap["LIS"].city == "Lisbon"
    assert "XXXX" not in ap and len(ap) == 15


def test_html_to_text_tables():
    text = parse.html_to_text("<table><tr><td>16:10</td><td>MAD</td></tr></table><p>A<br>B</p>")
    assert "16:10 | MAD" in text.splitlines()
    assert "A" in text.splitlines() and "B" in text.splitlines()


def test_jsonld_flight():
    html = """<script type="application/ld+json">{"@context": "http://schema.org", "@type": "FlightReservation",
      "reservationNumber": "ABC123", "reservationFor": {"@type": "Flight", "flightNumber": "1234",
      "airline": {"@type": "Airline", "iataCode": "KL"},
      "departureAirport": {"@type": "Airport", "iataCode": "MAD"}, "departureTime": "2026-11-16T16:10:00+01:00",
      "arrivalAirport": {"@type": "Airport", "iataCode": "AMS"}, "arrivalTime": "2026-11-16T19:15:00+01:00"}}</script>"""
    legs = parse.jsonld_legs(html, airports())
    assert len(legs) == 1
    leg = legs[0]
    assert (leg.flight, leg.dep, leg.arr) == ("KL1234", "MAD", "AMS")
    assert leg.codes == ("ABC123",)
    assert leg.dep_local == datetime(2026, 11, 16, 16, 10)
    assert leg.arr_local == datetime(2026, 11, 16, 19, 15)
    assert leg.complete


def test_jsonld_offset_converted_to_airport_time():
    html = """<script type="application/ld+json">[{"@type": "FlightReservation", "reservationNumber": "ABC123",
      "reservationFor": {"flightNumber": "TP1234", "airline": {"iataCode": "TP"},
      "departureAirport": {"iataCode": "LIS"}, "departureTime": "2026-11-16T09:00:00Z",
      "arrivalAirport": {"iataCode": "AMS"}, "arrivalTime": "2026-11-16T11:45:00Z"}}]</script>"""
    leg = parse.jsonld_legs(html, airports())[0]
    assert leg.flight == "TP1234"  # airline prefix not doubled
    assert leg.dep_local == datetime(2026, 11, 16, 9, 0)    # Lisbon is UTC+0 in November
    assert leg.arr_local == datetime(2026, 11, 16, 12, 45)  # Amsterdam is UTC+1


def test_jsonld_fixture_with_empty_reservation_number():
    leg = parse.jsonld_legs(html_of(fixture("booking_flights_jsonld")), airports() | {"BUD": parse.Airport("Budapest", "Budapest", "Europe/Budapest")})[0]
    assert (leg.flight, leg.dep, leg.arr, leg.codes) == ("W62202", "EIN", "BUD", ())
    assert leg.dep_local == datetime(2026, 11, 26, 21, 15)


def test_microdata_fixture():
    ap = airports() | {"ALC": parse.Airport("Alicante", "Alicante", "Europe/Madrid")}
    leg = parse.jsonld_legs(html_of(fixture("ryanair_nl")), ap)[0]
    assert (leg.flight, leg.dep, leg.codes) == ("FR8302", "EIN", ("DEF456",))
    assert leg.arr == ""  # empty in the markup: text rules fill it in
    assert leg.dep_local == datetime(2026, 11, 20, 7, 15)
    assert not leg.complete


def test_load_airlines():
    al = airlines()
    assert al["KL"] == ("KL", "KLM Royal Dutch Airlines") and al["KLM"] == ("KL", "KLM Royal Dutch Airlines")
    assert al["EZY"][0] == "U2"


D = datetime


def test_klm_nl_booking():
    p = parsed("klm_nl_booking")
    assert p.kind == "booking"
    assert legs(p) == [("KL1234", "AMS", "LIS", D(2026, 11, 16, 16, 10), D(2026, 11, 16, 17, 55))]
    assert p.legs[0].codes == ("ABC123",)
    assert p.passengers == ["Jan Testers"]


def test_ryanair_microdata_filled_from_text():
    p = parsed("ryanair_nl")
    assert p.kind == "booking"
    assert legs(p) == [("FR8302", "EIN", "ALC", D(2026, 11, 20, 7, 15), D(2026, 11, 20, 9, 50))]
    assert p.legs[0].codes == ("DEF456",)
    assert parse.is_passenger(p.passengers, ["Jan Testers"])


def test_round_trip():
    p = parsed("easyjet_round_trip")
    assert p.kind == "booking"
    assert legs(p) == [("U27891", "AMS", "OPO", D(2027, 3, 5, 11, 40), D(2027, 3, 5, 13, 10)),
                       ("U27892", "OPO", "AMS", D(2027, 3, 12, 15, 5), D(2027, 3, 12, 18, 35))]
    assert all(l.codes == ("KQX7Z2T",) for l in p.legs)
    assert parse.is_passenger(p.passengers, ["Jan Testers"])


def test_gotogate_change():
    p = parsed("gotogate_change")
    assert p.kind == "change"
    assert legs(p) == [("S4127", "LIS", "PDL", D(2026, 10, 29, 10, 0), D(2026, 10, 29, 11, 45)),
                       ("SP412", "PDL", "SMA", D(2026, 10, 29, 13, 30), D(2026, 10, 29, 14, 5)),
                       ("SP517", "SMA", "TER", D(2026, 11, 4, 13, 50), D(2026, 11, 4, 14, 55)),
                       ("S4140", "TER", "LIS", D(2026, 11, 4, 18, 55), D(2026, 11, 4, 22, 15))]
    assert p.legs[0].codes[0] == "ABC123"
    assert parse.is_passenger(p.passengers, ["Jan Testers"])


def test_overnight():
    p = parsed("edreams_nl_overnight")
    assert p.kind == "booking"
    assert legs(p) == [("KL1702", "MAD", "AMS", D(2026, 11, 16, 22, 30), D(2026, 11, 17, 1, 5))]
    leg = p.legs[0]
    assert leg.codes == ("ABC123", "11112222333") and leg.agency == "eDreams 11112222333"
    dep, arr = leg.instants(airports())
    assert arr - dep == timedelta(hours=2, minutes=35)  # the stated duration


def test_rebooking_has_old_legs():
    p = parsed("klm_rebooked")
    assert p.kind == "change"
    assert legs(p) == [("AF1229", "BLQ", "CDG", D(2026, 12, 7, 6, 50), D(2026, 12, 7, 8, 40)),
                       ("AF1840", "CDG", "AMS", D(2026, 12, 7, 11, 30), D(2026, 12, 7, 13, 0))]
    assert [(l.flight, l.dep, l.arr, l.dep_local) for l in p.old_legs] == [("KL1642", "BLQ", "AMS", D(2026, 12, 6, 17, 0))]
    assert p.legs[0].codes == ("GHI654",) and p.old_legs[0].codes == ("GHI654",)


def test_booking_jsonld_code_from_text():
    p = parsed("booking_flights_jsonld")
    assert p.kind == "booking"
    assert legs(p) == [("W62202", "EIN", "BUD", D(2026, 11, 26, 21, 15), D(2026, 11, 26, 23, 20))]
    assert p.legs[0].codes == ("QWE321", "40-0000000001") and p.legs[0].agency == "Booking.com 40-0000000001"


def test_ignored():
    for name in ("booking_checkin_reminder", "google_price_alert"):
        assert parsed(name).kind == "other", name


def test_synthetic_cancel():
    p = parsed("synthetic_cancel_nl")
    assert p.kind == "cancel"
    assert [(l.flight, l.dep, l.arr, l.codes) for l in p.legs] == [("KL1234", "AMS", "LIS", ("ABC123",))]


def test_other_passenger():
    p = parsed("synthetic_other_passenger")
    assert p.passengers == ["Anna Testers"]
    assert not parse.is_passenger(p.passengers, ["Jan Testers"])
    assert parse.is_passenger([], ["Jan Testers"])
    assert parse.is_passenger(["TESTERS/JAN MR"], ["Jan Testers"])
    assert parse.is_passenger(["Dhr. JAN TÉSTERS"], ["Jan Testers"])


def test_looks_like_flight():
    assert parsed("klm_nl_booking").looks_like_flight
    blank = email.message_from_string("Subject: hello\nFrom: a@example.com\nContent-Type: text/html\n\n<p>Lunch at 12:30?</p>")
    p = parse.parse_email(blank, airports(), airlines())
    assert p.kind == "other" and not p.looks_like_flight and p.legs == []


def test_hotel_and_train_give_no_flights():
    for name in ("hotel_booking", "ns_train"):
        p = parsed(name)
        assert p.legs == [] and not p.looks_like_flight, (name, p.legs)


def test_action_needed_is_other():
    assert parsed("gotogate_action_needed").kind == "other"


def test_reply_and_forward_are_other():
    msg = fixture("klm_nl_booking")
    del msg["Subject"]
    for subject in ("Re: Boeking bevestigd", "[Gotogate] Re: Child Ticket: ABC123", "FW: Boeking bevestigd"):
        del msg["Subject"]
        msg["Subject"] = subject
        assert parse.parse_email(msg, airports(), airlines()).kind == "other", subject


def test_gotogate_order_update():
    p = parsed("gotogate_order_update")
    assert p.kind == "change"
    assert legs(p) == [("S4127", "LIS", "PDL", D(2026, 10, 29, 10, 0), D(2026, 10, 29, 11, 45)),
                       ("SP412", "PDL", "SMA", D(2026, 10, 29, 13, 30), D(2026, 10, 29, 14, 5))]


def test_unresolved_city_keeps_flight_and_day():
    p = parsed("easyjet_city_names")
    assert [(l.flight, l.dep, l.when) for l in p.legs] == [("U27891", "", date(2027, 3, 5)), ("U27892", "", date(2027, 3, 12))]


def test_codes_are_not_flight_numbers():
    al = {"CV": ("CV", "Cargolux"), "V3": ("V3", "Carpatair"), "NL": ("NL", "Shaheen"), "EC": ("EC", "easyJet Europe")}
    assert parse._flights("Booking V33IPW, reference CV6LTG", al) == []
    assert parse._flights("IBAN NL87 ABNA 0000", al) == ["NL87"]  # shape alone is not enough: context decides
    assert parse._flights("Flight number : EC9236", al) == ["EC9236"]


def test_latest_date():
    assert parsed("gotogate_order_update").latest_date == date(2026, 10, 29)
    assert parsed("klm_nl_booking").latest_date == date(2026, 11, 16)


def test_jsonld_flight_number_punctuation():
    html = """<script type="application/ld+json">{"@type": "FlightReservation", "reservationNumber": "ABC123",
      "reservationFor": {"flightNumber": "IU-863", "airline": {"iataCode": "IU"},
      "departureAirport": {"iataCode": "MAD"}, "departureTime": "2026-11-16T16:10:00",
      "arrivalAirport": {"iataCode": "AMS"}, "arrivalTime": "2026-11-16T18:45:00"}}</script>"""
    leg = parse.jsonld_legs(html, airports())[0]
    assert leg.flight == "IU863" and leg.when == date(2026, 11, 16)


def test_instants_dst():
    ap = airports()
    after = parse.Leg("S41234", "LIS", "PDL", datetime(2026, 10, 29, 10, 0), datetime(2026, 10, 29, 11, 45), ("ABC123",))
    dep, arr = after.instants(ap)
    assert dep.astimezone(timezone.utc).replace(tzinfo=None) == datetime(2026, 10, 29, 10, 0)
    assert arr.astimezone(timezone.utc).replace(tzinfo=None) == datetime(2026, 10, 29, 12, 45)
    before = parse.Leg("S41234", "LIS", "PDL", datetime(2026, 10, 21, 10, 0), datetime(2026, 10, 21, 11, 45), ("ABC123",))
    dep, arr = before.instants(ap)
    assert dep.astimezone(timezone.utc).replace(tzinfo=None) == datetime(2026, 10, 21, 9, 0)
    assert arr.astimezone(timezone.utc).replace(tzinfo=None) == datetime(2026, 10, 21, 11, 45)


if __name__ == "__main__":
    tests = [f for n, f in sorted(globals().items()) if n.startswith("test_")]
    for t in tests:
        t()
    print(f"OK {len(tests)} tests")
