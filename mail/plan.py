"""What to keep in step with the flights the owner is on: a check-in to-do per flight, a busy block in the work
calendar per flight, and an all-day banner per trip. Pure functions over rows of state["seen"]; flightmail.py
applies the result to Things and the calendars."""
from datetime import datetime, timedelta
from urllib.parse import quote_plus
from zoneinfo import ZoneInfo

CHECKIN = {  # airline IATA code -> online check-in page; others get a web search
    "KL": "https://www.klm.com/check-in", "AF": "https://wwws.airfrance.nl/check-in",
    "FR": "https://www.ryanair.com/gb/en/check-in", "U2": "https://www.easyjet.com/en/manage-bookings",
    "W6": "https://wizzair.com/en-gb/check-in", "HV": "https://www.transavia.com/en-NL/check-in/",
    "S4": "https://www.azoresairlines.pt/en/check-in", "SP": "https://www.azoresairlines.pt/en/check-in",
    "TP": "https://www.flytap.com/en-nl/check-in", "VY": "https://www.vueling.com/en/manage-your-booking/check-in",
    "LH": "https://www.lufthansa.com/nl/en/online-check-in", "IB": "https://www.iberia.com/nl/online-check-in/",
    "LO": "https://www.lot.com/nl/en/check-in", "SK": "https://www.flysas.com/en/check-in/",
    "AI": "https://www.airindia.com/in/en/manage/web-checkin.html", "BA": "https://www.britishairways.com/travel/olcilandingpageauthreq/public/en_nl",
}
STAY = timedelta(hours=12)  # a gap this long between two flights means a stay, not a connection


def _t(s):
    return datetime.fromisoformat(s)


def _city(code, airports):
    return airports[code].city if code in airports else code


def todo(row, airports, now):
    """Check-in to-do: scheduled the day before departure (today when that has passed), with the check-in link."""
    when = max((_t(row["dep_local"]) - timedelta(days=1)).date(), now.date())
    url = row.get("checkin_url") or CHECKIN.get(row["flight"][:2]) or \
        f"https://www.google.com/search?q={quote_plus(row['flight'] + ' online check-in')}"
    code = next((c for c in row["codes"] if not c.replace("-", "").isdigit()), row["codes"][0] if row["codes"] else "")
    return {"title": f"Check in ✈️ {row['flight']}: {_city(row['dep'], airports)} - {_city(row['arr'], airports)}",
            "when": when.isoformat(), "notes": url + (f"\nBooking code: {code}" if code else "")}


def block(row, airports):
    """Busy block: from 2 hours before departure to 1 hour after landing, as aware datetimes."""
    start = _t(row["dep_local"]).replace(tzinfo=ZoneInfo(airports[row["dep"]].tz)) - timedelta(hours=2)
    end = _t(row["arr_local"]).replace(tzinfo=ZoneInfo(airports[row["arr"]].tz)) + timedelta(hours=1)
    return start, end


def trips(rows, home, airports):
    """Trips from a home airport back to one: banner name (the place, or the country when several, or the
    countries joined by " · "), first and last day. Trips without a known return are left out."""
    out, cur = [], None
    for r in sorted(rows, key=lambda r: r["dep_local"]):
        if r["dep"] in home:
            cur = [r]
        elif cur is not None:
            cur.append(r)
        if cur and r["arr"] in home:
            stays = [a["arr"] for a, b in zip(cur, cur[1:]) if _t(b["dep_local"]) - _t(a["arr_local"]) >= STAY] or [cur[0]["arr"]]
            places = list(dict.fromkeys(_city(c, airports) for c in stays))
            countries = list(dict.fromkeys(airports[c].country for c in stays if c in airports))
            name = places[0] if len(places) == 1 else " · ".join(countries) if countries else " · ".join(places)
            out.append({"id": f"{cur[0]['flight']}@{cur[0]['dep_local'][:10]}", "name": name,
                        "start": cur[0]["dep_local"][:10], "end": cur[-1]["arr_local"][:10]})
            cur = None
    return out


def reconcile(desired, owned):
    """Ids to create, update (spec changed) and remove, given desired {id: spec} and owned {id: {ref, spec}}."""
    return {"create": [i for i in desired if i not in owned],
            "update": [i for i in desired if i in owned and owned[i]["spec"] != desired[i]],
            "remove": [i for i in owned if i not in desired]}
