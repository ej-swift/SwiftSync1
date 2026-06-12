const fs = require('fs');
const path = require('path');

const assetsDir = path.join(__dirname, '..', 'assets');
const sizes = [16, 32, 48, 256];
const pngBuffers = sizes.map((size) => {
  const filePath = path.join(assetsDir, `icon-${size}.png`);
  if (!fs.existsSync(filePath)) {
    throw new Error(`Missing ${filePath} — run scripts/export-icon-pngs.ps1 first`);
  }
  return { size, data: fs.readFileSync(filePath) };
});

const count = pngBuffers.length;
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(count, 4);

const entries = [];
let offset = 6 + 16 * count;
for (const { size, data } of pngBuffers) {
  const entry = Buffer.alloc(16);
  entry[0] = size >= 256 ? 0 : size;
  entry[1] = size >= 256 ? 0 : size;
  entry[2] = 0;
  entry[3] = 0;
  entry.writeUInt16LE(1, 4);
  entry.writeUInt16LE(32, 6);
  entry.writeUInt32LE(data.length, 8);
  entry.writeUInt32LE(offset, 12);
  entries.push(entry);
  offset += data.length;
}

const icoPath = path.join(assetsDir, 'icon.ico');
fs.writeFileSync(icoPath, Buffer.concat([header, ...entries, ...pngBuffers.map((p) => p.data)]));
console.log(`Wrote ${icoPath} (${fs.statSync(icoPath).size} bytes)`);
