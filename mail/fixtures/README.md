# Test emails

Anonymised copies of real booking emails, used by `mail/test_parse.py`. Names, booking codes, agency numbers,
flight numbers, routes, dates and prices were replaced with fake ones and links point to example.com; the layout,
tables and wording are the airline's own.

| File | Layout it copies | Notes |
|---|---|---|
| `klm_nl_booking.eml` | KLM booking confirmation (Dutch) | one leg |
| `ryanair_nl.eml` | Ryanair itinerary (Dutch) | schema.org microdata with an empty arrival airport code |
| `easyjet_round_trip.eml` | easyJet booking | two legs, city names only (no airport codes), ICAO-style flight numbers (`EJU…`) |
| `gotogate_change.eml` | Gotogate schedule change | four legs, first one after the 25 Oct 2026 DST change |
| `edreams_nl_overnight.eml` | eDreams confirmation (Dutch) | airline and agency codes; arrival after midnight |
| `klm_rebooked.eml` | Air France-KLM rebooking | old leg replaced by two new legs |
| `booking_flights_jsonld.eml` | Booking.com flight confirmation | written by hand in the same layout; JSON-LD with an empty reservation number |
| `booking_checkin_reminder.eml` | Booking.com check-in reminder | written by hand; must be ignored |
| `google_price_alert.eml` | Google Flights price alert | written by hand; must be ignored |
| `synthetic_cancel_nl.eml` | cancellation (Dutch) | synthetic: none in the mailbox |
| `synthetic_other_passenger.eml` | the KLM booking for another passenger | synthetic: must be skipped |
| `gotogate_order_update.eml` | Gotogate "Order …" update | written by hand in the same layout; date and flight number on one line, details below |
| `gotogate_action_needed.eml` | Gotogate "Action needed" | written by hand; lists options to choose from, must be ignored |
| `easyjet_city_names.eml` | easyJet booking | the easyJet fixture with a city name that matches no airport (`Majorca (Palma)`) |
| `hotel_booking.eml` | Booking.com hotel confirmation | must give no flights |
| `ns_train.eml` | NS International train tickets | train numbers like `EC 9236` and an IBAN, must give no flights |
| `ns_train.eml` (also) | NS International | outward and return train, used for train tests too |
| `sncf_ground.eml` | SNCF Connect order | journey only (origin, destination, departure time), no arrival time |
| `redbus_ground.eml` | redBus ticket | 12-hour times (`09:45 PM`), boarding and dropping points |
| `flix_bus.eml` | FlixBus confirmation | written by hand in the same layout; schema.org `BusReservation` |
| `flix_cancel.eml` | FlixBus cancellation | written by hand; only the booking number |
| `twelvego_bus.eml` | 12Go confirmation | written by hand; `BusReservation` with a wrong time-zone offset and stop names with "departure time" in them |
| `rne_bus.eml` | Rede Expressos ticket | written by hand in the same layout; departure, connection and arrival |
