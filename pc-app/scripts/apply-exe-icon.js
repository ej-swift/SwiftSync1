const fs = require('fs');
const { NtExecutable, NtExecutableResource, Resource, Data } = require('resedit');

function applyWindowsIcon(exePath, iconPath, productName = 'SwiftSync') {
  const exeBuffer = fs.readFileSync(exePath);
  const exe = NtExecutable.from(exeBuffer);
  const resource = NtExecutableResource.from(exe);

  const iconFile = Data.IconFile.from(fs.readFileSync(iconPath));
  const icons = iconFile.icons.map((item) => item.data);
  Resource.IconGroupEntry.replaceIconsForResource(resource.entries, 1, 1033, icons);

  const versionEntries = Resource.VersionInfo.fromEntries(resource.entries);
  if (versionEntries.length === 1) {
    const versionInfo = versionEntries[0];
    const languages = versionInfo.getAllLanguagesForStringValues();
    const lang = languages[0] || { lang: 1033, codepage: 1200 };
    versionInfo.setStringValues(
      { lang: lang.lang, codepage: lang.codepage },
      {
        ProductName: productName,
        FileDescription: `${productName} PC controller for OBS`,
        InternalName: productName,
        OriginalFilename: `${productName}.exe`
      }
    );
    versionInfo.outputToResourceEntries(resource.entries);
  }

  resource.outputResource(exe);
  fs.writeFileSync(exePath, Buffer.from(exe.generate()));
}

module.exports = { applyWindowsIcon };

if (require.main === module) {
  const exe = process.argv[2];
  const icon = process.argv[3];
  if (!exe || !icon) {
    console.error('Usage: node apply-exe-icon.js <exePath> <iconPath>');
    process.exit(1);
  }
  applyWindowsIcon(exe, icon);
}
