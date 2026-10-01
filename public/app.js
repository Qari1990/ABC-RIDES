'use strict';

// ---- State & API ------------------------------------------------------------

const store = {
  get token() { try { return localStorage.getItem('token'); } catch { return null; } },
  set token(v) { try { v ? localStorage.setItem('token', v) : localStorage.removeItem('token'); } catch { /* private mode */ } },
};
let me = null;
let cities = [];

async function api(path, { method = 'GET', body } = {}) {
  const headers = {};
  if (body) headers['content-type'] = 'application/json';
  if (store.token) headers.authorization = `Bearer ${store.token}`;
  const res = await fetch(`/api${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  if (res.status === 401 && store.token && path !== '/auth/login') { store.token = null; me = null; }
  if (!res.ok) throw new Error((data && data.error) || `Request failed (${res.status})`);
  return data;
}

// ---- Helpers ----------------------------------------------------------------

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (n) => `Rs ${Number(n).toLocaleString('en-PK')}`;
const when = (iso) => new Date(iso).toLocaleString('en-PK', { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
const initials = (name) => name.split(/\s+/).map((p) => p[0]).slice(0, 2).join('').toUpperCase();
const stars = (n) => '★'.repeat(Math.round(n)) + '☆'.repeat(5 - Math.round(n));
const TYPE_LABEL = { professional: 'Working professional', student: 'Student', traveler: 'Regular traveller' };
const isPast = (iso) => new Date(iso) <= new Date();

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
    target.disabled = true;
    try { await handler(target.dataset.action, target.dataset); } catch (err) { toast(err.message, true); } finally { target.disabled = false; }
  });
}

function requireLogin() {
  if (me) return true;
  location.hash = `#/login?next=${encodeURIComponent(location.hash.slice(1))}`;
  return false;
}

// ---- Components -------------------------------------------------------------

function rideCard(r) {
  const showStudent = r.student_discount_pct > 0;
  return `
  <a class="card" href="#/ride/${r.id}">
    <div class="ride-top">
      <div>
        <div class="route">${esc(r.from_city)} <span class="arrow">→</span> ${esc(r.to_city)}</div>
        <div class="meta"><span>🕒 ${when(r.departure_at)}</span><span>💺 ${r.seats_left} left</span>${r.pickup_point ? `<span>📍 ${esc(r.pickup_point)}</span>` : ''}</div>
      </div>
      <div class="price">${money(r.your_price ?? r.price_per_seat)}<small>per seat</small></div>
    </div>
    <div class="badges">
      <span class="badge">${esc(r.driver.name)}${r.driver.rating_avg ? ` · ★ ${r.driver.rating_avg}` : ''}</span>
      ${showStudent ? `<span class="badge student">🎓 ${r.student_discount_pct}% student discount</span>` : ''}
      ${r.women_only ? '<span class="badge women">♀ Women only</span>' : ''}
      ${r.instant_book ? '<span class="badge">⚡ Instant booking</span>' : ''}
    </div>
  </a>`;
}

function personRow(u, extra = '') {
  return `
  <a class="person" href="#/user/${u.id}" style="color:inherit;text-decoration:none">
    <div class="avatar">${esc(initials(u.name))}</div>
    <div>
      <div><b>${esc(u.name)}</b></div>
      <div class="muted small">${esc(TYPE_LABEL[u.traveler_type] || '')}${u.organization ? ` · ${esc(u.organization)}` : ''}</div>
      <div class="small">${u.rating_avg ? `<span class="stars">${stars(u.rating_avg)}</span> ${u.rating_avg} (${u.rating_count})` : '<span class="muted">No reviews yet</span>'}${extra}</div>
    </div>
  </a>`;
}

function searchForm(q = {}) {
  const date = q.date || '';
  return `
  <form id="search" class="card">
    ${cityOptions()}
    <div class="row two">
      <div class="field"><label for="from">From</label><input id="from" name="from" list="cities" placeholder="e.g. Lahore" value="${esc(q.from)}" required></div>
      <div class="field"><label for="to">To</label><input id="to" name="to" list="cities" placeholder="e.g. Islamabad" value="${esc(q.to)}" required></div>
    </div>
    <div class="row two">
      <div class="field"><label for="date">Date <span class="muted">(optional)</span></label><input id="date" name="date" type="date" value="${esc(date)}"></div>
      <div class="field"><label for="seats">Seats</label><select id="seats" name="seats">${[1, 2, 3, 4].map((n) => `<option ${String(q.seats) === String(n) ? 'selected' : ''}>${n}</option>`).join('')}</select></div>
    </div>
    <label class="check"><input type="checkbox" name="women_only" value="true" ${q.women_only === 'true' ? 'checked' : ''}> Women-only rides</label>
    <button class="btn block" type="submit">Find a ride</button>
  </form>`;
}

function bindSearch() {
  onSubmit($('#search'), (d) => {
    const params = new URLSearchParams({ from: d.from.trim(), to: d.to.trim(), date: d.date || '', seats: d.seats });
    if (d.women_only) params.set('women_only', 'true');
    location.hash = `#/search?${params}`;
  });
}

// ---- Views ------------------------------------------------------------------

const views = {};

views.home = async (view) => {
  view.innerHTML = `
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
    <div class="actions" style="margin-bottom:16px"><a class="btn ghost block" href="#/offer">🚗 Driving somewhere? Offer your empty seats</a></div>
    <h2>Upcoming rides</h2>
    <div id="upcoming"><p class="muted">Loading…</p></div>`;
  bindSearch();
  const rides = await api('/rides');
  $('#upcoming').innerHTML = rides.length
    ? rides.slice(0, 10).map(rideCard).join('')
    : '<div class="card empty">No rides posted yet. Be the first to <a href="#/offer">offer one</a>!</div>';
};

views.search = async (view, q) => {
  view.innerHTML = `${searchForm(q)}<div id="results"><p class="muted">Searching…</p></div>`;
  bindSearch();
  const params = new URLSearchParams({ from: q.from || '', to: q.to || '', seats: q.seats || '1' });
  if (q.women_only) params.set('women_only', 'true');
  if (q.date) {
    const start = new Date(`${q.date}T00:00`);
    params.set('after', start.toISOString());
    params.set('before', new Date(start.getTime() + 864e5).toISOString());
  }
  const rides = await api(`/rides?${params}`);
  $('#results').innerHTML = `
    <h2>${rides.length} ride${rides.length === 1 ? '' : 's'} from ${esc(q.from)} to ${esc(q.to)}</h2>
    ${rides.map(rideCard).join('') || `<div class="card empty">No rides found for this day.<br><a href="#/search?${new URLSearchParams({ from: q.from || '', to: q.to || '', seats: q.seats || '1' })}">See all upcoming dates</a></div>`}`;
};

views.ride = async (view, _q, id) => {
  const r = await api(`/rides/${id}`);
  const isDriver = me && me.id === r.driver.id;
  const b = r.my_booking;
  const activeBooking = b && ['pending', 'confirmed'].includes(b.status);
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
          ${x.status === 'pending' && r.status === 'scheduled' ? `
            <button class="btn small" data-action="confirm" data-id="${x.id}">Accept</button>
            <button class="btn small ghost" data-action="reject" data-id="${x.id}">Decline</button>` : ''}
        </div>
      </div>`).join('');
    bookingSection = `
      <div class="card">
        <h3>Booking requests</h3>
        ${rows || '<p class="muted">No bookings yet. Share this page with colleagues and classmates!</p>'}
      </div>
      ${r.status === 'scheduled' ? `<div class="actions">
        ${departed ? '<button class="btn" data-action="complete">Mark ride completed</button>' : ''}
        <button class="btn danger" data-action="cancel-ride">Cancel ride</button>
      </div>` : ''}`;
  } else if (activeBooking) {
    bookingSection = `
      <div class="card">
        <h3>Your booking <span class="badge ${b.status}">${b.status}</span></h3>
        <p>${b.seats} seat(s) · ${money(b.price_per_seat * b.seats)} to pay the driver</p>
        ${b.status === 'pending' ? '<p class="muted small">The driver will accept or decline your request soon.</p>' : ''}
        ${r.driver.phone ? `<p>📞 Driver: <a href="tel:${esc(r.driver.phone)}">${esc(r.driver.phone)}</a></p>` : ''}
        ${r.status === 'scheduled' ? `<button class="btn ghost" data-action="cancel-booking" data-id="${b.id}">Cancel booking</button>` : ''}
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

  view.innerHTML = `
    <p><a href="javascript:history.back()">← Back</a></p>
    <div class="card">
      <div class="ride-top">
        <div>
          <div class="route">${esc(r.from_city)} <span class="arrow">→</span> ${esc(r.to_city)}</div>
          <div class="meta"><span>🕒 ${when(r.departure_at)}</span><span>💺 ${r.seats_left} of ${r.seats_total} seats left</span></div>
        </div>
        <div class="price">${money(r.your_price)}<small>per seat</small></div>
      </div>
      <div class="badges">
        ${r.status !== 'scheduled' ? `<span class="badge ${r.status}">${r.status}</span>` : ''}
        ${r.student_discount_pct ? `<span class="badge student">🎓 Students ${money(r.student_price)} (${r.student_discount_pct}% off)</span>` : ''}
        ${r.women_only ? '<span class="badge women">♀ Women only</span>' : ''}
        ${r.instant_book ? '<span class="badge">⚡ Instant booking</span>' : '<span class="badge">Driver approves requests</span>'}
      </div>
      <div class="list-row" style="margin-top:12px"><span class="muted">Pickup</span><span>${esc(r.pickup_point || 'Ask the driver')}</span></div>
      <div class="list-row"><span class="muted">Drop-off</span><span>${esc(r.dropoff_point || 'Ask the driver')}</span></div>
      ${r.vehicle ? `<div class="list-row"><span class="muted">Vehicle</span><span>${esc(r.vehicle)}</span></div>` : ''}
      ${r.notes ? `<div class="list-row"><span class="muted">Notes</span><span>${esc(r.notes)}</span></div>` : ''}
    </div>
    <div class="card">
      <h3>Driver</h3>
      ${personRow(r.driver)}
      ${r.passengers.length ? `<h3 style="margin-top:12px">Passengers</h3><p>${r.passengers.map((p) => `<a href="#/user/${p.id}">${esc(p.name)}</a>`).join(', ')}</p>` : ''}
    </div>
    ${!me && r.status === 'scheduled' && !departed ? `<a class="btn block" href="#/login?next=${encodeURIComponent(`/ride/${r.id}`)}">Log in to book</a>` : ''}
    ${me ? bookingSection : ''}
    ${reviewSection}`;

  const rerender = () => views.ride(view, _q, id);
  const book = $('#book', view);
  if (book) {
    onSubmit(book, async (d) => {
      const res = await api(`/rides/${r.id}/bookings`, { method: 'POST', body: { seats: Number(d.seats), message: d.message } });
      toast(res.status === 'confirmed' ? 'Booked! Your seat is confirmed.' : 'Request sent to the driver.');
      await rerender();
    });
  }
  view.querySelectorAll('form.review').forEach((form) => onSubmit(form, async (d) => {
    await api(`/rides/${r.id}/reviews`, { method: 'POST', body: { reviewee_id: Number(form.dataset.reviewee), rating: Number(d.rating), comment: d.comment } });
    toast('Thanks for your review!');
    await rerender();
  }));
  onClick(view, async (action, data) => {
    if (action === 'confirm' || action === 'reject') await api(`/bookings/${data.id}/${action}`, { method: 'POST' });
    if (action === 'cancel-booking') {
      if (!confirm('Cancel your booking?')) return;
      await api(`/bookings/${data.id}/cancel`, { method: 'POST' });
    }
    if (action === 'cancel-ride') {
      if (!confirm('Cancel this ride? All passengers will be notified that it is cancelled.')) return;
      await api(`/rides/${r.id}/cancel`, { method: 'POST' });
    }
    if (action === 'complete') await api(`/rides/${r.id}/complete`, { method: 'POST' });
    toast('Updated');
    await rerender();
  });
};

views.offer = async (view) => {
  if (!requireLogin()) return;
  const start = new Date(Date.now() + 864e5);
  start.setHours(8, 0, 0, 0);
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  view.innerHTML = `
    <h1>Offer a ride</h1>
    <p class="muted">Going between cities anyway? Fill your empty seats and share fuel and toll costs.</p>
    <form id="offer" class="card">
      ${cityOptions()}
      <div class="row two">
        <div class="field"><label for="of">From</label><input id="of" name="from_city" list="cities" required></div>
        <div class="field"><label for="ot">To</label><input id="ot" name="to_city" list="cities" required></div>
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
      <div class="row two">
        <div class="field"><label for="ov">Vehicle</label><input id="ov" name="vehicle" placeholder="e.g. Toyota Corolla, white"></div>
        <div class="field"><label for="osd">Student discount (%)</label><input id="osd" name="student_discount_pct" type="number" min="0" max="100" value="0"></div>
      </div>
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

  const form = $('#offer');
  onSubmit(form, async (d) => {
    const first = new Date(d.departure_at);
    const picked = [...form.querySelectorAll('input[name=day]:checked')].map((el) => Number(el.value));
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
        instant_book: !!d.instant_book, women_only: !!d.women_only,
      },
    });
    toast(created.length > 1 ? `Published ${created.length} rides` : 'Ride published');
    location.hash = created.length > 1 ? '#/trips?tab=driving' : `#/ride/${created[0].id}`;
  });
};

views.trips = async (view, q) => {
  if (!requireLogin()) return;
  const tab = q.tab === 'driving' ? 'driving' : 'booked';
  view.innerHTML = `
    <h1>My trips</h1>
    <div class="tabs">
      <a class="btn ${tab === 'booked' ? '' : 'ghost'}" href="#/trips?tab=booked" style="flex:1">As passenger</a>
      <a class="btn ${tab === 'driving' ? '' : 'ghost'}" href="#/trips?tab=driving" style="flex:1">As driver</a>
    </div>
    <div id="list"><p class="muted">Loading…</p></div>`;

  if (tab === 'booked') {
    const rows = await api('/me/bookings');
    $('#list').innerHTML = rows.map((b) => `
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
  } else {
    const rides = await api('/me/rides');
    $('#list').innerHTML = rides.map((r) => `
      <a class="card" href="#/ride/${r.id}">
        <div class="ride-top">
          <div>
            <div class="route">${esc(r.from_city)} <span class="arrow">→</span> ${esc(r.to_city)}</div>
            <div class="meta"><span>🕒 ${when(r.departure_at)}</span><span>💺 ${r.seats_total - r.seats_left}/${r.seats_total} booked</span></div>
          </div>
          <div class="price">${money(r.price_per_seat)}<small>per seat</small></div>
        </div>
        <div class="badges">
          <span class="badge ${r.status}">${r.status}</span>
          ${r.pending_requests ? `<span class="badge pending">${r.pending_requests} new request(s)</span>` : ''}
        </div>
      </a>`).join('') || '<div class="card empty">You haven’t offered any rides. <a href="#/offer">Offer one</a></div>';
  }
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

views.login = async (view, q) => {
  if (me) { location.hash = '#/'; return; }
  view.innerHTML = `
    <h1>Log in</h1>
    <form id="login" class="card">
      <div class="field"><label for="le">Email</label><input id="le" name="email" type="email" autocomplete="email" required></div>
      <div class="field"><label for="lp">Password</label><input id="lp" name="password" type="password" autocomplete="current-password" required></div>
      <button class="btn block" type="submit">Log in</button>
    </form>
    <p class="muted">New here? <a href="#/register${q.next ? `?next=${encodeURIComponent(q.next)}` : ''}">Create an account</a></p>`;
  onSubmit($('#login'), async (d) => {
    const res = await api('/auth/login', { method: 'POST', body: d });
    store.token = res.token; me = res.user;
    location.hash = `#${q.next || '/'}`;
  });
};

views.register = async (view, q) => {
  if (me) { location.hash = '#/'; return; }
  view.innerHTML = `
    <h1>Create your account</h1>
    <form id="register" class="card">
      ${profileFields()}
      <div class="field"><label for="re">Email</label><input id="re" name="email" type="email" autocomplete="email" required></div>
      <div class="field"><label for="rp">Password</label><input id="rp" name="password" type="password" minlength="8" autocomplete="new-password" required></div>
      <button class="btn block" type="submit">Sign up</button>
    </form>
    <p class="muted">Already have an account? <a href="#/login">Log in</a></p>`;
  onSubmit($('#register'), async (d) => {
    const res = await api('/auth/register', { method: 'POST', body: d });
    store.token = res.token; me = res.user;
    toast(`Welcome, ${me.name.split(' ')[0]}!`);
    location.hash = `#${q.next || '/'}`;
  });
};

views.profile = async (view) => {
  if (!requireLogin()) return;
  me = await api('/me');
  view.innerHTML = `
    <h1>My profile</h1>
    <div class="card">${personRow(me)}<p class="muted small" style="margin-top:8px">${esc(me.email)}</p></div>
    <form id="profile" class="card">
      ${profileFields(me)}
      <div class="field"><label for="pb">About me</label><textarea id="pb" name="bio" maxlength="500" placeholder="e.g. Commute Lahore ↔ Islamabad every weekend. Non-smoker.">${esc(me.bio)}</textarea></div>
      <button class="btn block" type="submit">Save</button>
    </form>
    <button class="btn ghost block" id="logout">Log out</button>`;
  onSubmit($('#profile'), async (d) => {
    me = await api('/me', { method: 'PATCH', body: d });
    toast('Profile saved');
    render();
  });
  $('#logout').addEventListener('click', async () => {
    await api('/auth/logout', { method: 'POST' }).catch(() => {});
    store.token = null; me = null;
    location.hash = '#/';
  });
};

views.user = async (view, _q, id) => {
  const u = await api(`/users/${id}`);
  view.innerHTML = `
    <p><a href="javascript:history.back()">← Back</a></p>
    <div class="card">
      ${personRow(u)}
      ${u.bio ? `<p style="margin-top:12px">${esc(u.bio)}</p>` : ''}
      <p class="muted small" style="margin-top:8px">${u.rides_driven} ride(s) driven · Member since ${new Date(u.member_since).toLocaleDateString('en-PK', { month: 'long', year: 'numeric' })}</p>
    </div>
    <h2>Reviews</h2>
    ${u.reviews.map((r) => `
      <div class="card">
        <div><span class="stars">${stars(r.rating)}</span> <b>${esc(r.reviewer_name)}</b> <span class="muted small">${new Date(r.created_at).toLocaleDateString('en-PK')}</span></div>
        ${r.comment ? `<p style="margin:6px 0 0">${esc(r.comment)}</p>` : ''}
      </div>`).join('') || '<div class="card empty">No reviews yet.</div>'}`;
};

// ---- Router -----------------------------------------------------------------

function parseHash() {
  const [path, query = ''] = location.hash.slice(1).split('?');
  const parts = (path || '/').split('/').filter(Boolean);
  return { name: parts[0] || 'home', id: parts[1], query: Object.fromEntries(new URLSearchParams(query)) };
}

function renderNav(active) {
  const links = [
    ['home', '#/', '🔍', 'Find'],
    ['offer', '#/offer', '➕', 'Offer'],
    ['trips', '#/trips', '🧭', 'Trips'],
    me ? ['profile', '#/profile', '👤', 'Profile'] : ['login', '#/login', '👤', 'Log in'],
  ];
  const isActive = (n) => n === active || (n === 'home' && active === 'search') || (n === 'login' && active === 'register');
  $('#nav').innerHTML = links.map(([n, href, , label]) => `<a href="${href}" class="${isActive(n) ? 'active' : ''}">${label}</a>`).join('');
  $('#tabbar').innerHTML = links.map(([n, href, icon, label]) => `<a href="${href}" class="${isActive(n) ? 'active' : ''}"><span>${icon}</span>${label}</a>`).join('');
}

async function render() {
  const { name, id, query } = parseHash();
  const view = $('#view');
  const fn = views[name] || views.home;
  renderNav(name);
  try {
    await fn(view, query, id);
  } catch (err) {
    view.innerHTML = `<div class="card empty"><p>${esc(err.message)}</p><a class="btn" href="#/">Go home</a></div>`;
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
})();
