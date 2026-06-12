const fs = require('fs');
const path = require('path');
const { applyWindowsIcon } = require('./apply-exe-icon');

const DEFAULT_INSTALL = path.join(process.env['ProgramFiles'] || 'C:\\Program Files', 'SwiftSync', 'SwiftSync.exe');
const installExe = process.argv[2] || DEFAULT_INSTALL;
const iconPath = path.join(__dirname, '..', 'assets', 'icon.ico');

if (!fs.existsSync(installExe)) {
  console.error(`SwiftSync not found at: ${installExe}`);
  process.exit(1);
}

if (!fs.existsSync(iconPath)) {
  console.error(`Icon not found at: ${iconPath}`);
  process.exit(1);
}

try {
  applyWindowsIcon(installExe, iconPath, 'SwiftSync');
  console.log(`Updated icon in ${installExe}`);
  console.log('Tip: delete and recreate desktop/taskbar shortcuts if Windows still shows the old icon.');
} catch (err) {
  if (err.code === 'EPERM' || /EACCES|commit/i.test(String(err.message))) {
    console.error('Permission denied. Re-run this script in an elevated (Run as administrator) terminal, or reinstall from the latest SwiftSync Setup.exe.');
  } else {
    console.error(err.message || err);
  }
  process.exit(1);
}
