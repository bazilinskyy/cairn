"""Tests for stays.py (hotel, Airbnb and rental car emails; fixtures are anonymised). Run: python mail/test_stays.py."""
import email
import sys
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import stays  # noqa: E402

FIX = Path(__file__).parent / "fixtures"


def load(name):
    return stays.parse_email(email.message_from_bytes((FIX / name).read_bytes()))


def test_booking_hotel():
    s = load("hotel_booking.eml")
    assert (s.kind, s.what, s.provider, s.code) == ("booking", "stay", "Booking.com", "5000000001"), s
    assert (s.place, s.country) == ("Brussels", "Belgium"), s
    assert (s.start, s.end) == (date(2026, 12, 16), date(2026, 12, 17)), s
    assert (s.type, s.price) == ("Hotel", "99€"), s
    assert s.link == "https://secure.booking.com/confirmation.en-gb.html?aid=1;auth_key=TESTKEY", s


def test_booking_cancel():
    s = load("booking_cancel.eml")
    assert (s.kind, s.provider, s.code, s.place) == ("cancel", "Booking.com", "5000000001", "Brussels"), s
    assert (s.start, s.end) == (date(2026, 12, 16), date(2026, 12, 17)), s


def test_airbnb():
    s = load("airbnb_booking.eml")
    assert (s.kind, s.what, s.provider, s.code) == ("booking", "stay", "Airbnb", "HMTEST0001"), s
    assert (s.place, s.country) == ("Annecy", "France"), s
    assert (s.start, s.end) == (date(2026, 6, 15), date(2026, 6, 18)), s
    assert (s.type, s.price) == ("Room", "64.50€"), s
    assert s.link == "https://www.airbnb.com/trips/v1/reservation-details/ro/RESERVATION2_CHECKIN/HMTEST0001", s


def test_airbnb_cancel():
    s = load("airbnb_cancel.eml")
    assert (s.kind, s.provider, s.code) == ("cancel", "Airbnb", "HMTEST0001"), s
    assert (s.start, s.end) == (date(2026, 6, 15), date(2026, 6, 18)), s


def test_discovercars():
    s = load("discovercars_nl.eml")
    assert (s.kind, s.what, s.provider, s.code) == ("booking", "car", "DiscoverCars", "D000000001"), s
    assert (s.place, s.country) == ("Porto", "Portugal"), s
    assert (s.start, s.end) == (date(2026, 11, 12), date(2026, 11, 15)), s
    assert (s.type, s.price) == ("Rental car", "64.20€"), s
    assert s.link == "https://www.discovercars.com/nl/reservation/show/D000000001/dGVzdA==", s


def test_vipcars():
    s = load("vipcars_nl.eml")
    assert (s.kind, s.what, s.provider, s.code) == ("booking", "car", "VIPCars", "G00000001"), s
    assert s.place == "Bangkok", s
    assert (s.start, s.end) == (date(2026, 12, 3), date(2026, 12, 9)), s
    assert s.price == "4500 THB", s
    assert s.link.startswith("https://www.vipcars.com/voucher/?id=G00000001"), s


def test_not_stays():
    for name in ("booking_flights_jsonld.eml", "booking_checkin_reminder.eml", "klm_nl_booking.eml"):
        assert load(name) is None, name


def test_types():
    for name, want in [("Test Hostel", "Hostel"), ("Bed in 6-bed dorm", "Hostel"), ("Sea View Apartment", "Flat"),
                       ("Entire rental unit hosted by A", "Flat"), ("Room hosted by A", "Room"),
                       ("Guest house Test", "Room"), ("Villa Test", "House"), ("Home hosted by A", "House"),
                       ("Grand Plaza", "Hotel")]:
        assert stays.type_of(name) == want, name


def test_price():
    assert stays.price("€ 1,234.50") == "1234.50€"
    assert stays.price("MYR 1.234,00") == "1234 MYR"
    assert stays.price("9.00 EUR") == "9€"
    assert stays.price("Rs. 2,759.40") == "2759.40 INR"
    assert stays.price("Rp 240,241") == "240241 IDR"
    assert stays.price("nothing") == ""


def test_tracked_link():
    url = "https://x.r.eu-west-1.awstrack.me/L0/https:%2F%2Fwww.example.com%2Freservation%2Fshow%2FD1/1/abc=123"
    assert stays._untrack(url) == "https://www.example.com/reservation/show/D1"


if __name__ == "__main__":
    tests = [f for n, f in sorted(globals().items()) if n.startswith("test_") and callable(f)]
    for t in tests:
        t()
    print(f"OK {len(tests)} tests")
