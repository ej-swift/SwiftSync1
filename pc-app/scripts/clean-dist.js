const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');

for (const dir of ['dist', 'dist-build', 'dist-release']) {
  const target = path.join(root, dir);
  if (!fs.existsSync(target)) continue;
  fs.rmSync(target, { recursive: true, force: true });
  console.log(`clean-dist: removed ${dir}/`);
}

fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
