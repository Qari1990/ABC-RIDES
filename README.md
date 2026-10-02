# ABC Rides

Intercity ride sharing for **working professionals (job commuters)**, **students** and **regular travellers**.
Drivers who are already going between cities post their empty seats; passengers find a ride, book a seat and split the cost.

## Features

- **Terms & disclaimer at onboarding**: sign-up needs the terms accepted (platform only, drivers responsible for
  their car and driving, limited liability, emergency numbers); drivers also sign a declaration. When the terms
  change (`server/terms.js`), everyone accepts the new version before booking or posting.
- **Car catalog**: drivers pick their car from ~57 common Pakistani models (make, model, body type, engine, seats,
  class) or "Other"; plus year, colour, plate, AC and features. That car is used for every ride. A one-off ride in
  another car is declared as a *temporary car*; a permanent change is sent with photos and checked in
  **Admin → Car changes** (the old car stays in use until approved).
- **Fares by car**: each class (economy ×0.9, standard ×1, premium ×1.2, SUV ×1.3, van ×0.95; no AC ×0.85, all
  admin settings) scales the suggested and allowed per-km fare. Everyone can read the rules on **How fares work**
  (`#/how-it-works`), with reliability points and ride timings.
- **Private rides**: the whole car for one group, straight from pickup to drop-off, one price for the car
  (default Rs 18/km standard car, Rs 12–30 allowed); passengers book with the number of people and need a verified
  ID (setting). Passengers can also request a private car and drivers offer a price for it.
- **Ride lifecycle**: unbooked rides expire 30 min after departure, unanswered requests lapse, rides with
  passengers complete by themselves some hours after arrival and everyone is asked to review; ride requests close
  when their window ends.
- **Reviews update reliability**: 5★ +1, 4★ 0, 3★ −1, 2★ −3, 1★ −5 points (admin settings), both ways.
- **Find a ride**: search by from/to city, date (optional), time of day (morning/afternoon/evening), seats needed and women-only.
- **Maps** (Leaflet + OpenStreetMap, no API key): route maps with stops on every ride, tap-to-choose pickup points
  for ride requests, tap-your-home on the map for home pickup, suggested stops you can add from the map, and
  Google Maps directions links.
- **Ride requests reach drivers**: a new passenger request alerts (inbox + push) the drivers who drive that
  route, or every approved driver when nobody does yet, and admins (Admin → Settings). Requests can include
  pickup/drop-off points and home pickup/drop chosen on a map; "Offer this ride" fills all of it in.
- **Driver offers on requests**: instead of posting a ride, a driver sends an offer (time, price per seat, seats
  to share, home pickup/drop) to a passenger's request. Accepting it creates the ride and a confirmed booking at
  once, charges both fees, and shows each the other's phone; other drivers' offers close, and spare seats go on
  sale to other passengers. Request cards show the distance, the passenger's price per km and the fair price.
- **App updates**: the Android app checks `public/downloads/version.json` (written by `android/sign-dist.sh`)
  and offers newer versions with an Update button; screens and features update without it.
- **Live updates**: ride lists, requests, trips, inbox and ride pages refresh themselves (every 20 s, when the
  app comes back to the screen, and when a new alert arrives), without disturbing a form being filled in.
- **Search near your pickup point**: choose where you'll get on; rides are sorted by how close their stop is.
- **Error log**: crashes on users' phones and server errors appear in **Admin → Errors**.
- **Push notifications**: booking, ride and chat alerts with the app closed, turned on in Inbox or Profile. The
  Android app uses Firebase Cloud Messaging (free); browsers and home-screen web apps use Web Push (no account).
- **Forgot password**: a code by email (free Brevo account); otherwise an admin sets a temporary password.
- **Road-following route lines** on maps (OSRM's free routing server, cached on our server).
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
- **Onboarding with security**: sign up on one screen, then verify the email address with a 6-digit code sent by email (free with Brevo; SMS costs money in Pakistan, so it is not used). Admins can also verify members by hand in **Admin → Users**. Identity
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
| `SIGNUP_LIMIT_PER_HOUR` | `100` | Sign-ups allowed per network address per hour |
| `ROUTING_URL` | `https://router.project-osrm.org` | OSRM server used by "Update distances from maps" |
| `DATABASE_URL` | | PostgreSQL address (e.g. a free [Neon](https://neon.tech) database). The SQLite database and uploaded photos are copied there after every change and restored on start-up, so hosts that wipe the disk (Render free) keep all data |
| `MAP_TILE_URL` | OpenStreetMap | Map tiles (`{z}/{x}/{y}` URL). OpenStreetMap's servers are for light use; at scale use a provider such as MapTiler or Stadia with your key, and set `MAP_ATTRIBUTION` |
| `BREVO_API_KEY`, `EMAIL_FROM` | | Free email (Brevo, 300/day) for password reset codes. `EMAIL_FROM` is a sender address verified in Brevo; `EMAIL_FROM_NAME` defaults to "ABC Rides" |
| `FIREBASE_SERVICE_ACCOUNT` | | Firebase service account JSON (or base64 of it) for push notifications to the Android app. The app side needs the Firebase values in `android/app.properties` |
| `PUSH_CONTACT` | | `mailto:` address given to browser push services (Web Push); push works without it |
| `REMOVE_DEMO_DATA` | off | `1` deletes the demo accounts (`*@example.com`) and their rides on start-up; use when going live |
| `DEMO_SEED` | off | `1` loads the demo users and rides whenever the server starts with an empty database |
| `KEEP_AWAKE_URL` | `RENDER_EXTERNAL_URL` | Public address the server pings every 10 minutes so free hosting doesn't put it to sleep (`KEEP_AWAKE=0` turns it off) |

Fees, booking mode and onboarding requirements are changed in the app under **Admin → Settings**.
Default policy: email verification required, drivers must be approved, student prices need a verified student
card, drivers pay 5% and passengers 2% after 3 free confirmations, reliability threshold 70% with a Rs 100 fee.

**Before going live**, set `BREVO_API_KEY` and `EMAIL_FROM` (otherwise verification codes are shown on screen, so
anyone could verify any email address) and replace the placeholder top-up accounts in Admin → Settings with your real JazzCash/Easypaisa numbers.

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

**With push notifications (Firebase):** the Firebase SDK needs Gradle, so this build runs on GitHub
Actions (`.github/workflows/android.yml`, free). Each push that changes `android/` builds the app and
commits the unsigned APK to `android/dist/`; then `git pull && android/sign-dist.sh` signs it with the
same key and publishes it as `public/downloads/abc-rides.apk`. To switch push on:

1. In the [Firebase console](https://console.firebase.google.com) create a project and add an Android
   app with package name `pk.abcrides.app`.
2. Copy the values from its `google-services.json` into `android/app.properties`
   (`firebaseProjectId` = `project_id`, `firebaseAppId` = `mobilesdk_app_id`,
   `firebaseApiKey` = `current_key`, `firebaseSenderId` = `project_number`).
3. Project settings → Service accounts → **Generate new private key**, and paste the whole JSON
   into the server's `FIREBASE_SERVICE_ACCOUNT` setting.

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
  phone.js          phone number normalisation
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
| POST | `/me/email/send-code` · `/me/email/verify` 🔒 | Email verification by code (optionally corrects the email first) |
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

- **Automatic wallet top-ups**: needs JazzCash/Easypaisa merchant accounts. Today an admin approves each top-up after checking the transaction ID, and fares are paid to drivers directly.
- **Automatic face matching** of selfie vs CNIC (and NADRA verification): today an admin compares them by eye.
- **Live location tracking** during a trip.
- **iOS app**: the web app works in Safari and can be added to the home screen.
