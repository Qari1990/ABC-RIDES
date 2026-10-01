# ABC Rides

Intercity ride sharing for **working professionals (job commuters)**, **students** and **regular travellers**.
Drivers who are already going between cities post their empty seats; passengers find a ride, book a seat and split the cost.

## Features

- **Find a ride**: search by from/to city, date (optional), seats needed and women-only.
- **Offer a ride**: route, pickup/drop-off points, departure time, seats, price per seat, vehicle and notes.
- **Commuter mode**: repeat a ride on chosen weekdays for up to 4 weeks (e.g. Lahore → Islamabad every Monday, back every Friday).
- **Student discount**: drivers can set a % discount, applied automatically when a student books.
- **Women-only rides**: women drivers can offer rides that only women passengers can book.
- **Booking flow**: driver approves each request, or turns on *instant booking*. Seats on pending requests are held so a ride can't be overbooked.
- **Privacy**: phone numbers are shown only between a driver and their *confirmed* passengers.
- **Trust**: profiles show traveller type, company/university, and ratings and reviews left after completed rides.
- **My trips**: bookings as a passenger, rides as a driver, with pending request counts.
- Mobile-first web app, installable as a PWA, with light and dark themes.

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
```

Demo accounts after seeding: `ahmed@example.com` (professional), `ayesha@example.com` (student),
`bilal@example.com` (traveller), `sara@example.com` (professional, offers a women-only ride).

Environment variables: `PORT` (default `3000`) and `DB_FILE` (default `data/abc-rides.db`).

## Project layout

```
server/
  index.js          start the HTTP server
  app.js            Express app: API mounted at /api, static files from public/
  db.js             SQLite schema and transaction helper
  auth.js           password hashing, sessions, auth middleware
  errors.js         HttpError and input validators
  routes/users.js   register, login, profile, public profiles
  routes/rides.js   rides, search, bookings, reviews
  seed.js           demo data
public/             web app (index.html, app.js, styles.css, manifest)
test/api.test.js    end-to-end API tests (node:test)
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

## Roadmap ideas

- Phone/OTP login and CNIC / student-ID / company-email verification badges
- Push and SMS notifications for booking requests and confirmations
- In-app chat between the driver and passengers
- Ride requests ("I need a ride Lahore → Multan on Friday") that drivers can respond to
- Maps for pickup points, live trip sharing and an SOS button
- Online payments (JazzCash / Easypaisa) and cancellation policies
- Native Android/iOS app on top of the same API
