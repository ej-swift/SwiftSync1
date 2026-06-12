const path = require('path');
const { applyWindowsIcon } = require('./apply-exe-icon');

/** @param {import('app-builder-lib').AfterPackContext} context */
exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'win32') return;

  const productName = context.packager.appInfo.productFilename;
  const exePath = path.join(context.appOutDir, `${productName}.exe`);
  const iconPath = path.join(context.packager.info.projectDir, 'assets', 'icon.ico');

  applyWindowsIcon(exePath, iconPath, productName);
  console.log(`Applied SwiftSync icon to ${exePath}`);
};
