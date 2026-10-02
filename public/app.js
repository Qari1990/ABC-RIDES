'use strict';

// ---- State & API ------------------------------------------------------------

const store = {
  get token() { try { return localStorage.getItem('token'); } catch { return null; } },
  set token(v) { try { v ? localStorage.setItem('token', v) : localStorage.removeItem('token'); } catch { /* private mode */ } },
};
let me = null;
let cities = [];
// Admin policy: fees, booking mode, onboarding requirements (GET /api/settings).
let settings = {};
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
    err.code = data && data.code;
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
const roundFare = (n) => Math.max(10, Math.round(n / 10) * 10);
function haversineKm(lat1, lon1, lat2, lon2) {
  const rad = (d) => (d * Math.PI) / 180;
  const h = Math.sin(rad(lat2 - lat1) / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(rad(lon2 - lon1) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}
// "31.52, 74.35", or a Google Maps link containing @31.52,74.35 or q=31.52,74.35.
function parseLocation(text) {
  const m = String(text || '').match(/(-?\d{1,2}\.\d+)\s*,\s*(-?\d{1,3}\.\d+)/);
  return m ? { lat: Number(m[1]), lon: Number(m[2]) } : null;
}
const mapLink = (lat, lon) => `https://maps.google.com/?q=${lat},${lon}`;
const segmentQuery = (seg) => (seg ? `?board=${seg.board}&alight=${seg.alight}` : '');
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
    try { await handler(formData(form), form); } catch (err) { handleError(err); } finally { if (btn) btn.disabled = false; }
  });
}

function onClick(el, handler) {
  el.addEventListener('click', async (e) => {
    const target = e.target.closest('[data-action]');
    if (!target) return;
    e.preventDefault();
    target.disabled = true;
    try { await handler(target.dataset.action, target.dataset, target); } catch (err) { handleError(err); } finally { target.disabled = false; }
  });
}

// Shows the error and, when a setup step is missing, takes the user to it.
const SETUP_STEP = {
  phone_unverified: '/verify-phone', id_required: '/verify-id', driver_required: '/driver', insufficient_balance: '/wallet',
};
function handleError(err) {
  // Our own messages ("Choose a drop-off stop...") are not bugs; crashes and server errors are.
  if (err instanceof TypeError || err instanceof ReferenceError || err instanceof RangeError || err.status >= 500) {
    reportError(err.message, err.stack);
  }
  toast(err.message, true);
  const step = SETUP_STEP[err.code];
  if (step) setTimeout(() => { location.hash = `#${step}?next=${encodeURIComponent(location.hash.slice(1))}`; }, 1500);
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

// A photo picker with a preview. bindPhotos collects the chosen photos (resized) by field name.
function photoField(name, label, { hint = 'Tap to take or choose a photo', capture = '' } = {}) {
  return `
    <div class="field photo-field">
      <span class="label">${label}</span>
      <label class="photo-drop">
        <input type="file" accept="image/*" name="${name}" ${capture ? `capture="${capture}"` : ''} hidden>
        <img alt="" hidden>
        <span>📷 ${hint}</span>
      </label>
    </div>`;
}

function bindPhotos(form) {
  const photos = {};
  form.querySelectorAll('.photo-field input[type=file]').forEach((input) => {
    input.addEventListener('change', async () => {
      const file = input.files[0];
      if (!file) return;
      try {
        photos[input.name] = await imageToDataUrl(file);
        const box = input.parentElement;
        box.querySelector('img').src = photos[input.name];
        box.querySelector('img').hidden = false;
        box.querySelector('span').textContent = '✔ Tap to change';
      } catch {
        toast('Could not read that photo. Please try another one.', true);
      }
    });
  });
  return photos;
}

function requirePhotos(photos, names) {
  const labels = { cnic_front: 'CNIC front', cnic_back: 'CNIC back', selfie: 'selfie', licence_photo: 'driving licence',
    vehicle_photo: 'vehicle photo', registration_photo: 'registration (vehicle book)', student_card: 'student card' };
  const missing = names.filter((n) => !photos[n]);
  if (missing.length) throw new Error(`Please add a photo of your ${missing.map((n) => labels[n] || n).join(', ')}`);
}

// 3520212345671 -> 35202-1234567-1 as the user types.
function formatCnicInput(input) {
  input.addEventListener('input', () => {
    const d = input.value.replace(/\D/g, '').slice(0, 13);
    input.value = [d.slice(0, 5), d.slice(5, 12), d.slice(12)].filter(Boolean).join('-');
  });
}

function shareText(text) {
  if (nativeApp && nativeApp.share) { nativeApp.share(text); return; }
  if (navigator.share) { navigator.share({ text }).catch(() => {}); return; }
  window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, '_blank');
}

// ---- Components -------------------------------------------------------------

const verifiedBadge = (u) => (u.verified ? ' <span class="verified" title="ID verified">✔ Verified</span>' : '')
  + (u.approved_driver ? ' <span class="verified" title="Licence and vehicle checked">🚗 Approved driver</span>' : '')
  + (u.student_verified ? ' <span class="verified" title="Student card checked">🎓</span>' : '');
const reliabilityText = (u) => (u.reliability != null ? ` · <span title="Drops when trips are cancelled">${u.reliability}% reliable</span>` : '');

// Estimated time at a stop, spreading the travel time over the kilometres.
function timeAtStop(r, idx) {
  const last = r.stops && r.stops[r.stops.length - 1];
  if (!r.duration_minutes || !last || !last.km || r.stops[idx].km == null) return idx ? r.arrival_at : r.departure_at;
  return new Date(new Date(r.departure_at).getTime() + (r.duration_minutes * 60000 * r.stops[idx].km) / last.km).toISOString();
}

function rideCard(r) {
  const seg = r.segment || { board: 0, alight: (r.stops || []).length - 1, from: r.pickup_point || r.from_city, to: r.dropoff_point || r.to_city };
  const stopCity = (i, fallback) => (r.stops && r.stops[i] ? r.stops[i].city : fallback);
  const startAt = r.stops ? timeAtStop(r, seg.board) : r.departure_at;
  const endAt = r.stops ? timeAtStop(r, seg.alight) : r.arrival_at;
  const tags = [
    r.student_discount_pct > 0 && `<span class="badge student">🎓 ${r.student_discount_pct}% student discount</span>`,
    r.women_only && '<span class="badge women">♀ Women only</span>',
    r.instant_book && '<span class="badge brand">⚡ Instant booking</span>',
    (r.home_pickup || r.home_drop) && `<span class="badge">🏠 Home ${[r.home_pickup && 'pickup', r.home_drop && 'drop'].filter(Boolean).join(' & ')}</span>`,
    r.stops && r.stops.length > 2 && `<span class="badge">🛑 ${r.stops.length - 2} stop(s) on the way</span>`,
  ].filter(Boolean);
  return `
  <a class="card ride-card" href="#/ride/${r.id}${segmentQuery(r.segment)}">
    <div class="ride-top">
      <div class="meta" style="margin:0 0 10px"><span>${icon('calendar')} ${new Date(r.departure_at).toLocaleDateString('en-PK', { weekday: 'short', day: 'numeric', month: 'short' })}</span>
        ${r.duration_minutes ? `<span>${icon('clock')} ${duration(r.duration_minutes)}</span>` : ''}${seg.km ? `<span>${icon('route')} ${seg.km} km</span>` : ''}
        ${r.stops && (seg.board > 0 || seg.alight < r.stops.length - 1) ? `<span>${icon('car')} part of ${esc(r.from_city)} → ${esc(r.to_city)} ride</span>` : ''}</div>
      <div class="price">${money(r.your_price ?? r.price_per_seat)}<small>per seat${seg.km ? ` · Rs ${((r.your_price ?? r.price_per_seat) / seg.km).toFixed(1)}/km` : ''}</small></div>
    </div>
    <div class="trip">
      <span class="t">${clock(startAt)}</span><span class="rail"><i></i><b></b></span>
      <span class="place">${esc(stopCity(seg.board, r.from_city))}<small>${esc(seg.from)}</small></span><span></span>
      <span class="t">${endAt ? clock(endAt) : ''}</span><span class="rail"><i class="end"></i></span>
      <span class="place">${esc(stopCity(seg.alight, r.to_city))}<small>${esc(seg.to)}</small></span><span></span>
    </div>
    ${tags.length ? `<div class="badges">${tags.join('')}</div>` : ''}
    <div class="ride-foot">
      <span class="who"><span class="mini-avatar">${esc(initials(r.driver.name))}</span><span>${esc(r.driver.name)}${r.driver.verified ? ' ✔' : ''}</span>
        ${r.driver.rating_avg ? `<span class="stars">★</span>${r.driver.rating_avg}` : ''}</span>
      <span class="seats-left">${icon('armchair')} ${r.seats_left} left</span>
    </div>
  </a>`;
}

function requestCard(r, { mine = false } = {}) {
  const day = new Date(r.earliest_at);
  const offerParams = new URLSearchParams({ from: r.from_city, to: r.to_city, date: localInputValue(day).slice(0, 10) });
  if (r.from_place) offerParams.set('pickup', r.from_place.id);
  if (r.to_place) offerParams.set('drop', r.to_place.id);
  const point = (p, label) => (p
    ? `<div class="small">📍 ${label}: <b>${esc(p.name)}</b>, ${esc(p.city)} · <a href="${mapLink(p.lat, p.lon)}" target="_blank" rel="noopener">map</a></div>`
    : `<div class="small muted">📍 ${label}: anywhere in the city</div>`);
  return `
  <div class="card">
    <div class="ride-top">
      <div>
        <div class="route">${esc(r.from_city)} <span class="arrow">→</span> ${esc(r.to_city)}</div>
        <div class="meta"><span>📅 ${when(r.earliest_at)} – ${new Date(r.latest_at).toLocaleTimeString('en-PK', { hour: 'numeric', minute: '2-digit' })}</span><span>💺 ${r.seats}</span></div>
      </div>
      ${r.max_price ? `<div class="price">≤ ${money(r.max_price)}<small>per seat</small></div>` : ''}
    </div>
    <div class="request-points">${point(r.from_place, 'Pickup')}${point(r.to_place, 'Drop-off')}</div>
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
      <div class="small">${u.rating_avg ? `<span class="stars">${stars(u.rating_avg)}</span> ${u.rating_avg} (${u.rating_count})` : '<span class="muted">No reviews yet</span>'}${reliabilityText(u)}${extra}</div>
    </div>
  </a>`;
}

// The search card: where from/to (with a swap button), when, how many seats.
function searchForm(q = {}, { compact = false } = {}) {
  const today = localInputValue(new Date()).slice(0, 10);
  const tomorrow = localInputValue(new Date(Date.now() + 864e5)).slice(0, 10);
  const seats = Math.max(1, Math.min(4, Number(q.seats) || 1));
  return `
  <form id="search" class="card search-card">
    ${cityOptions()}
    <div class="where">
      <label class="leg" for="from">${icon('circle-dot')}<span style="flex:1"><small>From</small>
        <input id="from" name="from" list="cities" placeholder="Leaving from" value="${esc(q.from)}" autocomplete="off" required></span></label>
      <label class="leg" for="to">${icon('map-pin')}<span style="flex:1"><small>To</small>
        <input id="to" name="to" list="cities" placeholder="Going to" value="${esc(q.to)}" autocomplete="off" required></span></label>
      <button type="button" class="swap" data-action="swap" aria-label="Swap cities">${icon('arrow-up-down')}</button>
    </div>
    <div class="quick-chips" role="group" aria-label="Date">
      <button type="button" data-date="" class="${!q.date ? 'on' : ''}">Any day</button>
      <button type="button" data-date="${today}" class="${q.date === today ? 'on' : ''}">Today</button>
      <button type="button" data-date="${tomorrow}" class="${q.date === tomorrow ? 'on' : ''}">Tomorrow</button>
      <button type="button" data-date="pick" class="${q.date && q.date !== today && q.date !== tomorrow ? 'on' : ''}">${icon('calendar')} Pick date</button>
    </div>
    <div class="field" id="date-field" ${q.date && q.date !== today && q.date !== tomorrow ? '' : 'hidden'}>
      <input id="date" name="date" type="date" min="${today}" value="${esc(q.date || '')}" aria-label="Date"></div>
    <div class="inline-fields">
      <div class="field"><span class="label">Seats</span>
        <div class="stepper"><button type="button" data-action="seat-minus" aria-label="Fewer seats">${icon('minus')}</button>
          <output id="seats-out">${seats}</output><input type="hidden" id="seats" name="seats" value="${seats}">
          <button type="button" data-action="seat-plus" aria-label="More seats">${icon('plus')}</button></div></div>
      <div class="field"><label for="time">Time</label><select id="time" name="time">
        <option value="">Any time</option>
        ${Object.entries(TIME_SLOTS).map(([k, [label]]) => `<option value="${k}" ${q.time === k ? 'selected' : ''}>${label}</option>`).join('')}
      </select></div>
    </div>
    <label class="check"><input type="checkbox" name="women_only" value="true" ${q.women_only === 'true' ? 'checked' : ''}> Women-only rides</label>
    <button class="btn block lg" type="submit">${icon('search')} ${compact ? 'Search again' : 'Find a ride'}</button>
  </form>`;
}

function bindSearch(page) {
  const form = $('#search', page);
  form.addEventListener('click', (e) => {
    const chip = e.target.closest('[data-date]');
    if (chip) {
      form.querySelectorAll('[data-date]').forEach((b) => b.classList.toggle('on', b === chip));
      const pick = chip.dataset.date === 'pick';
      $('#date-field', form).hidden = !pick;
      if (!pick) form.date.value = chip.dataset.date;
      else form.date.focus();
      return;
    }
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    if (btn.dataset.action === 'swap') [form.from.value, form.to.value] = [form.to.value, form.from.value];
    if (btn.dataset.action.startsWith('seat-')) {
      const n = Math.max(1, Math.min(4, Number(form.seats.value) + (btn.dataset.action === 'seat-plus' ? 1 : -1)));
      form.seats.value = n;
      $('#seats-out', form).textContent = n;
    }
  });
  onSubmit(form, (d) => {
    const params = new URLSearchParams({ from: d.from.trim(), to: d.to.trim(), date: d.date || '', seats: d.seats });
    if (d.time) params.set('time', d.time);
    if (d.women_only) params.set('women_only', 'true');
    location.hash = `#/search?${params}`;
  });
}

const skeletons = (n = 3) => Array.from({ length: n }, () => '<div class="skeleton"></div>').join('');

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
  const first = me ? me.name.split(' ')[0] : null;
  page.innerHTML = `
    <section class="hero">
      <div class="segmented"><a class="on" href="#/">${icon('search')} Find a ride</a><a href="#/offer">${icon('car')} Offer a ride</a></div>
      <h1>${first ? `Where to, ${esc(first)}?` : 'Share the ride between cities'}</h1>
      <p>Travel with verified commuters, students and regular travellers. Pay only for your seat.</p>
    </section>
    ${searchForm()}
    <div class="audiences">
      <div><b>${icon('briefcase')}</b>Office commuters</div>
      <div><b>${icon('graduation-cap')}</b>Students</div>
      <div><b>${icon('shield-check')}</b>Verified drivers</div>
    </div>
    <div class="row two quick">
      <a class="btn ghost" href="#/offer">${icon('car')} Offer your empty seats</a>
      <a class="btn ghost" href="#/requests">${icon('hand')} Passengers looking for rides</a>
    </div>
    <div class="section-head"><h2>Upcoming rides</h2><a class="small" href="#/requests">Ride requests</a></div>
    <div id="upcoming">${skeletons(3)}</div>
    ${nativeApp ? '' : `<p class="small muted legal-links"><a href="download.html">${icon('phone')} Get the Android app</a> · <a href="privacy.html">Privacy</a> · <a href="terms.html">Terms</a></p>`}`;
  bindSearch(page);
  const rides = await api('/rides');
  $('#upcoming', page).innerHTML = rides.length
    ? rides.slice(0, 10).map(rideCard).join('')
    : `<div class="card empty">${icon('car', 'i-big')}<h2>No rides yet</h2><p>Be the first to <a href="#/offer">offer one</a>.</p></div>`;
};

views.search = async (page, q) => {
  page.innerHTML = `${searchForm(q, { compact: true })}<div id="results">${skeletons(3)}</div>`;
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

views.ride = async (page, q, id) => {
  const qs = new URLSearchParams(Object.entries({ board: q.board, alight: q.alight, from: q.from, to: q.to }).filter(([, v]) => v != null));
  const [r] = await Promise.all([api(`/rides/${id}?${qs}`), refreshMe()]);
  const stopsKnown = r.stops.every((st) => st.km != null);
  const lastStop = r.stops.length - 1;
  const stopName = (i) => {
    const st = r.stops[i ?? 0];
    return st ? esc(st.name.toLowerCase().includes(String(st.city).toLowerCase()) ? st.name : `${st.name}, ${st.city}`) : '';
  };
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
          <span class="muted small">· ${esc(TYPE_LABEL[x.passenger_type])} · ${x.passenger_reliability}% reliable · ${x.seats} seat(s) · ${money(x.price_per_seat * x.seats + x.home_charge)}</span>
          <div class="small">📍 ${stopName(x.board_stop)} → ${stopName(x.alight_stop ?? lastStop)}${x.segment_km ? ` · ${x.segment_km} km` : ''}</div>
          ${x.home_pickup ? `<div class="small">🏠 Pick up from: ${esc(x.home_pickup.address)} (${x.home_pickup.km} km) · <a href="${mapLink(x.home_pickup.lat, x.home_pickup.lon)}" target="_blank" rel="noopener">map</a> · +${money(x.home_pickup.charge)}</div>` : ''}
          ${x.home_drop ? `<div class="small">🏠 Drop at: ${esc(x.home_drop.address)} (${x.home_drop.km} km) · <a href="${mapLink(x.home_drop.lat, x.home_drop.lon)}" target="_blank" rel="noopener">map</a> · +${money(x.home_drop.charge)}</div>` : ''}
          ${x.message ? `<div class="small">“${esc(x.message)}”</div>` : ''}
          ${x.passenger_phone ? `<div class="small">📞 <a href="tel:${esc(x.passenger_phone)}">${esc(x.passenger_phone)}</a></div>` : ''}
          ${x.status === 'pending' && x.sharing_discount_pct ? `<div class="small">🎉 ${x.sharing_discount_pct}% commission discount for sharing your car</div>` : ''}
          ${x.status === 'confirmed' && x.commission_discount_pct ? `<div class="small muted">Commission ${money(x.driver_fee)} (${x.commission_discount_pct}% sharing discount)</div>` : ''}
        </div>
        <div class="actions">
          <span class="badge ${x.status}">${x.status}</span>
          ${['pending', 'confirmed'].includes(x.status) ? `<a class="btn small ghost" href="#/chat/${x.id}">💬 Chat</a>` : ''}
          ${x.status === 'pending' && r.status === 'scheduled' ? `
            <button class="btn small" data-action="confirm" data-id="${x.id}">Accept${x.driver_fee_preview ? ` · fee ${money(x.driver_fee_preview)}` : ''}</button>
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
          ${stopsKnown ? '<p class="small muted">The route and stops stay fixed once posted, so passengers can rely on them.</p>' : `
          <div class="row two">
            <div class="field"><label>Pickup point</label><input name="pickup_point" value="${esc(r.pickup_point)}"></div>
            <div class="field"><label>Drop-off point</label><input name="dropoff_point" value="${esc(r.dropoff_point)}"></div>
          </div>`}
          <div class="field"><label>Vehicle</label><input name="vehicle" value="${esc(r.vehicle)}"></div>
          ${durationFields(r.duration_minutes)}
          <div class="field"><label>Payment methods</label>${paymentCheckboxes(r.payment_methods)}</div>
          <div class="field"><label>Payment account details</label><input name="payment_details" value="${esc(r.payment_details)}" placeholder="e.g. JazzCash 0300 1234567 (Ahmed Raza)"></div>
          <div class="field"><label>Notes</label><textarea name="notes" maxlength="500">${esc(r.notes)}</textarea></div>
          ${settings.booking_mode === 'driver_choice' ? `<label class="check"><input type="checkbox" name="instant_book" value="1" ${r.instant_book ? 'checked' : ''}> Instant booking</label>` : ''}
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
        <p>📍 ${stopName(b.board_stop)} → ${stopName(b.alight_stop ?? lastStop)}${b.segment_km ? ` · ${b.segment_km} km` : ''}</p>
        ${b.home_pickup ? `<p class="small">🏠 Home pickup: ${esc(b.home_pickup.address)} (+${money(b.home_pickup.charge)})</p>` : ''}
        ${b.home_drop ? `<p class="small">🏠 Home drop: ${esc(b.home_drop.address)} (+${money(b.home_drop.charge)})</p>` : ''}
        <p>${b.seats} seat(s) · <b>${money(b.price_per_seat * b.seats + b.home_charge)}</b> to pay the driver</p>
        ${!b.home_pickup && r.stops[b.board_stop ?? 0] && r.stops[b.board_stop ?? 0].lat != null ? `<p><a class="btn small ghost" href="${directions(r.stops[b.board_stop ?? 0].lat, r.stops[b.board_stop ?? 0].lon)}" target="_blank" rel="noopener">🧭 Directions to ${stopName(b.board_stop)}</a></p>` : ''}
        ${b.status === 'pending' ? '<p class="muted small">The driver will accept or decline your request soon. You’ll get a notification.</p>' : ''}
        ${r.driver.phone ? `<p>📞 Driver: <a href="tel:${esc(r.driver.phone)}">${esc(r.driver.phone)}</a></p>` : ''}
        ${r.payment_details ? `<p>💳 Pay to: <b>${esc(r.payment_details)}</b></p>` : ''}
        ${r.vehicle_plate ? `<p class="plate-note">🚘 Car: <b>${esc(r.vehicle || '')}</b>, plate <b class="plate">${esc(r.vehicle_plate)}</b>. Check the plate before you get in.</p>` : ''}
        ${b.passenger_fee ? `<p class="muted small">Booking fee paid: ${money(b.passenger_fee)}</p>` : ''}
        <div class="actions">
          <a class="btn" href="#/chat/${b.id}">💬 Message driver</a>
          ${r.status === 'scheduled' ? `<button class="btn ghost" data-action="cancel-booking" data-id="${b.id}">Cancel booking</button>` : ''}
        </div>
      </div>`;
  } else if (r.status === 'scheduled' && !departed && r.seats_left > 0) {
    bookingSection = `
      <form id="book" class="card">
        <h3>Book seats</h3>
        ${r.stops.length > 2 ? `
        <div class="row two">
          <div class="field"><label for="bboard">Get on at</label><select id="bboard" name="board_stop">${r.stops.slice(0, -1).map((st, i) => `<option value="${i}" ${i === r.segment.board ? 'selected' : ''}>${esc(st.name)}, ${esc(st.city)}</option>`).join('')}</select></div>
          <div class="field"><label for="balight">Get off at</label><select id="balight" name="alight_stop">${r.stops.map((st, i) => (i ? `<option value="${i}" ${i === r.segment.alight ? 'selected' : ''}>${esc(st.name)}, ${esc(st.city)}</option>` : '')).join('')}</select></div>
        </div>` : ''}
        <div class="row two">
          <div class="field"><label for="bseats">Seats</label><select id="bseats" name="seats">${Array.from({ length: Math.min(r.seats_left, 4) }, (_, i) => `<option>${i + 1}</option>`).join('')}</select></div>
          <div class="field"><label>Price per seat</label><input id="seat-price" value="${money(r.your_price)}" disabled></div>
        </div>
        ${['pickup', 'drop'].filter((k) => r[`home_${k}`]).map((k) => `
        <div class="home-opt">
          <label class="check"><input type="checkbox" name="want_${k}" value="1"><span>🏠 ${k === 'pickup' ? 'Pick me up from home' : 'Drop me at home'}
            <span class="muted small" style="display:block">Within ${r.home_radius_km} km of the ${k === 'pickup' ? 'pickup' : 'drop-off'} point · ${money(settings.home_pickup_per_km)}/km, min ${money(settings.home_pickup_min)}</span></span></label>
          <div class="home-fields" data-kind="${k}" hidden>
            <div class="field"><input name="${k}_address" placeholder="House/street and a landmark"></div>
            <p class="small muted" style="margin:0">Tap your home on the map${k === 'pickup' ? ', use your current location,' : ''} or paste a Google Maps link.</p>
            <div class="map small" data-map="${k}"></div>
            <div class="actions">
              ${k === 'pickup' ? '<button class="btn small ghost" type="button" data-action="locate">📍 Use my current location</button>' : ''}
              <input name="${k}_loc" placeholder="Google Maps link or coordinates" style="flex:1;min-width:200px">
            </div>
            <p class="small muted home-note"></p>
          </div>
        </div>`).join('')}
        <div class="field"><label for="bmsg">Message to driver (optional)</label><textarea id="bmsg" name="message" maxlength="300" placeholder="e.g. I’ll have one small bag. Can you pick me up near Kalma Chowk?"></textarea></div>
        <div class="fee-box" id="fee-box"></div>
        <button class="btn block" type="submit">${r.instant_book ? 'Book now' : 'Request to book'}</button>
        ${me && me.traveler_type === 'student' && !me.student_verified && settings.student_price_requires_verification && r.student_discount_pct
    ? `<p class="small" style="margin-top:8px">🎓 Students pay ${money(r.student_price)}. <a href="#/verify-id">Verify your student card</a> to get this price.</p>`
    : me && me.traveler_type !== 'student' && r.student_discount_pct ? `<p class="muted small" style="margin-top:8px">Students pay ${money(r.student_price)} on this ride.</p>` : ''}
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
        ${r.student_discount_pct ? `<span class="badge student">🎓 Students ${money(r.segment ? r.segment.student_fare : r.student_price)} (${r.student_discount_pct}% off)</span>` : ''}
        ${r.women_only ? '<span class="badge women">♀ Women only</span>' : ''}
        ${r.instant_book ? '<span class="badge">⚡ Instant booking</span>' : '<span class="badge">Driver approves requests</span>'}
      </div>
      <div class="list-row" style="margin-top:12px"><span class="muted">Departure</span><b>${when(r.departure_at)}</b></div>
      ${r.arrival_at ? `
      <div class="list-row"><span class="muted">Arrival (approx.)</span><span>${when(r.arrival_at)}</span></div>
      <div class="list-row"><span class="muted">Travel time</span><span>${duration(r.duration_minutes)}</span></div>` : ''}
      ${stopsKnown ? `
      <div class="stops">${r.stops.map((st, i) => {
    const at = r.duration_minutes && r.stops[lastStop].km ? new Date(new Date(r.departure_at).getTime() + (r.duration_minutes * 60000 * st.km) / r.stops[lastStop].km) : null;
    const on = i >= r.segment.board && i <= r.segment.alight;
    return `<div class="stop ${on ? 'on' : ''}"><span class="dot"></span><div><b>${esc(st.name)}</b>, ${esc(st.city)}
          <div class="muted small">${st.km} km${at ? ` · ~${clock(at.toISOString())}` : ''}${i === r.segment.board && r.segment.board ? ' · you get on' : ''}${i === r.segment.alight && r.segment.alight < lastStop ? ' · you get off' : ''}</div></div></div>`;
  }).join('')}</div>
      <div class="map" id="ride-map" role="img" aria-label="Map of the route"></div>
      <p class="small muted map-note">Tap a stop for Google Maps and directions.</p>
      <p class="small muted">Rs ${r.fare_per_km}/km per seat · bus ≈ Rs ${settings.ref_bus_per_km}/km · private car ≈ Rs ${settings.ref_private_car_per_km}/km for the whole car.</p>
      ${r.home_pickup || r.home_drop ? `<p class="small">🏠 Home ${[r.home_pickup && 'pickup', r.home_drop && 'drop-off'].filter(Boolean).join(' & ')} within ${r.home_radius_km} km.</p>` : ''}` : `
      <div class="list-row"><span class="muted">Pickup</span><span>${esc(r.pickup_point || 'Ask the driver')}</span></div>
      <div class="list-row"><span class="muted">Drop-off</span><span>${esc(r.dropoff_point || 'Ask the driver')}</span></div>`}
      ${r.vehicle ? `<div class="list-row"><span class="muted">Vehicle</span><span>${esc(r.vehicle)}</span></div>` : ''}
      <div class="list-row"><span class="muted">Payment</span><span>${r.payment_methods.map((m) => PAY_LABEL[m]).join(', ')}</span></div>
      ${r.notes ? `<div class="list-row"><span class="muted">Notes</span><span>${esc(r.notes)}</span></div>` : ''}
    </div>
    ${!isDriver && !activeBooking && r.status === 'scheduled' && !departed && r.seats_left > 0 ? `
    <div class="bookbar">
      <div class="price">${money(r.your_price)}<small>per seat · ${r.seats_left} left</small></div>
      <button class="btn" data-action="${me ? 'jump-book' : 'login'}">${icon('ticket')} ${me ? (r.instant_book ? 'Book now' : 'Request seat') : 'Log in to book'}</button>
    </div>` : ''}
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
  const drawRideMap = (seg = r.segment) => {
    const el = $('#ride-map', page);
    if (!el) return;
    const homes = [];
    const addHome = (h, label, stopIndex) => h && homes.push({ lat: h.lat, lon: h.lon, label, near: r.stops[stopIndex] });
    if (isDriver) {
      for (const x of (r.bookings || []).filter((y) => ['pending', 'confirmed'].includes(y.status))) {
        addHome(x.home_pickup, `Pick up ${x.passenger_name}`, x.board_stop ?? 0);
        addHome(x.home_drop, `Drop ${x.passenger_name}`, x.alight_stop ?? lastStop);
      }
    } else if (activeBooking) {
      addHome(b.home_pickup, 'Your home pickup', b.board_stop ?? 0);
      addHome(b.home_drop, 'Your home drop-off', b.alight_stop ?? lastStop);
    }
    const mine = activeBooking ? { board: b.board_stop ?? 0, alight: b.alight_stop ?? lastStop } : seg;
    routeMap(el, r.stops, { board: isDriver ? 0 : mine.board, alight: isDriver ? lastStop : mine.alight, homes })
      .catch((err) => { console.warn('Map failed:', err); el.hidden = true; });
  };
  if (stopsKnown) drawRideMap();
  const studentOk = me && me.traveler_type === 'student' && (!settings.student_price_requires_verification || me.student_verified);
  // Mirrors the server: whole route at the posted price, parts of it by km.
  const seatPrice = (bIdx, aIdx) => {
    const base = !stopsKnown || (bIdx === 0 && aIdx === lastStop) ? r.price_per_seat : roundFare((r.stops[aIdx].km - r.stops[bIdx].km) * r.fare_per_km);
    return studentOk ? Math.round((base * (100 - r.student_discount_pct)) / 100) : base;
  };
  const segmentNow = () => ({
    board: book && book.board_stop ? Number(book.board_stop.value) : r.segment.board,
    alight: book && book.alight_stop ? Number(book.alight_stop.value) : r.segment.alight,
  });
  // Home pickup/drop: location from the phone or a pasted link, charge by distance from the stop.
  const homeChoice = (kind) => {
    if (!book || !book[`want_${kind}`] || !book[`want_${kind}`].checked) return null;
    const seg = segmentNow();
    const stop = r.stops[kind === 'pickup' ? seg.board : seg.alight];
    const loc = parseLocation(book[`${kind}_loc`].value);
    const note = book.querySelector(`.home-fields[data-kind=${kind}] .home-note`);
    if (!loc) { note.textContent = 'Add your location to see the charge.'; return { error: `Add your ${kind === 'pickup' ? 'pickup' : 'drop-off'} location` }; }
    const km = Math.round(haversineKm(stop.lat, stop.lon, loc.lat, loc.lon) * 1.3 * 10) / 10;
    if (km > r.home_radius_km) { note.textContent = `That is ${km} km from ${stop.name}; this driver goes up to ${r.home_radius_km} km.`; return { error: note.textContent }; }
    const charge = Math.max(settings.home_pickup_min, roundFare(km * settings.home_pickup_per_km));
    note.innerHTML = `${km} km from ${esc(stop.name)} · <b>+${money(charge)}</b> (paid to the driver)`;
    return { lat: loc.lat, lon: loc.lon, address: book[`${kind}_address`].value.trim(), charge };
  };
  // The booking fee depends on the seats and stops chosen; show it before the passenger commits.
  const showFee = () => {
    const f = r.booking_fee;
    if (!book || !f) return;
    const seg = segmentNow();
    const price = seatPrice(seg.board, seg.alight);
    $('#seat-price', page).value = money(price);
    const fare = price * Number(book.seats.value);
    const home = ['pickup', 'drop'].map(homeChoice).filter((h) => h && !h.error).reduce((sum, h) => sum + h.charge, 0);
    const fee = (f.free ? 0 : Math.ceil((fare * f.pct) / 100)) + f.low_reliability_fee;
    const segKm = stopsKnown ? r.stops[seg.alight].km - r.stops[seg.board].km : null;
    const lines = [`You pay the driver <b>${money(fare + home)}</b> directly${home ? ` (incl. ${money(home)} home pickup/drop)` : ''}.`];
    if (segKm) lines.push(`${segKm} km · Rs ${(price / segKm).toFixed(1)}/km per seat (bus ≈ Rs ${settings.ref_bus_per_km}/km).`);
    if (fee) {
      lines.push(`Booking fee <b>${money(fee)}</b>${f.free ? '' : ` (${f.pct}%)`}${f.low_reliability_fee ? `, incl. ${money(f.low_reliability_fee)} low-reliability fee` : ''}, taken from your wallet when the booking is confirmed.`);
      lines.push(`Wallet: ${money(me.wallet_balance)}${me.wallet_balance < fee ? ' · <a href="#/wallet">Top up</a>' : ''}`);
    } else if (f.free) {
      lines.push(`No booking fee: ${me.free_confirmations_left} free booking(s) left.`);
    }
    $('#fee-box', page).innerHTML = lines.map((l) => `<div class="small">${l}</div>`).join('');
  };
  if (book) {
    book.addEventListener('change', showFee);
    book.addEventListener('input', showFee);
    const pickers = {};
    const showPicker = (kind) => {
      const seg = segmentNow();
      const stop = r.stops[kind === 'pickup' ? seg.board : seg.alight];
      const input = book[`${kind}_loc`];
      locationPicker(book.querySelector(`[data-map=${kind}]`), {
        around: stop,
        radiusKm: r.home_radius_km,
        value: parseLocation(input.value),
        onPick: ({ lat, lon }) => { input.value = `${lat}, ${lon}`; showFee(); },
      }).then((p) => { pickers[kind] = p; }).catch((err) => { console.warn('Map failed:', err); book.querySelector(`[data-map=${kind}]`).hidden = true; });
    };
    book.querySelectorAll('[name^=want_]').forEach((cb) => cb.addEventListener('change', () => {
      const kind = cb.name.slice(5);
      book.querySelector(`.home-fields[data-kind=${kind}]`).hidden = !cb.checked;
      if (cb.checked) showPicker(kind);
    }));
    // Changing stops moves the allowed area for home pickup/drop, and the route highlight.
    for (const sel of [book.board_stop, book.alight_stop].filter(Boolean)) {
      sel.addEventListener('change', () => {
        drawRideMap(segmentNow());
        for (const kind of ['pickup', 'drop']) if (book[`want_${kind}`] && book[`want_${kind}`].checked) showPicker(kind);
      });
    }
    for (const kind of ['pickup', 'drop']) {
      const input = book[`${kind}_loc`];
      if (input) input.addEventListener('change', () => { const loc = parseLocation(input.value); if (loc && pickers[kind]) pickers[kind].set(loc); });
    }
    showFee();
    onClick(book, async (action) => {
      if (action !== 'locate') return;
      const link = await currentLocationLink();
      if (!link) throw new Error('Could not get your location. Paste a Google Maps link instead.');
      book.pickup_loc.value = link;
      const loc = parseLocation(link);
      if (loc && pickers.pickup) pickers.pickup.set(loc);
      showFee();
    });
    onSubmit(book, async (d) => {
      const seg = segmentNow();
      if (seg.board >= seg.alight) throw new Error('Choose a drop-off stop after your pickup stop');
      const homes = {};
      for (const kind of ['pickup', 'drop']) {
        const h = homeChoice(kind);
        if (h && h.error) throw new Error(h.error);
        if (h) homes[`home_${kind}`] = { lat: h.lat, lon: h.lon, address: h.address };
      }
      const res = await api(`/rides/${r.id}/bookings`, {
        method: 'POST', body: { seats: Number(d.seats), message: d.message, board_stop: seg.board, alight_stop: seg.alight, ...homes },
      });
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
          ...(stopsKnown ? {} : { pickup_point: d.pickup_point, dropoff_point: d.dropoff_point }), vehicle: d.vehicle, notes: d.notes,
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
    if (action === 'locate') return; // handled by the booking form
    if (action === 'jump-book') { $('#book', page).scrollIntoView({ behavior: 'smooth', block: 'start' }); return; }
    if (action === 'login') { location.hash = `#/login?next=${encodeURIComponent(location.hash.slice(1))}`; return; }
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
  await refreshMe();
  // Drivers need a verified phone and (if the admin requires it) an approved driver registration.
  if (settings.require_phone_verification && !me.phone_verified) {
    page.innerHTML = setupNeeded('Verify your phone first', 'Posting rides needs a verified phone number. It takes a minute.', '/verify-phone?next=/offer', 'Verify phone');
    return;
  }
  if (settings.require_driver_approval && me.driver_status !== 'approved') {
    page.innerHTML = me.driver_status === 'pending'
      ? setupNeeded('Driver registration under review ⏳', 'We are checking your licence and vehicle. You’ll get a notification as soon as you can post rides.', '/driver', 'View my application')
      : setupNeeded('Become a driver', 'To keep passengers safe, drivers register once with their CNIC, driving licence and vehicle. It takes about 3 minutes.', '/driver', 'Register as a driver');
    return;
  }
  const postingFee = me.reliability < settings.reliability_threshold ? settings.low_reliability_fee : 0;
  const start = q.date ? new Date(`${q.date}T08:00`) : new Date(Date.now() + 864e5);
  if (!q.date) start.setHours(8, 0, 0, 0);
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const STEP_TITLES = ['Route', 'When & seats', 'Price', 'Extras', 'Review'];
  page.innerHTML = `
    <h1>Offer a ride</h1>
    <div class="progress" aria-hidden="true">${STEP_TITLES.map(() => '<span></span>').join('')}</div>
    <p class="small muted" id="wiz-label"></p>
    ${postingFee ? `<div class="card warn">⚠️ Your reliability is ${me.reliability}% (below ${settings.reliability_threshold}%), so each ride you post costs ${money(postingFee)} from your wallet (balance ${money(me.wallet_balance)}). Complete trips without cancelling to earn points back.</div>` : ''}
    <form id="offer" novalidate>
      <section data-step="1">
        <div class="card">
          <h3 class="step-title"><span class="step">1</span> Where are you driving?</h3>
          ${cityOptions()}
          <div class="row two">
            <div class="field"><label for="of">From city</label><input id="of" name="from_city" list="cities" value="${esc(q.from)}" placeholder="e.g. Lahore" required></div>
            <div class="field"><label for="opp">Pickup point</label><select id="opp" name="pickup_place"><option value="">Choose a city first</option></select></div>
          </div>
          <div class="row two">
            <div class="field"><label for="ot">To city</label><input id="ot" name="to_city" list="cities" value="${esc(q.to)}" placeholder="e.g. Islamabad" required></div>
            <div class="field"><label for="odp">Drop-off point</label><select id="odp" name="drop_place"><option value="">Choose a city first</option></select></div>
          </div>
          <div id="route-info" class="small muted">Choose the cities and points to see the distance and stops on the way.</div>
          <div class="map" id="offer-map" hidden></div>
          <div id="legacy-price" class="field" hidden>
            <label for="opr">Price per seat (Rs)</label><input id="opr" name="price_per_seat" type="number" min="0" step="50">
            <p class="muted small">This city has no listed pickup points yet, so set the price yourself.</p>
          </div>
        </div>
        <p class="small muted">${icon('hand')} See <a href="#/requests">passengers looking for rides</a> on your route.</p>
      </section>

      <section data-step="2" hidden>
        <div class="card">
          <h3 class="step-title"><span class="step">2</span> When are you leaving?</h3>
          <div class="row two">
            <div class="field"><label for="ow">Departure</label><input id="ow" name="departure_at" type="datetime-local" value="${localInputValue(start)}" required></div>
            <div class="field"><label for="os">Seats for passengers</label><input id="os" name="seats_total" type="number" min="1" max="${me.vehicle ? me.vehicle.seats : 8}" value="${Math.min(3, me.vehicle ? me.vehicle.seats : 3)}" required></div>
          </div>
          ${durationFields(null)}
          <details class="card" style="box-shadow:none;margin:0">
            <summary><b>${icon('calendar')} Regular commute? Repeat this ride</b></summary>
            <p class="muted small" style="margin-top:10px">Pick weekdays to post the same ride for several weeks — ideal for office commutes or weekly trips home.</p>
            <div class="days field">${days.map((d, i) => `<label><input type="checkbox" name="day" value="${i}"><span>${d}</span></label>`).join('')}</div>
            <div class="field" style="margin:0"><label for="oweeks">For how many weeks</label><select id="oweeks" name="weeks">${[1, 2, 3, 4].map((n) => `<option>${n}</option>`).join('')}</select></div>
          </details>
        </div>
      </section>

      <section data-step="3" hidden>
        <div class="card" id="fare-card">
          <h3 class="step-title"><span class="step">3</span> Set your price</h3>
          <div class="field"><label for="ofk">Fare per km per seat (Rs)</label>
            <input id="ofk" name="fare_per_km" type="number" value="${settings.fare_per_km}" ${settings.enforce_fare_limits ? `min="${settings.fare_min_per_km}" max="${settings.fare_max_per_km}"` : 'min="1"'} required>
            <p class="muted small">Suggested Rs ${settings.fare_per_km}/km${settings.enforce_fare_limits ? `, allowed Rs ${settings.fare_min_per_km}–${settings.fare_max_per_km}/km` : ''}. Passengers who join on the way pay for their kilometres only.</p>
          </div>
          <div id="fare-info"></div>
          <div id="earnings"></div>
        </div>
        <div class="card">
          <h3>Payment</h3>
          <div class="field"><label>How passengers can pay you</label>${paymentCheckboxes()}</div>
          <div class="field"><label for="opd">Payment account <span class="muted">(shown only to confirmed passengers)</span></label>
            <input id="opd" name="payment_details" placeholder="e.g. JazzCash 0300 1234567 (Ahmed Raza)"></div>
          <div class="field" style="margin:0"><label for="osd">Student discount (%)</label><input id="osd" name="student_discount_pct" type="number" min="0" max="100" value="0"></div>
        </div>
      </section>

      <section data-step="4" hidden>
        <div class="card">
          <h3 class="step-title"><span class="step">4</span> Extras <span class="muted small">(all optional)</span></h3>
          <label class="check"><input type="checkbox" name="home_pickup" value="1"> Pick passengers up from home near the pickup point</label>
          <label class="check"><input type="checkbox" name="home_drop" value="1"> Drop passengers at home near the drop-off point</label>
          <div class="field"><label for="ohr">Up to how far from the point (km)</label><input id="ohr" name="home_radius_km" type="number" min="1" max="${settings.home_max_radius_km}" value="${Math.min(5, settings.home_max_radius_km)}"></div>
          <div class="hint">${icon('wallet')}<span>Passengers pay ${money(settings.home_pickup_per_km)}/km for home pickup/drop (at least ${money(settings.home_pickup_min)}), and <b>you keep all of it, commission-free</b>.</span></div>
          ${settings.booking_mode === 'driver_choice' ? '<label class="check"><input type="checkbox" name="instant_book" value="1"> Instant booking (accept passengers automatically)</label>'
    : `<p class="muted small">${settings.booking_mode === 'instant' ? 'Bookings are confirmed instantly.' : 'You approve each booking request.'}</p>`}
          ${me.gender === 'female' ? '<label class="check"><input type="checkbox" name="women_only" value="1"> Women-only ride</label>' : ''}
          <div class="field"><label for="ov">Vehicle</label><input id="ov" name="vehicle" placeholder="${me.vehicle ? esc(`${me.vehicle.make} ${me.vehicle.model} (${me.vehicle.color})`) : 'e.g. Toyota Corolla, white'}"></div>
          <div class="field" style="margin:0"><label for="on">Notes for passengers</label><textarea id="on" name="notes" maxlength="500" placeholder="Luggage space, AC, music, smoking rules…"></textarea></div>
        </div>
      </section>

      <section data-step="5" hidden>
        <div class="card" id="offer-summary"></div>
        ${postingFee ? '' : `<p class="small">${icon('circle-check')} Posting rides is free.</p>`}
      </section>

      <div class="wizard-nav">
        <button class="btn ghost" type="button" id="wiz-back" hidden>${icon('chevron-left')} Back</button>
        <button class="btn" type="submit" id="wiz-next">Next</button>
      </div>
    </form>`;

  const form = $('#offer', page);
  let plan = null; // { stops: [...], distance_km, duration_minutes } for the chosen points
  let suggested = [];
  let touched = false;
  form.dur_h.addEventListener('input', () => { touched = true; });
  form.dur_m.addEventListener('input', () => { touched = true; });

  const fillPoints = async (cityInput, select, legacyKey) => {
    const list = cityInput.value.trim() ? await api(`/places?city=${encodeURIComponent(cityInput.value.trim())}`).catch(() => []) : [];
    select.innerHTML = list.length
      ? list.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join('')
      : `<option value="">${cityInput.value.trim() ? 'No listed points' : 'Choose a city first'}</option>`;
    select.dataset[legacyKey] = list.length ? '' : '1';
  };

  const chosenStopIds = () => [
    form.pickup_place.value,
    ...checkedValues(form, 'via').sort((a, b) => Number(form.querySelector(`[name=via][value="${a}"]`).dataset.km) - Number(form.querySelector(`[name=via][value="${b}"]`).dataset.km)),
    form.drop_place.value,
  ];

  // Distances for the chosen points; endpointsChanged refreshes the suggested stops.
  const replan = async (endpointsChanged) => {
    const noPoints = !form.pickup_place.value || !form.drop_place.value;
    $('#legacy-price', page).hidden = !noPoints || !form.from_city.value || !form.to_city.value;
    form.price_per_seat.required = !$('#legacy-price', page).hidden;
    if (noPoints) {
      plan = null;
      $('#offer-map', page).hidden = true;
      $('#route-info', page).textContent = 'Choose the cities and points to see the distance and stops on the way.';
      updateFare();
      return;
    }
    const ids = endpointsChanged ? [form.pickup_place.value, form.drop_place.value] : chosenStopIds();
    try {
      plan = await api(`/route-plan?stops=${ids.join(',')}`);
    } catch (err) {
      plan = null;
      $('#route-info', page).textContent = err.message;
      return;
    }
    if (endpointsChanged) suggested = plan.suggested_stops;
    if (!touched) {
      form.dur_h.value = Math.floor(plan.duration_minutes / 60);
      form.dur_m.value = plan.duration_minutes % 60;
    }
    const checked = new Set(checkedValues(form, 'via'));
    $('#route-info', page).innerHTML = `
      <p>🛣️ About <b>${plan.distance_km} km</b> by road${plan.stops.length > 2 ? ` with ${plan.stops.length - 2} stop(s)` : ''}.</p>
      ${suggested.length ? `<p class="small">Add stops on the way so more passengers can join (they pay for their part of the route):</p>
      <div class="days">${suggested.map((p) => `<label><input type="checkbox" name="via" value="${p.id}" data-km="${p.km}" ${checked.has(String(p.id)) ? 'checked' : ''}><span>${esc(p.city)} · ${esc(p.name)}</span></label>`).join('')}</div>` : ''}`;
    $('#route-info', page).querySelectorAll('[name=via]').forEach((cb) => cb.addEventListener('change', () => replan(false)));
    // The route on a map; tapping a suggested stop (+) adds it.
    const mapEl = $('#offer-map', page);
    mapEl.hidden = false;
    const onRoute = new Set(plan.stops.map((p) => String(p.id)));
    routeMap(mapEl, plan.stops, {
      extra: suggested.filter((p) => !onRoute.has(String(p.id)) && p.lat != null),
      onExtra: (p) => {
        const cb = form.querySelector(`[name=via][value="${p.id}"]`);
        if (cb) { cb.checked = true; replan(false); }
      },
    }).catch((err) => { console.warn('Map failed:', err); mapEl.hidden = true; });
    updateFare();
  };

  // Seat price, comparison and what the driver earns with 1, 2, 3… passengers.
  function updateFare() {
    const rate = Number(form.fare_per_km.value) || 0;
    const km = plan ? plan.distance_km : null;
    if (!km) {
      $('#fare-info', page).innerHTML = '';
      $('#earnings', page).innerHTML = '';
      return;
    }
    const price = roundFare(km * rate);
    const seats = Math.max(1, Math.min(8, Number(form.seats_total.value) || 1));
    const fuel = Math.round((km * settings.petrol_price) / settings.car_km_per_litre);
    const commissionFor = (k) => {
      const disc = k >= 3 ? settings.share_discount_3_pct : k === 2 ? settings.share_discount_2_pct : 0;
      return Math.ceil((price * settings.driver_commission_pct * (100 - disc)) / 10000);
    };
    $('#fare-info', page).innerHTML = `
      <p>Seat price for the whole route: <b>${money(price)}</b>.</p>
      <p class="small muted">For comparison on this distance: bus about ${money(roundFare(km * settings.ref_bus_per_km))} per seat,
        private car about ${money(roundFare(km * settings.ref_private_car_per_km))} for the whole car.</p>`;
    let income = 0;
    let commission = 0;
    const rows = [];
    for (let n = 1; n <= seats; n++) {
      income += price;
      commission += commissionFor(n);
      rows.push(`<tr><td>${n}</td><td><b>${money(income - commission)}</b><br><span class="muted">of ${money(income)}</span></td>
        <td>${money(commission)}${n >= 2 ? `<br><span class="badge confirmed">${n >= 3 ? settings.share_discount_3_pct : settings.share_discount_2_pct}% off</span>` : ''}</td>
        <td>${Math.round(((income - commission) / fuel) * 100)}%</td></tr>`);
    }
    $('#earnings', page).innerHTML = `
      <p class="small"><b>What you earn</b> (fuel for ${km} km ≈ ${money(fuel)} at ${money(settings.petrol_price)}/litre, ${settings.car_km_per_litre} km/litre):</p>
      <div class="table-wrap"><table class="earn">
        <tr><th>Riders</th><th>You keep</th><th>Commission</th><th>Fuel paid</th></tr>
        ${rows.join('')}
      </table></div>
      <p class="small">🚗 The more seats you fill, the less commission you pay: ${settings.share_discount_2_pct}% off with 2 passengers, ${settings.share_discount_3_pct}% off with 3 or more,
        plus +${settings.share_bonus_points} reliability point per extra passenger. Home pickup/drop charges are all yours.
        ${me.free_confirmations_left ? `Your next ${me.free_confirmations_left} confirmed booking(s) are commission-free.` : ''}</p>`;
  }

  // One timer per field, so typing the destination does not cancel the origin lookup.
  const timers = {};
  const cityChanged = (input, select, key) => {
    clearTimeout(timers[key]);
    timers[key] = setTimeout(async () => { await fillPoints(input, select, key); replan(true); }, 400);
  };
  form.from_city.addEventListener('input', () => cityChanged(form.from_city, form.pickup_place, 'nofrom'));
  form.to_city.addEventListener('input', () => cityChanged(form.to_city, form.drop_place, 'noto'));
  form.pickup_place.addEventListener('change', () => replan(true));
  form.drop_place.addEventListener('change', () => replan(true));
  form.fare_per_km.addEventListener('input', updateFare);
  form.seats_total.addEventListener('input', updateFare);
  await Promise.all([fillPoints(form.from_city, form.pickup_place, 'nofrom'), fillPoints(form.to_city, form.drop_place, 'noto')]);
  // "Offer this ride" from a passenger's request passes their points along.
  const preselect = (select, id) => { if (id && select.querySelector(`option[value="${CSS.escape(id)}"]`)) select.value = id; };
  preselect(form.pickup_place, q.pickup);
  preselect(form.drop_place, q.drop);
  replan(true);

  // Step-by-step: each step is checked before moving on, the last one reviews and publishes.
  let step = 1;
  const sectionOf = (n) => form.querySelector(`[data-step="${n}"]`);
  const checkStep = (n) => {
    for (const el of sectionOf(n).querySelectorAll('input, select, textarea')) {
      if (!el.checkValidity()) {
        showStep(n);
        el.reportValidity();
        throw new Error(el.validationMessage || 'Please complete this step');
      }
    }
    if (n === 1 && !plan && $('#legacy-price', page).hidden) throw new Error('Choose your cities and pickup/drop-off points');
  };
  function showStep(n) {
    step = n;
    for (let i = 1; i <= STEP_TITLES.length; i++) sectionOf(i).hidden = i !== n;
    page.querySelectorAll('.progress span').forEach((el, i) => el.classList.toggle('done', i < n));
    $('#wiz-label', page).textContent = `Step ${n} of ${STEP_TITLES.length} · ${STEP_TITLES[n - 1]}`;
    $('#wiz-back', page).hidden = n === 1;
    $('#wiz-next', page).innerHTML = n === STEP_TITLES.length ? `${icon('check')} Publish ride` : `Next ${icon('chevron-right')}`;
    if (n === STEP_TITLES.length) renderSummary();
    window.scrollTo(0, 0);
  }
  function renderSummary() {
    const d = formData(form);
    const days2 = checkedValues(form, 'day').map((i) => days[i]);
    const price = plan ? roundFare(plan.distance_km * Number(d.fare_per_km)) : Number(d.price_per_seat);
    const row = (k, v) => `<div class="summary-row"><span>${k}</span><span>${v}</span></div>`;
    $('#offer-summary', page).innerHTML = `
      <h3 class="step-title"><span class="step">5</span> Check and publish</h3>
      <div class="big-price">${money(price)}<span class="muted small" style="font-weight:600"> per seat${plan ? ` · Rs ${d.fare_per_km}/km` : ''}</span></div>
      ${row('Route', plan ? plan.stops.map((st) => esc(st.city)).join(' → ') : `${esc(d.from_city)} → ${esc(d.to_city)}`)}
      ${plan ? row('Pickup / drop-off', `${esc(plan.stops[0].name)} → ${esc(plan.stops[plan.stops.length - 1].name)}`) : ''}
      ${plan ? row('Distance', `${plan.distance_km} km`) : ''}
      ${row('Departure', d.departure_at ? when(new Date(d.departure_at).toISOString()) : '—')}
      ${days2.length ? row('Repeats', `${days2.join(', ')} for ${d.weeks} week(s)`) : ''}
      ${row('Seats', d.seats_total)}
      ${row('Payment', checkedValues(form, 'pay').map((m) => PAY_LABEL[m]).join(', ') || '—')}
      ${d.home_pickup || d.home_drop ? row('Home service', [d.home_pickup && 'pickup', d.home_drop && 'drop-off'].filter(Boolean).join(' & ') + ` within ${d.home_radius_km} km`) : ''}
      ${d.instant_book ? row('Bookings', 'Instant') : ''}${d.women_only ? row('Passengers', 'Women only') : ''}`;
  }
  $('#wiz-back', page).addEventListener('click', () => showStep(Math.max(1, step - 1)));
  showStep(1);

  onSubmit(form, async (d) => {
    if (step < STEP_TITLES.length) {
      checkStep(step);
      showStep(step + 1);
      return;
    }
    for (let i = 1; i < STEP_TITLES.length; i++) checkStep(i);
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
    const route = plan
      ? { stops: chosenStopIds().map(Number), fare_per_km: Number(d.fare_per_km) }
      : { from_city: d.from_city, to_city: d.to_city, price_per_seat: Number(d.price_per_seat) };
    const created = await api('/rides', {
      method: 'POST',
      body: {
        ...route,
        departures: departures.map((x) => x.toISOString()),
        seats_total: Number(d.seats_total),
        student_discount_pct: Number(d.student_discount_pct || 0), vehicle: d.vehicle, notes: d.notes,
        payment_methods: checkedValues(form, 'pay'), payment_details: d.payment_details,
        duration_minutes: durationValue(d),
        home_pickup: !!d.home_pickup, home_drop: !!d.home_drop, home_radius_km: Number(d.home_radius_km),
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
        <div class="field"><label for="rqf">From city</label><input id="rqf" name="from_city" list="cities" value="${esc(q.from)}" placeholder="e.g. Islamabad" required></div>
        <div class="field"><label for="rqfp">Pickup point</label><select id="rqfp" name="from_place_id"><option value="">Choose a city first</option></select></div>
      </div>
      <div class="map small" data-points="from_place_id" hidden></div>
      <div class="row two">
        <div class="field"><label for="rqt">To city</label><input id="rqt" name="to_city" list="cities" value="${esc(q.to)}" placeholder="e.g. Lahore" required></div>
        <div class="field"><label for="rqtp">Drop-off point</label><select id="rqtp" name="to_place_id"><option value="">Choose a city first</option></select></div>
      </div>
      <div class="map small" data-points="to_place_id" hidden></div>
      <p class="small muted">Tap a point on a map or pick from the list. Choose “Anywhere in the city” if you’re flexible.</p>
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
  const form = $('#rq', page);
  const timers = {};
  const lists = new Map(); // select → places listed in it
  const redraws = new Map(); // select → redraw function of its map
  // One map per city, so each city's points are far enough apart to tap.
  const drawMap = async (select) => {
    const el = form.querySelector(`[data-points=${select.name}]`);
    const places = lists.get(select) || [];
    const group = [{ places, selected: select.value, onPick: (p) => { select.value = String(p.id); drawMap(select); } }];
    if (!places.length) { el.hidden = true; redraws.delete(select); return; }
    el.hidden = false;
    try {
      if (redraws.has(select)) redraws.get(select)(group);
      else redraws.set(select, await pointsMap(el, group, { end: select === form.to_place_id }));
    } catch (err) { console.warn('Map failed:', err); el.hidden = true; }
  };
  const fill = async (input, select) => {
    const city = input.value.trim();
    const list = city ? await api(`/places?city=${encodeURIComponent(city)}`).catch(() => []) : [];
    const keep = select.value;
    select.innerHTML = city
      ? `<option value="">Anywhere in the city</option>${list.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join('')}`
      : '<option value="">Choose a city first</option>';
    if (keep && list.some((p) => String(p.id) === keep)) select.value = keep;
    lists.set(select, list);
  };
  for (const [input, select] of [[form.from_city, form.from_place_id], [form.to_city, form.to_place_id]]) {
    input.addEventListener('input', () => {
      clearTimeout(timers[input.name]);
      timers[input.name] = setTimeout(async () => { await fill(input, select); drawMap(select); }, 350);
    });
    select.addEventListener('change', () => drawMap(select));
  }
  await Promise.all([fill(form.from_city, form.from_place_id), fill(form.to_city, form.to_place_id)]);
  drawMap(form.from_place_id);
  drawMap(form.to_place_id);

  onSubmit(form, async (d) => {
    await api('/ride-requests', {
      method: 'POST',
      body: {
        from_city: d.from_city, to_city: d.to_city, seats: Number(d.seats), notes: d.notes,
        from_place_id: d.from_place_id ? Number(d.from_place_id) : null,
        to_place_id: d.to_place_id ? Number(d.to_place_id) : null,
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
      <a class="card" href="#/ride/${b.ride_id}${b.alight_stop != null ? segmentQuery({ board: b.board_stop, alight: b.alight_stop }) : ''}">
        <div class="ride-top">
          <div>
            <div class="route">${esc(b.from_city)} <span class="arrow">→</span> ${esc(b.to_city)}</div>
            <div class="meta"><span>🕒 ${when(b.departure_at)}</span><span>🚗 ${esc(b.driver_name)}</span><span>💺 ${b.seats}</span>
              <span>📍 ${esc(b.board_name)} → ${esc(b.alight_name)}</span>${b.home_charge ? '<span>🏠 home pickup/drop</span>' : ''}</div>
          </div>
          <div class="price">${money(b.price_per_seat * b.seats + b.home_charge)}<small>total</small></div>
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
      <div class="field"><label for="le">Email or verified phone</label><input id="le" name="email" type="text" inputmode="email" autocomplete="username" placeholder="you@example.com or 03xx xxxxxxx" required></div>
      <div class="field"><label for="lp">Password</label><input id="lp" name="password" type="password" autocomplete="current-password" required></div>
      <button class="btn block" type="submit">Log in</button>
      <p class="small" style="margin:12px 0 0;text-align:center"><a href="#/forgot">Forgot password?</a></p>
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

views.forgot = async (page) => {
  if (me) { location.hash = '#/'; return; }
  page.innerHTML = `
    <h1>Reset your password</h1>
    <form id="fp-send" class="card">
      <p class="muted small">Enter the phone number you verified on ABC Rides. We’ll text you a 6-digit code.</p>
      <div class="field"><label for="fpp">Phone</label><input id="fpp" name="phone" type="tel" placeholder="03xx xxxxxxx" required></div>
      <button class="btn block" type="submit">Send code</button>
    </form>
    <form id="fp-confirm" class="card" hidden>
      <div class="field"><label for="fpc">Code</label><input id="fpc" name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" required></div>
      <div class="field"><label for="fpn">New password</label><input id="fpn" name="new_password" type="password" minlength="8" autocomplete="new-password" required></div>
      <button class="btn block" type="submit">Set new password</button>
    </form>
    <div id="fp-help" class="card warn small" hidden></div>
    <p class="muted"><a href="#/login">Back to log in</a></p>`;
  let phone = '';
  onSubmit($('#fp-send', page), async (d) => {
    try {
      const res = await api('/auth/reset/send', { method: 'POST', body: d });
      phone = d.phone;
      toast(res.message);
      $('#fp-confirm', page).hidden = false;
      $('#fpc', page).focus();
    } catch (err) {
      if (err.code !== 'reset_unavailable') throw err;
      const help = $('#fp-help', page);
      help.hidden = false;
      help.textContent = `${err.message} Support can set a temporary password for you after checking it’s really you.`;
    }
  });
  onSubmit($('#fp-confirm', page), async (d) => {
    await api('/auth/reset/confirm', { method: 'POST', body: { ...d, phone } });
    toast('Password changed. Log in with your new password.');
    location.hash = '#/login';
  });
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
      <p class="small muted" style="margin-top:10px;text-align:center">By signing up you agree to the <a href="terms.html">Terms</a> and <a href="privacy.html">Privacy policy</a>.</p>
    </form>
    <p class="muted">Already have an account? <a href="#/login">Log in</a></p>`;
  onSubmit($('#register', page), async (d) => {
    const res = await api('/auth/register', { method: 'POST', body: d });
    store.token = res.token; me = res.user;
    toast(`Welcome, ${me.name.split(' ')[0]}! Let’s verify your phone.`);
    location.hash = `#/verify-phone?next=${encodeURIComponent(q.next || '/')}`;
  });
};

async function refreshMe() {
  if (store.token) me = await api('/me').catch(() => me);
}

function setupNeeded(title, text, href, button) {
  return `<div class="card empty"><h2>${title}</h2><p>${text}</p><a class="btn" href="#${href}">${button}</a></div>`;
}

const STATUS_ICON = { verified: '✅', approved: '✅', pending: '⏳', rejected: '⚠️', none: '➕' };

// Profile checklist: what is done and what is next, with as few steps as possible.
function setupChecklist(u) {
  const row = (done, title, sub, href, cta) => `
    <a class="list-row setup-row" href="#${href}">
      <span>${done} <b>${title}</b><br><span class="muted small">${sub}</span></span>
      ${cta ? `<span class="btn small ${done === '✅' ? 'ghost' : ''}">${cta}</span>` : ''}
    </a>`;
  const idStatus = u.verification_status;
  const rows = [
    row(u.phone_verified ? '✅' : '➕', 'Phone number', u.phone_verified ? esc(u.phone) : 'Needed to book and post rides', '/verify-phone', u.phone_verified ? '' : 'Verify'),
    row(STATUS_ICON[idStatus], 'Identity (CNIC + selfie)',
      { verified: `Verified · ${esc(u.cnic_masked || '')}`, pending: 'Under review', rejected: `Not approved${u.verification_note ? `: ${esc(u.verification_note)}` : ''}`, none: 'Get a verified badge and more bookings' }[idStatus],
      '/verify-id', idStatus === 'verified' || idStatus === 'pending' ? '' : 'Verify'),
  ];
  if (u.traveler_type === 'student') {
    rows.push(row(STATUS_ICON[u.student_status], 'Student card',
      { verified: 'Student prices unlocked', pending: 'Under review', rejected: 'Not approved, please try again', none: 'Unlock student discounts' }[u.student_status],
      '/verify-id', ['verified', 'pending'].includes(u.student_status) ? '' : 'Add'));
  }
  rows.push(row(STATUS_ICON[u.driver_status], 'Driver & vehicle',
    { approved: u.vehicle ? `${esc(u.vehicle.make)} ${esc(u.vehicle.model)} · ${esc(u.vehicle.plate)}` : 'Approved', pending: 'Under review',
      rejected: `Not approved${u.driver_note ? `: ${esc(u.driver_note)}` : ''}`, none: 'Optional: offer rides and earn' }[u.driver_status],
    '/driver', u.driver_status === 'approved' || u.driver_status === 'pending' ? '' : 'Start'));
  return `
    <div class="card">
      <h3>Account setup</h3>
      ${rows.join('')}
      <a class="list-row setup-row" href="#/wallet">
        <span>💳 <b>Wallet ${money(u.wallet_balance)}</b><br><span class="muted small">Reliability ${u.reliability}% · ${u.free_confirmations_left} free booking(s) left</span></span>
        <span class="btn small ghost">Open</span>
      </a>
    </div>`;
}

views['verify-phone'] = async (page, q) => {
  if (!requireLogin()) return;
  await refreshMe();
  const next = q.next || '/profile';
  if (me.phone_verified) {
    page.innerHTML = setupNeeded('Phone verified ✅', `${esc(me.phone)} is verified.`, next, 'Continue');
    return;
  }
  page.innerHTML = `
    <h1>Verify your phone</h1>
    <p class="muted">We’ll send a 6-digit code by SMS to <b>${esc(me.phone)}</b>. <a href="#/profile">Wrong number?</a></p>
    <div id="dev-code"></div>
    <form id="otp" class="card">
      <div class="field"><label for="code">Code</label>
        <input id="code" name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" placeholder="••••••" required class="otp"></div>
      <button class="btn block" type="submit">Verify</button>
      <button class="btn ghost block" type="button" data-action="resend" style="margin-top:8px">Send code</button>
    </form>`;
  const resend = page.querySelector('[data-action=resend]');
  let timer;
  const send = async () => {
    const res = await api('/me/phone/send-code', { method: 'POST' });
    if (res.dev_code) {
      $('#dev-code', page).innerHTML = `<div class="card warn small">Development mode (no SMS provider set up): your code is <b>${res.dev_code}</b>.</div>`;
      page.querySelector('#code').value = res.dev_code;
    } else {
      toast(`Code sent to ${res.sent_to}`);
    }
    let left = 60;
    resend.disabled = true;
    clearInterval(timer);
    timer = setInterval(() => {
      left -= 1;
      resend.textContent = left > 0 ? `Resend code in ${left}s` : 'Resend code';
      if (left <= 0) { clearInterval(timer); resend.disabled = false; }
    }, 1000);
    pageTimers.push(timer);
  };
  onClick(page, async (action) => { if (action === 'resend') await send(); });
  onSubmit($('#otp', page), async (d) => {
    me = await api('/me/phone/verify', { method: 'POST', body: { code: d.code } });
    toast('Phone verified ✅');
    location.hash = `#${next}`;
  });
  send().catch(handleError);
};

views['verify-id'] = async (page, q) => {
  if (!requireLogin()) return;
  await refreshMe();
  const idDone = ['verified', 'pending'].includes(me.verification_status);
  const wantsStudent = me.traveler_type === 'student' && !['verified', 'pending'].includes(me.student_status);
  if (idDone && !wantsStudent) {
    page.innerHTML = setupNeeded(me.verification_status === 'verified' ? 'Identity verified ✅' : 'Under review ⏳',
      me.verification_status === 'verified' ? 'Your CNIC and selfie were checked.' : 'We’re checking your documents. You’ll get a notification, usually within a few hours.',
      q.next || '/profile', 'Done');
    return;
  }
  page.innerHTML = `
    <h1>${idDone ? 'Add your student card' : 'Verify your identity'}</h1>
    <p class="muted">Takes 2 minutes. Only the ABC Rides team sees these photos; other members just see a ✔ Verified badge.</p>
    <form id="idv" class="card">
      ${idDone ? '' : `
      <div class="field"><label for="cnic">CNIC number</label><input id="cnic" name="cnic_number" inputmode="numeric" placeholder="35202-1234567-1" required></div>
      <div class="row two">
        ${photoField('cnic_front', 'CNIC front', { capture: 'environment' })}
        ${photoField('cnic_back', 'CNIC back', { capture: 'environment' })}
      </div>
      ${photoField('selfie', 'Selfie', { hint: 'Take a clear selfie, face visible', capture: 'user' })}`}
      ${me.traveler_type === 'student' ? photoField('student_card', `Student card${idDone ? '' : ' (for student prices)'}`, { capture: 'environment' }) : ''}
      <button class="btn block" type="submit">Submit for review</button>
      <p class="muted small" style="margin-top:8px">🔒 One account per CNIC. Fake or someone else’s documents lead to a permanent ban.</p>
    </form>`;
  const form = $('#idv', page);
  if (form.cnic_number) formatCnicInput(form.cnic_number);
  const photos = bindPhotos(form);
  onSubmit(form, async (d) => {
    if (!idDone) requirePhotos(photos, ['cnic_front', 'cnic_back', 'selfie']);
    if (idDone) requirePhotos(photos, ['student_card']);
    me = await api('/me/verification', { method: 'POST', body: { cnic_number: d.cnic_number, ...photos } });
    toast('Submitted! We’ll review it soon.');
    location.hash = `#${q.next || '/profile'}`;
  });
};

views.driver = async (page) => {
  if (!requireLogin()) return;
  await refreshMe();
  if (me.driver_status === 'approved' || me.driver_status === 'pending') {
    const v = me.vehicle;
    page.innerHTML = `
      <h1>${me.driver_status === 'approved' ? 'You’re an approved driver ✅' : 'Driver registration under review ⏳'}</h1>
      ${v ? `<div class="card"><h3>🚗 ${esc(v.make)} ${esc(v.model)} (${v.year})</h3>
        <div class="list-row"><span class="muted">Colour</span><span>${esc(v.color)}</span></div>
        <div class="list-row"><span class="muted">Plate</span><b class="plate">${esc(v.plate)}</b></div>
        <div class="list-row"><span class="muted">Passenger seats</span><span>${v.seats}</span></div></div>` : ''}
      ${me.driver_status === 'approved' ? '<a class="btn block" href="#/offer">➕ Offer a ride</a>' : '<p class="muted">You’ll get a notification once our team has checked your documents.</p>'}`;
    return;
  }
  const needId = !['verified', 'pending'].includes(me.verification_status);
  const year = new Date().getFullYear();
  page.innerHTML = `
    <h1>Become a driver</h1>
    <p class="muted">Register once, then post rides for free. We check every driver so passengers feel safe.</p>
    ${me.driver_status === 'rejected' ? `<div class="card warn">Your last application was not approved${me.driver_note ? `: ${esc(me.driver_note)}` : ''}. Please fix it and submit again.</div>` : ''}
    ${settings.require_phone_verification && !me.phone_verified ? setupNeeded('Step 0: verify your phone', 'Verify your phone number first.', '/verify-phone?next=/driver', 'Verify phone') : `
    <form id="drv">
      ${needId ? `
      <div class="card">
        <h3><span class="step">1</span> Your identity</h3>
        <div class="field"><label for="cnic">CNIC number</label><input id="cnic" name="cnic_number" inputmode="numeric" placeholder="35202-1234567-1" required></div>
        <div class="row two">
          ${photoField('cnic_front', 'CNIC front', { capture: 'environment' })}
          ${photoField('cnic_back', 'CNIC back', { capture: 'environment' })}
        </div>
        ${photoField('selfie', 'Selfie', { hint: 'Take a clear selfie, face visible', capture: 'user' })}
      </div>` : ''}
      <div class="card">
        <h3><span class="step">${needId ? 2 : 1}</span> Driving licence</h3>
        <div class="field"><label for="lic">Licence number</label><input id="lic" name="licence_number" required></div>
        ${photoField('licence_photo', 'Licence photo', { capture: 'environment' })}
      </div>
      <div class="card">
        <h3><span class="step">${needId ? 3 : 2}</span> Vehicle</h3>
        <div class="row two">
          <div class="field"><label>Make</label><input name="make" placeholder="Toyota" required></div>
          <div class="field"><label>Model</label><input name="model" placeholder="Corolla" required></div>
        </div>
        <div class="row three">
          <div class="field"><label>Year</label><input name="year" type="number" min="1980" max="${year + 1}" placeholder="2019" required></div>
          <div class="field"><label>Colour</label><input name="color" placeholder="White" required></div>
          <div class="field"><label>Passenger seats</label><input name="seats" type="number" min="1" max="8" value="4" required></div>
        </div>
        <div class="field"><label>Number plate</label><input name="plate" placeholder="LEA-1234" autocapitalize="characters" required></div>
        <div class="row two">
          ${photoField('vehicle_photo', 'Car photo (plate visible)', { capture: 'environment' })}
          ${photoField('registration_photo', 'Registration (vehicle book)', { capture: 'environment' })}
        </div>
      </div>
      <button class="btn block" type="submit">Submit for review</button>
      <p class="muted small" style="margin-top:8px">🔒 Your documents are only seen by the ABC Rides team. Passengers see your car and, once confirmed, its plate.</p>
    </form>`}`;
  const form = $('#drv', page);
  if (!form) return;
  if (form.cnic_number) formatCnicInput(form.cnic_number);
  const photos = bindPhotos(form);
  onSubmit(form, async (d) => {
    requirePhotos(photos, [...(needId ? ['cnic_front', 'cnic_back', 'selfie'] : []), 'licence_photo', 'vehicle_photo', 'registration_photo']);
    if (needId) {
      await api('/me/verification', { method: 'POST', body: { cnic_number: d.cnic_number, cnic_front: photos.cnic_front, cnic_back: photos.cnic_back, selfie: photos.selfie } });
    }
    me = await api('/me/driver', {
      method: 'POST',
      body: {
        licence_number: d.licence_number, licence_photo: photos.licence_photo, vehicle_photo: photos.vehicle_photo,
        registration_photo: photos.registration_photo,
        vehicle: { make: d.make, model: d.model, year: Number(d.year), color: d.color, plate: d.plate, seats: Number(d.seats) },
      },
    });
    toast('Submitted! We’ll review it soon.');
    render();
  });
};

const TXN_LABEL = { topup: 'Top-up', commission: 'Driver commission', fee: 'Fee', refund: 'Refund', adjustment: 'Adjustment' };

views.wallet = async (page) => {
  if (!requireLogin()) return;
  const w = await api('/me/wallet');
  const s = w.settings;
  const meter = Math.max(0, Math.min(100, w.reliability));
  page.innerHTML = `
    <h1>Wallet</h1>
    <div class="card wallet-hero">
      <div class="small muted">Balance</div>
      <div class="balance">${money(w.balance)}</div>
      <div class="small">Reliability <b>${w.reliability}%</b>${w.low_reliability ? ` <span class="badge cancelled">below ${s.reliability_threshold}%</span>` : ''}</div>
      <div class="meter"><span style="width:${meter}%" class="${w.low_reliability ? 'low' : ''}"></span><i style="left:${s.reliability_threshold}%"></i></div>
      <div class="small muted">${w.free_confirmations_left} free booking confirmation(s) left</div>
    </div>
    <details class="card" ${w.balance === 0 && !w.transactions.length ? 'open' : ''}>
      <summary><b>How fees work</b></summary>
      <ul class="small rules">
        <li>Posting a ride is <b>free</b>.</li>
        <li>When a booking is confirmed, the driver pays <b>${s.driver_commission_pct}%</b> and the passenger <b>${s.passenger_commission_pct}%</b> of the fare from their wallets. Everyone’s first <b>${s.free_confirmations}</b> confirmed bookings are free.</li>
        <li>The fare itself is paid directly to the driver (cash, JazzCash…).</li>
        <li>Cancelling a confirmed trip costs reliability points (driver ${s.penalty_driver_cancel}, passenger ${s.penalty_passenger_cancel}; double within ${s.late_cancel_hours} hours of departure). The other side gets their fee back.</li>
        <li>Below <b>${s.reliability_threshold}%</b> reliability, posting a ride or confirming a booking costs an extra <b>${money(s.low_reliability_fee)}</b>.</li>
        <li>Every completed trip earns <b>+${s.reward_completed}</b> points.</li>
      </ul>
    </details>
    <form id="topup" class="card">
      <h3>Top up</h3>
      <p class="small">1. Send money to:</p>
      <pre class="accounts">${esc(s.topup_accounts)}</pre>
      <p class="small">2. Enter the details from your payment receipt. We add it to your wallet after checking.</p>
      <div class="row three">
        <div class="field"><label>Amount (Rs)</label><input name="amount" type="number" min="${s.min_topup}" step="50" value="${Math.max(500, s.min_topup)}" required></div>
        <div class="field"><label>Sent with</label><select name="method"><option value="jazzcash">JazzCash</option><option value="easypaisa">Easypaisa</option><option value="bank_transfer">Bank transfer</option></select></div>
        <div class="field"><label>Transaction ID</label><input name="reference" placeholder="e.g. 0123456789" required></div>
      </div>
      <button class="btn block" type="submit">Submit top-up</button>
    </form>
    ${w.topups.length ? `<h2>Top-ups</h2><div class="card">${w.topups.map((t) => `
      <div class="list-row"><span>${money(t.amount)} · ${esc(t.method)} · <span class="muted small">${esc(t.reference)}</span>${t.note ? `<br><span class="muted small">${esc(t.note)}</span>` : ''}</span>
      <span class="badge ${t.status === 'approved' ? 'confirmed' : t.status === 'rejected' ? 'cancelled' : 'pending'}">${t.status}</span></div>`).join('')}</div>` : ''}
    <h2>History</h2>
    <div class="card">${w.transactions.map((t) => `
      <div class="list-row"><span>${TXN_LABEL[t.type]}${t.ride_id ? ` · <a href="#/ride/${t.ride_id}">ride</a>` : ''}<br><span class="muted small">${esc(t.note || '')} · ${timeAgo(t.created_at)}</span></span>
      <b class="${t.amount < 0 ? 'neg' : 'pos'}">${t.amount < 0 ? '−' : '+'}${money(Math.abs(t.amount))}</b></div>`).join('') || '<p class="muted">No transactions yet.</p>'}</div>`;
  onSubmit($('#topup', page), async (d) => {
    await api('/me/wallet/topups', { method: 'POST', body: { amount: Number(d.amount), method: d.method, reference: d.reference.trim() } });
    toast('Top-up submitted. We’ll add it after checking the payment.');
    render();
  });
};

views.profile = async (page) => {
  if (!requireLogin()) return;
  me = await api('/me');
  page.innerHTML = `
    <h1>My profile</h1>
    <div class="card">${personRow(me)}<p class="muted small" style="margin-top:8px">${esc(me.email)}</p></div>
    ${me.role === 'admin' ? '<a class="btn block" href="#/admin" style="margin-bottom:12px">🛠 Admin panel</a>' : ''}
    ${setupChecklist(me)}
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
    <details class="card">
      <summary><b>Delete my account</b></summary>
      <form id="delete-account" style="margin-top:12px">
        <p class="small muted">Your name, phone, ID photos and vehicle are removed and you are signed out everywhere. Past trips stay in other people's history as "Deleted user". Cancel upcoming trips first.</p>
        <div class="field"><label>Password</label><input name="password" type="password" autocomplete="current-password" required></div>
        <button class="btn danger" type="submit">Delete my account</button>
      </form>
    </details>
    <div class="actions">
      ${nativeApp ? '<button class="btn ghost" data-action="server">🌐 Change server</button>' : ''}
      <button class="btn ghost" data-action="logout">Log out</button>
    </div>
    <p class="small muted legal-links"><a href="privacy.html">Privacy policy</a> · <a href="terms.html">Terms</a> · <a href="download.html">Get the app</a></p>`;
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
  onSubmit($('#delete-account', page), async (d) => {
    if (!confirm('Delete your ABC Rides account? This cannot be undone.')) return;
    await api('/me', { method: 'DELETE', body: d });
    store.token = null; me = null; unread = { notifications: 0, messages: 0 };
    toast('Your account has been deleted');
    location.hash = '#/';
  });
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
  const tab = ['verify', 'topups', 'reports', 'users', 'places', 'settings', 'errors'].includes(q.tab) ? q.tab : 'overview';
  const tabLink = (t, label) => `<a class="btn small ${tab === t ? '' : 'ghost'}" href="#/admin?tab=${t}">${label}</a>`;
  page.innerHTML = `
    <h1>Admin</h1>
    <div class="tabs wrap">${tabLink('overview', 'Overview')}${tabLink('verify', 'Verifications')}${tabLink('topups', 'Top-ups')}${tabLink('reports', 'Reports')}${tabLink('users', 'Users')}${tabLink('places', 'Places')}${tabLink('settings', 'Settings')}${tabLink('errors', 'Errors')}</div>
    <div id="admin-body"><p class="muted">Loading…</p></div>`;
  const body = $('#admin-body', page);

  if (tab === 'overview') {
    const s = await api('/admin/stats');
    const sum = (o) => Object.values(o).reduce((a, b) => a + b, 0);
    const tile = (label, value, href) => `<a class="card stat" href="${href || '#/admin'}"><b>${value}</b><span>${label}</span></a>`;
    body.innerHTML = `
      ${s.sms_configured ? '' : `<div class="card warn small">⚠️ <b>No SMS provider is set up.</b> Phone codes are shown on screen, so phone
        verification is not secure yet. Set <code>SMS_GATEWAY_URL</code> on the server before launch.</div>`}
      ${!s.backup || !s.backup.configured
        ? `<div class="card warn small">⚠️ <b>Data is not backed up.</b> On free hosting, accounts and rides are lost when the server restarts. Set <code>DATABASE_URL</code> to a free PostgreSQL database (e.g. Neon).</div>`
        : s.backup.last_error
          ? `<div class="card warn small">⚠️ <b>Backup failing:</b> ${esc(s.backup.last_error)}</div>`
          : `<p class="small muted">✅ Data backed up${s.backup.last_saved_at ? ` · last saved ${esc(when(s.backup.last_saved_at))}` : ''}</p>`}
      <div class="stats">
        ${tile('Revenue (all time)', money(s.revenue))}
        ${tile('Revenue (30 days)', money(s.revenue_30d))}
        ${tile('Pending top-ups', s.pending_topups, '#/admin?tab=topups')}
        ${tile('Members', sum(s.users), '#/admin?tab=users')}
        ${tile('Rides scheduled', s.rides.scheduled || 0)}
        ${tile('Rides completed', s.rides.completed || 0)}
        ${tile('Seats booked', s.seats_booked)}
        ${tile('Pending verifications', s.pending_verifications, '#/admin?tab=verify')}
        ${tile('Open reports', s.open_reports, '#/admin?tab=reports')}
        ${tile('App errors (7 days)', s.errors_7d, '#/admin?tab=errors')}
      </div>
      <div class="card"><h3>Members by type</h3>
        ${Object.entries(TYPE_LABEL).map(([k, v]) => `<div class="list-row"><span>${v}</span><b>${s.users[k] || 0}</b></div>`).join('')}
      </div>
      <div class="card"><h3>Bookings</h3>
        ${['pending', 'confirmed', 'rejected', 'cancelled'].map((k) => `<div class="list-row"><span class="badge ${k}">${k}</span><b>${s.bookings[k] || 0}</b></div>`).join('')}
        <div class="list-row"><span>Open ride requests</span><b>${s.open_requests}</b></div>
      </div>`;
  } else if (tab === 'errors') {
    const rows = await api('/admin/errors');
    body.innerHTML = `
      <p class="muted small">Errors on users’ phones and on the server, newest first. Send these to your developer to fix.</p>
      ${rows.length ? `<button class="btn small ghost" data-action="clear-errors">Clear all</button>` : ''}
      ${rows.map((e) => `
        <details class="card">
          <summary><span class="badge ${e.source === 'server' ? 'cancelled' : 'pending'}">${e.source}</span> <b>${esc(e.message)}</b>
            <div class="muted small">${esc(when(e.created_at))}${e.user_name ? ` · ${esc(e.user_name)}` : ''}${e.url ? ` · ${esc(e.url)}` : ''}</div></summary>
          ${e.detail ? `<pre class="small" style="white-space:pre-wrap;overflow-wrap:anywhere">${esc(e.detail)}</pre>` : ''}
          ${e.user_agent ? `<p class="muted small">${esc(e.user_agent)}</p>` : ''}
        </details>`).join('') || '<div class="card empty">No errors recorded. 🎉</div>'}`;
    onClick(body, async (action) => {
      if (action !== 'clear-errors') return;
      await api('/admin/errors', { method: 'DELETE' });
      render();
    });
  } else if (tab === 'verify') {
    const DOC_NAMES = { cnic_front: 'CNIC front', cnic_back: 'CNIC back', selfie: 'Selfie', student_card: 'Student card', employee_card: 'Employee card',
      driving_license: 'Driving licence', vehicle_photo: 'Vehicle', vehicle_registration: 'Registration' };
    const users = await api('/admin/verifications');
    const pendingList = (u) => [u.verification_status === 'pending' && 'identity', u.student_status === 'pending' && 'student card',
      u.driver_status === 'pending' && 'driver'].filter(Boolean).join(' + ');
    body.innerHTML = users.map((u) => `
      <div class="card" data-user="${u.id}">
        <div class="ride-top"><b>${esc(u.name)}</b><span class="badge pending">${pendingList(u)}</span></div>
        <div class="small muted">${esc(u.email)} · ${esc(u.phone)} ${u.phone_verified ? '✅' : '(phone not verified)'} · ${esc(TYPE_LABEL[u.traveler_type])}${u.organization ? ` · ${esc(u.organization)}` : ''}</div>
        <div class="list-row"><span class="muted">CNIC</span><b>${esc(u.cnic || '—')}</b></div>
        ${u.licence_number ? `<div class="list-row"><span class="muted">Licence</span><b>${esc(u.licence_number)}</b></div>` : ''}
        ${u.vehicle ? `<div class="list-row"><span class="muted">Vehicle</span><b>${esc(u.vehicle.make)} ${esc(u.vehicle.model)} ${u.vehicle.year}, ${esc(u.vehicle.color)} · ${esc(u.vehicle.plate)} · ${u.vehicle.seats} seats</b></div>` : ''}
        <p class="small muted">Check: the selfie matches the CNIC photo, the name and CNIC number match the details above, the plate in the car photo matches the registration.</p>
        <div class="docs">${u.documents.map((d) => `<figure><img class="doc" alt="${esc(DOC_NAMES[d.kind] || d.kind)}" data-doc="${d.id}"><figcaption>${esc(DOC_NAMES[d.kind] || d.kind)}</figcaption></figure>`).join('')}</div>
        <div class="field"><input name="note" placeholder="Note to the user (required when rejecting)"></div>
        <div class="actions">
          <button class="btn" data-action="approve" data-id="${u.id}">Approve all</button>
          <button class="btn ghost" data-action="decline" data-id="${u.id}">Reject</button>
        </div>
      </div>`).join('') || '<div class="card empty">No pending verifications 🎉</div>';
    body.querySelectorAll('img[data-doc]').forEach(async (img) => {
      const res = await fetch(`/api/admin/documents/${img.dataset.doc}`, { headers: { authorization: `Bearer ${store.token}` } });
      if (res.ok) img.src = URL.createObjectURL(await res.blob());
    });
    body.addEventListener('click', (e) => {
      // Tap a document to see it full size.
      if (e.target.matches('img.doc') && e.target.src) window.open(e.target.src, '_blank');
    });
    onClick(body, async (action, data) => {
      const note = body.querySelector(`[data-user="${data.id}"] input[name=note]`).value.trim();
      if (action === 'decline' && !note) throw new Error('Please write a note telling the user what to fix');
      await api(`/admin/users/${data.id}/review`, { method: 'POST', body: { approve: action === 'approve', note } });
      toast(action === 'approve' ? 'Approved' : 'Rejected');
      render();
    });
  } else if (tab === 'topups') {
    const status = ['approved', 'rejected'].includes(q.status) ? q.status : 'pending';
    const rows = await api(`/admin/topups?status=${status}`);
    const sub = (st, label) => `<a class="btn small ${status === st ? '' : 'ghost'}" href="#/admin?tab=topups&status=${st}">${label}</a>`;
    body.innerHTML = `
      <div class="tabs">${sub('pending', 'Pending')}${sub('approved', 'Approved')}${sub('rejected', 'Rejected')}</div>
      <p class="muted small">Check each transaction ID in your JazzCash / Easypaisa / bank app before approving.</p>
      ${rows.map((t) => `
      <div class="card" data-topup="${t.id}">
        <div class="ride-top"><b>${money(t.amount)}</b><span class="muted small">${timeAgo(t.created_at)}</span></div>
        <div class="small"><a href="#/user/${t.user_id}">${esc(t.user_name)}</a> · ${esc(t.user_phone)}</div>
        <div class="list-row"><span class="muted">${esc(t.method)}</span><b class="plate">${esc(t.reference)}</b></div>
        ${t.note ? `<p class="small muted">${esc(t.note)}</p>` : ''}
        ${status === 'pending' ? `
        <div class="field"><input name="note" placeholder="Note (if rejecting)"></div>
        <div class="actions">
          <button class="btn small" data-action="approve" data-id="${t.id}">Approve & credit</button>
          <button class="btn small ghost" data-action="reject" data-id="${t.id}">Reject</button>
        </div>` : ''}
      </div>`).join('') || '<div class="card empty">Nothing here.</div>'}`;
    onClick(body, async (action, data) => {
      const note = body.querySelector(`[data-topup="${data.id}"] input[name=note]`)?.value;
      await api(`/admin/topups/${data.id}/${action}`, { method: 'POST', body: { note } });
      toast(action === 'approve' ? 'Wallet credited' : 'Rejected');
      render();
    });
  } else if (tab === 'places') {
    const [places, distances] = await Promise.all([api('/places'), api('/admin/distances')]);
    const byCity = {};
    for (const p of places) (byCity[p.city] = byCity[p.city] || []).push(p);
    body.innerHTML = `
      <div class="card">
        <h3>Road distances</h3>
        <p class="small muted">${distances.length ? `${distances.length} city pairs from the map routing service (last updated ${timeAgo(distances[0].updated_at)}).`
    : 'Using built-in estimates. Load real road distances between all cities from the map routing service (OpenStreetMap / OSRM).'}</p>
        <button class="btn small" data-action="refresh-distances">🗺️ Update distances from maps</button>
      </div>
      <form id="add-place" class="card">
        <h3>Add a pickup / drop-off point</h3>
        <p class="small muted">In Google Maps, long-press the spot and copy the coordinates (e.g. 31.5040, 74.3310).</p>
        <div class="row three">
          <div class="field"><label>City</label><input name="city" list="cities" required></div>
          <div class="field"><label>Name</label><input name="name" placeholder="e.g. Daewoo Terminal" required></div>
          <div class="field"><label>Coordinates</label><input name="coords" placeholder="31.5040, 74.3310" required></div>
        </div>
        ${cityOptions()}
        <button class="btn small" type="submit">Add point</button>
      </form>
      ${Object.entries(byCity).map(([city, list]) => `
      <details class="card"><summary><b>${esc(city)}</b> <span class="muted small">${list.length} point(s)</span></summary>
        ${list.map((p) => `
        <form class="list-row place-row" data-id="${p.id}">
          <input name="name" value="${esc(p.name)}" style="flex:2;min-width:160px">
          <input name="coords" value="${p.lat}, ${p.lon}" style="flex:1;min-width:150px">
          <span class="actions">
            <a class="btn small ghost" href="${mapLink(p.lat, p.lon)}" target="_blank" rel="noopener">Map</a>
            <button class="btn small" type="submit">Save</button>
            <button class="btn small ghost" type="button" data-action="hide-place" data-id="${p.id}">Remove</button>
          </span>
        </form>`).join('')}
      </details>`).join('')}`;
    onSubmit($('#add-place', body), async (d) => {
      const loc = parseLocation(d.coords);
      if (!loc) throw new Error('Coordinates should look like 31.5040, 74.3310');
      await api('/admin/places', { method: 'POST', body: { city: d.city, name: d.name, ...loc } });
      toast('Point added');
      render();
    });
    body.querySelectorAll('form.place-row').forEach((f) => onSubmit(f, async (d) => {
      const loc = parseLocation(d.coords);
      if (!loc) throw new Error('Coordinates should look like 31.5040, 74.3310');
      await api(`/admin/places/${f.dataset.id}`, { method: 'PATCH', body: { name: d.name, ...loc } });
      toast('Saved');
    }));
    onClick(body, async (action, data) => {
      if (action === 'hide-place') {
        if (!confirm('Remove this point? Existing rides keep it.')) return;
        await api(`/admin/places/${data.id}`, { method: 'DELETE' });
        toast('Removed');
        render();
      }
      if (action === 'refresh-distances') {
        const res = await api('/admin/distances/refresh', { method: 'POST' });
        toast(`Updated ${res.updated} city distances from maps`);
        render();
      }
    });
  } else if (tab === 'settings') {
    const { values, spec } = await api('/admin/settings');
    const MODE = { driver_choice: 'Driver decides (instant or approve)', manual: 'Driver must approve every booking', instant: 'Every booking is confirmed instantly' };
    const groups = [
      ['Booking acceptance', ['booking_mode']],
      ['Fares per km', ['fare_per_km', 'fare_min_per_km', 'fare_max_per_km', 'enforce_fare_limits']],
      ['Fees', ['driver_commission_pct', 'passenger_commission_pct', 'free_confirmations', 'min_topup']],
      ['Driver benefits for sharing', ['share_discount_2_pct', 'share_discount_3_pct', 'share_bonus_points']],
      ['Home pickup & drop', ['home_pickup_per_km', 'home_pickup_min', 'home_max_radius_km']],
      ['Calculator & comparisons', ['petrol_price', 'car_km_per_litre', 'ref_bus_per_km', 'ref_private_car_per_km']],
      ['Reliability points', ['reliability_threshold', 'low_reliability_fee', 'penalty_driver_cancel', 'penalty_passenger_cancel', 'late_cancel_hours', 'reward_completed']],
      ['Onboarding & security', ['require_phone_verification', 'require_id_for_booking', 'require_driver_approval', 'student_price_requires_verification']],
      ['Wallet top-up accounts', ['topup_accounts']],
    ];
    const input = (k) => {
      const sp = spec[k];
      const v = values[k];
      if (sp.type === 'boolean') return `<label class="check"><input type="checkbox" name="${k}" ${v ? 'checked' : ''}> ${esc(sp.label)}</label>`;
      if (sp.options) return `<div class="field"><label>${esc(sp.label)}</label><select name="${k}">${sp.options.map((o) => `<option value="${o}" ${o === v ? 'selected' : ''}>${esc(MODE[o] || o)}</option>`).join('')}</select></div>`;
      if (sp.type === 'number') return `<div class="field"><label>${esc(sp.label)}</label><input name="${k}" type="number" min="${sp.min}" max="${sp.max}" value="${v}" required></div>`;
      return `<div class="field"><label>${esc(sp.label)}</label><textarea name="${k}" rows="3">${esc(v)}</textarea></div>`;
    };
    body.innerHTML = `
      <form id="settings">
        ${groups.map(([title, keys]) => `<div class="card"><h3>${title}</h3>${keys.map(input).join('')}</div>`).join('')}
        <button class="btn block" type="submit">Save settings</button>
      </form>`;
    onSubmit($('#settings', body), async (_d, form) => {
      const patch = {};
      for (const [k, sp] of Object.entries(spec)) {
        const el = form.elements[k];
        if (!el) continue;
        patch[k] = sp.type === 'boolean' ? el.checked : sp.type === 'number' ? Number(el.value) : el.value;
      }
      settings = (await api('/admin/settings', { method: 'PUT', body: patch })).values;
      toast('Settings saved');
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
              <span class="badge ${u.verification_status === 'verified' ? 'confirmed' : u.verification_status === 'pending' ? 'pending' : ''}">ID ${u.verification_status === 'none' ? 'not verified' : u.verification_status}</span>
              ${u.driver_status !== 'none' ? `<span class="badge ${u.driver_status === 'approved' ? 'confirmed' : u.driver_status === 'pending' ? 'pending' : 'cancelled'}">driver ${u.driver_status}</span>` : ''}
              ${u.phone_verified ? '<span class="badge">📱 verified</span>' : ''}
              <span class="badge">${money(u.wallet_balance)}</span>
              <span class="badge ${u.reliability < settings.reliability_threshold ? 'cancelled' : ''}">${u.reliability}% reliable</span>
              ${u.suspended ? '<span class="badge cancelled">suspended</span>' : ''}
            </div>
            <details class="small" style="margin-top:6px"><summary>Wallet & reliability</summary>
              <form class="adjust" data-user="${u.id}" style="margin-top:8px">
                <div class="row two">
                  <input name="amount" type="number" placeholder="Rs, e.g. 200 or -200" required>
                  <input name="note" placeholder="Reason" required>
                </div>
                <button class="btn small" type="submit" style="margin-top:6px">Adjust wallet</button>
              </form>
              <form class="reliab" data-user="${u.id}" style="margin-top:8px">
                <input name="reliability" type="number" min="0" max="100" value="${u.reliability}" style="width:100px">
                <button class="btn small ghost" type="submit">Set reliability</button>
              </form>
            </details>
          </div>
          <button class="btn small ghost" data-action="temp-password" data-user="${u.id}" data-name="${esc(u.name)}">Temporary password</button>
          ${u.role !== 'admin' ? `<button class="btn small ${u.suspended ? '' : 'danger'}" data-action="suspend" data-user="${u.id}" data-suspended="${u.suspended ? 0 : 1}">${u.suspended ? 'Unsuspend' : 'Suspend'}</button>` : ''}
        </div>
      </div>`).join('') || '<div class="card empty">No users found.</div>'}`;
    onSubmit($('#user-search', body), (d) => { location.hash = `#/admin?tab=users&q=${encodeURIComponent(d.q)}`; });
    body.querySelectorAll('form.adjust').forEach((f) => onSubmit(f, async (d) => {
      await api(`/admin/users/${f.dataset.user}/wallet`, { method: 'POST', body: { amount: Number(d.amount), note: d.note } });
      toast('Wallet adjusted');
      render();
    }));
    body.querySelectorAll('form.reliab').forEach((f) => onSubmit(f, async (d) => {
      await api(`/admin/users/${f.dataset.user}/reliability`, { method: 'POST', body: { reliability: Number(d.reliability) } });
      toast('Reliability updated');
      render();
    }));
    onClick(body, async (action, data) => {
      if (action === 'temp-password') {
        if (!confirm(`Set a temporary password for ${data.name}? Only do this after checking it is really them (e.g. call their verified phone). They will be logged out everywhere.`)) return;
        const res = await api(`/admin/users/${data.user}/temp-password`, { method: 'POST' });
        prompt(`Temporary password for ${data.name}. Tell them to change it in Profile → Change password after logging in.`, res.password);
        return;
      }
      if (action !== 'suspend') return;
      if (data.suspended === '1' && !confirm('Suspend this user? They will be logged out everywhere.')) return;
      await api(`/admin/users/${data.user}/suspend`, { method: 'POST', body: { suspended: data.suspended === '1' } });
      toast('Updated');
      render();
    });
  }
};

// ---- Error reporting --------------------------------------------------------
// Unexpected errors on the phone are sent to the server so admins can see them
// (Admin → Errors). A few per page load at most, without repeats.
const reported = new Set();
function reportError(message, stack) {
  const key = String(message).slice(0, 200);
  if (!message || reported.has(key) || reported.size >= 5) return;
  reported.add(key);
  fetch('/api/client-errors', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(store.token ? { authorization: `Bearer ${store.token}` } : {}) },
    body: JSON.stringify({ message: key, stack: stack ? String(stack).slice(0, 4000) : null, url: location.hash || '/' }),
  }).catch(() => {});
}
window.addEventListener('error', (e) => reportError(e.message, e.error && e.error.stack));
window.addEventListener('unhandledrejection', (e) => {
  const r = e.reason || {};
  // Expected API refusals (wrong password, full ride...) are not bugs.
  if (r.status && r.status < 500) return;
  reportError(r.message || String(r), r.stack);
});

// ---- Router -----------------------------------------------------------------

function parseHash() {
  const [path, query = ''] = location.hash.slice(1).split('?');
  const parts = (path || '/').split('/').filter(Boolean);
  return { name: parts[0] || 'home', id: parts[1], query: Object.fromEntries(new URLSearchParams(query)) };
}

const NAV_GROUP = {
  search: 'home', requests: 'offer', register: 'login', forgot: 'login', chat: 'inbox', admin: 'profile', user: 'home', ride: 'trips',
  'verify-phone': 'profile', 'verify-id': 'profile', driver: 'offer', wallet: 'profile',
};

function renderNav(active) {
  const total = unread.notifications + unread.messages;
  const links = [
    ['home', '#/', 'search', 'Find'],
    ['offer', '#/offer', 'plus', 'Offer'],
    ['trips', '#/trips', 'route', 'Trips'],
    ['inbox', '#/inbox', 'bell', 'Inbox', total],
    me ? ['profile', '#/profile', 'user', 'Profile'] : ['login', '#/login', 'user', 'Log in'],
  ];
  const group = NAV_GROUP[active] || active;
  const badge = (n) => (n ? `<i class="dot">${n > 9 ? '9+' : n}</i>` : '');
  $('#nav').innerHTML = links.map(([n, href, ic, label, count]) => `<a href="${href}" class="${n === group ? 'active' : ''}">${icon(ic)}${label}${badge(count)}</a>`).join('');
  $('#tabbar').innerHTML = links.map(([n, href, ic, label, count]) => `<a href="${href}" class="${n === group ? 'active' : ''}"><span>${icon(ic)}${badge(count)}</span>${label}</a>`).join('');
  $('#top-right').innerHTML = me ? `<a class="wallet-chip" href="#/wallet" title="Wallet">${icon('wallet')}${money(me.wallet_balance)}</a>` : '';
}

// Emojis in templates and server messages become matching icons (Lucide), so
// the app looks the same on every phone instead of depending on emoji fonts.
const EMOJI_ICONS = {
  '📍': 'map-pin', '🕒': 'clock', '💺': 'armchair', '🚗': 'car', '💬': 'message-circle', '📞': 'phone', '📱': 'phone',
  '💳': 'credit-card', '🚘': 'car-front', '🚨': 'siren', '📤': 'share-2', '✏️': 'pencil', '🔒': 'lock', '💰': 'wallet',
  '🏠': 'house', '🎓': 'graduation-cap', '⚡': 'zap', '🛑': 'milestone', '🛣️': 'route', '📅': 'calendar', '🙋': 'hand',
  '📷': 'camera', '🛠': 'settings', '🌐': 'globe', '🗺️': 'map', '📩': 'send', '💼': 'briefcase', '🧳': 'backpack',
  '⚠️': 'triangle-alert', '✅': 'circle-check', '✔': 'badge-check', '♀': 'venus', '💵': 'banknote', '🏦': 'banknote',
  '🎉': 'sparkles', '👋': 'hand', '🔍': 'search', '➕': 'plus', '🧭': 'route', '🔔': 'bell', '👤': 'user', '⏳': 'history',
};
const EMOJI_RE = new RegExp(Object.keys(EMOJI_ICONS).sort((a, b) => b.length - a.length).map((e) => e.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g');

function iconize(root) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const hits = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    EMOJI_RE.lastIndex = 0;
    if (EMOJI_RE.test(n.nodeValue)) hits.push(n);
  }
  for (const node of hits) {
    const parent = node.parentNode;
    if (!parent) continue;
    // Options and text areas can only hold text: drop the emoji there.
    if (['OPTION', 'TEXTAREA', 'TITLE'].includes(parent.nodeName)) {
      node.nodeValue = node.nodeValue.replace(EMOJI_RE, '').trimStart();
      continue;
    }
    const tpl = document.createElement('template');
    tpl.innerHTML = esc(node.nodeValue).replace(EMOJI_RE, (e) => icon(EMOJI_ICONS[e]));
    parent.replaceChild(tpl.content, node);
  }
}

new MutationObserver((records) => {
  for (const r of records) r.addedNodes.forEach((n) => { if (n.nodeType === 1 || n.nodeType === 3) iconize(n.nodeType === 1 ? n : n.parentNode || document.body); });
}).observe(document.body, { childList: true, subtree: true });

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
    if (!err.status || err.status >= 500) reportError(`${name}: ${err.message}`, err.stack);
    page.innerHTML = `<div class="card empty"><p>${esc(err.message)}</p><a class="btn" href="#/">Go home</a></div>`;
  }
  renderNav(parseHash().name);
}

// Loads the session and settings once; pages render only after this, so a
// navigation during start-up does not render as logged out.
const ready = (async function init() {
  [cities, settings] = await Promise.all([
    api('/cities').catch(() => []),
    api('/settings').catch(() => ({})),
    store.token ? api('/me').then((u) => { me = u; }).catch(() => { store.token = null; }) : null,
  ]);
})();

window.addEventListener('hashchange', async () => {
  await ready;
  render();
  window.scrollTo(0, 0);
});

ready.then(() => {
  render();
  refreshUnread();
  setInterval(refreshUnread, 30000);
});
