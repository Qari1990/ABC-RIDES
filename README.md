# ABC Rides

Intercity ride sharing for **working professionals (job commuters)**, **students** and **regular travellers**.
Drivers who are already going between cities post their empty seats; passengers find a ride, book a seat and split the cost.

## Features

- **Find a ride**: search by from/to city, date (optional), time of day (morning/afternoon/evening), seats needed and women-only.
- **Maps** (Leaflet + OpenStreetMap, no API key): route maps with stops on every ride, tap-to-choose pickup points
  for ride requests, tap-your-home on the map for home pickup, suggested stops you can add from the map, and
  Google Maps directions links.
- **Error log**: crashes on users' phones and server errors appear in **Admin → Errors**.
- **Popular pickup & drop-off points**: about 110 well-known points across 48 cities (Thokar Niaz Baig, Kalma
  Chowk, Faizabad, Sohrab Goth…) with coordinates. Admins correct or add points by pasting coordinates from Google Maps.
- **Map-based distances**: road distances between cities from built-in estimates, upgraded to real road distances
  with **Admin → Places → Update distances from maps** (OpenStreetMap routing via OSRM).
- **Fair per-km fares**: drivers set a rate per km per seat within admin limits (default suggested Rs 8/km, allowed
  Rs 6–11). For reference, in October 2026 a Daewoo Luxury seat Lahore–Islamabad was about Rs 2,620–2,660 (~Rs 7/km)
  and inDrive listed a private car from about Rs 5,840 (~Rs 15/km for the car). Passengers see the comparison.
- **Stops on the way**: drivers add suggested stops along the route; passengers can join and leave at any stop and
  pay only for their kilometres. Search finds rides passing through your cities, not just starting there.
- **Home pickup & drop**: drivers can offer pickup from / drop at home within a radius of a stop; passengers share
  their location (or paste a Google Maps link) and pay a per-km charge (default Rs 50/km, minimum Rs 150) that goes
  entirely to the driver, commission-free.
- **Driver benefits for sharing**: 25% less commission when the car reaches 2 passengers, 50% less from 3, extra
  reliability points per extra passenger, and an earnings calculator showing what the driver keeps and how much of
  the fuel is covered for 1, 2, 3… passengers.
- **Ride time**: each ride shows departure, estimated arrival and travel time (e.g. "7:00 am → 11:15 am · 4h 15m"). The travel time is estimated from the cities and drivers can adjust it.
- **Offer a ride**: route, pickup/drop-off points, departure time, seats, price per seat, vehicle and notes.
- **Commuter mode**: repeat a ride on chosen weekdays for up to 4 weeks (e.g. Lahore → Islamabad every Monday, back every Friday).
- **Student discount**: drivers can set a % discount, applied automatically when a student books.
- **Women-only rides**: women drivers can offer rides that only women passengers can book.
- **Booking flow**: driver approves each request, or turns on *instant booking*. Seats on pending requests are held so a ride can't be overbooked.
- **Privacy**: phone numbers are shown only between a driver and their *confirmed* passengers.
- **Trust**: profiles show traveller type, company/university, and ratings and reviews left after completed rides.
- **ID verification**: members upload a photo of their CNIC, student card, employee card or driving licence; an admin approves it and the profile gets a ✔ Verified badge.
- **My trips**: bookings as a passenger, rides as a driver, and your ride requests.
- **Ride requests**: passengers post "I need a ride Multan → Lahore on Friday". Drivers browse them, and the passenger is notified automatically when a matching ride is posted.
- **Chat**: a private conversation per booking between driver and passenger, with unread badges.
- **Notifications**: in-app alerts for booking requests, confirmations, cancellations, ride changes, matching rides, verification results and "rate your trip".
- **Payments**: drivers choose accepted methods (cash, JazzCash, Easypaisa, bank transfer); their account details are shown only to confirmed passengers.
- **Safety**: SOS panel with one-tap calls to Police 15, Rescue 1122 and Motorway Police 130, an SMS to your emergency contact with trip details and current location, trip sharing, and reporting users.
- **Ride editing**: drivers can update pickup/drop-off, vehicle, notes and payment details; passengers are notified.
- **Onboarding with security**: sign up on one screen, then verify the phone with an SMS code. Identity
  verification takes a CNIC number, CNIC front/back photos and a selfie (plus a student card for student prices).
  Drivers register once with their licence and vehicle (make, model, year, colour, plate, seats, car photo,
  registration). An admin reviews everything in one place. One account per CNIC and per phone number; photos are
  checked to be real images; confirmed passengers see the car's plate so they can check it before getting in.
- **Wallet & fees**: posting rides is free. When a booking is confirmed, the driver pays a commission and the
  passenger a booking fee (both a % of the fare) from their wallets, after each user's first few free
  confirmations. Users top up by sending money to the platform's JazzCash/Easypaisa/bank account and entering the
  transaction ID; an admin approves it. Every charge, refund and top-up is recorded in the wallet history.
- **Reliability points**: everyone starts at 100%. Cancelling a confirmed trip costs points (double close to
  departure) and refunds the other side's fee; completed trips earn points back. Below the threshold, posting a
  ride or confirming a booking costs an extra flat fee.
- **Admin-controlled policy**: booking mode (driver's choice / always approve / always instant), commission
  percentages, free confirmations, reliability threshold, penalties and fee, and which onboarding steps are required.
- **Admin panel**: revenue and stats, verification queue with document viewer, wallet top-up approvals, settings,
  user reports, user search, suspension, wallet adjustments and reliability overrides.
- **Account**: change password (signs out other devices), emergency contact.
- Mobile-first web app, installable as a PWA, with light and dark themes, plus an **Android app** (see below).

## Tech stack

- **Backend:** Node.js 22.13+ with Express 5 and the built-in `node:sqlite` database (no native dependencies).
- **Frontend:** dependency-free HTML/CSS/JS single-page app in `public/`.
- **Auth:** email + password (scrypt hashes), with bearer-token sessions.

## Getting started

```bash
npm install
npm run seed     # optional: demo users and rides (password: password123)
npm start        # http://localhost:3000
npm test         # API tests
npm run test:e2e # end-to-end tests in a real browser (needs: npx playwright install chromium)
```

The end-to-end suite signs up five users (driver, student, traveller, passenger, admin) and walks
through every feature in Chromium: offering single, recurring and women-only rides, search filters,
booking with approval, chat, ride edits, share/SOS, ride requests, ID verification, reports and
suspension, completing and reviewing rides, cancellations and password change.

Demo accounts after seeding: `ahmed@example.com` (professional), `ayesha@example.com` (student),
`bilal@example.com` (traveller), `sara@example.com` (professional, offers a women-only ride) and
`admin@example.com` (admin).

Environment variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port |
| `DB_FILE` | `data/abc-rides.db` | SQLite database file |
| `UPLOAD_DIR` | `data/uploads` | Uploaded ID documents (private, admin-only) |
| `ADMIN_EMAILS` | | Comma-separated emails that get the admin role |
| `SMS_GATEWAY_URL` | | SMS provider send URL with `{to}` and `{message}` placeholders. Unset = development mode: phone codes are shown on screen |
| `SMS_GATEWAY_METHOD` | `GET` | HTTP method for the SMS URL |
| `SIGNUP_LIMIT_PER_HOUR` | `100` | Sign-ups allowed per network address per hour |
| `ROUTING_URL` | `https://router.project-osrm.org` | OSRM server used by "Update distances from maps" |
| `DATABASE_URL` | | PostgreSQL address (e.g. a free [Neon](https://neon.tech) database). The SQLite database and uploaded photos are copied there after every change and restored on start-up, so hosts that wipe the disk (Render free) keep all data |
| `MAP_TILE_URL` | OpenStreetMap | Map tiles (`{z}/{x}/{y}` URL). OpenStreetMap's servers are for light use; at scale use a provider such as MapTiler or Stadia with your key, and set `MAP_ATTRIBUTION` |
| `REMOVE_DEMO_DATA` | off | `1` deletes the demo accounts (`*@example.com`) and their rides on start-up; use when going live |
| `DEMO_SEED` | off | `1` loads the demo users and rides whenever the server starts with an empty database |
| `KEEP_AWAKE_URL` | `RENDER_EXTERNAL_URL` | Public address the server pings every 10 minutes so free hosting doesn't put it to sleep (`KEEP_AWAKE=0` turns it off) |

Fees, booking mode and onboarding requirements are changed in the app under **Admin → Settings**.
Default policy: phone verification required, drivers must be approved, student prices need a verified student
card, drivers pay 5% and passengers 2% after 3 free confirmations, reliability threshold 70% with a Rs 100 fee.

**Before going live**, set `SMS_GATEWAY_URL` (otherwise anyone can verify any phone number, since the code is shown
on screen) and replace the placeholder top-up accounts in Admin → Settings with your real JazzCash/Easypaisa numbers.

## Android app

`android/` holds a small native Android app (a WebView shell around the web app) that adds photo
picking for ID verification, location for SOS, the share sheet, dialer/SMS/WhatsApp links and the
back button. On first launch it asks for the server address; change it later under
**Profile → Change server**.

Build it without Gradle or the full Android SDK, using the tools Ubuntu/Debian package:

```bash
sudo apt-get install aapt dalvik-exchange zipalign apksigner android-sdk-platform-23 default-jdk-headless
android/build.sh                                  # asks for the server on first launch
android/build.sh https://abc-rides.onrender.com   # or bake a server address in
# → android/build/abc-rides.apk
```

Signing uses `android/debug.keystore`, created on the first build and git-ignored. Keep it: updates
only install over an app signed with the same key. Set `KEYSTORE`, `KEYSTORE_PASS` and `KEY_ALIAS`
to sign with a release key.

**Testing on a phone over Wi-Fi:** run `npm start` on your computer, find its local IP (`ipconfig` on
Windows, `ip addr` on Linux/macOS), install the APK on the phone, and enter `http://<that-ip>:3000`.
Both devices must be on the same Wi-Fi, and the firewall must allow port 3000.

## Deploying the server

- **Docker:** `docker build -t abc-rides . && docker run -p 3000:3000 -v abc-data:/data -e ADMIN_EMAILS=you@example.com abc-rides`
- **Render:** New → Blueprint → select this repo (`render.yaml`). The free plan has no persistent
  disk, so data resets on redeploy; attach a disk at `/data` to keep it.

## Project layout

```
server/
  index.js          start the HTTP server
  app.js            Express app: API mounted at /api, static files from public/
  db.js             SQLite schema and transaction helper
  auth.js           password hashing, sessions, auth middleware
  errors.js         HttpError and input validators
  notify.js         in-app notification helper
  settings.js       admin-controlled policy (fees, fares, booking mode, requirements)
  geo.js            cities, road distances, distances between places, suggested stops
  places-data.js    built-in popular pickup/drop-off points
  fares.js          per-km and per-segment fares, home pickup charges
  wallet.js         wallet ledger, booking fees, reliability points
  policy.js         onboarding checks (phone, identity, driver approval)
  security.js       security headers and rate limiting
  sms.js            SMS gateway and phone number normalisation
  uploads.js        photo checks and storage
  routes/users.js   register, login, profile, notifications
  routes/onboarding.js phone codes, identity verification, driver registration
  routes/wallet.js  wallet, top-ups, public settings
  routes/places.js  places, route plans, admin places and map distances
  routes/rides.js   rides, search, bookings, reviews
  routes/requests.js ride requests
  routes/messages.js chat and user reports
  routes/admin.js   admin panel API
  seed.js           demo data
public/             web app (index.html, app.js, styles.css, manifest)
android/            Android app (WebView shell) and its build script
test/               API tests (node:test)
```

## API overview

All endpoints are under `/api`. Send `Authorization: Bearer <token>` for the ones marked 🔒.

| Method | Path | Description |
| --- | --- | --- |
| POST | `/auth/register` | Create an account and get a token |
| POST | `/auth/login` | Log in and get a token |
| POST | `/auth/logout` 🔒 | End the session |
| GET / PATCH | `/me` 🔒 | Your profile |
| GET | `/users/:id` | Public profile, rating and reviews |
| GET | `/cities` | Suggested cities |
| GET | `/route-estimate?from=&to=` | Estimated road distance and travel time between two listed cities |
| GET | `/places?city=` | Popular pickup/drop-off points |
| GET | `/route-plan?stops=1,2,3` | Distance along chosen points, travel time, and suggested stops on the way |
| POST / PATCH / DELETE | `/admin/places` 🛠 | Add, correct or remove points |
| POST | `/admin/distances/refresh` 🛠 | Load road distances between all cities from the map routing service |
| GET | `/rides?from=&to=&after=&before=&seats=&women_only=` | Search upcoming rides |
| POST | `/rides` 🔒 | Offer a ride (`departure_at`, or `departures: [...]` for a series) |
| GET | `/rides/:id` | Ride details (the driver also sees bookings) |
| POST | `/rides/:id/cancel` 🔒 | Driver cancels the ride and its bookings |
| POST | `/rides/:id/complete` 🔒 | Driver marks the ride completed after departure |
| GET | `/me/rides` 🔒 | Rides you drive |
| POST | `/rides/:id/bookings` 🔒 | Book seats |
| GET | `/me/bookings` 🔒 | Your bookings |
| POST | `/bookings/:id/confirm` · `/reject` 🔒 | Driver answers a request |
| POST | `/bookings/:id/cancel` 🔒 | Passenger cancels |
| POST | `/rides/:id/reviews` 🔒 | Rate the driver or a passenger after a completed ride |
| PATCH | `/rides/:id` 🔒 | Driver edits pickup/drop-off, vehicle, notes, payment, instant booking |
| POST | `/me/password` 🔒 | Change password |
| GET | `/notifications` · `/notifications/unread-count` 🔒 | Alerts, and unread counts for badges |
| POST | `/notifications/read-all` 🔒 | Mark alerts read |
| GET / POST | `/bookings/:id/messages` 🔒 | Chat between the driver and a passenger |
| GET | `/me/conversations` 🔒 | Chat inbox |
| GET / POST | `/ride-requests` | Browse / post (🔒) ride requests |
| GET | `/me/ride-requests` 🔒 | Your ride requests |
| POST | `/ride-requests/:id/close` 🔒 | Close your request |
| POST | `/reports` 🔒 | Report a user |
| POST | `/me/phone/send-code` · `/me/phone/verify` 🔒 | Phone verification by SMS code |
| POST | `/me/verification` 🔒 | CNIC number + CNIC front/back + selfie (+ student/employee card), as data URLs |
| POST | `/me/driver` 🔒 | Driver registration: licence + vehicle details and photos |
| GET | `/settings` | Current fees, booking mode and requirements |
| GET | `/me/wallet` 🔒 | Balance, reliability, free confirmations left, history |
| POST | `/me/wallet/topups` 🔒 | Report a top-up (amount, method, transaction ID) |
| GET / PUT | `/admin/settings` 🛠 | Read / change the policy |
| GET | `/admin/topups` · POST `/admin/topups/:id/approve` · `/reject` 🛠 | Review top-ups |
| POST | `/admin/users/:id/review` 🛠 | Approve or reject everything a user has pending |
| GET | `/admin/documents/:id` 🛠 | View an uploaded document |
| POST | `/admin/users/:id/wallet` · `/admin/users/:id/reliability` 🛠 | Adjust a wallet or reliability score |
| GET | `/admin/stats` · `/admin/users` · `/admin/verifications` · `/admin/reports` 🛠 | Admin views |
| POST | `/admin/users/:id/suspend` · `/admin/reports/:id/resolve` 🛠 | Admin actions |

🛠 = admin only.

## Not built yet (needs third-party accounts)

- **Password reset by email**: reset by SMS code is built in and switches on with `SMS_GATEWAY_URL`; until then an admin sets a temporary password (Admin → Users).
- **Push notifications while the app is closed**: needs Firebase Cloud Messaging. Today alerts appear in the app's inbox.
- **Automatic wallet top-ups**: needs JazzCash/Easypaisa merchant accounts. Today an admin approves each top-up after checking the transaction ID, and fares are paid to drivers directly.
- **Automatic face matching** of selfie vs CNIC (and NADRA verification): today an admin compares them by eye.
- **Live location tracking and road-following route lines**: maps show stops joined by straight lines; drawing the exact road needs a routing service.
- **iOS app**: the web app works in Safari and can be added to the home screen.
