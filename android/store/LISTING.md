# Google Play listing: ABC Rides

Everything Play Console asks for, ready to paste. Graphics are in this folder.

| Asset | File |
| --- | --- |
| App icon 512×512 | `icon-512.png` |
| Feature graphic 1024×500 | `feature-graphic-1024x500.png` |
| Phone screenshots (1080×1920) | `screen-1-home.png` … `screen-4-wallet.png` |

## Store text

**App name** (max 30): `ABC Rides: Intercity Carpool`

**Short description** (max 80):
`Share intercity rides with verified drivers. Fair per-km fares, student discounts`

**Full description** (max 4000):

```
ABC Rides connects people travelling between cities in Pakistan, so empty car seats get filled and everyone pays less.

FOR PASSENGERS
• Find rides between Lahore, Islamabad, Rawalpindi, Karachi, Hyderabad, Peshawar, Faisalabad, Multan, Gujranwala, Sialkot and more
• Book only the part you need: get on or off at stops along the way and pay for those kilometres only
• Fair per-km fares, usually cheaper than travelling alone and comparable to an AC bus
• Student discounts for verified students
• Women-only rides
• Home pickup and drop-off when the driver offers it

FOR DRIVERS
• Posting a ride is free
• The app suggests a fair fare for every stop and shows what you will earn
• Lower commission when you share your car with 2 or 3 passengers
• Extra earnings for home pickup and drop-off

SAFETY FIRST
• Phone verification for everyone, CNIC and selfie checks, driver licence and vehicle review
• Ratings and reviews after every trip
• In-app chat, so you don't have to share your number before a booking is confirmed
• SOS button that sends your location to your emergency contact
• Reliability score: people who cancel at the last minute are flagged

Made for office commuters, university students and anyone who travels between cities regularly.
```

**Category:** Maps & Navigation (or Travel & Local)
**Tags:** Carpool, Ride sharing, Travel
**Contact email:** your support email · **Website:** https://abc-rides.onrender.com/download.html
**Privacy policy URL:** https://abc-rides.onrender.com/privacy.html

## App content answers

- **App access:** some features need login. Give reviewers `ahmed@example.com` / `password123` (driver) and `ayesha@example.com` / `password123` (passenger), with a note: "Phone codes are shown on screen in this version."
- **Ads:** No ads.
- **Content rating (IARC questionnaire):** Category "Social / communication". Users can interact and share location: Yes. No violence, sex, gambling or drugs. Expected result: Everyone/PEGI 3 with "Users interact" and "Shares location".
- **Target audience:** 18 and over.
- **News app:** No. **Government app:** No. **Financial features:** none of the listed ones (the wallet only holds prepaid service fees).
- **Account deletion URL:** https://abc-rides.onrender.com/privacy.html#delete (in-app: Profile → Delete my account).

## Data safety form

Data is encrypted in transit: **Yes**. Users can request deletion: **Yes**. Data shared with third parties: **No** (service providers that process data for us don't count as sharing).

| Data type | Collected | Purpose | Optional? |
| --- | --- | --- | --- |
| Name, email, phone number | Yes | Account management, app functionality | Required |
| User IDs (CNIC number) | Yes | Fraud prevention, security | Optional (required by some features) |
| Photos (CNIC, selfie, licence, vehicle) | Yes | Fraud prevention, security | Optional |
| Approximate and precise location | Yes, only when SOS or a pickup point is used | App functionality, safety | Optional |
| Messages (in-app chat) | Yes | App functionality | Optional |
| Other user-generated content (reviews, reports, bio) | Yes | App functionality | Optional |
| Purchase history (wallet top-ups) | Yes | App functionality, account management | Optional |
| Other info: gender, traveller type | Yes | App functionality (women-only and student rides) | Required |
| Crash logs / diagnostics | No | | |

None of this data is processed ephemerally only; it is stored.

## Before you submit

1. Create an upload key and add the four GitHub secrets (see `.github/workflows/android.yml`).
2. Raise `versionCode` in `android/app.properties`, push, and download `abc-rides-aab` from GitHub → Actions.
3. Point the app at a server that keeps data (paid Render plan with a disk, or similar) and set a real SMS gateway: reviewers and real users must not lose their accounts on a restart.
4. Personal developer accounts: run a closed test with at least 12 testers for 14 days before applying for production.
