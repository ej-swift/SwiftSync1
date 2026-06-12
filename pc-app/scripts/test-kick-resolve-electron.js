const { app, net } = require('electron');
const { setElectronFetchJson } = require('../chat/http-utils');
const { resolveKickChatroom } = require('../chat/kick');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

async function electronFetchJson(url, opts = {}) {
  const res = await net.fetch(url, {
    method: opts.method || 'GET',
    headers: {
      Accept: 'application/json',
      'User-Agent': opts.userAgent || UA,
      ...(opts.headers || {})
    },
    body: opts.body || undefined
  });
  const text = await res.text();
  if (res.status >= 400) throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
  return JSON.parse(text || '{}');
}

app.whenReady().then(async () => {
  setElectronFetchJson(electronFetchJson);
  const slug = process.argv[2] || 'xqc';
  try {
    const room = await resolveKickChatroom(slug, {});
    console.log('OK', room);
  } catch (e) {
    console.error('FAIL', e.message);
    process.exitCode = 1;
  }
  app.quit();
});
