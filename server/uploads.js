const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { bad } = require('./errors');

const MAX_BYTES = 4 * 1024 * 1024;

// Checks the file's real signature, not just the type the client claims.
function sniff(bytes) {
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpg';
  if (bytes.length > 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (bytes.length > 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  return null;
}

// Decodes a data: URL photo and checks it, without writing anything.
function decodeImage(dataUrl, label) {
  const match = typeof dataUrl === 'string' && dataUrl.match(/^data:image\/[a-z]+;base64,([A-Za-z0-9+/=]+)$/);
  if (!match) throw bad(`Please attach a photo for: ${label}`);
  const bytes = Buffer.from(match[1], 'base64');
  if (bytes.length > MAX_BYTES) throw bad(`${label}: the photo must be smaller than 4 MB`);
  const ext = sniff(bytes);
  if (!ext) throw bad(`${label}: please upload a JPG, PNG or WebP photo`);
  return { bytes, ext };
}

// Writes checked photos and records them as documents of the user.
function saveDocuments(db, uploadDir, userId, images) {
  fs.mkdirSync(uploadDir, { recursive: true });
  const insert = db.prepare('INSERT INTO documents (user_id, kind, file) VALUES (?, ?, ?)');
  for (const [kind, { bytes, ext }] of Object.entries(images)) {
    const file = `${userId}-${kind}-${crypto.randomBytes(8).toString('hex')}.${ext}`;
    fs.writeFileSync(path.join(uploadDir, file), bytes);
    insert.run(userId, kind, file);
  }
}

module.exports = { decodeImage, saveDocuments };
