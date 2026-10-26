"""Hotel, Airbnb and rental car bookings from emails (Booking.com, Airbnb, DiscoverCars, VIPCars), and stays with hosts
(Couchsurfing, BeWelcome), for the trip docs.
Text rules only: these emails carry no schema.org markup."""
import re
from dataclasses import dataclass
from datetime import date, datetime
from html import unescape
from urllib.parse import unquote

from parse import MONTH, MONTHS, _dates, html_to_text, message_parts


@dataclass(frozen=True)
class Stay:
    kind: str          # "booking" or "cancel"
    what: str          # "stay" or "car"
    provider: str
    code: str
    place: str = ""
    country: str = ""
    start: date = None
    end: date = None
    type: str = ""     # what the Accommodation link says: Hotel, Hostel, Flat, Room, House; "Rental car"
    price: str = ""    # like the docs: "99€", "770 MYR"
    link: str = ""


TYPES = [("Hostel", r"hostel|\bdorm|\bbed in\b|capsule"),
         ("Flat", r"apart(?:ment|amento|ament)|appartement|\bflat\b|studio|condo|rental unit|\bloft\b"),
         ("Room", r"\broom\b|guest ?house|homestay|b&b|bed and breakfast|pension"),
         ("House", r"\bhouse\b|villa|\bhome\b|cottage|chalet|cabin|bungalow"),
         ("Hotel", r"hotel|\binn\b|resort|motel|lodge")]
CURRENCY = {"€": "EUR", "$": "USD", "£": "GBP", "Rs.": "INR", "Rs": "INR", "₹": "INR", "Rp": "IDR"}


def type_of(*texts):
    """The first type any of the texts names (property name before room), else Hotel."""
    for text in texts:
        for name, rx in TYPES:
            if text and re.search(rx, text, re.I):
                return name
    return "Hotel"


def price(text):
    m = re.search(r"(€|\$|£|₹|\bRs\.?|\bRp|\b[A-Z]{3}\b)\s*(\d[\d.,]*)|(\d[\d.,]*)\s*(€|\b[A-Z]{3}\b)", text or "")
    if not m:
        return ""
    cur, num = (m.group(1), m.group(2)) if m.group(1) else (m.group(4), m.group(3))
    cur = CURRENCY.get(cur, cur)
    if "," in num and "." in num:
        dec = max(num.rfind(","), num.rfind("."))
        num = re.sub(r"[.,]", "", num[:dec]) + "." + num[dec + 1:]
    elif "," in num:
        num = num.replace(",", ".") if re.search(r",\d{2}$", num) else num.replace(",", "")
    elif re.fullmatch(r"\d{1,3}(\.\d{3})+", num):
        num = num.replace(".", "")
    num = re.sub(r"\.00$", "", num)
    return f"{num}€" if cur == "EUR" else f"{num} {cur}"


def _date(text, hint):
    """A date in text: '16 December 2026', '26 sep 2026', '2026-09-28', '05-08-2026', or 'Jul 21' (year from hint)."""
    found = _dates(text, hint)
    if found:
        return found[0][1].date()
    m = re.search(r"\b(\d{1,2})-(\d{1,2})-(\d{4})\b", text)
    if m:
        return date(int(m.group(3)), int(m.group(2)), int(m.group(1)))
    m = re.search(rf"(?i)\b(\d{{1,2}})-({MONTH})-(\d{{4}})\b", text)
    if m:
        return date(int(m.group(3)), MONTHS[m.group(2).lower()], int(m.group(1)))
    m = re.search(rf"(?i)\b({MONTH})\.?\s+(\d{{1,2}})\b(?:,?\s+(\d{{4}}))?", text)
    if m:
        d = date(int(m.group(3) or hint.year), MONTHS[m.group(1).lower()], int(m.group(2)))
        return d if m.group(3) or d >= hint.date() else d.replace(year=d.year + 1)
    return None


def _after(lines, label, hint=None, reach=3):
    """The text after a label at the start of a line, or the next line; with hint, the first date within reach lines."""
    for i, line in enumerate(lines):
        m = re.match(rf"(?i)(?:{label})[\s:|]*(.*)$", line)
        if not m:
            continue
        rest = [m.group(1)] + lines[i + 1:i + 1 + reach]
        if hint is None:
            return next((x for x in rest if x), "")
        for x in rest:
            d = _date(x, hint)
            if d:
                return d
    return None if hint else ""


def _links(html):
    return [(_untrack(unescape(u)), re.sub(r"<[^>]+>|\s+", " ", unescape(t)).strip())
            for u, t in re.findall(r'(?is)<a\s[^>]*?href="([^"]+)"[^>]*>((?:(?!<a\s).)*?)</a>', html)]


def _untrack(url):
    """The real address behind an Amazon SES click-tracking link (…awstrack.me/L0/<quoted url>/…)."""
    m = re.search(r"awstrack\.me/L0/([^/]+)", url)
    return unquote(m.group(1)) if m else url


def _link(html, text_rx, url_rx):
    links = _links(html)
    return next((u for u, t in links if re.search(text_rx, t, re.I)), "") or \
        next((u for u, t in links if re.search(url_rx, u)), "")


def _booking(subject, lines, html, received):
    text = "\n".join(lines)
    confirmed = re.search(r"Your booking in (.+?) is confirmed", text)
    cancelled = re.search(r"reservation at (.+?) has been cancell?ed", text) or re.match(r"Booking cancell?ed for", subject)
    if not (confirmed or cancelled):
        return None
    code = _after(lines, r"Booking number") or _after(lines, r"Confirmation number")
    name = re.sub(r"^.*?(?:confirmed at|cancell?ed for)\s+", "", subject)
    address = next((l for l in lines if l.count(",") >= 3 and re.search(r"\d", l) and l != name and "expecting you" not in l), "")
    parts = [p.strip() for p in address.split(",")]
    place = confirmed.group(1) if confirmed else (parts[-3] if len(parts) >= 3 else "")
    common = dict(provider="Booking.com", code=code.split()[0] if code else "", place=place,
                  country=parts[-1] if len(parts) >= 3 else "",
                  start=_after(lines, r"Check-in", received), end=_after(lines, r"Check-out", received))
    if cancelled:
        return Stay("cancel", "stay", **common)
    room = next((l for l in lines if re.match(r"(?i)\d+\s.*\b(room|bed|apartment|studio|suite|dorm|house|villa)\b", l)), "")
    return Stay("booking", "stay", **common, type=type_of(name, room), price=price(_after(lines, r"Total price") or _after(lines, r"Price")),
                link=_link(html, r"^Modify your booking$", r"booking\.com/confirmation"))


def _airbnb(subject, lines, html, received):
    text = "\n".join(lines)
    m = re.search(r"/reservation-details/[^\"\s?]*?/(HM[A-Z0-9]+)", html) or re.search(r"Confirmation code:?\s*(HM[A-Z0-9]+)", text)
    if not m:
        return None
    code = m.group(1)
    common = dict(provider="Airbnb", code=code,
                  link=f"https://www.airbnb.com/trips/v1/reservation-details/ro/RESERVATION2_CHECKIN/{code}")
    if re.search(r"(?i)reservation (?:has been )?cancel+ed", subject + "\n" + text):
        r = re.search(rf"(?i)\b({MONTH})\.?\s+(\d{{1,2}})\s*[–-]\s*(?:({MONTH})\.?\s+)?(\d{{1,2}})\b", text)
        start = end = None
        if r:
            start = _date(f"{r.group(1)} {r.group(2)}", received)
            end = _date(f"{r.group(3) or r.group(1)} {r.group(4)}", datetime.combine(start, datetime.min.time()))
        return Stay("cancel", "stay", start=start, end=end, **common)
    place = re.search(r"(?i)all set for (.+)", text)
    if not place:
        return None
    i = next((i for i, l in enumerate(lines) if re.match(r"(?i)check-?in\b", l)), len(lines))
    days = [d for l in lines[i:i + 2] for d in [_date(x, received) for x in re.split(r"\s*\|\s*|(?<=\d) (?=[A-Z][a-z]{2},)", l)] if d]
    if len(days) == 1:
        days.append(_after(lines, r"Check-?out", received))
    address = _after(lines, r"Address")
    country = address.rsplit(",", 1)[-1].strip() if "," in address else ""
    return Stay("booking", "stay", place=place.group(1).strip(), country="" if re.search(r"\d", country) else country,
                start=days[0] if days else None, end=days[1] if len(days) > 1 else None,
                type=type_of(next((l for l in lines if re.search(r"(?i)hosted by", l)), "")),
                price=price(_after(lines, r"Total \(\w+\)") or _after(lines, r"Balance due(?: \(\w+\))?") or _after(lines, r"Amount paid")),
                **common)


def _discovercars(subject, lines, html, received):
    text = "\n".join(lines)
    code = re.search(r"\b(DC-?\d{6,}|D\d{6,})\b", subject + "\n" + text)
    if not code:
        return None
    common = dict(provider="DiscoverCars", code=code.group(1), type="Rental car")
    if re.search(r"(?i)geannuleerd|cancell?ed", subject):
        return Stay("cancel", "car", **common)
    where = re.search(r"(?i)boeking in (.+?) is bevestigd|booking in (.+?) (?:is|has been) confirmed", text)
    if not where:
        return None
    place, _, country = (where.group(1) or where.group(2)).rpartition(", ")
    return Stay("booking", "car", place=place or country, country=country if place else "",
                start=_after(lines, r"Ophalen|Pick-?up", received), end=_after(lines, r"Inleveren|Drop-?off", received),
                price=price(_after(lines, r"Totaalbedrag|Total(?: price| amount)?")),
                link=_link(html, r"Boeking bekijken|Boeking beheren|View booking|Manage booking", r"discovercars\.com/.*/reservation/show/"), **common)


def _vipcars(subject, lines, html, received):
    text = "\n".join(lines)
    code = (re.search(r"(?i)(?:reserveringsnummer|reservation number)[\s:]*(G\d+)", text) or re.match(r"(G\d+):", subject)
            or re.search(r"(?i)reservation no\.?\s*(G\d+)", subject))
    if not code:
        return None
    common = dict(provider="VIPCars", code=code.group(1), type="Rental car")
    if re.search(r"(?i)geannuleerd|cancell?ed|cancellation", subject):
        return Stay("cancel", "car", **common)
    where = (re.search(r"(?i)autoverhuur op (.+?)\.?$|car rental (?:at|in) (.+?)\.?$", text, re.M)
             or re.search(r"(?i)car rental booking in (.+?)(?: on \d|$)()", subject))
    place, _, country = ((where.group(1) or where.group(2) or "") if where else "").rpartition(", ")
    if not place:  # no country after a comma
        place, country = country, ""
    place = re.sub(r"(?i)\s+(stadscentrum|centrum|city cent(?:re|er)|downtown|luchthaven|airport)$", "", place)
    return Stay("booking", "car", place=place, country=country,
                start=_after(lines, r"Ophalen|Pick-?up|Tijdstip van ophaling", received),
                end=_after(lines, r"Inleveren|Drop-?off|Tijdstip van aflevering", received),
                price=price(_after(lines, r"Te betalen bedrag|Totaal|Amount to pay|Total")),
                link=_link(html, r"Voucher", r"vipcars\.com/voucher"), **common)


# Other rental car brokers and companies: (name, confirmation subject, cancellation subject); their confirmations are
# read by one rule (_rental) that looks for the labelled pick-up and drop-off details most of them have
RENTALS = {
    "rentalcars.com": ("Rentalcars.com", r"^(?:uw|your) rentalcars\.com (?:boeking|booking)\b|car is confirmed|auto is bevestigd",
                       r"annulering|cancell?ation"),
    "holidayautos": ("Holiday Autos", r"boekingsbevestiging|booking confirmation", r"annulering|annuleringsverzoek|cancell?"),
    "arguscarhire": ("Argus Car Hire", r"boekingsbevestiging|booking confirmation", r"annulering|annuleringsverzoek|cancell?"),
    "stressfreecarrental": ("Stressfree Car Rental", r"reservation confirmation", r"reservation cancell?ation"),
    "bsp-auto": ("BSP Auto", r"voucher", r"annulering|cancell?"),
    "bookinggroup.com": ("EconomyBookings", r"is confirmed|confirmation of your car rental", r"cancell?"),
    "economybookings": ("EconomyBookings", r"is confirmed|confirmation of your car rental", r"cancell?"),
    "qeeq.com": ("QEEQ", r"reservation confirm|reservering bevestigd", r"cancell?ed|geannuleerd"),
    "hertz.com": ("Hertz", r"my hertz reservation", r"cancell?"),
    "thrifty.com": ("Thrifty", r"my thrifty reservation", r"cancell?"),
    "goldcar": ("Goldcar", r"^check-out", r"^$"),
}
PICK_UP = (r"picking up your car|pick[- ]?up(?: details| location| date)?|pickup(?: details)?|ophalen|afhalen|ophaallocatie|vertrek|"
           r"recogida|levantamento|prise en charge|abholung|ritiro")
DROP_OFF = (r"dropping off your car|drop[- ]?off(?: details| location| date)?|return(?: details| location| date)?|inleveren|afzetten|"
            r"terugkeer|terugbrengen|devoluci[oó]n|devolu[cç][aã]o|restitution|r[uü]ckgabe|riconsegna")
NOT_A_PLACE = (r"(?i)instructions|instructies|time|tijd|hora|date|datum|fecha|hours|uren|policy|voorwaarden|cancel|annul|deposit|borg|"
               r"company|bedrijf|supplied|leverancier|phone|telefoon|^[/|]|:\s*$|^\W*$|@|https?:|\d{1,2}:\d{2}|"
               r"^(?:mon|tue|wed|thu|fri|sat|sun|ma|di|wo|do|vr|za|zo)\w*\b.*\d")  # opening hours


def _block(lines, label, received):
    """(place, date) after the first line that starts with this label: within the next few lines, the first date and the
    first line that reads as a place."""
    for i, line in enumerate(lines):
        m = re.match(rf"(?i)^(?:{label})\b[^:]*?[:|]?\s*(.*)$", line)
        if not m or len(line) > 60 and not m.group(1):
            continue
        near = [m.group(1)] + lines[i + 1:i + 6]
        when = next((d for d in (_date(x, received) for x in near if x) if d), None)
        on = re.match(r"(.+?)\s+(?:on|op)\s+\w{2,3}\s+\d", m.group(1))  # "Vliegveld Cairns on Sun 28-Sep-2025 at 10:00"
        if on and when:
            return on.group(1), when
        where = next((re.sub(r"(?i)^(?:location|locatie|lugar|adres|address)\s*:\s*|,\s*[\w-]*\d[\w-]*$", "", x) for x in near
                      if x and not _date(x, received) and not re.search(NOT_A_PLACE, x) and re.search(r"[^\W\d_]{3}", x)
                      and len(x) <= 80 and not re.match(rf"(?i)^(?:{PICK_UP}|{DROP_OFF})\b", x)), "")
        if when:
            return where, when
    return "", None


def _rental(provider, confirm, cancel):
    def rule(subject, lines, html, received):
        code = re.search(r"(?i)(?:ref\.?:?|reference|referentie|verwijzing|voucher|reservation|reservering|contrat[oa]|contratto|"
                         r"booking|boeking|RA#)\s*#?\s*([A-Z0-9][A-Z0-9-]{4,})|#\s*([A-Z0-9]{5,})|\b([A-Z]{0,3}\d{6,})\b", subject)
        code = code and next(g for g in code.groups() if g)
        if not code:
            return None
        common = dict(provider=provider, code=code, type="Rental car")
        if re.search(rf"(?i){cancel}", subject):
            return Stay("cancel", "car", **common)
        if not re.search(rf"(?i){confirm}", subject):
            return None
        if provider == "QEEQ":  # "Reservering bevestigd - Kos - December 28, 2024 (verwijzing 1)"
            m = re.search(r"(?i)(?:confirm\w*|bevestigd) - (.+?) - (\w+ \d{1,2}, \d{4})", subject)
            if m:
                where, _, country = m.group(1).rpartition(", ")
                day = _date(m.group(2), received)
                return Stay("booking", "car", place=where or country, country=country if where else "", start=day, end=day, **common)
        if provider == "Goldcar":  # a contract at the counter: the airport's code in the subject, the email's day
            airport = re.search(r"\(([A-Z]{3})\)", subject)
            return Stay("booking", "car", place=airport.group(1), start=received.date(), end=received.date(), **common) if airport else None
        place, start = _block(lines, PICK_UP, received)
        _, end = _block(lines, DROP_OFF, received)
        if not start:
            return None
        where, _, country = place.rpartition(", ")
        return Stay("booking", "car", place=where or country, country=country if where else "", start=start, end=end or start,
                    price=price(_after(lines, r"Totaal(?:bedrag|prijs)?|Total(?: price| amount| cost)?|Prijs|Price")), **common)
    return rule


# --- hospitality exchanges: staying with a host ---

PL_MONTHS = {"sty": 1, "lut": 2, "mar": 3, "kwi": 4, "maj": 5, "cze": 6, "lip": 7, "sie": 8, "wrz": 9, "paź": 10, "paz": 10,
             "lis": 11, "gru": 12}  # Couchsurfing wrote some dates in Polish: "wto, 18 cze, 2024"


def _day_month_year(text):
    """The dates like 'Thu, 30 Aug, 2018' or 'wto, 18 cze, 2024' in text, in order."""
    out = []
    for d, mon, y in re.findall(r"\b(\d{1,2})\s+([^\W\d_]{3,9})\.?,?\s+(\d{4})\b", text):
        m = MONTHS.get(mon.lower()) or MONTHS.get(mon.lower()[:3]) or PL_MONTHS.get(mon.lower()[:3])
        if m:
            out.append(date(int(y), m, int(d)))
    return out


def _couchsurfing(subject, lines, html, received):
    """'X accepted your request' (the host's town and the dates) and 'How was your stay with X?' (after the stay):
    the same stay, keyed by host and first night. A request someone sends you is you hosting: not a stay."""
    m = re.match(r"(?i)\s*(.+?) accepted your request\s*$", subject) or re.match(r"(?i)\s*How was your stay with (.+?)\?\s*$", subject)
    if not m:
        return None
    host = m.group(1).strip()
    text = re.sub(r"\s+", " ", " ".join(lines))
    text = re.sub(r"\[\]\(\s*https?://[^)]*\)|\(\s*https?://[^)]*\)|https?://\S+", " ", text)  # links after the host's name
    text = re.sub(r"\s+", " ", text)
    where = re.search(re.escape(host) + r"\s*(.+?)\s*•", text)
    when = re.search(r"(?:Accepted|Feedback Required)\s*:\s*(.+?\d{4})\s*[–-]\s*(.+?\d{4})", text)
    if not where or not when:
        return None
    days = _day_month_year(when.group(1)) + _day_month_year(when.group(2))
    if len(days) < 2:
        return None
    parts = [x.strip() for x in where.group(1).split(",") if x.strip()]
    country = parts[-1] if len(parts) > 1 else ""
    country = re.sub(r"\s*\(.*\)|, Republic of", "", country)
    return Stay("booking", "stay", "Couchsurfing", f"cs-{re.sub(r'\W+', '', host.lower())[:20]}-{days[0]:%Y%m%d}",
                place=parts[0], country=country, start=days[0], end=days[1], type=f"with {host}")


def _bewelcome(subject, lines, html, received):
    """'... has replied to your hosting request' with the request (accepted): the dates, not the host's town; the town
    is what the subject names, else Contrail puts the stay where the rest of your data has you then."""
    text = re.sub(r"\s+", " ", " ".join(lines))
    if not re.search(r"(?i)replied to your hosting request", text) or not re.search(r"(?i)(?<!tentatively )\baccepted\)", subject):
        return None
    host = re.search(r"(?i)Dear \S+,?\s*(\S+) has replied", text)
    arrival = re.search(r"(?i)Arrival:\s*\w+,\s*(\w+ \d{1,2}, \d{4})", text)
    departure = re.search(r"(?i)Departure:\s*\w+,\s*(\w+ \d{1,2}, \d{4})", text)
    if not host or not arrival:
        return None
    start = _date(arrival.group(1), received)
    end = _date(departure.group(1), received) if departure else start
    name = host.group(1).replace("\\_", "_")
    # the town in the subject: "Visiting Porto for a day", "coming to Palermo for 2 nights"
    # (not "in": "Ukrainian living in Holland, coming to Palermo")
    town = re.search(r"(?i:visiting|coming to|going to|trip to|travel(?:l?ing)? to|to)\s+([A-Z][\w'-]+(?: [A-Z][\w'-]+)?)", subject)
    return Stay("booking", "stay", "BeWelcome", f"bw-{re.sub(r'\W+', '', name.lower())[:20]}-{start:%Y%m%d}",
                place=town.group(1) if town else f"BeWelcome host {name}", start=start, end=end, type=f"with {name}")


PROVIDERS = {"booking.com": _booking, "airbnb.": _airbnb, "discovercars.com": _discovercars, "vipcars.com": _vipcars,
             "couchsurfing.com": _couchsurfing, "bewelcome.org": _bewelcome,
             **{k: _rental(*v) for k, v in RENTALS.items()}}


def parse_email(msg):
    """The Stay in a booking email from a known provider, else None."""
    subject, sender, received, html, plain = message_parts(msg)
    domain = sender.rsplit("@", 1)[-1].lower()
    rule = next((f for k, f in PROVIDERS.items() if k in domain), None)
    if not rule:
        return None
    lines = (html_to_text(html) if html else plain).split("\n")
    s = rule(subject, [l.strip() for l in lines if l.strip()], html, received)
    return s if s and s.code else None
