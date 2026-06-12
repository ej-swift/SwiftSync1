const { setElectronFetchJson } = require('./http-utils');

let installed = false;

function installElectronHttp() {
  if (installed) return;
  installed = true;
  try {
    const { ipcRenderer } = require('electron');
    if (!ipcRenderer?.invoke) return;

    setElectronFetchJson(async (url, opts = {}) => {
      return ipcRenderer.invoke('swiftsync:fetch-json', {
        url,
        method: opts.method || 'GET',
        headers: opts.headers || {},
        body: opts.body || null,
        timeout: opts.timeout || 15000,
        userAgent: opts.userAgent || null,
        parseJson: opts.parseJson !== false
      });
    });
  } catch {
    /* not running inside Electron renderer */
  }
}

module.exports = { installElectronHttp };
