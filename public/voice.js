'use strict';

// Voice search: turns what someone said, in Urdu, Roman Urdu or English, into
// a ride search. "Lahore se Faisalabad kal subah", "لاہور سے ساہیوال پرسوں دو سیٹ",
// "from Sahiwal to Lahore tomorrow evening".

// Urdu spellings and common short or old names for cities.
const CITY_ALIASES = {
  Lahore: ['لاہور', 'lahor', 'lhr'],
  Faisalabad: ['فیصل آباد', 'فیصلآباد', 'faislabad', 'faisal abad', 'fsd', 'lyallpur', 'layalpur', 'لائل پور'],
  Sahiwal: ['ساہیوال', 'ساهیوال', 'sahiwaal', 'saiwal', 'sahival', 'montgomery'],
  Islamabad: ['اسلام آباد', 'اسلامآباد', 'isb', 'islamabaad'],
  Rawalpindi: ['راولپنڈی', 'پنڈی', 'pindi', 'rwp'],
  Karachi: ['کراچی', 'khi'],
  Multan: ['ملتان'],
  Okara: ['اوکاڑہ', 'اوکاڑا', 'okarah'],
  Sheikhupura: ['شیخوپورہ', 'sheikhupora', 'shekhupura'],
  Gujranwala: ['گوجرانوالہ', 'گوجرانوالا', 'gujranwalah'],
  Sialkot: ['سیالکوٹ'],
  Peshawar: ['پشاور'],
  Hyderabad: ['حیدرآباد', 'حیدر آباد'],
  Sargodha: ['سرگودھا'],
  Jhang: ['جھنگ'],
  Bahawalpur: ['بہاولپور'],
  Pattoki: ['پتوکی'],
  Harappa: ['ہڑپہ'],
  Chichawatni: ['چیچہ وطنی', 'chicha watni'],
  Jaranwala: ['جڑانوالہ'],
  Samundri: ['سمندری'],
  'Toba Tek Singh': ['ٹوبہ ٹیک سنگھ', 'toba'],
  Kasur: ['قصور'],
  Gujrat: ['گجرات'],
  Quetta: ['کوئٹہ'],
  Abbottabad: ['ایبٹ آباد'],
  Murree: ['مری'],
  Jhelum: ['جہلم'],
  Pakpattan: ['پاکپتن'],
  Arifwala: ['عارف والا'],
  'Renala Khurd': ['رینالہ خورد', 'renala'],
  Kamalia: ['کمالیہ'],
  Vehari: ['وہاڑی'],
  Mianwali: ['میانوالی'],
  Chakwal: ['چکوال'],
  Mardan: ['مردان'],
};

const FROM_AFTER = ['se', 'say', 'sy', 'sey', 'سے', 'سی'];
const TO_AFTER = ['tak', 'tk', 'ko', 'jana', 'janna', 'jaana', 'jane', 'janay', 'تک', 'کو', 'جانا', 'جانے', 'جاؤں', 'jaun'];
const NUMBERS = { ek: 1, aik: 1, one: 1, 'ایک': 1, do: 2, two: 2, 'دو': 2, teen: 3, three: 3, 'تین': 3, char: 4, chaar: 4, four: 4, 'چار': 4 };
const SEAT_WORDS = ['seat', 'seats', 'seet', 'سیٹ', 'سیٹیں', 'سیٹس', 'log', 'logon', 'لوگ', 'afraad', 'افراد', 'bande', 'banday', 'بندے', 'passenger', 'passengers', 'people', 'persons', 'sawari', 'سواری'];
const WEEKDAYS = [
  ['sunday', 'itwar', 'اتوار'], ['monday', 'peer', 'pir', 'پیر'], ['tuesday', 'mangal', 'منگل'], ['wednesday', 'budh', 'بدھ'],
  ['thursday', 'jumeraat', 'jumerat', 'جمعرات'], ['friday', 'juma', 'jumma', 'jummah', 'جمعہ'], ['saturday', 'hafta', 'ہفتہ', 'ہفتے'],
];

const isLetter = (ch) => !!ch && /[\p{L}\p{M}]/u.test(ch);
const words = (text) => text.split(/[^\p{L}\p{M}\p{N}]+/u).filter(Boolean);

/** The cities mentioned, in the order they were said: [{ city, start, end }]. */
function findCities(text, cityList) {
  const names = [];
  for (const city of cityList) {
    const variants = [city.toLowerCase(), city.toLowerCase().replace(/\s+/g, ''), ...(CITY_ALIASES[city] || [])];
    for (const v of new Set(variants)) names.push([v, city]);
  }
  names.sort((a, b) => b[0].length - a[0].length); // longest first: "faisal abad" before "abad"
  const found = [];
  for (const [name, city] of names) {
    let i = text.indexOf(name);
    while (i !== -1) {
      const end = i + name.length;
      const taken = found.some((f) => i < f.end && end > f.start);
      if (!taken && !isLetter(text[i - 1]) && !isLetter(text[end])) found.push({ city, start: i, end });
      i = text.indexOf(name, i + 1);
    }
  }
  return found.sort((a, b) => a.start - b.start);
}

const dateIn = (days, now) => {
  const d = new Date(now.getTime() + days * 864e5);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/**
 * What a spoken search asks for: { from, to, date, time, seats, women_only }.
 * Only the parts that were heard are set.
 */
function parseVoiceQuery(said, cityList, now = new Date()) {
  const text = ` ${String(said || '').toLowerCase()
    .replace(/[۰-۹]/g, (d) => '۰۱۲۳۴۵۶۷۸۹'.indexOf(d))
    .replace(/[٠-٩]/g, (d) => '٠١٢٣٤٥٦٧٨٩'.indexOf(d))
    .replace(/\s+/g, ' ')} `;
  const out = {};
  const found = findCities(text, cityList);
  const nextWord = (f) => (words(text.slice(f.end))[0] || '');
  const prevWord = (f) => (words(text.slice(0, f.start)).pop() || '');
  const isFrom = (f) => FROM_AFTER.includes(nextWord(f)) || ['from', 'az'].includes(prevWord(f));
  const isTo = (f) => TO_AFTER.includes(nextWord(f)) || ['to', 'for', 'towards'].includes(prevWord(f));
  const from = found.find(isFrom);
  const to = found.find((f) => f !== from && isTo(f)) || found.find((f) => f !== from && f.city !== (from && from.city));
  if (from) out.from = from.city;
  if (to) out.to = to.city;
  if (!from && to && found.length > 1) out.from = found.find((f) => f !== to).city;
  if (out.from && out.from === out.to) delete out.to;

  const w = words(text);
  const has = (...list) => list.some((x) => (/\s/.test(x) ? text.includes(` ${x} `) : w.includes(x)));
  if (has('parson', 'parsoon', 'پرسوں', 'day after tomorrow')) out.date = dateIn(2, now);
  else if (has('kal', 'kl', 'کل', 'tomorrow')) out.date = dateIn(1, now);
  else if (has('aaj', 'aj', 'آج', 'today', 'abhi', 'ابھی')) out.date = dateIn(0, now);
  else {
    const day = WEEKDAYS.findIndex((names) => has(...names));
    if (day !== -1) out.date = dateIn((day - now.getDay() + 7) % 7, now);
  }

  if (has('subah', 'subha', 'sobah', 'صبح', 'morning', 'savere', 'سویرے')) out.time = 'morning';
  else if (has('dopahar', 'dopehar', 'dupehar', 'دوپہر', 'afternoon', 'zuhr', 'ظہر')) out.time = 'afternoon';
  else if (has('shaam', 'sham', 'شام', 'evening', 'raat', 'rat', 'رات', 'night')) out.time = 'evening';

  for (let i = 0; i < w.length; i += 1) {
    if (!SEAT_WORDS.includes(w[i + 1]) && !SEAT_WORDS.includes(w[i + 2])) continue;
    const n = NUMBERS[w[i]] || (/^\d$/.test(w[i]) ? Number(w[i]) : 0);
    if (n) { out.seats = Math.min(4, n); break; }
  }
  if (has('khawateen', 'khawatin', 'خواتین', 'ladies', 'women', 'woman', 'female', 'aurat', 'عورت', 'خاتون', 'ladies only')) out.women_only = true;
  return out;
}

if (typeof module === 'object' && module.exports) module.exports = { parseVoiceQuery, CITY_ALIASES };
