"""Decide what one parsed email changes in the Travel calendar and in Contrail.

The calendar and Contrail are passed in as objects with has_flight / create|add / update / delete, so the rules
can be tested without EventKit or a server. state["legs"] remembers the legs flightmail created. Trains, buses and
ferries go to Contrail too (for the lines on its map), with the id of their calendar event.
"""
from dataclasses import replace
from datetime import datetime

from parse import Leg, is_passenger


def _row(leg):
    return {"flight": leg.key, "dep": leg.dep, "arr": leg.arr,
            "dep_local": leg.dep_local.isoformat() if leg.dep_local else None,
            "arr_local": leg.arr_local.isoformat() if leg.arr_local else None}


def enrich(parsed, lookup, cache, now, limit):
    """Airports and times of each future leg from lookup(flight, day) -> Leg | None (AeroDataBox): times win over
    the email's for the same route; airports only when the email gives none. One lookup per flight and day, kept in cache; at most `limit` lookups per calendar month."""
    month = now.strftime("%Y-%m")
    if cache.get("month") != month:
        cache["month"], cache["count"] = month, 0
    known = cache.setdefault("flights", {})
    legs = []
    for leg in parsed.legs:
        day = leg.when
        if leg.mode != "flight" or not leg.flight or not day or day < now.date():
            legs.append(leg)
            continue
        key = f"{leg.flight} {day.isoformat()}"
        if key not in known:
            if cache["count"] >= limit:
                legs.append(leg)
                continue
            cache["count"] += 1
            found = lookup(leg.flight, day)
            known[key] = _row(found) if found and found.complete else None
        hit = known[key]
        # one flight number can fly several hops: a full route in the email is the passenger's, so the lookup only
        # gives times for that same route, or the route when the email has none
        if hit and leg.dep and leg.arr and (hit["dep"], hit["arr"]) != (leg.dep, leg.arr):
            hit = None
        legs.append(replace(leg, dep=hit["dep"], arr=hit["arr"], dep_local=datetime.fromisoformat(hit["dep_local"]),
                            arr_local=datetime.fromisoformat(hit["arr_local"])) if hit else leg)
    return replace(parsed, legs=legs)


def apply(parsed, sender, subject, received, state, cal, con, names, now, airports):
    """Apply one email; returns alert lines (empty when there is nothing to report)."""
    legs = state.setdefault("legs", [])
    seen = state.setdefault("seen", {})  # every future flight the owner is on, also ones flightmail did not create
    ground = state.setdefault("ground", {})  # the same for trains, buses and ferries (for busy blocks)
    if parsed.kind == "other" or not is_passenger(parsed.passengers, names):
        return []
    alerts = []
    where = f"{sender} | {subject} | {received.isoformat()}"
    in_email = {(l.key, l.when.isoformat()) for l in parsed.legs if l.when}
    about_future = bool(parsed.latest_date and parsed.latest_date >= now.date())  # alerts only for trips still ahead

    def owned(leg):
        """The stored leg for this flight: same booking code (or, without codes, same day); a stored leg for
        another day only when that day is not itself in this email (a schedule change moved it)."""
        day = leg.when.isoformat() if leg.when else None
        fallback = None
        for e in legs:
            if e["flight"] != leg.key:
                continue
            same_day = day is not None and e["dep_local"][:10] == day
            if leg.codes and e["codes"]:
                if not set(leg.codes) & set(e["codes"]):
                    continue
                if same_day or day is None:
                    return e
                if (e["flight"], e["dep_local"][:10]) not in in_email:
                    fallback = fallback or e
            elif same_day:
                return e
        return fallback

    def unsee(leg, keep=None):
        """Forget registry entries for this flight number and booking (another day than `keep`)."""
        for sid in [k for k, r in seen.items() if r["flight"] == leg.key and (not leg.codes or not r["codes"]
                    or set(leg.codes) & set(r["codes"])) and k != keep and (r["flight"], r["dep_local"][:10]) not in in_email]:
            del seen[sid]

    def unsee_ground(leg, keep=None):
        for sid in [k for k, r in ground.items() if r["flight"] == leg.key and k != keep
                    and (not leg.codes or not r["codes"] or set(leg.codes) & set(r["codes"]))]:
            del ground[sid]

    def see(leg):
        if leg.mode == "flight":
            sid = f"{leg.key}@{leg.when.isoformat()}"
            unsee(leg, keep=sid)
            seen[sid] = {**_row(leg), "codes": list(leg.codes), "checkin_url": leg.checkin_url}
        else:
            sid = f"{leg.key}@{leg.dep_local.isoformat()}"
            unsee_ground(leg, keep=sid)
            ground[sid] = {**_row(leg), "codes": list(leg.codes), "mode": leg.mode, "tz": list(leg.tz(airports))}

    def remove(e):
        if e["event_id"]:
            cal.delete(e["event_id"])
        if e["contrail_id"]:
            con.delete(e["contrail_id"])
        legs.remove(e)

    if parsed.kind == "cancel":
        if not parsed.legs and parsed.codes:  # e.g. "your booking #123 has been cancelled"
            for e in [e for e in legs if set(e["codes"]) & set(parsed.codes)]:
                remove(e)
            for reg in (seen, ground):
                for sid in [k for k, r in reg.items() if set(r["codes"]) & set(parsed.codes)]:
                    del reg[sid]
            return alerts
        for leg in parsed.legs:
            in_email.clear()
            unsee(leg)
            unsee_ground(leg)
            e = owned(leg)
            if e:
                remove(e)
            elif about_future:
                alerts.append(f"Cancellation for {leg.flight} not applied, its event was not made by flightmail: {where}")
        return alerts

    complete = [l for l in parsed.legs if l.complete]
    if not complete:
        if about_future and parsed.looks_like_flight and not any(owned(l) for l in parsed.legs):
            alerts.append(f"Could not read flight: {where}")
        return alerts

    rebooked = []
    for old in parsed.old_legs:
        unsee(old)
        e = owned(old)
        if e:
            rebooked.append(f"Rebooked from {e['flight']} on {e['dep_local'][:10]}")
            remove(e)

    local_now = now.astimezone()
    for leg in complete:
        if not all(leg.tz(airports)) or leg.instants(airports)[0] <= local_now:
            continue
        see(leg)
        e = owned(leg)
        if e:
            if all(e[k] == v for k, v in _row(leg).items()):
                continue
            if e["event_id"]:
                cal.update(e["event_id"], leg, f"Updated {now.date().isoformat()}: schedule change ({sender})")
            if e["contrail_id"]:
                con.update(e["contrail_id"], leg)
            e.update(_row(leg))
            e["codes"] = list(dict.fromkeys(e["codes"] + list(leg.codes)))
            continue
        notes = list(rebooked)
        prev = next((e for e in legs if set(e["codes"]) & set(leg.codes) and (e["dep"], e["arr"]) == (leg.dep, leg.arr)
                     and (e["flight"], e["dep_local"][:10]) not in in_email), None)
        if prev:
            notes.append(f"Rebooked from {prev['flight']} on {prev['dep_local'][:10]}")
            remove(prev)
        day = leg.dep_local.date()
        if leg.mode == "flight":
            in_cal, in_con = cal.has_flight(leg.flight, day), con.has_flight(leg.flight, leg.dep, leg.arr, day)
        else:  # trains, buses, ferries: any event starting at the same moment is this one; Contrail keeps one
            in_cal, in_con = cal.has_event_at(leg.instants(airports)[0]), False  # trip per minute and mode itself
        if parsed.kind == "change" and not notes and (in_cal or in_con or leg.mode != "flight"):
            alerts.append(f"Change for {leg.key} on {day} not applied, its event was not made by flightmail: {where}")
            continue
        event_id = None if in_cal else cal.create(leg, notes)
        contrail_id = None if in_con else con.add(leg, event_id)
        if event_id or contrail_id:
            legs.append({**_row(leg), "codes": list(leg.codes), "event_id": event_id, "contrail_id": contrail_id})
    return alerts
