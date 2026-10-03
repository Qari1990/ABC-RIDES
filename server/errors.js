class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const bad = (message) => new HttpError(400, message);

// Small validators used by the route handlers. Each throws a 400 on bad input.
function str(value, field, { required = false, max = 200 } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) throw bad(`${field} is required`);
    return null;
  }
  if (typeof value !== 'string') throw bad(`${field} must be text`);
  const trimmed = value.trim();
  if (required && !trimmed) throw bad(`${field} is required`);
  if (trimmed.length > max) throw bad(`${field} must be at most ${max} characters`);
  return trimmed || null;
}

function int(value, field, { min, max, fallback } = {}) {
  if ((value === undefined || value === null || value === '') && fallback !== undefined) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n)) throw bad(`${field} must be a whole number`);
  if (min !== undefined && n < min) throw bad(`${field} must be at least ${min}`);
  if (max !== undefined && n > max) throw bad(`${field} must be at most ${max}`);
  return n;
}

function oneOf(value, field, options, { required = false } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) throw bad(`${field} is required`);
    return null;
  }
  if (!options.includes(value)) throw bad(`${field} must be one of: ${options.join(', ')}`);
  return value;
}

function isoDate(value, field) {
  const d = new Date(value);
  if (typeof value !== 'string' || Number.isNaN(d.getTime())) throw bad(`${field} must be a valid date/time`);
  return d;
}

module.exports = { HttpError, bad, str, int, oneOf, isoDate };
