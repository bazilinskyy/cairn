"""Read flight legs out of booking emails: schema.org markup first, text rules after (no network, no LLM)."""
import csv
import json
import re
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta
from html.parser import HTMLParser
from zoneinfo import ZoneInfo


@dataclass(frozen=True)
class Airport:
    name: str
    city: str
    tz: str


@dataclass(frozen=True)
class Leg:
    flight: str                 # "KL1234", no space
    dep: str                    # IATA airport codes
    arr: str
    dep_local: datetime | None  # local airport times, naive
    arr_local: datetime | None
    codes: tuple = ()           # airline PNR first, then the agency number
    agency: str = ""            # "eDreams 11112222333"
    day: date | None = None     # departure day when the times are unknown
    mode: str = "flight"        # flight | train | bus | ferry; dep/arr are station names for the last three
    dep_tz: str = ""            # time zones of ground stations (flights use their airports')
    arr_tz: str = ""
    arr_guess: bool = False     # arrival time not in the email: one hour after departure

    @property
    def when(self):
        return self.dep_local.date() if self.dep_local else self.day

    @property
    def key(self):
        """Identity used to recognise the leg again: the flight or service number, else the route."""
        return self.flight or f"{self.mode}:{self.dep}>{self.arr}"

    def tz(self, airports):
        dep = self.dep_tz or (airports[self.dep].tz if self.dep in airports else "")
        arr = self.arr_tz or (airports[self.arr].tz if self.arr in airports else "")
        return dep, arr

    @property
    def complete(self):
        return bool((self.flight or self.mode != "flight") and self.dep and self.arr and self.dep_local and self.arr_local)

    def instants(self, airports):
        """Departure and arrival as aware datetimes in each airport's (or station's) own zone."""
        dep, arr = self.tz(airports)
        return self.dep_local.replace(tzinfo=ZoneInfo(dep)), self.arr_local.replace(tzinfo=ZoneInfo(arr))


@dataclass
class Parsed:
    kind: str                   # "booking" | "change" | "cancel" | "other"
    legs: list
    passengers: list
    looks_like_flight: bool
    old_legs: list = field(default_factory=list)  # legs a rebooking replaces
    latest_date: date | None = None               # latest date mentioned anywhere in the email
    codes: tuple = ()                             # booking codes of the email (also when no leg could be read)


def load_airports(path):
    """OpenFlights airports.dat: IATA code -> Airport (rows without IATA code or time zone are skipped)."""
    out = {}
    with open(path, encoding="utf-8", newline="") as f:
        for row in csv.reader(f):
            if len(row) > 11 and re.fullmatch(r"[A-Z]{3}", row[4]) and "/" in row[11]:
                out[row[4]] = Airport(row[1], row[2], row[11])
    return out


def load_airlines(path):
    """OpenFlights airlines.dat: IATA and ICAO code -> (IATA code, name); active airlines win over defunct ones."""
    out = {}
    with open(path, encoding="utf-8", newline="") as f:
        rows = [r for r in csv.reader(f) if len(r) > 7 and re.fullmatch(r"[A-Z0-9]{2}", r[3])]
    for r in sorted(rows, key=lambda r: r[7] == "Y"):  # active rows last, so they overwrite
        out[r[3]] = (r[3], r[1])
        if re.fullmatch(r"[A-Z]{3}", r[4]):
            out[r[4]] = (r[3], r[1])
    return out


# --- HTML to text ---

BLOCK = {"p", "div", "tr", "br", "li", "table", "h1", "h2", "h3", "h4", "h5", "h6", "section", "article", "header", "footer"}
SKIP = {"script", "style", "head", "title"}


class _Text(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts, self.skip = [], 0

    def handle_starttag(self, tag, attrs):
        if tag in SKIP:
            self.skip += 1
        elif tag in BLOCK:
            self.parts.append("\n")

    def handle_endtag(self, tag):
        if tag in SKIP:
            self.skip = max(0, self.skip - 1)
        elif tag in ("td", "th"):
            self.parts.append(" | ")
        elif tag in BLOCK:
            self.parts.append("\n")

    def handle_data(self, data):
        if not self.skip:
            self.parts.append(data)


def html_to_text(html):
    p = _Text()
    p.feed(html)
    lines = (re.sub(r"[\s​‌͏]+", " ", l).strip(" |") for l in "".join(p.parts).split("\n"))
    return "\n".join(l for l in lines if l)


# --- schema.org markup ---

VOID = {"meta", "link", "img", "br", "hr", "input", "source", "area", "base", "col", "wbr"}


class _Microdata(HTMLParser):
    """Collects itemscope items as nested dicts. ponytail: attribute values only (content/href/datetime);
    itemprop values given as element text are ignored, add text capture when a sender needs it."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.items, self.stack = [], []  # stack: (tag, item or None)

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        parent = next((it for _, it in reversed(self.stack) if it is not None), None)
        item = None
        if "itemscope" in a:
            item = {"@type": (a.get("itemtype") or "").rstrip("/").rsplit("/", 1)[-1]}
            if a.get("itemprop") and parent is not None:
                parent[a["itemprop"]] = item
            elif parent is None:
                self.items.append(item)
        elif a.get("itemprop") and parent is not None:
            value = a.get("content", a.get("href", a.get("datetime")))
            if value is not None:
                parent[a["itemprop"]] = value
        if tag not in VOID:
            self.stack.append((tag, item))

    def handle_endtag(self, tag):
        for i in range(len(self.stack) - 1, -1, -1):
            if self.stack[i][0] == tag:
                del self.stack[i:]
                break


def reservations(html, types=("FlightReservation",)):
    """All schema.org reservations of these types in JSON-LD scripts and microdata."""
    found = []

    def walk(x):
        if isinstance(x, list):
            for y in x:
                walk(y)
        elif isinstance(x, dict):
            if x.get("@type") in types:
                found.append(x)
            for k in ("@graph", "itemListElement"):
                walk(x.get(k))

    for block in re.findall(r"(?is)<script[^>]*application/ld\+json[^>]*>(.*?)</script>", html):
        try:
            walk(json.loads(block))
        except ValueError:
            pass
    md = _Microdata()
    md.feed(html)
    walk(md.items)
    return found


def _time(value, code, airports):
    if not value:
        return None
    try:
        t = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
    except ValueError:
        return None
    if t.tzinfo and code in airports:
        t = t.astimezone(ZoneInfo(airports[code].tz))
    return t.replace(tzinfo=None)


def _code(x):
    return ((x or {}).get("iataCode") or "").strip().upper() if isinstance(x, dict) else ""


def jsonld_legs(html, airports):
    legs = []
    for r in reservations(html):
        f = r.get("reservationFor") or {}
        number = re.sub(r"[^A-Z0-9]", "", str(f.get("flightNumber") or "").upper())
        airline = _code(f.get("airline")) or _code(r.get("airline"))
        flight = number if not airline or number.startswith(airline) else airline + number
        dep, arr = _code(f.get("departureAirport")), _code(f.get("arrivalAirport"))
        code = str(r.get("reservationNumber") or "").strip()
        legs.append(Leg(flight, dep, arr, _time(f.get("departureTime"), dep, airports),
                        _time(f.get("arrivalTime"), arr, airports), (code,) if code else ()))
    return legs


# --- text rules ---

MONTHS = {m: i + 1 for i, names in enumerate([
    "january januari jan", "february februari feb", "march maart mar mrt", "april apr", "may mei",
    "june juni jun", "july juli jul", "august augustus aug", "september sept sep", "october oktober oct okt",
    "november nov", "december dec"]) for m in names.split()}
MONTH = "|".join(sorted(MONTHS, key=len, reverse=True))
DATE_RX = re.compile(
    rf"(?i)\b(?P<d>\d{{1,2}})\.?\s+(?P<m>{MONTH})\b\.?,?(?:\s+(?P<y>\d{{4}}|\d{{2}})(?![\d:]))?"
    r"|\b(?P<d2>\d{1,2})/(?P<m2>\d{1,2})/(?P<y2>\d{4})\b|\b(?P<y3>\d{4})-(?P<m3>\d{2})-(?P<d3>\d{2})\b")
TIME_RX = re.compile(r"(?<![\d:])([01]?\d|2[0-3]):([0-5]\d)(?![\d:])")
FLIGHT_RX = re.compile(r"(?<![A-Za-z0-9])([A-Z][A-Z0-9]|[0-9][A-Z])\s?(\d{1,4})(?![A-Za-z0-9]|[:.,]\d)"
                       r"|(?<![A-Za-z0-9])([A-Z]{3})(\d{1,4})(?![A-Za-z0-9]|[:.,]\d)")
FLIGHT_WORD = re.compile(r"(?i)\b(flights?|vlucht\w*|flug|vuelo|voo|departs?|departure|departing|vertrek|aankomst|arrival"
                         r"|arrives?|arriving|boarding|airlines?|luchtvaart\w*|operated by|uitgevoerd door)\b")
ICAO_EXTRA = {"EJU": "U2", "EZS": "U2"}  # easyJet Europe / Switzerland sell their flights as U2
STOP = {"KLM", "EUR", "USD", "GBP", "PIN", "VAT", "BTW", "THE", "AND", "FOR", "VIA", "ALL", "NEW", "OLD"}
CODE_LABELS = sorted([
    "referentie van luchtvaartmaatschappij", "airline reference", "booking reference", "booking code",
    "boekingscode", "reserveringsnummer", "reservation number", "reservation", "confirmation code",
    "confirmation number", "bevestigingscode", "pnr", "booking", "customer reference", "klantreferentie",
    "order number", "order", "bestelnummer", "referentie", "edreams-reserveringsnummer"], key=len, reverse=True)
CODE_RX = re.compile(r"(?i)(?<![\w-])(" + "|".join(map(re.escape, CODE_LABELS)) + r")\b")
AGENCIES = {"edreams": "eDreams", "booking.com": "Booking.com", "gotogate": "Gotogate", "kiwi": "Kiwi.com",
            "opodo": "Opodo", "expedia": "Expedia", "mytrip": "Mytrip", "trip.com": "Trip.com", "budgetair": "BudgetAir"}
TITLE = r"(?:mr|mrs|ms|miss|dhr|mevr|mw|de heer|mevrouw)"
NAME_RX = re.compile(rf"(?i)^(?:{TITLE}\.?\s+)?[^\W\d_][^\W\d_'’-]*(?:[\s'’-]+[^\W\d_]+){{1,3}}$")
SLASH_NAME_RX = re.compile(r"^[A-Z][A-Z' -]+/[A-Z][A-Z' -]+?(?:\s+(?:MR|MRS|MS|MISS))?$")
PASSENGER_LABEL_RX = re.compile(r"(?i)^(passagiersinformatie|passagier\(s\)|passagiers?(?: \d+)?|passengers?(?: \d+)?"
                                r"|travell?ers?|reizigers?|ticket numbers|names?)\s*:?\s*(.*)$")
LABEL_RX = re.compile(r"(?i)^(from|van|to|naar|flight number|vluchtnummer|departure|vertrek|arrival|aankomst)\s*[:|]\s*(.*)$")
OLD_RX = re.compile(r"(?i)old travel details|oude reisgegevens|your old|uw oude|original flight")
NEW_RX = re.compile(r"(?i)new travel details|nieuwe reisgegevens|rebooked you|omgeboekt naar|new itinerary")
OTHER_SUBJECT = re.compile(r"(?i)^\s*(?:\[[^\]]*\]\s*)?(?:re|fwd?|fw|antw|wg|tr)\s*:|action needed|actie vereist|choose|kies je|select|options?\b|check[- ]?in|inchecken|price|prijs|tracked flight|evaluate|survey|enquête|review"
                           r"|newsletter|nieuwsbrief|boarding pass|instapkaart|bag\(s\)|baggage|bagage|upgrade|points|miles|regulations")
CANCEL_RX = re.compile(r"(?i)geannuleerd|cancell?ed|annulering")
CHANGE_RX = re.compile(r"(?i)schedule change|schedule (?:has )?changed|(?:has|have) (?:been )?changed|rescheduled"
                       r"|modified the time|rebooked|omgeboekt|gewijzigd|wijziging")
BOOKING_RX = re.compile(r"(?i)confirm|bevestig|booking reference|boekingscode|e-ticket|itinerary|reisoverzicht|reisplan"
                        r"|your booking|uw boeking|je boeking|ticket")


def _flights(line, airlines):
    """Flight numbers in a line, as IATA code + number."""
    out = []
    for m in FLIGHT_RX.finditer(line):
        code, number = (m.group(1), m.group(2)) if m.group(1) else (m.group(3), m.group(4))
        if len(code) == 3:
            code = ICAO_EXTRA.get(code) or (airlines.get(code) or (None,))[0]
        elif code not in airlines:
            code = None
        if code:
            out.append(code + number)
    return out


def _dates(line, year_hint):
    """(position, date) for each date in a line; dates without a year get the year that puts them on or after year_hint."""
    out = []
    for m in DATE_RX.finditer(line):
        try:
            if m.group("d"):
                y = m.group("y")
                y = (2000 + int(y)) if y and len(y) == 2 else int(y) if y else None
                d = datetime(y or year_hint.year, MONTHS[m.group("m").lower()], int(m.group("d")))
                if not y and d.date() < year_hint.date():
                    d = d.replace(year=d.year + 1)
            elif m.group("d2"):
                d = datetime(int(m.group("y2")), int(m.group("m2")), int(m.group("d2")))
            else:
                d = datetime(int(m.group("y3")), int(m.group("m3")), int(m.group("d3")))
        except ValueError:
            continue
        out.append((m.start(), d))
    return out


def _airports_in(line, airports, cities):
    codes = re.findall(r"\(([A-Z]{3})\)", line) + re.findall(r"^([A-Z]{3})(?:\s*·.*)?$", line.strip())
    codes += [c for pair in re.findall(r"\b([A-Z]{3})\s*[-–]\s*([A-Z]{3})\b", line) for c in pair]
    codes = [c for c in codes if c in airports and c not in STOP]
    if not codes and len(line) < 60:
        m = re.fullmatch(r"(?i)(.+?)\s+(?:to|naar)\s+(.+)", line.strip())
        if m:
            pair = [cities.get(re.sub(r"\s*\(.*\)", "", s).strip().lower()) for s in m.groups()]
            if all(pair):
                codes = pair
    return codes


def _leg_from_block(lines, flight, airports, cities, year_hint):
    found, stamps, current, first_date = [], [], None, None
    for line in lines:
        for c in _airports_in(line, airports, cities):
            if c not in found:
                found.append(c)
        events = [(p, "d", d) for p, d in _dates(line, year_hint)] + \
                 [(m.start(), "t", (int(m.group(1)), int(m.group(2)))) for m in TIME_RX.finditer(line)]
        for _, kind, value in sorted(events, key=lambda e: e[0]):
            if kind == "d":
                current = value
                first_date = first_date or value
            elif not stamps or stamps[-1][1] != value:
                stamps.append((current, value))
    dep = arr = None
    if stamps and (stamps[0][0] or first_date):
        day = stamps[0][0] or first_date
        dep = day.replace(hour=stamps[0][1][0], minute=stamps[0][1][1])
        if len(stamps) > 1:
            arr = (stamps[1][0] or day).replace(hour=stamps[1][1][0], minute=stamps[1][1][1])
            if arr <= dep:
                arr += timedelta(days=1)
    day = dep.date() if dep else first_date.date() if first_date else None
    return Leg(flight, found[0] if found else "", found[1] if len(found) > 1 else "", dep, arr, day=day)


def _in_context(lines, i, airports, cities):
    """A flight number counts only with an airport or a flight word within three lines."""
    near = lines[max(0, i - 3):i + 4]
    return any(FLIGHT_WORD.search(l) or _airports_in(l, airports, cities) for l in near)


def _occurrences(lines, airlines, airports, cities):
    occ = []
    for i, line in enumerate(lines):
        for f in _flights(line, airlines):
            if (not occ or occ[-1][1] != f) and _in_context(lines, i, airports, cities):
                occ.append((i, f))
    return occ


def _positional_legs(lines, airlines, airports, cities, year_hint):
    occ = _occurrences(lines, airlines, airports, cities)
    if not occ:
        return []
    if len(occ) == 1:
        blocks = [lines]
    else:
        head = lines[:occ[0][0] + 1]
        head_times = sum(len(TIME_RX.findall(l)) for l in head)
        if head_times >= 2 and any(_airports_in(l, airports, cities) for l in head):  # details come before the number
            ends = [i for i, _ in occ]
            blocks = [lines[(ends[k - 1] + 1 if k else 0):ends[k] + 1] for k in range(len(occ))]
        else:  # the number comes first; its route line may sit just above it
            starts = []
            for k, (i, _) in enumerate(occ):
                floor, s0 = (occ[k - 1][0] + 1 if k else 0), i
                while s0 > max(floor, i - 2) and not TIME_RX.search(lines[s0 - 1]):
                    s0 -= 1
                starts.append(s0)
            blocks = [lines[starts[k]:(starts[k + 1] if k + 1 < len(occ) else len(lines))] for k in range(len(occ))]
    return [_leg_from_block(b, f, airports, cities, year_hint) for b, (_, f) in zip(blocks, occ)]


def _labelled_legs(lines, airlines, airports, cities, year_hint):
    """Blocks of 'From: / To: / Flight number: / Departure: / Arrival:' lines; returns (new legs, old legs)."""
    new, old, section, block = [], [], "new", None

    def close():
        if block and block.get("flight"):
            dep_l = [block.get("from", ""), block.get("to", "")]
            leg = _leg_from_block([block.get("departure", ""), block.get("arrival", "")], block["flight"], airports, cities, year_hint)
            codes = [c for l in dep_l for c in _airports_in(l, airports, cities)]
            leg = Leg(leg.flight, codes[0] if codes else "", codes[1] if len(codes) > 1 else "", leg.dep_local, leg.arr_local, day=leg.day)
            (old if block["section"] == "old" else new).append(leg)

    for i, line in enumerate(lines):
        if OLD_RX.search(line):
            section = "old"
        elif NEW_RX.search(line):
            section = "new"
        m = LABEL_RX.match(line)
        if not m:
            continue
        label = m.group(1).lower()
        value = m.group(2).strip() or (lines[i + 1] if i + 1 < len(lines) else "")
        key = {"van": "from", "naar": "to", "vluchtnummer": "flight", "flight number": "flight",
               "vertrek": "departure", "aankomst": "arrival"}.get(label, label)
        if key == "from":
            close()
            block = {"section": section}
        if block is None:
            continue
        if key == "flight":
            fl = _flights(value, airlines)
            if fl:
                block["flight"] = fl[0]
        else:
            block[key] = value
    close()
    return new, old


def _codes(lines, airlines):
    pnrs, numbers = [], []
    for i, line in enumerate(lines):
        for m in CODE_RX.finditer(line):
            rest = line[m.end():].strip(" :|#-–")
            value = (rest or (lines[i + 1] if i + 1 < len(lines) else "")).strip(" :|#").split(" ")[0].strip("()[],.;")
            if re.fullmatch(r"[A-Z0-9]{5,12}", value) and re.search(r"[A-Z]", value) and not _flights(value, airlines):
                if value not in pnrs:
                    pnrs.append(value)
            elif re.fullmatch(r"\d[\d-]{6,}\d", value) and value not in numbers:
                numbers.append(value)
    return pnrs, numbers


def _passengers(lines, structured):
    out = [n for n in structured if n]
    for i, line in enumerate(lines):
        m = PASSENGER_LABEL_RX.match(line)
        if m:
            candidates = [m.group(2)] if m.group(2) else []
            candidates += lines[i + 1:i + 4]
            names = []
            for c in candidates:
                if NAME_RX.match(c) or SLASH_NAME_RX.match(c):
                    names.append(c)
                elif names:
                    break
            out += names
        elif re.match(rf"(?i)^{TITLE}\.?\s", line) and NAME_RX.match(line) or SLASH_NAME_RX.match(line):
            out.append(line)
    seen, unique = set(), []
    for n in out:
        if n.lower() not in seen:
            seen.add(n.lower())
            unique.append(n)
    return unique


def _tokens(name):
    import unicodedata
    plain = "".join(c for c in unicodedata.normalize("NFKD", name) if not unicodedata.combining(c)).lower()
    words = re.split(r"[\s/.,]+", plain)
    return {w for w in words if w and not re.fullmatch(TITLE, w)}


def is_passenger(passengers, names):
    """True when no passengers are listed, or any listed passenger matches any of the owner's names."""
    if not passengers:
        return True
    return any(_tokens(n) and _tokens(n) <= _tokens(p) for p in passengers for n in names)


def _kind(subject, lines):
    head = "\n".join([subject] + lines[:25])
    if OTHER_SUBJECT.search(subject):
        return "other"
    if CANCEL_RX.search(subject) or re.search(r"(?i)(?:has been|have been|is|zijn|werd|was)\s+(?:cancell?ed|geannuleerd)", head):
        return "cancel"
    if CHANGE_RX.search(head):
        return "change"
    if BOOKING_RX.search(subject) or BOOKING_RX.search("\n".join(lines)):
        return "booking"
    return "other"


def _agency_name(sender):
    domain = sender.rsplit("@", 1)[-1].lower()
    for key, name in AGENCIES.items():
        if key in domain:
            return name
    parts = domain.split(".")
    return parts[-2].capitalize() if len(parts) > 1 else domain


def parse_email(msg, airports, airlines, places=None, home_tz="Europe/Amsterdam"):
    """places: GeoNames towns (ground.load_cities) for the time zones of train, bus and ferry stations."""
    from email.header import decode_header, make_header
    from email.utils import parseaddr, parsedate_to_datetime

    subject = str(make_header(decode_header(msg.get("Subject", ""))))
    sender = parseaddr(msg.get("From", ""))[1]
    try:
        received = parsedate_to_datetime(msg.get("Date")).replace(tzinfo=None)
    except (TypeError, ValueError):
        received = datetime.now()
    html = plain = ""
    for part in msg.walk():
        if part.get_content_maintype() == "text" and not part.get_filename():
            body = part.get_payload(decode=True) or b""
            body = body.decode(part.get_content_charset() or "utf-8", "replace")
            if part.get_content_subtype() == "html" and not html:
                html = body
            elif part.get_content_subtype() == "plain" and not plain:
                plain = body
    text = html_to_text(html) if html else plain
    lines = text.split("\n")
    cities = {}
    for code, a in airports.items():
        cities.setdefault(a.city.lower(), set()).add(code)
    cities = {c: next(iter(s)) for c, s in cities.items() if len(s) == 1}

    pnrs, numbers = _codes([subject] + lines, airlines)
    import ground
    mode = ground.mode_of(sender, html)
    if mode:  # trains, buses, ferries: their own rules, no flights in these emails
        found = ground.legs(sender, subject, html, lines, received, places or {}, home_tz, mode)
        codes = tuple(dict.fromkeys(pnrs + numbers[:1]))
        found = [Leg(l.flight, l.dep, l.arr, l.dep_local, l.arr_local, tuple(dict.fromkeys(list(l.codes) + list(codes))),
                     "", l.day, l.mode, l.dep_tz, l.arr_tz, l.arr_guess) for l in found]
        dates = [d for line in [subject] + lines for _, d in _dates(line, received)]
        return Parsed(_kind(subject, lines), found, _passengers(lines, []), bool(found), [],
                      max(dates).date() if dates else None, tuple(dict.fromkeys(list(codes) + [c for l in found for c in l.codes])))
    structured = reservations(html) if html else []
    markup = jsonld_legs(html, airports) if html else []
    new, old = _labelled_legs(lines, airlines, airports, cities, received)
    text_legs = new if any(l.complete for l in new) else _positional_legs(lines, airlines, airports, cities, received)
    if markup:
        by_flight = {l.flight: l for l in text_legs}
        legs = []
        for m in markup:
            t = by_flight.get(m.flight) or (text_legs[0] if len(markup) == 1 and len(text_legs) == 1 else None)
            legs.append(m if m.complete or not t else Leg(
                m.flight, m.dep or t.dep, m.arr or t.arr, m.dep_local or t.dep_local, m.arr_local or t.arr_local, m.codes,
                day=m.day or t.day))
    else:
        legs = text_legs
    agency = f"{_agency_name(sender)} {numbers[0]}" if numbers else ""
    out, seen = [], set()
    for l in legs:
        key = (l.flight, l.when)
        if not l.flight or key in seen:
            continue
        seen.add(key)
        codes = tuple(dict.fromkeys(list(l.codes) + pnrs + numbers[:1]))
        out.append(Leg(l.flight, l.dep, l.arr, l.dep_local, l.arr_local, codes, agency, l.day))
    old = [Leg(l.flight, l.dep, l.arr, l.dep_local, l.arr_local, tuple(dict.fromkeys(pnrs + numbers[:1])), agency, l.day) for l in old]
    dates = [d for line in [subject] + lines for _, d in _dates(line, received)]
    names = [((r.get("underName") or {}).get("name") or "").strip() for r in structured if isinstance(r.get("underName"), dict)]
    return Parsed(_kind(subject, lines), out, _passengers(lines, names),
                  bool(out or _occurrences(lines, airlines, airports, cities)), old, max(dates).date() if dates else None,
                  tuple(dict.fromkeys(pnrs + numbers[:1])))
