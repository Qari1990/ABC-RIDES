// End-to-end tests: drive the real web app in Chromium with several users.
//
//   npm run test:e2e
//
// Needs a Chromium for Playwright (`npx playwright install chromium`), or set
// CHROMIUM_PATH to an existing Chromium binary.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { chromium } = require('playwright');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'abc-rides-e2e-'));
process.env.ADMIN_EMAILS = 'admin@e2e.pk';
const { openDb } = require('../../server/db');
const { createApp } = require('../../server/app');
const { setSettings, getSettings } = require('../../server/settings');

let server, base, browser, db;
const errors = [];
const users = {};

// A small valid PNG to upload as an ID document. Written once: the browser
// reads uploads from disk lazily, so rewriting it mid-test corrupts uploads.
let pngPath;
function pngFile() {
  if (pngPath) return pngPath;
  const w = 40;
  const h = 25;
  const raw = Buffer.concat(Array.from({ length: h }, () => Buffer.from([0, ...Array(w).fill([15, 118, 110]).flat()])));
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(Buffer.concat([Buffer.from(type), data])));
    return Buffer.concat([len, Buffer.from(type), data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const file = path.join(tmp, 'card.png');
  fs.writeFileSync(file, Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]));
  pngPath = file;
  return file;
}

// "YYYY-MM-DDTHH:MM" for a datetime-local input, N days from now in Karachi time.
function localDateTime(daysAhead, hour, minute = 0) {
  const now = new Date(Date.now() + 5 * 36e5); // UTC+5
  now.setUTCDate(now.getUTCDate() + daysAhead);
  const d = now.toISOString().slice(0, 10);
  return `${d}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

before(async () => {
  db = openDb(path.join(tmp, 'e2e.db'));
  server = createApp(db, { uploadDir: path.join(tmp, 'uploads') }).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/`;
  browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
});

after(async () => {
  await browser?.close();
  server?.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

// Opens a phone-sized browser for one user. withBridge fakes the Android app's bridge.
async function openUser(name, { withBridge = false } = {}) {
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 }, timezoneId: 'Asia/Karachi', locale: 'en-PK',
    permissions: ['geolocation'], geolocation: { latitude: 31.52, longitude: 74.35 },
  });
  if (withBridge) {
    await ctx.addInitScript(() => {
      window.bridgeCalls = [];
      window.AbcAndroid = {
        share: (t) => window.bridgeCalls.push(['share', t]),
        changeServer: () => window.bridgeCalls.push(['changeServer']),
        saveServer: () => {},
        getServer: () => location.origin,
      };
    });
  }
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
  page.on('dialog', (d) => d.accept());
  const go = async (hash, selector) => {
    const url = `${base}#${hash}`;
    // Going to the URL the page is already on does not fire hashchange, so re-render instead.
    if (page.url() === url) await page.evaluate(() => render());
    else await page.goto(url);
    if (selector) await page.waitForSelector(selector);
  };
  const toast = async (pattern) => {
    await page.waitForFunction((src) => new RegExp(src).test(document.querySelector('#toast').textContent), pattern.source);
  };
  const u = { name, page, go, toast };
  users[name] = u;
  return u;
}

// Signs up through the form, then verifies the phone with the one-time code
// (shown on screen because no SMS gateway is configured in tests).
async function register(u, { email, phone, type, gender, org }) {
  await u.go('/register', '#register');
  await u.page.fill('#pn', u.name);
  await u.page.fill('#pp', phone);
  await u.page.selectOption('#pt', type);
  if (gender) await u.page.selectOption('#pg', gender);
  if (org) await u.page.fill('#po', org);
  await u.page.fill('#re', email);
  await u.page.fill('#rp', 'password123');
  await u.page.click('#register [type=submit]');
  await u.page.waitForSelector('#otp');
  await u.page.waitForFunction(() => /^\d{6}$/.test(document.querySelector('#code').value));
  assert.match(await u.page.textContent('#dev-code'), /Development mode/);
  await u.page.click('#otp [type=submit]');
  await u.page.waitForSelector('.hero');
  u.email = email;
  u.phone = phone;
}

async function addPhotos(page, names) {
  for (const n of names) await page.setInputFiles(`input[name=${n}]`, pngFile());
  // Photos are resized in the browser before upload; wait for every preview.
  await page.waitForFunction((list) => list.every((n) => !document.querySelector(`input[name=${n}]`).parentElement.querySelector('img').hidden), names);
}

// Fills the route part of the Offer form and waits for the road distance.
async function chooseRoute(page, { from, to, pickup, drop }) {
  await page.fill('#of', from);
  await page.fill('#ot', to);
  await page.waitForFunction(() => document.querySelector('#opp').value && document.querySelector('#odp').value);
  if (pickup) await page.selectOption('#opp', { label: pickup });
  if (drop) await page.selectOption('#odp', { label: drop });
  await page.waitForFunction(() => /km by road/.test(document.querySelector('#route-info').textContent));
}

// The Offer form is a wizard: Route → When & seats → Price → Extras → Review.
async function toStep(page, n) {
  for (let i = 0; i < 6; i++) {
    const current = Number(await page.getAttribute('#offer section:not([hidden])', 'data-step'));
    if (current >= n) break;
    await page.click('#wiz-next');
    await page.waitForSelector(`#offer [data-step="${current + 1}"]:not([hidden])`);
  }
}

async function publish(page) {
  await toStep(page, 5);
  await page.click('#wiz-next');
}

const rideRow = (id) => db.prepare('SELECT * FROM rides WHERE id = ?').get(id);
const rs = (n) => `Rs ${Number(n).toLocaleString('en-PK')}`;

const rideIdFromUrl = (page) => Number(page.url().match(/#\/ride\/(\d+)/)[1]);

async function badgeCount(u) {
  await u.page.evaluate(() => refreshUnread());
  const dot = u.page.locator('.tabbar .dot');
  return (await dot.count()) ? Number(await dot.textContent()) : 0;
}

test('1. sign up and verify phone: driver, student, traveller, admin', async () => {
  await register(await openUser('Sana Driver'), { email: 'sana@e2e.pk', phone: '0300 1110001', type: 'professional', gender: 'female', org: 'Engro' });
  await register(await openUser('Ali Student', { withBridge: true }), { email: 'ali@e2e.pk', phone: '0300 1110002', type: 'student', gender: 'male', org: 'FAST Lahore' });
  await register(await openUser('Zara Traveller'), { email: 'zara@e2e.pk', phone: '0300 1110003', type: 'traveler', gender: 'female' });
  await register(await openUser('Omar Passenger'), { email: 'omar@e2e.pk', phone: '0300 1110004', type: 'traveler', gender: 'male' });
  const admin = await openUser('Admin');
  await register(admin, { email: 'admin@e2e.pk', phone: '0300 1110005', type: 'professional' });
  await admin.go('/profile', 'text=Admin panel');
  assert.match(await admin.page.textContent('.card:has(h3:text("Account setup"))'), /Phone number[\s\S]*0300 1110005/);
});

test('1b. onboarding: driver wizard, student card, admin approval', async () => {
  const sana = users['Sana Driver'];
  await sana.go('/offer', 'text=Register as a driver');
  await sana.page.click('text=Register as a driver');
  await sana.page.waitForSelector('#drv');
  await sana.page.fill('#cnic', '3520212345671');
  assert.equal(await sana.page.inputValue('#cnic'), '35202-1234567-1', 'CNIC is formatted as you type');
  await sana.page.fill('#lic', 'LHR-998877');
  await sana.page.fill('#drv [name=make]', 'Honda');
  await sana.page.fill('#drv [name=model]', 'City');
  await sana.page.fill('#drv [name=year]', '2021');
  await sana.page.fill('#drv [name=color]', 'Silver');
  await sana.page.fill('#drv [name=plate]', 'lea-2468');
  await sana.page.click('#drv [type=submit]');
  await sana.page.waitForSelector('.toast.error');
  assert.match(await sana.page.textContent('#toast'), /Please add a photo/);
  await addPhotos(sana.page, ['cnic_front', 'cnic_back', 'selfie', 'licence_photo', 'vehicle_photo', 'registration_photo']);
  await sana.page.click('#drv [type=submit]');
  await sana.page.waitForSelector('text=Driver registration under review');
  assert.match(await sana.page.textContent('#view'), /LEA-2468/);
  await sana.go('/offer', 'text=View my application');

  const ali = users['Ali Student'];
  await ali.go('/verify-id', '#idv');
  await ali.page.fill('#cnic', '35202-7654321-3');
  await addPhotos(ali.page, ['cnic_front', 'cnic_back', 'selfie', 'student_card']);
  await ali.page.click('#idv [type=submit]');
  await ali.page.waitForSelector('text=Account setup');
  assert.match(await ali.page.textContent('#view'), /Identity[\s\S]*Under review[\s\S]*Student card[\s\S]*Under review/);

  const admin = users.Admin;
  await admin.go('/admin?tab=verify', '[data-user]');
  assert.equal(await admin.page.locator('#admin-body [data-user]').count(), 2);
  const sanaCard = admin.page.locator('[data-user]', { hasText: 'Sana Driver' });
  assert.match(await sanaCard.textContent(), /identity \+ driver[\s\S]*35202-1234567-1[\s\S]*LHR-998877[\s\S]*Honda City 2021, Silver · LEA-2468/);
  await admin.page.waitForFunction(() => document.querySelectorAll('img.doc[src^="blob:"]').length === 10, null, { timeout: 15000 });
  await sanaCard.locator('[data-action=decline]').click();
  await admin.toast(/write a note/);
  await sanaCard.locator('[data-action=approve]').click();
  await admin.page.waitForFunction(() => document.querySelectorAll('#admin-body [data-user]').length === 1);
  await admin.page.locator('[data-user]', { hasText: 'Ali Student' }).locator('[data-action=approve]').click();
  await admin.page.waitForSelector('text=No pending verifications');

  await sana.go('/inbox', '#inbox-list .card');
  assert.match(await sana.page.textContent('#inbox-list'), /You are verified[\s\S]*driver registration[\s\S]*can now post rides/);
  await ali.go('/profile', 'text=Student prices unlocked');
});

test('2. offer a ride: travel time is estimated and payment details saved', async () => {
  const { page, go } = users['Sana Driver'];
  await go('/offer', '#offer');
  await chooseRoute(page, { from: 'Lahore', to: 'Islamabad', pickup: 'Thokar Niaz Baig', drop: 'Faizabad Interchange' });
  const hours = Number(await page.inputValue('[name=dur_h]'));
  assert.ok(hours >= 3 && hours <= 5, `estimated ${hours}h`);
  // Gujranwala is suggested as a stop on the way; the fare table shows the sharing discounts.
  assert.match(await page.textContent('#route-info'), /Gujranwala/);
  assert.match(await page.textContent('#earnings'), /25% off[\s\S]*50% off/);
  assert.match(await page.textContent('#fare-info'), /bus about Rs/);
  await toStep(page, 2);
  await page.fill('#ow', localDateTime(2, 8));
  await toStep(page, 3);
  await page.fill('#ofk', '8');
  await page.fill('#osd', '20');
  await page.click('.days >> text=JazzCash');
  await page.fill('#opd', 'JazzCash 0300 1112233 (Sana)');
  await toStep(page, 4);
  await page.check('[name=home_pickup]');
  await page.fill('#ohr', '6');
  await page.fill('#ov', 'Honda City (silver)');
  await toStep(page, 5);
  assert.match(await page.textContent('#offer-summary'), /Thokar Niaz Baig → Faizabad Interchange[\s\S]*Cash, JazzCash[\s\S]*pickup within 6 km/);
  await publish(page);
  await page.waitForURL(/#\/ride\/\d+/);
  await page.waitForSelector('text=Arrival (approx.)');
  users['Sana Driver'].rideId = rideIdFromUrl(page);
  assert.match(await page.textContent('#view'), /Cash, JazzCash/);
  assert.equal(await page.inputValue('#edit-ride [name=payment_details]'), 'JazzCash 0300 1112233 (Sana)');
  const ride = rideRow(users['Sana Driver'].rideId);
  assert.equal(ride.fare_per_km, 8);
  assert.equal(ride.home_pickup, 1);
  assert.equal(ride.home_radius_km, 6);
  const km = JSON.parse(ride.stops).at(-1).km;
  assert.equal(ride.price_per_seat, Math.round((km * 8) / 10) * 10, 'price = km × rate, rounded to Rs 10');
  assert.match(await page.textContent('.stops'), /Thokar Niaz Baig[\s\S]*0 km[\s\S]*Faizabad Interchange/);
});

test('3. recurring commute: Mon + Fri for 2 weeks posts 4 rides', async () => {
  const { page, go } = users['Sana Driver'];
  await go('/offer', '#offer');
  await chooseRoute(page, { from: 'Islamabad', to: 'Rawalpindi' });
  await toStep(page, 2);
  await page.fill('#ow', localDateTime(1, 18));
  await page.fill('[name=dur_h]', '0');
  await page.fill('[name=dur_m]', '45');
  await page.click('summary:has-text("Regular commute")');
  await page.click('.days >> text="Mon"');
  await page.click('.days >> text="Fri"');
  await page.selectOption('#oweeks', '2');
  await toStep(page, 5);
  assert.match(await page.textContent('#offer-summary'), /Repeats\s*Mon, Fri for 2 week/);
  await publish(page);
  await page.waitForURL(/tab=driving/);
  await page.waitForSelector('#list .card');
  assert.equal(await page.locator('#list .card', { hasText: 'Rawalpindi' }).count(), 4);
  assert.match(await page.locator('#list .card', { hasText: 'Rawalpindi' }).first().textContent(), /45m/);
});

test('4. women-only ride by a woman driver', async () => {
  const { page, go } = users['Sana Driver'];
  await go('/offer', '#offer');
  await chooseRoute(page, { from: 'Lahore', to: 'Faisalabad' });
  await toStep(page, 2);
  await page.fill('#ow', localDateTime(3, 9));
  await toStep(page, 4);
  await page.check('[name=women_only]');
  await page.check('[name=instant_book]');
  await publish(page);
  await page.waitForURL(/#\/ride\/\d+/);
  users['Sana Driver'].womenRideId = rideIdFromUrl(page);
  await page.waitForSelector('text=Women only');
  // People who have not registered as drivers are asked to register first.
  await users['Omar Passenger'].go('/offer', 'text=Become a driver');
  assert.equal(await users['Omar Passenger'].page.locator('#offer').count(), 0);
});

test('5. search: student price, arrival time and time-of-day filter', async () => {
  const { page, go } = users['Ali Student'];
  await go('/', '#search');
  await page.fill('#from', 'lahore');
  await page.fill('#to', 'Islamabad');
  await page.selectOption('#time', 'evening');
  await page.click('#search [type=submit]');
  await page.waitForSelector('#results h2');
  assert.match(await page.textContent('#results h2'), /^0 rides/);
  await page.selectOption('#time', 'morning');
  await page.click('#search [type=submit]');
  await page.waitForFunction(() => /^1 ride /.test(document.querySelector('#results h2')?.textContent || ''));
  const card = await page.textContent('#results a.card');
  const full = rideRow(users['Sana Driver'].rideId).price_per_seat;
  assert.match(card, new RegExp(rs(Math.round(full * 0.8))), 'student pays 20% less');
  assert.match(card, /Rs [\d.]+\/km/);
  assert.match(card, /Home pickup/);
  assert.match(card, /8:00 am[\s\S]*Lahore[\s\S]*Thokar Niaz Baig[\s\S]*\d{1,2}:\d{2} (am|pm)[\s\S]*Islamabad/, 'departure and arrival times shown');
  assert.match(card, /20% student discount/);
});

test('6. women-only rides cannot be booked by men', async () => {
  const omar = users['Omar Passenger'];
  await omar.go(`/ride/${users['Sana Driver'].womenRideId}`, '#book');
  await omar.page.click('#book [type=submit]');
  await omar.page.waitForSelector('.toast.error');
  assert.match(await omar.page.textContent('#toast'), /women only/i);
});

test('7. request to book → driver accepts → passenger sees phone and payment details', async () => {
  const ali = users['Ali Student'];
  const sana = users['Sana Driver'];
  const rideId = sana.rideId;
  await ali.go(`/ride/${rideId}`, '#book');
  await ali.page.fill('#bmsg', 'Can you pick me up at Thokar?');
  await ali.page.click('#book [type=submit]');
  await ali.page.waitForSelector('text=Your booking');
  assert.match(await ali.page.textContent('#view'), /pending/);
  assert.doesNotMatch(await ali.page.textContent('#view'), /JazzCash 0300/, 'payment details hidden while pending');

  assert.equal(await badgeCount(sana), 1);
  await sana.go('/inbox', '#inbox-list .card');
  assert.match(await sana.page.textContent('#inbox-list'), /New booking request from Ali Student/);
  await sana.page.click('#inbox-list .card');
  await sana.page.waitForSelector('[data-action=confirm]');
  await sana.page.click('[data-action=confirm]');
  await sana.page.waitForSelector('.list-row a[href^="tel:"]');

  await ali.go(`/ride/${rideId}`, 'text=Your booking');
  const text = await ali.page.textContent('#view');
  assert.match(text, /confirmed/);
  assert.match(text, /Pay to: JazzCash 0300 1112233/);
  assert.match(text, /Driver: 0300 1110001/);
  assert.match(text, /Car: Honda City \(silver\), plate LEA-2468/, 'the vehicle text the driver typed in test 2');
  await ali.go('/inbox', '#inbox-list .card');
  assert.match(await ali.page.textContent('#inbox-list'), /Booking confirmed/);
});

test('8. chat between passenger and driver', async () => {
  const ali = users['Ali Student'];
  const sana = users['Sana Driver'];
  await ali.go(`/ride/${sana.rideId}`, 'text=Message driver');
  await ali.page.click('text=Message driver');
  await ali.page.waitForSelector('#chat-form');
  await ali.page.fill('#chat-form input', 'Assalam o alaikum! I will be at the bus stop.');
  await ali.page.click('#chat-form [type=submit]');
  await ali.page.waitForSelector('.bubble.mine');

  await sana.go('/inbox?tab=messages', '#inbox-list .card');
  assert.match(await sana.page.textContent('#inbox-list'), /Ali Student[\s\S]*1 new/);
  await sana.page.click('#inbox-list .card');
  await sana.page.waitForSelector('.bubble');
  await sana.page.fill('#chat-form input', 'Walaikum salam, see you at 8.');
  await sana.page.click('#chat-form [type=submit]');
  // The passenger's open chat polls every 5 seconds.
  await ali.page.waitForSelector('.bubble:not(.mine)', { timeout: 10000 });
  assert.match(await ali.page.textContent('#chat'), /see you at 8/);
});

test('9. driver edits the ride; passenger is notified', async () => {
  const sana = users['Sana Driver'];
  await sana.go(`/ride/${sana.rideId}`, 'summary:has-text("Edit ride details")');
  await sana.page.click('summary:has-text("Edit ride details")');
  // Rides with stops keep their route; drivers can still change the details.
  assert.equal(await sana.page.locator('#edit-ride [name=pickup_point]').count(), 0);
  await sana.page.fill('#edit-ride [name=notes]', 'I will wait at the Thokar petrol station.');
  await sana.page.fill('#edit-ride [name=dur_h]', '5');
  await sana.page.fill('#edit-ride [name=dur_m]', '0');
  await sana.page.click('#edit-ride [type=submit]');
  await sana.page.waitForSelector('text=I will wait at the Thokar petrol station.');
  assert.match(await sana.page.textContent('#view'), /Travel time\s*5h/);
  const ali = users['Ali Student'];
  await ali.go('/inbox', '#inbox-list .card');
  assert.match(await ali.page.textContent('#inbox-list'), /Ride details updated/);
});

test('10. share trip and SOS (with the Android bridge)', async () => {
  const ali = users['Ali Student'];
  await ali.go(`/ride/${users['Sana Driver'].rideId}`, 'text=Share trip');
  await ali.page.click('text=Share trip');
  const calls = await ali.page.evaluate(() => window.bridgeCalls);
  assert.equal(calls[0][0], 'share');
  assert.match(calls[0][1], /Lahore → Islamabad .* with Sana Driver/);

  await ali.page.click('[data-action=sos]');
  await ali.page.waitForSelector('#sos:not([hidden])');
  for (const n of ['15', '1122', '130']) assert.equal(await ali.page.locator(`#sos a[href="tel:${n}"]`).count(), 1);
  assert.match(await ali.page.textContent('#sos'), /Add an emergency contact/);

  await ali.go('/profile', '#profile');
  await ali.page.fill('[name=emergency_name]', 'Abbu');
  await ali.page.fill('[name=emergency_phone]', '+92 321 5556677');
  await ali.page.click('#profile [type=submit]');
  await ali.toast(/Profile saved/);
  await ali.go(`/ride/${users['Sana Driver'].rideId}`, 'text=Share trip');
  await ali.page.click('[data-action=sos]');
  await ali.page.waitForSelector('text=Alert Abbu');
  assert.equal(await ali.page.locator('[data-action=server]').count(), 0, 'no server button on ride page');
});

test('11. ride request → matching ride → passenger alerted', async () => {
  const zara = users['Zara Traveller'];
  const date = localDateTime(4, 0).slice(0, 10);
  await zara.go(`/requests/new?from=Multan&to=Lahore&date=${date}`, '#rq');
  // Pickup chosen by tapping it on the Multan map, drop-off from the list.
  const multanMap = zara.page.locator('[data-points=from_place_id]');
  await multanMap.locator('.leaflet-marker-icon[title="Bahauddin Zakariya University"]').dispatchEvent('click');
  assert.equal(await zara.page.locator('#rqfp option:checked').textContent(), 'Bahauddin Zakariya University');
  assert.ok(await zara.page.locator('[data-points=to_place_id] .map-pin').count() > 3, 'Lahore points on the map');
  await zara.page.selectOption('#rqtp', { label: 'Liberty Market, Gulberg' });
  await zara.page.fill('#rq [name=max_price]', '3000');
  await zara.page.click('#rq [type=submit]');
  await zara.page.waitForURL(/tab=requests/);
  await zara.page.waitForSelector('#list .card');
  assert.match(await zara.page.textContent('#list'), /Multan → Lahore[\s\S]*open/);

  const sana = users['Sana Driver'];
  await sana.go('/requests?from=Multan', '#rq-list .card');
  assert.match(await sana.page.textContent('#rq-list'), /Zara Traveller/);
  assert.match(await sana.page.textContent('#rq-list'), /Pickup: Bahauddin Zakariya University, Multan[\s\S]*Drop-off: Liberty Market, Gulberg, Lahore/);
  await sana.page.click('text=Post as a new ride');
  await sana.page.waitForSelector('#offer');
  assert.equal(await sana.page.inputValue('#of'), 'Multan');
  await sana.page.waitForFunction(() => /km by road/.test(document.querySelector('#route-info').textContent));
  // The passenger's points are already chosen, and the route is on the map.
  assert.equal(await sana.page.locator('#opp option:checked').textContent(), 'Bahauddin Zakariya University');
  assert.equal(await sana.page.locator('#odp option:checked').textContent(), 'Liberty Market, Gulberg');
  await sana.page.waitForSelector('#offer-map .map-pin.start');
  await toStep(sana.page, 2);
  await sana.page.fill('#ow', `${date}T10:00`);
  await publish(sana.page);
  await sana.page.waitForURL(/#\/ride\/\d+/);

  assert.ok(await badgeCount(zara) >= 1);
  await zara.go('/inbox', '#inbox-list .card');
  assert.match(await zara.page.textContent('#inbox-list'), /A ride matches your request: Multan → Lahore/);
});

test('12. ID verification: one account per CNIC; a rejection tells the user what to fix', async () => {
  const zara = users['Zara Traveller'];
  await zara.go('/profile', 'text=Account setup');
  await zara.page.click('.setup-row:has-text("Identity")');
  await zara.page.waitForSelector('#idv');
  // Ali already registered this CNIC.
  await zara.page.fill('#cnic', '35202-7654321-3');
  await addPhotos(zara.page, ['cnic_front', 'cnic_back', 'selfie']);
  await zara.page.click('#idv [type=submit]');
  await zara.toast(/already registered with another account/);
  await zara.page.fill('#cnic', '61101-5556667-8');
  await zara.page.click('#idv [type=submit]');
  await zara.page.waitForSelector('text=Account setup');

  const admin = users.Admin;
  await admin.go('/admin?tab=verify', '[data-user]');
  const card = admin.page.locator('[data-user]', { hasText: 'Zara Traveller' });
  await card.locator('input[name=note]').fill('Selfie is blurry');
  await card.locator('[data-action=decline]').click();
  await admin.page.waitForSelector('text=No pending verifications');

  await zara.go('/profile', 'text=Account setup');
  assert.match(await zara.page.textContent('#view'), /Not approved: Selfie is blurry/);
  const aliId = await users['Ali Student'].page.evaluate(() => me.id);
  await users['Omar Passenger'].go(`/user/${aliId}`, '.person');
  const profile = await users['Omar Passenger'].page.textContent('#view');
  assert.match(profile, /CNIC verified by ABC Rides/);
  assert.match(profile, /Verified/);
});

test('13. decline a request; passenger cancels a booking', async () => {
  const omar = users['Omar Passenger'];
  const sana = users['Sana Driver'];
  await omar.go(`/ride/${sana.rideId}`, '#book');
  await omar.page.click('#book [type=submit]');
  await omar.page.waitForSelector('text=Your booking');
  await sana.go(`/ride/${sana.rideId}`, '[data-action=reject]');
  await sana.page.click('[data-action=reject]');
  await sana.page.waitForSelector('.badge.rejected');
  await omar.go('/inbox', '#inbox-list .card');
  assert.match(await omar.page.textContent('#inbox-list'), /Booking request declined/);

  // Omar books one of the commute rides, then cancels it.
  await omar.go('/search?from=Islamabad&to=Rawalpindi&seats=1', '#results a.card');
  await omar.page.click('#results a.card');
  await omar.page.waitForSelector('#book');
  await omar.page.click('#book [type=submit]');
  await omar.page.waitForSelector('[data-action=cancel-booking]');
  await omar.page.click('[data-action=cancel-booking]');
  await omar.page.waitForSelector('#book');
  await sana.go('/inbox', '#inbox-list .card');
  assert.match(await sana.page.textContent('#inbox-list'), /Omar Passenger cancelled their booking/);
});

test('14. report a user; admin resolves and suspends', async () => {
  const ali = users['Ali Student'];
  const omarId = await users['Omar Passenger'].page.evaluate(() => me.id);
  await ali.go(`/user/${omarId}`, 'summary:has-text("Report")');
  await ali.page.click('summary:has-text("Report")');
  await ali.page.selectOption('#report [name=reason]', 'No-show');
  await ali.page.fill('#report [name=details]', 'Booked and never came.');
  await ali.page.click('#report [type=submit]');
  await ali.toast(/Report sent/);

  const admin = users.Admin;
  await admin.go('/admin?tab=reports', '[data-report]');
  assert.match(await admin.page.textContent('#admin-body'), /No-show[\s\S]*Ali Student[\s\S]*reported[\s\S]*Omar Passenger/);
  await admin.page.click('[data-action=suspend]');
  await admin.page.waitForSelector('.badge.cancelled');
  await admin.page.fill('[name=resolution]', 'Suspended after no-show');
  await admin.page.click('[data-action=resolve]');
  await admin.page.waitForSelector('text=Nothing here.');

  const omar = users['Omar Passenger'];
  await omar.go('/profile', '#login');
  await omar.page.fill('#le', 'omar@e2e.pk');
  await omar.page.fill('#lp', 'password123');
  await omar.page.click('#login [type=submit]');
  await omar.page.waitForSelector('.toast.error');
  assert.match(await omar.page.textContent('#toast'), /suspended/);

  await admin.go('/admin?tab=users&q=omar', '#admin-body div.card');
  assert.match(await admin.page.textContent('#admin-body div.card'), /Omar Passenger[\s\S]*suspended/);
  await admin.page.click('[data-action=suspend]');
  await admin.page.waitForFunction(() => !document.querySelector('#admin-body .badge.cancelled'));
});

test('15. complete the ride and leave reviews both ways', async () => {
  const sana = users['Sana Driver'];
  const ali = users['Ali Student'];
  // Move the ride into the past so it can be completed.
  db.prepare('UPDATE rides SET departure_at = ? WHERE id = ?').run(new Date(Date.now() - 6 * 36e5).toISOString(), sana.rideId);
  await sana.go(`/ride/${sana.rideId}`, '[data-action=complete]');
  await sana.page.click('[data-action=complete]');
  await sana.page.waitForSelector('form.review');
  await sana.page.selectOption('form.review [name=rating]', '4');
  await sana.page.click('form.review [type=submit]');
  await sana.toast(/Thanks for your review/);

  await ali.go('/inbox', '#inbox-list .card');
  assert.match(await ali.page.textContent('#inbox-list'), /How was your trip\?/);
  await ali.go(`/ride/${sana.rideId}`, 'form.review');
  await ali.page.fill('form.review [name=comment]', 'Very punctual and safe driver.');
  await ali.page.click('form.review [type=submit]');
  await ali.toast(/Thanks for your review/);
  await ali.page.waitForFunction(() => !document.querySelector('form.review'));

  const sanaId = await sana.page.evaluate(() => me.id);
  await ali.go(`/user/${sanaId}`, '.stars');
  const profile = await ali.page.textContent('#view');
  assert.match(profile, /1 ride\(s\) driven/);
  assert.match(profile, /Very punctual and safe driver/);
});

test('16. driver cancels a ride; booked passenger is notified', async () => {
  const zara = users['Zara Traveller'];
  const sana = users['Sana Driver'];
  await zara.go(`/ride/${sana.womenRideId}`, '#book');
  await zara.page.click('#book [type=submit]');
  await zara.page.waitForSelector('text=confirmed');
  await sana.go(`/ride/${sana.womenRideId}`, '[data-action=cancel-ride]');
  await sana.page.click('[data-action=cancel-ride]');
  await sana.page.waitForSelector('.badge.cancelled');
  await zara.go('/inbox', '#inbox-list .card');
  assert.match(await zara.page.textContent('#inbox-list'), /Ride cancelled by the driver/);
  await zara.go('/trips', '#list .card');
  assert.match(await zara.page.textContent('#list'), /ride cancelled/);
});

test('16b. wallet: fees after free bookings, top-ups approved by admin, commission on accept', async () => {
  const before = getSettings(db);
  setSettings(db, { free_confirmations: 0, driver_commission_pct: 10, passenger_commission_pct: 5 });
  try {
    const sana = users['Sana Driver'];
    const zara = users['Zara Traveller'];
    const admin = users.Admin;
    await sana.go('/offer', '#offer');
    await chooseRoute(sana.page, { from: 'Lahore', to: 'Sialkot', pickup: 'Kalma Chowk', drop: 'City centre (Allama Iqbal Chowk)' });
    await toStep(sana.page, 2);
    await sana.page.fill('#ow', localDateTime(5, 7));
    await publish(sana.page);
    await sana.page.waitForURL(/#\/ride\/\d+/);
    const rideId = rideIdFromUrl(sana.page);
    const fare = rideRow(rideId).price_per_seat * 2;
    const passengerFee = Math.ceil((fare * 5) / 100);
    // Two seats make two passengers: 25% off the driver's 10% commission.
    const driverFee = Math.ceil((fare * 10 * 75) / 10000);

    // Zara's wallet is empty, so she is asked to top up.
    await zara.go(`/ride/${rideId}`, '#book');
    await zara.page.selectOption('#bseats', '2');
    assert.match(await zara.page.textContent('#fee-box'), new RegExp(`Booking fee ${rs(passengerFee)} \\(5%\\)[\\s\\S]*Wallet: Rs 0[\\s\\S]*Top up`));
    await zara.page.click('#book [type=submit]');
    await zara.toast(/wallet balance \(Rs 0\) is too low/);
    await zara.page.waitForURL(/#\/wallet/);
    await zara.page.waitForSelector('#topup');
    await zara.page.fill('#topup [name=amount]', '500');
    await zara.page.selectOption('#topup [name=method]', 'easypaisa');
    await zara.page.fill('#topup [name=reference]', 'EP20261001A');
    await zara.page.click('#topup [type=submit]');
    await zara.page.waitForSelector('.badge.pending');

    await admin.go('/admin?tab=topups', '[data-topup]');
    assert.match(await admin.page.textContent('[data-topup]'), /Rs 500[\s\S]*Zara Traveller[\s\S]*EP20261001A/);
    await admin.page.click('[data-topup] [data-action=approve]');
    await admin.page.waitForSelector('text=Nothing here.');

    await zara.go('/wallet', '.balance');
    assert.equal(await zara.page.textContent('.balance'), 'Rs 500');
    await zara.go(`/ride/${rideId}`, '#book');
    await zara.page.selectOption('#bseats', '2');
    await zara.page.click('#book [type=submit]');
    await zara.page.waitForSelector('text=Your booking');

    // The driver's wallet is empty too.
    await sana.go(`/ride/${rideId}`, '[data-action=confirm]');
    assert.match(await sana.page.textContent('[data-action=confirm]'), new RegExp(`Accept · fee ${rs(driverFee)}`));
    assert.match(await sana.page.textContent('#view'), /25% commission discount for sharing your car/);
    await sana.page.click('[data-action=confirm]');
    await sana.toast(/Your wallet balance \(Rs 0\) is too low/);
    await sana.page.waitForURL(/#\/wallet/);
    await sana.page.waitForSelector('#topup');
    await sana.page.fill('#topup [name=reference]', 'JC20261001B');
    await sana.page.click('#topup [type=submit]');
    await sana.page.waitForSelector('.badge.pending');
    await admin.go('/admin?tab=topups', '[data-topup]');
    await admin.page.click('[data-topup] [data-action=approve]');
    await admin.page.waitForSelector('text=Nothing here.');

    await sana.go(`/ride/${rideId}`, '[data-action=confirm]');
    await sana.page.click('[data-action=confirm]');
    await sana.page.waitForSelector('.badge.confirmed');
    await sana.go('/wallet', '.balance');
    assert.equal(await sana.page.textContent('.balance'), rs(500 - driverFee));
    assert.match(await sana.page.textContent('#view'), new RegExp(`10% commission \\(25% sharing discount\\) on Rs ${fare}[\\s\\S]*−${rs(driverFee)}`));
    await zara.go('/wallet', '.balance');
    assert.equal(await zara.page.textContent('.balance'), rs(500 - passengerFee));
    await zara.go(`/ride/${rideId}`, `text=Booking fee paid: ${rs(passengerFee)}`);

    await admin.go('/admin', '.stats');
    assert.match(await admin.page.textContent('.stats'), new RegExp(`${rs(driverFee + passengerFee)}\\s*Revenue \\(all time\\)`));
  } finally {
    setSettings(db, before);
  }
});

test('16d. stops on the way and home drop-off: pay for your part of the route', async () => {
  const sana = users['Sana Driver'];
  const omar = users['Omar Passenger'];
  await sana.go('/offer', '#offer');
  await chooseRoute(sana.page, { from: 'Lahore', to: 'Sialkot', pickup: 'Kalma Chowk', drop: 'City centre (Allama Iqbal Chowk)' });
  await sana.page.click('#route-info label:has-text("Gujranwala · City centre")');
  await sana.page.waitForFunction(() => /with 1 stop/.test(document.querySelector('#route-info').textContent));
  await toStep(sana.page, 2);
  await sana.page.fill('#ow', localDateTime(6, 8));
  await toStep(sana.page, 4);
  await sana.page.check('[name=home_drop]');
  await publish(sana.page);
  await sana.page.waitForURL(/#\/ride\/\d+/);
  const rideId = rideIdFromUrl(sana.page);
  const stops = JSON.parse(rideRow(rideId).stops);
  assert.deepEqual(stops.map((x) => x.city), ['Lahore', 'Gujranwala', 'Sialkot']);
  const segPrice = Math.round(((stops[2].km - stops[1].km) * rideRow(rideId).fare_per_km) / 10) * 10;

  // Omar (logged out since his suspension in test 14) logs back in.
  await omar.go('/login', '#login');
  await omar.page.fill('#le', 'omar@e2e.pk');
  await omar.page.fill('#lp', 'password123');
  await omar.page.click('#login [type=submit]');
  await omar.page.waitForSelector('.hero');

  // In Gujranwala, he finds the Lahore ride and pays only from Gujranwala.
  await omar.go('/search?from=Gujranwala&to=Sialkot&seats=1', '#results a.card');
  const card = omar.page.locator('#results a.card', { hasText: 'Lahore' });
  assert.match(await card.textContent(), new RegExp(`${rs(segPrice)}[\\s\\S]*Gujranwala[\\s\\S]*City centre \\(Sheranwala Bagh\\)[\\s\\S]*Sialkot[\\s\\S]*City centre \\(Allama Iqbal Chowk\\)`));
  await card.click();
  await omar.page.waitForSelector('#book');
  assert.equal(await omar.page.inputValue('#bboard'), '1');
  assert.match(await omar.page.textContent('.stops'), /you get on/);
  await omar.page.check('[name=want_drop]');
  await omar.page.fill('[name=drop_address]', 'House 5, Kashmir Road');
  await omar.page.fill('[name=drop_loc]', `https://maps.google.com/?q=${stops[2].lat + 0.01},${stops[2].lon}`);
  await omar.page.waitForFunction(() => /\+Rs 150/.test(document.querySelector('.home-note').textContent));
  assert.match(await omar.page.textContent('#fee-box'), new RegExp(`You pay the driver ${rs(segPrice + 150)}[\\s\\S]*incl. Rs 150 home`));
  await omar.page.click('#book [type=submit]');
  await omar.page.waitForSelector('text=Your booking');
  assert.match(await omar.page.textContent('#view'), new RegExp(`Home drop: House 5, Kashmir Road[\\s\\S]*${rs(segPrice + 150)} to pay the driver`));

  await sana.go(`/ride/${rideId}`, '[data-action=confirm]');
  const row = await sana.page.textContent('#view');
  assert.match(row, /Sheranwala Bagh\), Gujranwala → City centre \(Allama Iqbal Chowk\), Sialkot/);
  assert.match(row, /Drop at: House 5, Kashmir Road[\s\S]*map[\s\S]*\+Rs 150/);
  assert.equal(await sana.page.locator('a:has-text("map")').getAttribute('href'), `https://maps.google.com/?q=${stops[2].lat + 0.01},${stops[2].lon}`);
});

test('16c. admin settings: booking mode and fees from the admin panel', async () => {
  const admin = users.Admin;
  await admin.go('/admin?tab=settings', '#settings');
  await admin.page.selectOption('#settings [name=booking_mode]', 'manual');
  await admin.page.fill('#settings [name=driver_commission_pct]', '7');
  await admin.page.click('#settings [type=submit]');
  await admin.toast(/Settings saved/);
  assert.equal(getSettings(db).booking_mode, 'manual');
  assert.equal(getSettings(db).driver_commission_pct, 7);

  // Drivers no longer get the instant-booking option.
  const sana = users['Sana Driver'];
  await sana.page.reload();
  await sana.go('/offer', '#offer');
  assert.equal(await sana.page.locator('[name=instant_book]').count(), 0);
  assert.match(await sana.page.textContent('#offer'), /You approve each booking request/);
  setSettings(db, { booking_mode: 'driver_choice', driver_commission_pct: 5 });
});

test('17. change password, log out and log back in', async () => {
  const zara = users['Zara Traveller'];
  await zara.go('/profile', 'summary:has-text("Change password")');
  await zara.page.click('summary:has-text("Change password")');
  await zara.page.fill('#password [name=current_password]', 'password123');
  await zara.page.fill('#password [name=new_password]', 'newpassword9');
  await zara.page.click('#password [type=submit]');
  await zara.toast(/Password changed/);
  await zara.page.click('[data-action=logout]');
  await zara.page.waitForSelector('.hero');
  await zara.go('/login', '#login');
  await zara.page.fill('#le', 'zara@e2e.pk');
  await zara.page.fill('#lp', 'newpassword9');
  await zara.page.click('#login [type=submit]');
  await zara.page.waitForSelector('.hero');
  assert.match(await zara.page.textContent('#nav'), /Profile/);
});

test('18. admin overview, and the Android "change server" hook', async () => {
  const admin = users.Admin;
  await admin.go('/admin', '.stats');
  const stats = await admin.page.textContent('.stats');
  assert.match(stats, /5\s*Members/);
  assert.match(stats, /0\s*Open reports/);

  const ali = users['Ali Student'];
  await ali.go('/profile', '[data-action=server]');
  await ali.page.click('[data-action=server]');
  assert.deepEqual((await ali.page.evaluate(() => window.bridgeCalls)).at(-1), ['changeServer']);
});

test('no JavaScript errors in any page', () => {
  assert.deepEqual(errors, []);
});
