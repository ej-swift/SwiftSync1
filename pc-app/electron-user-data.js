const fs = require('fs');
const path = require('path');
const os = require('os');

const APP_SLUG = 'swiftsync';

function isInsideAppAsar(filePath) {
  const norm = String(filePath || '').replace(/\\/g, '/').toLowerCase();
  return norm.includes('app.asar/') || norm.endsWith('/app.asar');
}

function resolveElectronUserDataDir() {
  try {
    const { app } = require('electron');
    if (app?.getPath) {
      const dir = app.getPath('userData');
      if (dir && !isInsideAppAsar(dir)) return dir;
    }
  } catch {
    /* renderer: app module unavailable */
  }

  const home = os.homedir();
  if (process.platform === 'win32') {
    const base = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
    return path.join(base, APP_SLUG);
  }
  if (process.platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', APP_SLUG);
  }
  return path.join(home, '.config', APP_SLUG);
}

function userDataFile(fileName) {
  return path.join(resolveElectronUserDataDir(), fileName);
}

/** Never mkdir inside app.asar (EEXIST — app.asar is a file, not a folder). */
function safeMkdirForFile(filePath) {
  let target = String(filePath || '').trim();
  if (!target || isInsideAppAsar(target)) {
    target = userDataFile(path.basename(target) || 'data.json');
  }
  if (isInsideAppAsar(path.dirname(target))) {
    target = userDataFile(path.basename(target));
  }
  const dir = path.dirname(target);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return target;
}

module.exports = {
  isInsideAppAsar,
  resolveElectronUserDataDir,
  userDataFile,
  safeMkdirForFile
};
