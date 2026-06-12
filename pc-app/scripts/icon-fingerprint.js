const fs = require('fs');
const crypto = require('crypto');
const { NtExecutable, NtExecutableResource, Resource } = require('resedit');

function iconFingerprint(filePath) {
  const buf = fs.readFileSync(filePath);
  const exe = NtExecutable.from(buf);
  const res = NtExecutableResource.from(exe);
  const groups = Resource.IconGroupEntry.fromEntries(res.entries);
  return groups.map((group) => {
    const items = group.getIconItemsFromEntries(res.entries);
    return items.map((item) =>
      crypto.createHash('sha256').update(Buffer.from(item.data)).digest('hex').slice(0, 12)
    );
  });
}

const paths = process.argv.slice(2);
for (const p of paths) {
  console.log(p);
  console.log(JSON.stringify(iconFingerprint(p)));
}
