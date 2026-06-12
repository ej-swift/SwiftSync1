/**
 * Runs before electron-builder. Windows .ico generation needs PowerShell;
 * Mac/Linux builds skip that and use assets/Copilot_*.png for the .dmg icon.
 */
const { execSync } = require('child_process');
const path = require('path');

const root = path.join(__dirname, '..');

if (process.platform === 'win32') {
  execSync('powershell -ExecutionPolicy Bypass -File scripts/export-icon-pngs.ps1', {
    cwd: root,
    stdio: 'inherit'
  });
  execSync('node scripts/build-icons.js', { cwd: root, stdio: 'inherit' });
} else {
  const logo = path.join(root, 'assets', 'Copilot_20260522_174446.png');
  const fs = require('fs');
  if (!fs.existsSync(logo)) {
    console.warn('predist: expected', logo, '— Mac icon may fail; add logo PNG to assets/');
  } else {
    console.log('predist: skipping Windows .ico on', process.platform);
  }
}
