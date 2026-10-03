// The browser scripts aren't loaded by the API tests; make sure they at least parse.
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

for (const file of ['app.js', 'maps.js', 'icons.js', 'voice.js', 'sw.js']) {
  test(`public/${file} is valid JavaScript`, () => {
    new vm.Script(fs.readFileSync(path.join(__dirname, '..', 'public', file), 'utf8'), { filename: file });
  });
}
