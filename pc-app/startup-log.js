const fs = require('fs');
const { userDataFile, safeMkdirForFile } = require('./electron-user-data');

function getLogPath() {
  return safeMkdirForFile(userDataFile('startup.log'));
}

function logStartup(line) {
  const filePath = getLogPath();
  const stamp = new Date().toISOString();
  try {
    fs.appendFileSync(filePath, `[${stamp}] ${line}\n`, 'utf8');
  } catch {
    /* ignore */
  }
}

module.exports = { logStartup };
