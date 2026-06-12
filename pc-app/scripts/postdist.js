const fs = require('fs');
const path = require('path');

const dist = path.join(__dirname, '..', 'dist');
if (!fs.existsSync(dist)) process.exit(0);

const keep = new Set();
for (const name of fs.readdirSync(dist)) {
  if (/^SwiftSync Setup .*\.exe$/i.test(name)) keep.add(name);
}

for (const name of fs.readdirSync(dist)) {
  const full = path.join(dist, name);
  if (keep.has(name)) continue;
  fs.rmSync(full, { recursive: true, force: true });
}

const kept = [...keep];
if (kept.length) {
  console.log(`postdist: dist contains only ${kept.join(', ')}`);
} else {
  console.warn('postdist: no SwiftSync Setup *.exe found in dist/');
}
