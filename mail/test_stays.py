"""Tests for stays.py (hotel, Airbnb and rental car emails; fixtures are anonymised). Run: python mail/test_stays.py."""
import email
import email.message
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


def mail(sender, subject, body):
    m = email.message.EmailMessage()
    m["From"], m["Subject"], m["Date"] = sender, subject, "Mon, 03 Jun 2024 18:27:57 +0000"
    m.set_content(body)
    return stays.parse_email(m)


def test_couchsurfing_accepted():  # the dates in the language the host's app uses
    s = mail("noreply@marketing.couchsurfing.com", "HOST79 accepted your request",
             "Logo\niOS App\nHOST79 (\nhttps://example.com/u )\n\nKrakow, Lesser Poland, Poland\n •\n240\n references\n"
             " Accepted:\n\nwto, 18 cze, 2024 –\nśro, 19 cze, 2024\n Confirm or cancel your stay")
    assert (s.kind, s.what, s.provider, s.place, s.country) == ("booking", "stay", "Couchsurfing", "Krakow", "Poland"), s
    assert (s.start, s.end, s.code) == (date(2024, 6, 18), date(2024, 6, 19), "cs-host79-20240618"), s


def test_couchsurfing_after_the_stay():  # the same stay (same code) after it, in the older layout
    s = mail("noreply@couchsurfing.com", "How was your stay with Host Name?",
             "| Host Name [](http://example.com) Amman, Amman Governorate, Jordan • 18 References • 41 Friends |\n"
             "| Feedback Required: Thu, 30 Aug, 2018 – Sat, 1 Sep, 2018 Would you stay with Host Name again? |")
    assert (s.place, s.country, s.start, s.end, s.code) == ("Amman", "Jordan", date(2018, 8, 30), date(2018, 9, 1), "cs-hostname-20180830"), s


def test_couchsurfing_hosting_is_not_a_stay():  # someone asking to stay with you
    assert mail("noreply@notifications.couchsurfing.com", 'Guest requested to stay with you: "Hey" - Couchsurfing',
                "Guest Plymouth, England • 2 references 1 night Requested: Mon, 15 Sep, 2025 – Tue, 16 Sep, 2025") is None


def test_bewelcome_accepted():
    body = ("Dear me,\n\nHost\\_Porto has replied to your hosting request.\n\nHi!\n\n##### Request details\n\n"
            " You can stay with Host\\_Porto.\n\n Arrival:\n Monday, December 2, 2024\n Departure:\n Tuesday, December 3, 2024\n")
    s = mail("message@bewelcome.org", "Re: Visiting Porto for a day on the way to Azores  (accepted)", body)
    assert (s.provider, s.place, s.start, s.end, s.code) == ("BeWelcome", "Porto", date(2024, 12, 2), date(2024, 12, 3), "bw-host_porto-20241202"), s
    s = mail("message@bewelcome.org", "Re: Ukrainian living in Holland, coming to Palermo for 2 nights (accepted)", body)
    assert s.place == "Palermo", s
    s = mail("message@bewelcome.org", "Re: Last minute request. Plane rerouted ;( (Accepted)", body)
    assert s.place == "BeWelcome host Host_Porto", s  # Cairn places it by the rest of your data
    assert mail("message@bewelcome.org", "Re: Coming to Palermo (Tentatively accepted)", body) is None


if __name__ == "__main__":
    tests = [f for n, f in sorted(globals().items()) if n.startswith("test_") and callable(f)]
    for t in tests:
        t()
    print(f"OK {len(tests)} tests")
