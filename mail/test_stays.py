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


def test_hostelworld():
    body = ("Hi Test, your booking is confirmed\nReference Number: 10000-100000001\nManage Booking\nBooking Information\n"
            "Test Hostel\nTeststraat 1, Ghent, Belgium\ntest@example.com\nCheck In: Tue 9th Feb 2027\nCheck Out: Thu 11th Feb 2027\n"
            "Arrival Time: 18:00\nTue 9th Feb 2027\n6 Bed Mixed Dorm\n1 Bed\n€20.00\nTotal Cost: €40.00\nTotal Paid: €6.00\n")
    s = mail("bookings@hostelworld.com", "Confirmed booking from hostelworld.com - Test Hostel, Ghent", body)
    assert (s.kind, s.what, s.provider, s.code) == ("booking", "stay", "Hostelworld", "10000-100000001"), s
    assert (s.place, s.country, s.start, s.end, s.type, s.price) == ("Ghent", "Belgium", date(2027, 2, 9), date(2027, 2, 11), "Hostel", "40€"), s
    s = mail("bookings@hostelworld.com", "Hostelworld.com - Reservatie geannuleerd - Test Hostel, Ghent",
             "Hallo Test,\nje boeking is gratis geannuleerd.\nReserveringsaantal: 10000-100000001\nboekingsinformatie\nTest Hostel\n"
             "Teststraat 1, Ghent, België\nCHECKIN: Din 9 feb 2027\nCHECKOUT: Don 11 feb 2027\nStatus: Geannuleerd\n")
    assert (s.kind, s.code, s.start) == ("cancel", "10000-100000001", date(2027, 2, 9)), s
    assert mail("bookings@hostelworld.com", "Hi Test, how was your stay at Test Hostel?", body) is None


def test_hostelworld_old_layout():  # before about 2016: a <head> never closed, one row a night, no check-out
    m = email.message.EmailMessage()
    m["From"], m["Subject"], m["Date"] = "bookings@hostelworld.com", "Confirmed booking from hostelworld.com - Test Hostel, Cork", \
        "Thu, 01 May 2014 13:58:43 +0000"
    m.set_content("<html><head><style>p { margin: 0 }</style><body><table><tr><td>Your booking is confirmed. Your reference "
                  "number is 20000-200000002</td></tr><tr><td>Test Hostel</td></tr><tr><td>1 Test Road</td></tr><tr><td>Cork"
                  "</td></tr><tr><td>Ireland</td></tr><tr><td>p. +000 0000</td></tr><tr><td>Date</td><td>Room Details</td></tr>"
                  "<tr><td>Sat 3rd May 2014</td><td>6 Bed Mixed Dorm</td><td>&euro;13.00</td></tr><tr><td>Sun 4th May 2014</td>"
                  "<td>6 Bed Mixed Dorm</td><td>&euro;13.00</td></tr><tr><td>Total: &euro;26.00</td></tr></table></body></html>",
                  subtype="html")
    s = stays.parse_email(m)
    assert (s.code, s.place, s.country, s.start, s.end, s.price) == ("20000-200000002", "Cork", "Ireland", date(2014, 5, 3),
                                                                       date(2014, 5, 5), "26€"), s


def test_tripcom_hotel():  # a folded subject; its flight mails are left to parse.py
    m = email.message_from_bytes((
        "From: EN_HTL_NoReply@trip.com\nSubject: [Booking confirmation] Your booking at Test Inn has\n been confirmed-NoReply\n"
        "Date: Mon, 03 Jun 2024 18:27:57 +0000\nContent-Type: text/plain; charset=utf-8\n\nBooking No. 1 600 000 000 000 001\nHi TEST! The booking for your stay in Ghent "
        "is confirmed.\nCheck-in and check-out times\nFor the room type you selected, check-in is from 13:00.\nTest Inn\n"
        "Check-in\nApr 3, 2024 After 13:00 Hotel's local time\nCheck-out\nApr 4, 2024 10:00–12:00 Hotel's local time\n"
        "Address\nTeststraat 1, Ghent, 9000, Belgium\nTotal\nPrepay Online\n€20.00\nStandard Room with City View\n").encode())
    s = stays.parse_email(m)
    assert (s.provider, s.code, s.place, s.country) == ("Trip.com", "1600000000000001", "Ghent", "Belgium"), s
    assert (s.start, s.end, s.type, s.price) == (date(2024, 4, 3), date(2024, 4, 4), "Hotel", "20€"), s
    assert mail("trip.com@trip.com", "Flight Booking Confirmed (PIN: 0000, Booking No.: 10000000001)", "Booking No. 10000000001") is None


def test_hotelscom():
    s = mail("confirmation@mail.hotels.com", "Hotels.com reservation confirmation 9100000000001 - Test Villa - Test Town",
             "Test Villa\n1 Test Road, Test Town, 00000, VI\nCheck-in\nFriday, March 4, 2022 (3 PM-10:00 PM local time)\n"
             "Check-out\nSunday, March 6, 2022 (Before 11 AM local time)\nTotal price\n$180.00\n")
    assert (s.provider, s.code, s.place, s.start, s.end, s.type, s.price) == (
        "Hotels.com", "9100000000001", "Test Town", date(2022, 3, 4), date(2022, 3, 6), "House", "180 USD"), s
    s = mail("info@reply.mail.hotels.com", "Your reservation has been canceled - confirmation no: 9100000000001, Test Villa",
             "Test Villa\n1 Test Road, Test Town, 00000, VI\nCheck-in\nFriday, March 4, 2022\n")
    assert (s.kind, s.code, s.place) == ("cancel", "9100000000001", "Test Town"), s


def test_expedia_cars():
    s = mail("Expedia@expediamail.com", "Expedia car rental confirmation - Tue, Jun 4 - (Itinerary # 72000000000001)",
             "Thank you Test, your car reservation is confirmed\nPick-up\nTue, Jun 4 at 2:00pm\nTest Cars\n"
             "1 Test Road, Test Area, Ponce, PRI\nDrop-off\nSat, Jun 8 at 2:00pm\nTotal\n$120.50\n")
    assert (s.what, s.provider, s.code, s.place) == ("car", "Expedia", "72000000000001", "Ponce"), s
    assert (s.start, s.end, s.price) == (date(2024, 6, 4), date(2024, 6, 8), "120.50 USD"), s
    s = mail("expedia@eg.expedia.com", "Bevestiging Expedia-autoverhuur: do. 6 jun. (reisplannr. 73000000000001)",
             "Je autoboeking is bevestigd.\nTest Cars autoverhuur in Dubai\nOphalen en inleveren\n"
             "do. 6 jun., 09.00 uur - vr. 7 jun., 09.00 uur\nTest Airport, Dubai, ARE, DXB\nTotaal\n€ 30,00\n")
    assert (s.code, s.place, s.start, s.end, s.price) == ("73000000000001", "Dubai", date(2024, 6, 6), date(2024, 6, 7), "30€"), s
    s = mail("Expedia@expediamail.com", "Confirmed: Expedia Car Rental Cancellation - Hertz, Tue, Jun 4 - Fri, Jun 7 "
             "(Itinerary #72000000000002)", "Hi Test, your car reservation was cancelled")
    assert (s.kind, s.what, s.code) == ("cancel", "car", "72000000000002"), s
    assert mail("Expedia@nl.expediamail.com", "Autoreservering van Expedia geannuleerd", "Je autoreservering is geannuleerd.") is None


if __name__ == "__main__":
    tests = [f for n, f in sorted(globals().items()) if n.startswith("test_") and callable(f)]
    for t in tests:
        t()
    print(f"OK {len(tests)} tests")
