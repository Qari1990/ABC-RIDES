'use strict';

// ---- State & API ------------------------------------------------------------

const store = {
  get token() { try { return localStorage.getItem('token'); } catch { return null; } },
  set token(v) { try { v ? localStorage.setItem('token', v) : localStorage.removeItem('token'); } catch { /* private mode */ } },
};
let me = null;
let cities = [];
let unread = { notifications: 0, messages: 0 };
// Timers belonging to the current page (e.g. chat polling); cleared on navigation.
let pageTimers = [];

// The Android app exposes a small bridge; in a normal browser this is undefined.
const nativeApp = window.AbcAndroid;

async function api(path, { method = 'GET', body } = {}) {
  const headers = {};
  if (body) headers['content-type'] = 'application/json';
  if (store.token) headers.authorization = `Bearer ${store.token}`;
  const res = await fetch(`/api${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  if (res.status === 401 && store.token && path !== '/auth/login') { store.token = null; me = null; }
  if (!res.ok) {
    const err = new Error((data && data.error) || `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

// ---- Helpers ----------------------------------------------------------------

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (n) => `Rs ${Number(n).toLocaleString('en-PK')}`;
const when = (iso) => new Date(iso).toLocaleString('en-PK', { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
const clock = (iso) => new Date(iso).toLocaleTimeString('en-PK', { hour: 'numeric', minute: '2-digit' });
const duration = (min) => (min >= 60 ? `${Math.floor(min / 60)}h${min % 60 ? ` ${min % 60}m` : ''}` : `${min}m`);
// "Fri, 2 Oct, 7:00 am → 11:15 am (4h 15m)"; the arrival is shown with a "+1" if it is the next day.
const schedule = (r) => {
  if (!r.arrival_at) return when(r.departure_at);
  const days = Math.round((new Date(new Date(r.arrival_at).toDateString()) - new Date(new Date(r.departure_at).toDateString())) / 864e5);
  return `${when(r.departure_at)} → ${clock(r.arrival_at)}${days > 0 ? ` (+${days})` : ''} · ${duration(r.duration_minutes)}`;
};
const TIME_SLOTS = { morning: ['Morning (before 12 pm)', 0, 12], afternoon: ['Afternoon (12–5 pm)', 12, 17], evening: ['Evening & night (after 5 pm)', 17, 24] };
const timeAgo = (iso) => {
  const s = (Date.now() - new Date(iso)) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(iso).toLocaleDateString('en-PK', { day: 'numeric', month: 'short' });
};
const initials = (name) => name.split(/\s+/).map((p) => p[0]).slice(0, 2).join('').toUpperCase();
const stars = (n) => '★'.repeat(Math.round(n)) + '☆'.repeat(5 - Math.round(n));
const TYPE_LABEL = { professional: 'Working professional', student: 'Student', traveler: 'Regular traveller' };
const DOC_LABEL = { cnic: 'CNIC', student_card: 'Student card', employee_card: 'Employee card', driving_license: 'Driving licence' };
const PAY_LABEL = { cash: '💵 Cash', jazzcash: 'JazzCash', easypaisa: 'Easypaisa', bank_transfer: '🏦 Bank transfer' };
const isPast = (iso) => new Date(iso) <= new Date();
const rideUrl = (id) => `${location.origin}/#/ride/${id}`;

function toast(msg, isError = false) {
  const el = $('#toast');
  el.textContent = msg;
  el.className = `toast show${isError ? ' error' : ''}`;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => { el.className = 'toast'; }, 3000);
}

function localInputValue(date) {
  const d = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return d.toISOString().slice(0, 16);
}

// Start and end of a local calendar day ("2026-10-05").
function dayRange(date) {
  const start = new Date(`${date}T00:00`);
  return [start, new Date(start.getTime() + 864e5)];
}

function cityOptions() {
  return `<datalist id="cities">${cities.map((c) => `<option value="${esc(c)}">`).join('')}</datalist>`;
}

function formData(form) {
  return Object.fromEntries(new FormData(form).entries());
}

// Wraps a form submit handler with busy state and error toasts.
function onSubmit(form, handler) {
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = form.querySelector('[type=submit]');
    if (btn) btn.disabled = true;
    try { await handler(formData(form), form); } catch (err) { toast(err.message, true); } finally { if (btn) btn.disabled = false; }
  });
}

function onClick(el, handler) {
  el.addEventListener('click', async (e) => {
    const target = e.target.closest('[data-action]');
    if (!target) return;
    e.preventDefault();
    target.disabled = true;
    try { await handler(target.dataset.action, target.dataset, target); } catch (err) { toast(err.message, true); } finally { target.disabled = false; }
  });
}

function requireLogin() {
  if (me) return true;
  location.hash = `#/login?next=${encodeURIComponent(location.hash.slice(1))}`;
  return false;
}

// Shrinks a photo to at most 1600px and re-encodes it as JPEG so uploads stay small.
async function imageToDataUrl(file) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', 0.85);
}

function shareText(text) {
  if (nativeApp && nativeApp.share) { nativeApp.share(text); return; }
  if (navigator.share) { navigator.share({ text }).catch(() => {}); return; }
  window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, '_blank');
}

// ---- Components -------------------------------------------------------------

const verifiedBadge = (u) => (u.verified ? ' <span class="verified" title="ID verified">✔ Verified</span>' : '');

function rideCard(r) {
  const showStudent = r.student_discount_pct > 0;
  return `
  <a class="card" href="#/ride/${r.id}">
    <div class="ride-top">
      <div>
        <div class="route">${esc(r.from_city)} <span class="arrow">→</span> ${esc(r.to_city)}</div>
        <div class="meta"><span>🕒 ${schedule(r)}</span><span>💺 ${r.seats_left} left</span>${r.pickup_point ? `<span>📍 ${esc(r.pickup_point)}</span>` : ''}</div>
      </div>
      <div class="price">${money(r.your_price ?? r.price_per_seat)}<small>per seat</small></div>
    </div>
    <div class="badges">
      <span class="badge">${esc(r.driver.name)}${r.driver.verified ? ' ✔' : ''}${r.driver.rating_avg ? ` · ★ ${r.driver.rating_avg}` : ''}</span>
      ${showStudent ? `<span class="badge student">🎓 ${r.student_discount_pct}% student discount</span>` : ''}
      ${r.women_only ? '<span class="badge women">♀ Women only</span>' : ''}
      ${r.instant_book ? '<span class="badge">⚡ Instant booking</span>' : ''}
    </div>
  </a>`;
}

function requestCard(r, { mine = false } = {}) {
  const day = new Date(r.earliest_at);
  const offerParams = new URLSearchParams({ from: r.from_city, to: r.to_city, date: localInputValue(day).slice(0, 10) });
  return `
  <div class="card">
    <div class="ride-top">
      <div>
        <div class="route">${esc(r.from_city)} <span class="arrow">→</span> ${esc(r.to_city)}</div>
        <div class="meta"><span>📅 ${when(r.earliest_at)} – ${new Date(r.latest_at).toLocaleTimeString('en-PK', { hour: 'numeric', minute: '2-digit' })}</span><span>💺 ${r.seats}</span></div>
      </div>
      ${r.max_price ? `<div class="price">≤ ${money(r.max_price)}<small>per seat</small></div>` : ''}
    </div>
    ${r.notes ? `<p class="small" style="margin:8px 0 0">“${esc(r.notes)}”</p>` : ''}
    <div class="list-row" style="margin-top:8px">
      ${mine ? `<span class="badge ${r.status === 'open' && !isPast(r.latest_at) ? 'pending' : 'cancelled'}">${r.status === 'open' && !isPast(r.latest_at) ? 'open' : 'closed'}</span>`
    : `<a href="#/user/${r.passenger.id}">${esc(r.passenger.name)}</a><span class="muted small">${esc(TYPE_LABEL[r.passenger.traveler_type])}${r.passenger.verified ? ' · ✔ verified' : ''}</span>`}
      ${mine && r.status === 'open' && !isPast(r.latest_at) ? `<button class="btn small ghost" data-action="close-request" data-id="${r.id}">Close</button>` : ''}
      ${!mine && (!me || me.id !== r.passenger.id) ? `<a class="btn small" href="#/offer?${offerParams}">Offer this ride</a>` : ''}
    </div>
  </div>`;
}

function personRow(u, extra = '') {
  return `
  <a class="person" href="#/user/${u.id}" style="color:inherit;text-decoration:none">
    <div class="avatar">${esc(initials(u.name))}</div>
    <div>
      <div><b>${esc(u.name)}</b>${verifiedBadge(u)}</div>
      <div class="muted small">${esc(TYPE_LABEL[u.traveler_type] || '')}${u.organization ? ` · ${esc(u.organization)}` : ''}</div>
      <div class="small">${u.rating_avg ? `<span class="stars">${stars(u.rating_avg)}</span> ${u.rating_avg} (${u.rating_count})` : '<span class="muted">No reviews yet</span>'}${extra}</div>
    </div>
  </a>`;
}

function searchForm(q = {}) {
  return `
  <form id="search" class="card">
    ${cityOptions()}
    <div class="row two">
      <div class="field"><label for="from">From</label><input id="from" name="from" list="cities" placeholder="e.g. Lahore" value="${esc(q.from)}" required></div>
      <div class="field"><label for="to">To</label><input id="to" name="to" list="cities" placeholder="e.g. Islamabad" value="${esc(q.to)}" required></div>
    </div>
    <div class="row two">
      <div class="field"><label for="date">Date <span class="muted">(optional)</span></label><input id="date" name="date" type="date" value="${esc(q.date || '')}"></div>
      <div class="field"><label for="seats">Seats</label><select id="seats" name="seats">${[1, 2, 3, 4].map((n) => `<option ${String(q.seats) === String(n) ? 'selected' : ''}>${n}</option>`).join('')}</select></div>
    </div>
    <div class="field"><label for="time">Departure time</label><select id="time" name="time">
      <option value="">Any time</option>
      ${Object.entries(TIME_SLOTS).map(([k, [label]]) => `<option value="${k}" ${q.time === k ? 'selected' : ''}>${label}</option>`).join('')}
    </select></div>
    <label class="check"><input type="checkbox" name="women_only" value="true" ${q.women_only === 'true' ? 'checked' : ''}> Women-only rides</label>
    <button class="btn block" type="submit">Find a ride</button>
  </form>`;
}

function bindSearch(page) {
  onSubmit($('#search', page), (d) => {
    const params = new URLSearchParams({ from: d.from.trim(), to: d.to.trim(), date: d.date || '', seats: d.seats });
    if (d.time) params.set('time', d.time);
    if (d.women_only) params.set('women_only', 'true');
    location.hash = `#/search?${params}`;
  });
}

function paymentCheckboxes(selected = ['cash']) {
  return `<div class="days field">${Object.entries(PAY_LABEL).map(([k, label]) => `
    <label><input type="checkbox" name="pay" value="${k}" ${selected.includes(k) ? 'checked' : ''}><span>${label}</span></label>`).join('')}</div>`;
}

function durationFields(minutes) {
  const h = minutes ? Math.floor(minutes / 60) : '';
  const m = minutes ? minutes % 60 : '';
  return `
    <div class="field">
      <label>Travel time</label>
      <div class="row two duration">
        <div class="suffix"><input name="dur_h" type="number" min="0" max="48" value="${h}" placeholder="4" aria-label="Hours"><span>hours</span></div>
        <div class="suffix"><input name="dur_m" type="number" min="0" max="59" step="5" value="${m}" placeholder="15" aria-label="Minutes"><span>min</span></div>
      </div>
      <p class="muted small" id="dur-hint" style="margin:4px 0 0">Used to show passengers your arrival time.</p>
    </div>`;
}

function durationValue(d) {
  const total = Number(d.dur_h || 0) * 60 + Number(d.dur_m || 0);
  return total > 0 ? total : null;
}

const checkedValues = (form, name) => [...form.querySelectorAll(`input[name=${name}]:checked`)].map((el) => el.value);

// ---- Views ------------------------------------------------------------------

const views = {};

views.home = async (page) => {
  page.innerHTML = `
    <section class="hero">
      <h1>Travel between cities together</h1>
      <p>Share the drive and split the cost. Built for daily and weekly commuters, students heading home, and everyone who travels often.</p>
      <div class="audiences">
        <div><b>💼</b>Job commuters</div>
        <div><b>🎓</b>Students</div>
        <div><b>🧳</b>Travellers</div>
      </div>
    </section>
    ${searchForm()}
    <div class="row two quick">
      <a class="btn ghost" href="#/offer">🚗 Offer your empty seats</a>
      <a class="btn ghost" href="#/requests">🙋 Passengers looking for rides</a>
    </div>
    <h2>Upcoming rides</h2>
    <div id="upcoming"><p class="muted">Loading…</p></div>`;
  bindSearch(page);
  const rides = await api('/rides');
  $('#upcoming', page).innerHTML = rides.length
    ? rides.slice(0, 10).map(rideCard).join('')
    : '<div class="card empty">No rides posted yet. Be the first to <a href="#/offer">offer one</a>!</div>';
};

views.search = async (page, q) => {
  page.innerHTML = `${searchForm(q)}<div id="results"><p class="muted">Searching…</p></div>`;
  bindSearch(page);
  const params = new URLSearchParams({ from: q.from || '', to: q.to || '', seats: q.seats || '1' });
  if (q.women_only) params.set('women_only', 'true');
  if (q.date) {
    const [start, end] = dayRange(q.date);
    params.set('after', start.toISOString());
    params.set('before', end.toISOString());
  }
  let rides = await api(`/rides?${params}`);
  if (TIME_SLOTS[q.time]) {
    const [, from, to] = TIME_SLOTS[q.time];
    rides = rides.filter((r) => { const h = new Date(r.departure_at).getHours(); return h >= from && h < to; });
  }
  const requestLink = `#/requests/new?${new URLSearchParams({ from: q.from || '', to: q.to || '', date: q.date || '', seats: q.seats || '1' })}`;
  $('#results', page).innerHTML = `
    <h2>${rides.length} ride${rides.length === 1 ? '' : 's'} from ${esc(q.from)} to ${esc(q.to)}</h2>
    ${rides.map(rideCard).join('') || `<div class="card empty">No rides found${q.date ? ' for this day' : ''}.
      ${q.date ? `<br><a href="#/search?${new URLSearchParams({ from: q.from || '', to: q.to || '', seats: q.seats || '1' })}">See all upcoming dates</a>` : ''}</div>`}
    <div class="card"><b>Can’t find the right ride?</b><p class="muted small">Post a request and we’ll notify you when a driver offers a matching ride.</p>
      <a class="btn ghost" href="${requestLink}">🙋 Post a ride request</a></div>`;
};

function sosPanel(r) {
  const vehicle = r.vehicle ? ` (${r.vehicle})` : '';
  const text = `I'm travelling ${r.from_city} → ${r.to_city} on ${when(r.departure_at)} with ${r.driver.name}${vehicle}`
    + `${r.driver.phone ? `, driver phone ${r.driver.phone}` : ''}. Trip details: ${rideUrl(r.id)}`;
  const ec = me.emergency_phone;
  return `
    <div class="card sos" id="sos" hidden>
      <h3>🚨 Emergency help</h3>
      <div class="actions">
        <a class="btn danger" href="tel:15">Police 15</a>
        <a class="btn danger" href="tel:1122">Rescue 1122</a>
        <a class="btn danger" href="tel:130">Motorway Police 130</a>
      </div>
      <p class="small" style="margin-top:12px">${ec ? `Send your trip details and location to <b>${esc(me.emergency_name || ec)}</b>:` : 'Add an emergency contact in your <a href="#/profile">profile</a> to alert them in one tap.'}</p>
      ${ec ? `<button class="btn" data-action="sos-sms" data-text="${esc(text)}">📩 Alert ${esc(me.emergency_name || 'contact')}</button>` : ''}
    </div>`;
}

views.ride = async (page, _q, id) => {
  const r = await api(`/rides/${id}`);
  const isDriver = me && me.id === r.driver.id;
  const b = r.my_booking;
  const activeBooking = b && ['pending', 'confirmed'].includes(b.status);
  const onTrip = isDriver || (b && b.status === 'confirmed');
  const departed = isPast(r.departure_at);

  let bookingSection = '';
  if (isDriver) {
    const rows = (r.bookings || []).map((x) => `
      <div class="list-row">
        <div>
          <b><a href="#/user/${x.passenger_id}">${esc(x.passenger_name)}</a></b>
          <span class="muted small">· ${esc(TYPE_LABEL[x.passenger_type])} · ${x.seats} seat(s) · ${money(x.price_per_seat * x.seats)}</span>
          ${x.message ? `<div class="small">“${esc(x.message)}”</div>` : ''}
          ${x.passenger_phone ? `<div class="small">📞 <a href="tel:${esc(x.passenger_phone)}">${esc(x.passenger_phone)}</a></div>` : ''}
        </div>
        <div class="actions">
          <span class="badge ${x.status}">${x.status}</span>
          ${['pending', 'confirmed'].includes(x.status) ? `<a class="btn small ghost" href="#/chat/${x.id}">💬 Chat</a>` : ''}
          ${x.status === 'pending' && r.status === 'scheduled' ? `
            <button class="btn small" data-action="confirm" data-id="${x.id}">Accept</button>
            <button class="btn small ghost" data-action="reject" data-id="${x.id}">Decline</button>` : ''}
        </div>
      </div>`).join('');
    bookingSection = `
      <div class="card">
        <h3>Passengers & requests</h3>
        ${rows || '<p class="muted">No bookings yet. Share this ride with colleagues and classmates!</p>'}
      </div>
      ${r.status === 'scheduled' ? `
      <details class="card">
        <summary><b>✏️ Edit ride details</b></summary>
        <form id="edit-ride" style="margin-top:12px">
          <div class="row two">
            <div class="field"><label>Pickup point</label><input name="pickup_point" value="${esc(r.pickup_point)}"></div>
            <div class="field"><label>Drop-off point</label><input name="dropoff_point" value="${esc(r.dropoff_point)}"></div>
          </div>
          <div class="field"><label>Vehicle</label><input name="vehicle" value="${esc(r.vehicle)}"></div>
          ${durationFields(r.duration_minutes)}
          <div class="field"><label>Payment methods</label>${paymentCheckboxes(r.payment_methods)}</div>
          <div class="field"><label>Payment account details</label><input name="payment_details" value="${esc(r.payment_details)}" placeholder="e.g. JazzCash 0300 1234567 (Ahmed Raza)"></div>
          <div class="field"><label>Notes</label><textarea name="notes" maxlength="500">${esc(r.notes)}</textarea></div>
          <label class="check"><input type="checkbox" name="instant_book" value="1" ${r.instant_book ? 'checked' : ''}> Instant booking</label>
          <button class="btn" type="submit">Save changes</button>
        </form>
      </details>
      <div class="actions">
        ${departed ? '<button class="btn" data-action="complete">Mark ride completed</button>' : ''}
        <button class="btn danger" data-action="cancel-ride">Cancel ride</button>
      </div>` : ''}`;
  } else if (activeBooking) {
    bookingSection = `
      <div class="card">
        <h3>Your booking <span class="badge ${b.status}">${b.status}</span></h3>
        <p>${b.seats} seat(s) · ${money(b.price_per_seat * b.seats)} to pay the driver</p>
        ${b.status === 'pending' ? '<p class="muted small">The driver will accept or decline your request soon. You’ll get a notification.</p>' : ''}
        ${r.driver.phone ? `<p>📞 Driver: <a href="tel:${esc(r.driver.phone)}">${esc(r.driver.phone)}</a></p>` : ''}
        ${r.payment_details ? `<p>💳 Pay to: <b>${esc(r.payment_details)}</b></p>` : ''}
        <div class="actions">
          <a class="btn" href="#/chat/${b.id}">💬 Message driver</a>
          ${r.status === 'scheduled' ? `<button class="btn ghost" data-action="cancel-booking" data-id="${b.id}">Cancel booking</button>` : ''}
        </div>
      </div>`;
  } else if (r.status === 'scheduled' && !departed && r.seats_left > 0) {
    bookingSection = `
      <form id="book" class="card">
        <h3>Book seats</h3>
        <div class="row two">
          <div class="field"><label for="bseats">Seats</label><select id="bseats" name="seats">${Array.from({ length: Math.min(r.seats_left, 4) }, (_, i) => `<option>${i + 1}</option>`).join('')}</select></div>
          <div class="field"><label>Price per seat</label><input value="${money(r.your_price)}" disabled></div>
        </div>
        <div class="field"><label for="bmsg">Message to driver (optional)</label><textarea id="bmsg" name="message" maxlength="300" placeholder="e.g. I’ll have one small bag. Can you pick me up near Kalma Chowk?"></textarea></div>
        <button class="btn block" type="submit">${r.instant_book ? 'Book now' : 'Request to book'}</button>
        ${me && me.traveler_type !== 'student' && r.student_discount_pct ? `<p class="muted small" style="margin-top:8px">Students pay ${money(r.student_price)} on this ride.</p>` : ''}
      </form>`;
  } else if (r.status === 'scheduled' && !departed) {
    bookingSection = '<div class="card empty">This ride is full.</div>';
  }

  const reviewSection = (r.can_review || []).map((p) => `
    <form class="card review" data-reviewee="${p.id}">
      <h3>Rate ${esc(p.name)}</h3>
      <div class="field"><select name="rating" required>${[5, 4, 3, 2, 1].map((n) => `<option value="${n}">${stars(n)} ${n}</option>`).join('')}</select></div>
      <div class="field"><textarea name="comment" maxlength="500" placeholder="How was the trip?"></textarea></div>
      <button class="btn" type="submit">Submit review</button>
    </form>`).join('');

  page.innerHTML = `
    <p><a href="#/" data-action="back">← Back</a></p>
    <div class="card">
      <div class="ride-top">
        <div>
          <div class="route">${esc(r.from_city)} <span class="arrow">→</span> ${esc(r.to_city)}</div>
          <div class="meta"><span>💺 ${r.seats_left} of ${r.seats_total} seats left</span></div>
        </div>
        <div class="price">${money(r.your_price)}<small>per seat</small></div>
      </div>
      <div class="badges">
        ${r.status !== 'scheduled' ? `<span class="badge ${r.status}">${r.status}</span>` : ''}
        ${r.student_discount_pct ? `<span class="badge student">🎓 Students ${money(r.student_price)} (${r.student_discount_pct}% off)</span>` : ''}
        ${r.women_only ? '<span class="badge women">♀ Women only</span>' : ''}
        ${r.instant_book ? '<span class="badge">⚡ Instant booking</span>' : '<span class="badge">Driver approves requests</span>'}
      </div>
      <div class="list-row" style="margin-top:12px"><span class="muted">Departure</span><b>${when(r.departure_at)}</b></div>
      ${r.arrival_at ? `
      <div class="list-row"><span class="muted">Arrival (approx.)</span><span>${when(r.arrival_at)}</span></div>
      <div class="list-row"><span class="muted">Travel time</span><span>${duration(r.duration_minutes)}</span></div>` : ''}
      <div class="list-row"><span class="muted">Pickup</span><span>${esc(r.pickup_point || 'Ask the driver')}</span></div>
      <div class="list-row"><span class="muted">Drop-off</span><span>${esc(r.dropoff_point || 'Ask the driver')}</span></div>
      ${r.vehicle ? `<div class="list-row"><span class="muted">Vehicle</span><span>${esc(r.vehicle)}</span></div>` : ''}
      <div class="list-row"><span class="muted">Payment</span><span>${r.payment_methods.map((m) => PAY_LABEL[m]).join(', ')}</span></div>
      ${r.notes ? `<div class="list-row"><span class="muted">Notes</span><span>${esc(r.notes)}</span></div>` : ''}
    </div>
    ${me && onTrip && r.status === 'scheduled' ? `
      <div class="actions" style="margin-bottom:12px">
        <button class="btn ghost" data-action="share">📤 Share trip</button>
        <button class="btn danger" data-action="sos">🚨 SOS</button>
      </div>
      ${sosPanel(r)}` : ''}
    <div class="card">
      <h3>Driver</h3>
      ${personRow(r.driver)}
      ${r.passengers.length ? `<h3 style="margin-top:12px">Passengers</h3><p>${r.passengers.map((p) => `<a href="#/user/${p.id}">${esc(p.name)}</a>`).join(', ')}</p>` : ''}
    </div>
    ${!me && r.status === 'scheduled' && !departed ? `<a class="btn block" href="#/login?next=${encodeURIComponent(`/ride/${r.id}`)}">Log in to book</a>` : ''}
    ${me ? bookingSection : ''}
    ${reviewSection}`;

  const book = $('#book', page);
  if (book) {
    onSubmit(book, async (d) => {
      const res = await api(`/rides/${r.id}/bookings`, { method: 'POST', body: { seats: Number(d.seats), message: d.message } });
      toast(res.status === 'confirmed' ? 'Booked! Your seat is confirmed.' : 'Request sent to the driver.');
      render();
    });
  }
  const edit = $('#edit-ride', page);
  if (edit) {
    onSubmit(edit, async (d, form) => {
      await api(`/rides/${r.id}`, {
        method: 'PATCH',
        body: {
          pickup_point: d.pickup_point, dropoff_point: d.dropoff_point, vehicle: d.vehicle, notes: d.notes,
          payment_methods: checkedValues(form, 'pay'), payment_details: d.payment_details, instant_book: !!d.instant_book,
          duration_minutes: durationValue(d),
        },
      });
      toast('Ride updated. Passengers have been notified.');
      render();
    });
  }
  page.querySelectorAll('form.review').forEach((form) => onSubmit(form, async (d) => {
    await api(`/rides/${r.id}/reviews`, { method: 'POST', body: { reviewee_id: Number(form.dataset.reviewee), rating: Number(d.rating), comment: d.comment } });
    toast('Thanks for your review!');
    render();
  }));
  onClick(page, async (action, data) => {
    if (action === 'back') { history.length > 1 ? history.back() : (location.hash = '#/'); return; }
    if (action === 'share') {
      shareText(`I'm travelling ${r.from_city} → ${r.to_city} on ${when(r.departure_at)} with ${r.driver.name} via ABC Rides: ${rideUrl(r.id)}`);
      return;
    }
    if (action === 'sos') { $('#sos', page).hidden = !$('#sos', page).hidden; return; }
    if (action === 'sos-sms') {
      const loc = await currentLocationLink();
      const body = `🚨 I need help. ${data.text}${loc ? ` My location: ${loc}` : ''}`;
      location.href = `sms:${me.emergency_phone}?body=${encodeURIComponent(body)}`;
      return;
    }
    if (action === 'confirm' || action === 'reject') await api(`/bookings/${data.id}/${action}`, { method: 'POST' });
    if (action === 'cancel-booking') {
      if (!confirm('Cancel your booking?')) return;
      await api(`/bookings/${data.id}/cancel`, { method: 'POST' });
    }
    if (action === 'cancel-ride') {
      if (!confirm('Cancel this ride? All passengers will be notified.')) return;
      await api(`/rides/${r.id}/cancel`, { method: 'POST' });
    }
    if (action === 'complete') await api(`/rides/${r.id}/complete`, { method: 'POST' });
    toast('Updated');
    render();
  });
};

function currentLocationLink() {
  return new Promise((resolve) => {
    if (!navigator.geolocation) return resolve(null);
    navigator.geolocation.getCurrentPosition(
      (p) => resolve(`https://maps.google.com/?q=${p.coords.latitude.toFixed(5)},${p.coords.longitude.toFixed(5)}`),
      () => resolve(null),
      { timeout: 8000, maximumAge: 60000 },
    );
  });
}

views.offer = async (page, q) => {
  if (!requireLogin()) return;
  const start = q.date ? new Date(`${q.date}T08:00`) : new Date(Date.now() + 864e5);
  if (!q.date) start.setHours(8, 0, 0, 0);
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  page.innerHTML = `
    <h1>Offer a ride</h1>
    <p class="muted">Going between cities anyway? Fill your empty seats and share fuel and toll costs.
      See <a href="#/requests">passengers looking for rides</a>.</p>
    <form id="offer" class="card">
      ${cityOptions()}
      <div class="row two">
        <div class="field"><label for="of">From</label><input id="of" name="from_city" list="cities" value="${esc(q.from)}" required></div>
        <div class="field"><label for="ot">To</label><input id="ot" name="to_city" list="cities" value="${esc(q.to)}" required></div>
      </div>
      <div class="row two">
        <div class="field"><label for="op">Pickup point</label><input id="op" name="pickup_point" placeholder="e.g. Thokar Niaz Baig"></div>
        <div class="field"><label for="od">Drop-off point</label><input id="od" name="dropoff_point" placeholder="e.g. Faizabad"></div>
      </div>
      <div class="row three">
        <div class="field"><label for="ow">Departure</label><input id="ow" name="departure_at" type="datetime-local" value="${localInputValue(start)}" required></div>
        <div class="field"><label for="os">Seats</label><input id="os" name="seats_total" type="number" min="1" max="8" value="3" required></div>
        <div class="field"><label for="opr">Price per seat (Rs)</label><input id="opr" name="price_per_seat" type="number" min="0" step="50" value="2000" required></div>
      </div>
      ${durationFields(null)}
      <div class="row two">
        <div class="field"><label for="ov">Vehicle</label><input id="ov" name="vehicle" placeholder="e.g. Toyota Corolla, white"></div>
        <div class="field"><label for="osd">Student discount (%)</label><input id="osd" name="student_discount_pct" type="number" min="0" max="100" value="0"></div>
      </div>
      <div class="field"><label>Accepted payment</label>${paymentCheckboxes()}</div>
      <div class="field"><label for="opd">Payment account <span class="muted">(shown only to confirmed passengers)</span></label>
        <input id="opd" name="payment_details" placeholder="e.g. JazzCash 0300 1234567 (Ahmed Raza)"></div>
      <fieldset>
        <legend>Regular commute? Repeat this ride</legend>
        <p class="muted small">Pick weekdays to post the same ride for several weeks — ideal for office commutes or weekly trips home.</p>
        <div class="days field">${days.map((d, i) => `<label><input type="checkbox" name="day" value="${i}"><span>${d}</span></label>`).join('')}</div>
        <div class="field"><label for="oweeks">For how many weeks</label><select id="oweeks" name="weeks">${[1, 2, 3, 4].map((n) => `<option>${n}</option>`).join('')}</select></div>
      </fieldset>
      <div class="field"><label for="on">Notes</label><textarea id="on" name="notes" maxlength="500" placeholder="Luggage space, AC, music, smoking rules, stops on the way…"></textarea></div>
      <label class="check"><input type="checkbox" name="instant_book" value="1"> Instant booking (accept passengers automatically)</label>
      ${me.gender === 'female' ? '<label class="check"><input type="checkbox" name="women_only" value="1"> Women-only ride</label>' : ''}
      <button class="btn block" type="submit">Publish ride</button>
    </form>`;

  const form = $('#offer', page);
  // Fill in the estimated travel time when both cities are known, unless the driver typed one.
  let touched = false;
  form.dur_h.addEventListener('input', () => { touched = true; });
  form.dur_m.addEventListener('input', () => { touched = true; });
  const estimate = async () => {
    if (touched || !form.from_city.value || !form.to_city.value) return;
    const est = await api(`/route-estimate?${new URLSearchParams({ from: form.from_city.value, to: form.to_city.value })}`).catch(() => null);
    $('#dur-hint', page).textContent = est ? `Estimated ≈ ${est.distance_km} km by road. Adjust if needed.` : 'Enter how long the trip usually takes.';
    if (est) {
      form.dur_h.value = Math.floor(est.duration_minutes / 60);
      form.dur_m.value = est.duration_minutes % 60;
    }
  };
  let timer;
  const later = () => { clearTimeout(timer); timer = setTimeout(estimate, 400); };
  form.from_city.addEventListener('input', later);
  form.to_city.addEventListener('input', later);
  estimate();
  onSubmit(form, async (d) => {
    const first = new Date(d.departure_at);
    const picked = checkedValues(form, 'day').map(Number);
    let departures = [first];
    if (picked.length) {
      departures = [];
      for (let i = 0; i < Number(d.weeks) * 7; i++) {
        const day = new Date(first);
        day.setDate(first.getDate() + i);
        if (picked.includes(day.getDay())) departures.push(day);
      }
      if (!departures.length) throw new Error('No matching days in that range');
    }
    const created = await api('/rides', {
      method: 'POST',
      body: {
        from_city: d.from_city, to_city: d.to_city, pickup_point: d.pickup_point, dropoff_point: d.dropoff_point,
        departures: departures.map((x) => x.toISOString()),
        seats_total: Number(d.seats_total), price_per_seat: Number(d.price_per_seat),
        student_discount_pct: Number(d.student_discount_pct || 0), vehicle: d.vehicle, notes: d.notes,
        payment_methods: checkedValues(form, 'pay'), payment_details: d.payment_details,
        duration_minutes: durationValue(d),
        instant_book: !!d.instant_book, women_only: !!d.women_only,
      },
    });
    toast(created.length > 1 ? `Published ${created.length} rides` : 'Ride published');
    location.hash = created.length > 1 ? '#/trips?tab=driving' : `#/ride/${created[0].id}`;
  });
};

views.requests = async (page, q, sub) => {
  if (sub === 'new') return views.newRequest(page, q);
  page.innerHTML = `
    <h1>Passengers looking for rides</h1>
    <p class="muted">Driving one of these routes? Offer a ride and the passenger is notified instantly.</p>
    <form id="rq-filter" class="card">
      ${cityOptions()}
      <div class="row two">
        <div class="field"><label>From</label><input name="from" list="cities" value="${esc(q.from)}" placeholder="Any city"></div>
        <div class="field"><label>To</label><input name="to" list="cities" value="${esc(q.to)}" placeholder="Any city"></div>
      </div>
      <div class="actions"><button class="btn" type="submit">Filter</button><a class="btn ghost" href="#/requests/new">🙋 I need a ride</a></div>
    </form>
    <div id="rq-list"><p class="muted">Loading…</p></div>`;
  onSubmit($('#rq-filter', page), (d) => { location.hash = `#/requests?${new URLSearchParams({ from: d.from, to: d.to })}`; });
  const rows = await api(`/ride-requests?${new URLSearchParams({ from: q.from || '', to: q.to || '' })}`);
  $('#rq-list', page).innerHTML = rows.map((r) => requestCard(r)).join('') || '<div class="card empty">No open requests on this route.</div>';
};

views.newRequest = async (page, q) => {
  if (!requireLogin()) return;
  const date = q.date || localInputValue(new Date(Date.now() + 864e5)).slice(0, 10);
  page.innerHTML = `
    <h1>Request a ride</h1>
    <p class="muted">Tell drivers where and when you need to go. We’ll notify you as soon as a matching ride is posted.</p>
    <form id="rq" class="card">
      ${cityOptions()}
      <div class="row two">
        <div class="field"><label>From</label><input name="from_city" list="cities" value="${esc(q.from)}" required></div>
        <div class="field"><label>To</label><input name="to_city" list="cities" value="${esc(q.to)}" required></div>
      </div>
      <div class="row three">
        <div class="field"><label>Date</label><input name="date" type="date" value="${esc(date)}" required></div>
        <div class="field"><label>Leave after</label><input name="from_time" type="time" value="06:00" required></div>
        <div class="field"><label>Leave before</label><input name="to_time" type="time" value="22:00" required></div>
      </div>
      <div class="row two">
        <div class="field"><label>Seats</label><select name="seats">${[1, 2, 3, 4].map((n) => `<option ${String(q.seats) === String(n) ? 'selected' : ''}>${n}</option>`).join('')}</select></div>
        <div class="field"><label>Max price per seat (Rs, optional)</label><input name="max_price" type="number" min="0" step="50"></div>
      </div>
      <div class="field"><label>Notes</label><textarea name="notes" maxlength="300" placeholder="e.g. Flexible on time, one suitcase"></textarea></div>
      <button class="btn block" type="submit">Post request</button>
    </form>`;
  onSubmit($('#rq', page), async (d) => {
    await api('/ride-requests', {
      method: 'POST',
      body: {
        from_city: d.from_city, to_city: d.to_city, seats: Number(d.seats), notes: d.notes,
        max_price: d.max_price ? Number(d.max_price) : null,
        earliest_at: new Date(`${d.date}T${d.from_time}`).toISOString(),
        latest_at: new Date(`${d.date}T${d.to_time}`).toISOString(),
      },
    });
    toast('Request posted. We’ll notify you when a ride matches.');
    location.hash = '#/trips?tab=requests';
  });
};

views.trips = async (page, q) => {
  if (!requireLogin()) return;
  const tab = ['driving', 'requests'].includes(q.tab) ? q.tab : 'booked';
  const tabLink = (t, label) => `<a class="btn ${tab === t ? '' : 'ghost'}" href="#/trips?tab=${t}">${label}</a>`;
  page.innerHTML = `
    <h1>My trips</h1>
    <div class="tabs">${tabLink('booked', 'Booked')}${tabLink('driving', 'Driving')}${tabLink('requests', 'Requests')}</div>
    <div id="list"><p class="muted">Loading…</p></div>`;
  const list = $('#list', page);

  if (tab === 'booked') {
    const rows = await api('/me/bookings');
    list.innerHTML = rows.map((b) => `
      <a class="card" href="#/ride/${b.ride_id}">
        <div class="ride-top">
          <div>
            <div class="route">${esc(b.from_city)} <span class="arrow">→</span> ${esc(b.to_city)}</div>
            <div class="meta"><span>🕒 ${when(b.departure_at)}</span><span>🚗 ${esc(b.driver_name)}</span><span>💺 ${b.seats}</span></div>
          </div>
          <div class="price">${money(b.price_per_seat * b.seats)}<small>total</small></div>
        </div>
        <div class="badges"><span class="badge ${b.ride_status === 'scheduled' ? b.status : b.ride_status}">${b.ride_status === 'scheduled' ? b.status : `ride ${b.ride_status}`}</span></div>
      </a>`).join('') || '<div class="card empty">No bookings yet. <a href="#/">Find a ride</a></div>';
  } else if (tab === 'driving') {
    const rides = await api('/me/rides');
    list.innerHTML = rides.map((r) => `
      <a class="card" href="#/ride/${r.id}">
        <div class="ride-top">
          <div>
            <div class="route">${esc(r.from_city)} <span class="arrow">→</span> ${esc(r.to_city)}</div>
            <div class="meta"><span>🕒 ${schedule(r)}</span><span>💺 ${r.seats_total - r.seats_left}/${r.seats_total} booked</span></div>
          </div>
          <div class="price">${money(r.price_per_seat)}<small>per seat</small></div>
        </div>
        <div class="badges">
          <span class="badge ${r.status}">${r.status}</span>
          ${r.pending_requests ? `<span class="badge pending">${r.pending_requests} new request(s)</span>` : ''}
        </div>
      </a>`).join('') || '<div class="card empty">You haven’t offered any rides. <a href="#/offer">Offer one</a></div>';
  } else {
    const rows = await api('/me/ride-requests');
    list.innerHTML = `<a class="btn ghost block" href="#/requests/new" style="margin-bottom:12px">🙋 New ride request</a>`
      + (rows.map((r) => requestCard(r, { mine: true })).join('') || '<div class="card empty">No ride requests yet.</div>');
    onClick(list, async (action, data) => {
      if (action === 'close-request') {
        await api(`/ride-requests/${data.id}/close`, { method: 'POST' });
        render();
      }
    });
  }
};

views.inbox = async (page, q) => {
  if (!requireLogin()) return;
  const tab = q.tab === 'messages' ? 'messages' : 'alerts';
  page.innerHTML = `
    <h1>Inbox</h1>
    <div class="tabs">
      <a class="btn ${tab === 'alerts' ? '' : 'ghost'}" href="#/inbox">🔔 Notifications${unread.notifications ? ` (${unread.notifications})` : ''}</a>
      <a class="btn ${tab === 'messages' ? '' : 'ghost'}" href="#/inbox?tab=messages">💬 Messages${unread.messages ? ` (${unread.messages})` : ''}</a>
    </div>
    <div id="inbox-list"><p class="muted">Loading…</p></div>`;
  const list = $('#inbox-list', page);
  if (tab === 'alerts') {
    const rows = await api('/notifications');
    list.innerHTML = rows.map((n) => `
      <a class="card notif ${n.read_at ? '' : 'unread'}" href="${n.link ? `#${esc(n.link)}` : '#/inbox'}">
        <div class="ride-top"><b>${esc(n.title)}</b><span class="muted small">${timeAgo(n.created_at)}</span></div>
        ${n.body ? `<div class="small muted">${esc(n.body)}</div>` : ''}
      </a>`).join('') || '<div class="card empty">No notifications yet.</div>';
    if (rows.some((n) => !n.read_at)) {
      await api('/notifications/read-all', { method: 'POST' });
      refreshUnread();
    }
  } else {
    const rows = await api('/me/conversations');
    list.innerHTML = rows.map((c) => `
      <a class="card notif ${c.unread ? 'unread' : ''}" href="#/chat/${c.booking_id}">
        <div class="ride-top"><b>${esc(c.other_name)}</b><span class="muted small">${c.last_at ? timeAgo(c.last_at) : ''}</span></div>
        <div class="small muted">${esc(c.from_city)} → ${esc(c.to_city)} · ${when(c.departure_at)} · you’re the ${c.my_role}</div>
        <div class="small">${c.last_message ? esc(c.last_message) : '<span class="muted">No messages yet — say salaam 👋</span>'}${c.unread ? ` <span class="badge pending">${c.unread} new</span>` : ''}</div>
      </a>`).join('') || '<div class="card empty">No conversations yet. Chats open once you book a ride or receive a booking.</div>';
  }
};

views.chat = async (page, _q, bookingId) => {
  if (!requireLogin()) return;
  const data = await api(`/bookings/${bookingId}/messages`);
  const t = data.thread;
  const open = ['pending', 'confirmed'].includes(t.status) && t.ride_status !== 'cancelled';
  page.innerHTML = `
    <p><a href="#/inbox?tab=messages">← Messages</a></p>
    <div class="card chat-head">
      <b><a href="#/user/${t.other.id}">${esc(t.other.name)}</a></b>
      <div class="small muted"><a href="#/ride/${t.ride_id}">${esc(t.from_city)} → ${esc(t.to_city)}</a> · ${when(t.departure_at)} · booking ${esc(t.status)}</div>
    </div>
    <div class="chat" id="chat"></div>
    ${open ? `
    <form id="chat-form" class="chat-form">
      <input name="body" placeholder="Type a message…" autocomplete="off" maxlength="1000" required>
      <button class="btn" type="submit">Send</button>
    </form>` : '<p class="muted small">This conversation is closed.</p>'}`;
  const box = $('#chat', page);
  let lastId = 0;
  const paint = (messages) => {
    if (!messages.length && !lastId) { box.innerHTML = '<p class="muted small empty">No messages yet. Agree on pickup point, luggage or timing here.</p>'; return; }
    const fresh = messages.filter((m) => m.id > lastId);
    if (!fresh.length) return;
    if (!lastId) box.innerHTML = '';
    box.insertAdjacentHTML('beforeend', fresh.map((m) => `
      <div class="bubble ${m.sender_id === me.id ? 'mine' : ''}">${esc(m.body)}<small>${timeAgo(m.created_at)}</small></div>`).join(''));
    lastId = fresh[fresh.length - 1].id;
    box.scrollTop = box.scrollHeight;
    window.scrollTo(0, document.body.scrollHeight);
  };
  paint(data.messages);
  refreshUnread();
  const form = $('#chat-form', page);
  if (form) {
    onSubmit(form, async (d) => {
      const msg = await api(`/bookings/${bookingId}/messages`, { method: 'POST', body: { body: d.body } });
      form.reset();
      paint([msg]);
    });
  }
  pageTimers.push(setInterval(async () => {
    try { paint((await api(`/bookings/${bookingId}/messages`)).messages); } catch { /* keep polling */ }
  }, 5000));
};

function profileFields(u = {}) {
  const sel = (v, cur) => (v === cur ? 'selected' : '');
  return `
    <div class="field"><label for="pn">Full name</label><input id="pn" name="name" value="${esc(u.name)}" required></div>
    <div class="field"><label for="pp">Phone (shared only with confirmed co-travellers)</label><input id="pp" name="phone" type="tel" placeholder="+92 3xx xxxxxxx" value="${esc(u.phone)}" required></div>
    <div class="row two">
      <div class="field"><label for="pt">I am a</label><select id="pt" name="traveler_type" required>
        <option value="professional" ${sel('professional', u.traveler_type)}>💼 Working professional</option>
        <option value="student" ${sel('student', u.traveler_type)}>🎓 Student</option>
        <option value="traveler" ${sel('traveler', u.traveler_type)}>🧳 Regular traveller</option>
      </select></div>
      <div class="field"><label for="pg">Gender</label><select id="pg" name="gender">
        <option value="">Prefer not to say</option>
        <option value="female" ${sel('female', u.gender)}>Female</option>
        <option value="male" ${sel('male', u.gender)}>Male</option>
        <option value="other" ${sel('other', u.gender)}>Other</option>
      </select></div>
    </div>
    <div class="field"><label for="po">Company / university (optional)</label><input id="po" name="organization" placeholder="Helps others trust you" value="${esc(u.organization)}"></div>`;
}

views.login = async (page, q) => {
  if (me) { location.hash = '#/'; return; }
  page.innerHTML = `
    <h1>Log in</h1>
    <form id="login" class="card">
      <div class="field"><label for="le">Email</label><input id="le" name="email" type="email" autocomplete="email" required></div>
      <div class="field"><label for="lp">Password</label><input id="lp" name="password" type="password" autocomplete="current-password" required></div>
      <button class="btn block" type="submit">Log in</button>
    </form>
    <p class="muted">New here? <a href="#/register${q.next ? `?next=${encodeURIComponent(q.next)}` : ''}">Create an account</a></p>
    ${nativeApp ? '<p class="muted small">Connected to the wrong server? <a href="#" data-action="server">Change server</a></p>' : ''}`;
  onSubmit($('#login', page), async (d) => {
    const res = await api('/auth/login', { method: 'POST', body: d });
    store.token = res.token; me = res.user;
    refreshUnread();
    location.hash = `#${q.next || '/'}`;
  });
  onClick(page, (action) => { if (action === 'server') nativeApp.changeServer(); });
};

views.register = async (page, q) => {
  if (me) { location.hash = '#/'; return; }
  page.innerHTML = `
    <h1>Create your account</h1>
    <form id="register" class="card">
      ${profileFields()}
      <div class="field"><label for="re">Email</label><input id="re" name="email" type="email" autocomplete="email" required></div>
      <div class="field"><label for="rp">Password</label><input id="rp" name="password" type="password" minlength="8" autocomplete="new-password" required></div>
      <button class="btn block" type="submit">Sign up</button>
    </form>
    <p class="muted">Already have an account? <a href="#/login">Log in</a></p>`;
  onSubmit($('#register', page), async (d) => {
    const res = await api('/auth/register', { method: 'POST', body: d });
    store.token = res.token; me = res.user;
    toast(`Welcome, ${me.name.split(' ')[0]}! Verify your ID from your profile to build trust.`);
    location.hash = `#${q.next || '/'}`;
  });
};

function verificationCard(u) {
  const status = u.verification_status;
  if (status === 'verified') {
    return `<div class="card"><h3>✔ Verified</h3><p class="muted small">Your ${esc(DOC_LABEL[u.verification_doc_type])} was checked. Others see a verified badge on your profile.</p></div>`;
  }
  if (status === 'pending') {
    return `<div class="card"><h3>Verification under review ⏳</h3><p class="muted small">We’re checking your ${esc(DOC_LABEL[u.verification_doc_type])}. You’ll get a notification.</p></div>`;
  }
  return `
    <form id="verify" class="card">
      <h3>Get verified</h3>
      <p class="muted small">Upload a photo of your CNIC, student card or employee card. Verified members get more bookings. Only our team sees the photo.</p>
      ${status === 'rejected' ? `<p class="small" style="color:var(--danger)">Last upload was not approved${u.verification_note ? `: ${esc(u.verification_note)}` : ''}.</p>` : ''}
      <div class="field"><label>Document</label><select name="doc_type">
        ${Object.entries(DOC_LABEL).map(([k, v]) => `<option value="${k}" ${(k === 'student_card' && u.traveler_type === 'student') || (k === 'employee_card' && u.traveler_type === 'professional') ? 'selected' : ''}>${v}</option>`).join('')}
      </select></div>
      <div class="field"><label>Photo</label><input type="file" name="photo" accept="image/*" required></div>
      <button class="btn" type="submit">Upload for review</button>
    </form>`;
}

views.profile = async (page) => {
  if (!requireLogin()) return;
  me = await api('/me');
  page.innerHTML = `
    <h1>My profile</h1>
    <div class="card">${personRow(me)}<p class="muted small" style="margin-top:8px">${esc(me.email)}</p></div>
    ${me.role === 'admin' ? '<a class="btn block" href="#/admin" style="margin-bottom:12px">🛠 Admin panel</a>' : ''}
    ${verificationCard(me)}
    <form id="profile" class="card">
      <h3>Personal details</h3>
      ${profileFields(me)}
      <div class="field"><label for="pb">About me</label><textarea id="pb" name="bio" maxlength="500" placeholder="e.g. Commute Lahore ↔ Islamabad every weekend. Non-smoker.">${esc(me.bio)}</textarea></div>
      <h3 style="margin-top:8px">🚨 Emergency contact</h3>
      <p class="muted small">Used by the SOS button during a trip.</p>
      <div class="row two">
        <div class="field"><label>Name</label><input name="emergency_name" value="${esc(me.emergency_name)}" placeholder="e.g. Ammi"></div>
        <div class="field"><label>Phone</label><input name="emergency_phone" type="tel" value="${esc(me.emergency_phone)}" placeholder="+92 3xx xxxxxxx"></div>
      </div>
      <button class="btn block" type="submit">Save</button>
    </form>
    <details class="card">
      <summary><b>🔒 Change password</b></summary>
      <form id="password" style="margin-top:12px">
        <div class="field"><label>Current password</label><input name="current_password" type="password" autocomplete="current-password" required></div>
        <div class="field"><label>New password</label><input name="new_password" type="password" minlength="8" autocomplete="new-password" required></div>
        <button class="btn" type="submit">Update password</button>
      </form>
    </details>
    <div class="actions">
      ${nativeApp ? '<button class="btn ghost" data-action="server">🌐 Change server</button>' : ''}
      <button class="btn ghost" data-action="logout">Log out</button>
    </div>`;
  onSubmit($('#profile', page), async (d) => {
    me = await api('/me', { method: 'PATCH', body: d });
    toast('Profile saved');
    render();
  });
  onSubmit($('#password', page), async (d, form) => {
    await api('/me/password', { method: 'POST', body: d });
    form.reset();
    toast('Password changed. Other devices were signed out.');
  });
  const verify = $('#verify', page);
  if (verify) {
    onSubmit(verify, async (d, form) => {
      const file = form.photo.files[0];
      if (!file) throw new Error('Choose a photo first');
      me = await api('/me/verification', { method: 'POST', body: { doc_type: d.doc_type, image: await imageToDataUrl(file) } });
      toast('Uploaded! We’ll review it soon.');
      render();
    });
  }
  onClick(page, async (action) => {
    if (action === 'server') nativeApp.changeServer();
    if (action === 'logout') {
      await api('/auth/logout', { method: 'POST' }).catch(() => {});
      store.token = null; me = null; unread = { notifications: 0, messages: 0 };
      location.hash = '#/';
    }
  });
};

views.user = async (page, _q, id) => {
  const u = await api(`/users/${id}`);
  const canReport = me && me.id !== u.id;
  page.innerHTML = `
    <p><a href="#/" data-action="back">← Back</a></p>
    <div class="card">
      ${personRow(u)}
      ${u.verified ? `<p class="small" style="margin-top:8px">✔ ${esc(DOC_LABEL[u.verified_as] || 'ID')} verified by ABC Rides</p>` : ''}
      ${u.bio ? `<p style="margin-top:12px">${esc(u.bio)}</p>` : ''}
      <p class="muted small" style="margin-top:8px">${u.rides_driven} ride(s) driven · Member since ${new Date(u.member_since).toLocaleDateString('en-PK', { month: 'long', year: 'numeric' })}</p>
    </div>
    <h2>Reviews</h2>
    ${u.reviews.map((r) => `
      <div class="card">
        <div><span class="stars">${stars(r.rating)}</span> <b>${esc(r.reviewer_name)}</b> <span class="muted small">${new Date(r.created_at).toLocaleDateString('en-PK')}</span></div>
        ${r.comment ? `<p style="margin:6px 0 0">${esc(r.comment)}</p>` : ''}
      </div>`).join('') || '<div class="card empty">No reviews yet.</div>'}
    ${canReport ? `
    <details class="card">
      <summary class="muted">⚠️ Report ${esc(u.name)}</summary>
      <form id="report" style="margin-top:12px">
        <div class="field"><label>Reason</label><select name="reason">
          ${['Unsafe driving', 'Harassment', 'No-show', 'Fake profile', 'Asked for extra money', 'Other'].map((r) => `<option>${r}</option>`).join('')}
        </select></div>
        <div class="field"><label>What happened?</label><textarea name="details" maxlength="1000"></textarea></div>
        <button class="btn danger" type="submit">Send report</button>
      </form>
    </details>` : ''}`;
  const report = $('#report', page);
  if (report) {
    onSubmit(report, async (d, form) => {
      await api('/reports', { method: 'POST', body: { reported_user_id: u.id, reason: d.reason, details: d.details } });
      form.closest('details').open = false;
      toast('Report sent. Our team will review it.');
    });
  }
  onClick(page, (action) => { if (action === 'back') history.length > 1 ? history.back() : (location.hash = '#/'); });
};

views.admin = async (page, q) => {
  if (!requireLogin()) return;
  if (me.role !== 'admin') { page.innerHTML = '<div class="card empty">Admins only.</div>'; return; }
  const tab = ['verify', 'reports', 'users'].includes(q.tab) ? q.tab : 'overview';
  const tabLink = (t, label) => `<a class="btn small ${tab === t ? '' : 'ghost'}" href="#/admin?tab=${t}">${label}</a>`;
  page.innerHTML = `
    <h1>Admin</h1>
    <div class="tabs wrap">${tabLink('overview', 'Overview')}${tabLink('verify', 'Verifications')}${tabLink('reports', 'Reports')}${tabLink('users', 'Users')}</div>
    <div id="admin-body"><p class="muted">Loading…</p></div>`;
  const body = $('#admin-body', page);

  if (tab === 'overview') {
    const s = await api('/admin/stats');
    const sum = (o) => Object.values(o).reduce((a, b) => a + b, 0);
    const tile = (label, value, href) => `<a class="card stat" href="${href || '#/admin'}"><b>${value}</b><span>${label}</span></a>`;
    body.innerHTML = `
      <div class="stats">
        ${tile('Members', sum(s.users), '#/admin?tab=users')}
        ${tile('Rides scheduled', s.rides.scheduled || 0)}
        ${tile('Rides completed', s.rides.completed || 0)}
        ${tile('Seats booked', s.seats_booked)}
        ${tile('Pending verifications', s.pending_verifications, '#/admin?tab=verify')}
        ${tile('Open reports', s.open_reports, '#/admin?tab=reports')}
      </div>
      <div class="card"><h3>Members by type</h3>
        ${Object.entries(TYPE_LABEL).map(([k, v]) => `<div class="list-row"><span>${v}</span><b>${s.users[k] || 0}</b></div>`).join('')}
      </div>
      <div class="card"><h3>Bookings</h3>
        ${['pending', 'confirmed', 'rejected', 'cancelled'].map((k) => `<div class="list-row"><span class="badge ${k}">${k}</span><b>${s.bookings[k] || 0}</b></div>`).join('')}
        <div class="list-row"><span>Open ride requests</span><b>${s.open_requests}</b></div>
      </div>`;
  } else if (tab === 'verify') {
    const users = await api('/admin/verifications');
    body.innerHTML = users.map((u) => `
      <div class="card" data-user="${u.id}">
        <b>${esc(u.name)}</b> <span class="muted small">${esc(u.email)} · ${esc(u.phone)} · ${esc(TYPE_LABEL[u.traveler_type])}${u.organization ? ` · ${esc(u.organization)}` : ''}</span>
        <p class="small">Document: <b>${esc(DOC_LABEL[u.verification_doc_type])}</b></p>
        <img class="doc" alt="Uploaded document" data-doc="${u.id}">
        <div class="field"><input name="note" placeholder="Note to the user (if rejecting)"></div>
        <div class="actions">
          <button class="btn" data-action="approve" data-id="${u.id}">Approve</button>
          <button class="btn ghost" data-action="decline" data-id="${u.id}">Reject</button>
        </div>
      </div>`).join('') || '<div class="card empty">No pending verifications 🎉</div>';
    body.querySelectorAll('img[data-doc]').forEach(async (img) => {
      const res = await fetch(`/api/admin/users/${img.dataset.doc}/document`, { headers: { authorization: `Bearer ${store.token}` } });
      if (res.ok) img.src = URL.createObjectURL(await res.blob());
    });
    onClick(body, async (action, data) => {
      const note = body.querySelector(`[data-user="${data.id}"] input[name=note]`).value;
      await api(`/admin/users/${data.id}/verification`, { method: 'POST', body: { approve: action === 'approve', note } });
      toast(action === 'approve' ? 'Verified' : 'Rejected');
      render();
    });
  } else if (tab === 'reports') {
    const status = q.status === 'resolved' ? 'resolved' : 'open';
    const rows = await api(`/admin/reports?status=${status}`);
    body.innerHTML = `
      <div class="tabs"><a class="btn small ${status === 'open' ? '' : 'ghost'}" href="#/admin?tab=reports">Open</a><a class="btn small ${status === 'resolved' ? '' : 'ghost'}" href="#/admin?tab=reports&status=resolved">Resolved</a></div>
      ${rows.map((r) => `
      <div class="card" data-report="${r.id}">
        <b>${esc(r.reason)}</b> <span class="muted small">${timeAgo(r.created_at)}</span>
        <p class="small"><a href="#/user/${r.reporter_id}">${esc(r.reporter_name)}</a> reported <a href="#/user/${r.reported_user_id}">${esc(r.reported_name)}</a>${r.reported_suspended ? ' <span class="badge cancelled">suspended</span>' : ''}</p>
        ${r.details ? `<p class="small">“${esc(r.details)}”</p>` : ''}
        ${r.resolution ? `<p class="small muted">Resolution: ${esc(r.resolution)}</p>` : ''}
        ${status === 'open' ? `
        <div class="field"><input name="resolution" placeholder="Resolution note"></div>
        <div class="actions">
          <button class="btn small" data-action="resolve" data-id="${r.id}">Mark resolved</button>
          <button class="btn small danger" data-action="suspend" data-user="${r.reported_user_id}" data-suspended="${r.reported_suspended ? 0 : 1}">${r.reported_suspended ? 'Unsuspend' : 'Suspend'} ${esc(r.reported_name)}</button>
        </div>` : ''}
      </div>`).join('') || '<div class="card empty">Nothing here.</div>'}`;
    onClick(body, async (action, data) => {
      if (action === 'resolve') {
        const resolution = body.querySelector(`[data-report="${data.id}"] input[name=resolution]`).value;
        await api(`/admin/reports/${data.id}/resolve`, { method: 'POST', body: { resolution } });
      }
      if (action === 'suspend') await api(`/admin/users/${data.user}/suspend`, { method: 'POST', body: { suspended: data.suspended === '1' } });
      toast('Updated');
      render();
    });
  } else {
    const users = await api(`/admin/users?q=${encodeURIComponent(q.q || '')}`);
    body.innerHTML = `
      <form id="user-search" class="card"><div class="actions"><input name="q" value="${esc(q.q)}" placeholder="Name, email or phone" style="flex:1"><button class="btn" type="submit">Search</button></div></form>
      ${users.map((u) => `
      <div class="card">
        <div class="ride-top">
          <div><a href="#/user/${u.id}"><b>${esc(u.name)}</b></a> ${u.role === 'admin' ? '<span class="badge">admin</span>' : ''}
            <div class="small muted">${esc(u.email)} · ${esc(u.phone)} · ${esc(TYPE_LABEL[u.traveler_type])}</div>
            <div class="badges">
              <span class="badge ${u.verification_status === 'verified' ? 'confirmed' : u.verification_status === 'pending' ? 'pending' : ''}">${u.verification_status === 'none' ? 'not verified' : u.verification_status}</span>
              ${u.suspended ? '<span class="badge cancelled">suspended</span>' : ''}
            </div>
          </div>
          ${u.role !== 'admin' ? `<button class="btn small ${u.suspended ? '' : 'danger'}" data-action="suspend" data-user="${u.id}" data-suspended="${u.suspended ? 0 : 1}">${u.suspended ? 'Unsuspend' : 'Suspend'}</button>` : ''}
        </div>
      </div>`).join('') || '<div class="card empty">No users found.</div>'}`;
    onSubmit($('#user-search', body), (d) => { location.hash = `#/admin?tab=users&q=${encodeURIComponent(d.q)}`; });
    onClick(body, async (action, data) => {
      if (action !== 'suspend') return;
      if (data.suspended === '1' && !confirm('Suspend this user? They will be logged out everywhere.')) return;
      await api(`/admin/users/${data.user}/suspend`, { method: 'POST', body: { suspended: data.suspended === '1' } });
      toast('Updated');
      render();
    });
  }
};

// ---- Router -----------------------------------------------------------------

function parseHash() {
  const [path, query = ''] = location.hash.slice(1).split('?');
  const parts = (path || '/').split('/').filter(Boolean);
  return { name: parts[0] || 'home', id: parts[1], query: Object.fromEntries(new URLSearchParams(query)) };
}

const NAV_GROUP = { search: 'home', requests: 'offer', register: 'login', chat: 'inbox', admin: 'profile', user: 'home', ride: 'trips' };

function renderNav(active) {
  const total = unread.notifications + unread.messages;
  const links = [
    ['home', '#/', '🔍', 'Find'],
    ['offer', '#/offer', '➕', 'Offer'],
    ['trips', '#/trips', '🧭', 'Trips'],
    ['inbox', '#/inbox', '🔔', 'Inbox', total],
    me ? ['profile', '#/profile', '👤', 'Profile'] : ['login', '#/login', '👤', 'Log in'],
  ];
  const group = NAV_GROUP[active] || active;
  const badge = (n) => (n ? `<i class="dot">${n > 9 ? '9+' : n}</i>` : '');
  $('#nav').innerHTML = links.map(([n, href, , label, count]) => `<a href="${href}" class="${n === group ? 'active' : ''}">${label}${badge(count)}</a>`).join('');
  $('#tabbar').innerHTML = links.map(([n, href, icon, label, count]) => `<a href="${href}" class="${n === group ? 'active' : ''}"><span>${icon}${badge(count)}</span>${label}</a>`).join('');
}

async function refreshUnread() {
  if (!me) return;
  try {
    const next = await api('/notifications/unread-count');
    unread = next;
    renderNav(parseHash().name);
  } catch { /* offline; try again later */ }
}

async function render() {
  pageTimers.forEach(clearInterval);
  pageTimers = [];
  const { name, id, query } = parseHash();
  const view = $('#view');
  // A fresh element per render so listeners from the previous page are dropped.
  const page = document.createElement('div');
  view.replaceChildren(page);
  const fn = views[name] || views.home;
  renderNav(name);
  try {
    await fn(page, query, id);
  } catch (err) {
    // Signed out elsewhere, suspended or session expired: go to the login screen.
    if (err.status === 401 && name !== 'login') {
      toast('Please log in again', true);
      location.hash = `#/login?next=${encodeURIComponent(location.hash.slice(1))}`;
      return;
    }
    page.innerHTML = `<div class="card empty"><p>${esc(err.message)}</p><a class="btn" href="#/">Go home</a></div>`;
  }
  renderNav(parseHash().name);
}

window.addEventListener('hashchange', () => { render(); window.scrollTo(0, 0); });

(async function init() {
  [cities] = await Promise.all([
    api('/cities').catch(() => []),
    store.token ? api('/me').then((u) => { me = u; }).catch(() => { store.token = null; }) : null,
  ]);
  render();
  refreshUnread();
  setInterval(refreshUnread, 30000);
})();
