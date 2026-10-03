// Voice search: what people say, in Urdu, Roman Urdu or English, becomes a ride search.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseVoiceQuery } = require('../public/voice');
const { CITIES } = require('../server/geo');

const SATURDAY = new Date('2026-10-03T10:00:00'); // a Saturday
const parse = (text) => parseVoiceQuery(text, CITIES, SATURDAY);

test('Roman Urdu: "X se Y", day and time of day', () => {
  assert.deepEqual(parse('Lahore se Faisalabad kal subah'), { from: 'Lahore', to: 'Faisalabad', date: '2026-10-04', time: 'morning' });
  assert.deepEqual(parse('mujhe faisalabad jana hai lahore se'), { from: 'Lahore', to: 'Faisalabad' }, '"se" marks where you leave from, whatever the order');
  assert.deepEqual(parse('Kal Lahore jana hai'), { to: 'Lahore', date: '2026-10-04' });
  assert.equal(parse('lyallpur se lahor').from, 'Faisalabad', 'old and short names');
});

test('Urdu script, Urdu numbers and seats', () => {
  assert.deepEqual(parse('لاہور سے ساہیوال پرسوں دو سیٹ'), { from: 'Lahore', to: 'Sahiwal', date: '2026-10-05', seats: 2 });
  assert.deepEqual(parse('ساہیوال سے فیصل آباد آج شام کو'), { from: 'Sahiwal', to: 'Faisalabad', date: '2026-10-03', time: 'evening' });
  assert.equal(parse('فیصل آباد سے لاہور ۳ لوگ').seats, 3);
  assert.equal(parse('پنڈی سے اسلام آباد').from, 'Rawalpindi');
});

test('English, weekdays and women-only', () => {
  assert.deepEqual(parse('from Sahiwal to Lahore tomorrow evening'), { from: 'Sahiwal', to: 'Lahore', date: '2026-10-04', time: 'evening' });
  assert.deepEqual(parse('faisal abad to lahor friday 3 seats ladies'), { from: 'Faisalabad', to: 'Lahore', date: '2026-10-09', seats: 3, women_only: true });
  assert.equal(parse('Lahore to Sahiwal on Saturday').date, '2026-10-03', 'today when the weekday is today');
  assert.equal(parse('Lahore to Sahiwal on Monday').date, '2026-10-05');
});

test('things that are not cities or seats are ignored', () => {
  assert.deepEqual(parse('hello, what can I do here?'), {}, '"do" alone is not a seat count');
  assert.deepEqual(parse('Lahore se Lahore'), { from: 'Lahore' }, 'the same city twice is not a trip');
  assert.equal(parse('Murree').to, 'Murree');
  assert.equal(parse('Murreeeee').to, undefined, 'whole words only');
});
