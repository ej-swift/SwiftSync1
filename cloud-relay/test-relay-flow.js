/**
 * Integration test: mobile command -> cloud relay -> PC
 * Run: node cloud-relay/test-relay-flow.js
 */
const http = require('http');
const WebSocket = require('ws');

const TEST_CODE = 'ABCD1234';
const PORT = 9876;
process.env.PORT = String(PORT);
process.env.PUBLIC_URL = `http://127.0.0.1:${PORT}`;
const { startServer } = require('./server');

function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function postJson(path, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: PORT,
        path,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
      },
      (res) => {
        let buf = '';
        res.on('data', (c) => (buf += c));
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, body: JSON.parse(buf || '{}') });
          } catch {
            resolve({ status: res.statusCode, body: buf });
          }
        });
      }
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function main() {
  const { httpServer } = startServer();
  await wait(200);

  const wsUrl = `ws://127.0.0.1:${PORT}`;
  let pcReceived = [];

  const pc = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    pc.on('open', () => {
      pc.send(JSON.stringify({ type: 'role', role: 'pc', pairingCode: TEST_CODE }));
    });
    pc.on('message', (raw) => {
      const data = JSON.parse(raw.toString());
      if (data.type === 'pairingInfo') resolve(data);
    });
    pc.on('error', reject);
    setTimeout(() => reject(new Error('PC connect timeout')), 3000);
  });

  pc.on('message', (raw) => {
    const data = JSON.parse(raw.toString());
    if (data.from === 'mobile') pcReceived.push(data);
  });

  const mobile = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    mobile.on('open', () => {
      mobile.send(JSON.stringify({ type: 'role', role: 'mobile', pairingCode: TEST_CODE }));
    });
    mobile.on('message', (raw) => {
      const data = JSON.parse(raw.toString());
      if (data.type === 'paired') resolve(data);
    });
    mobile.on('error', reject);
    setTimeout(() => reject(new Error('Mobile connect timeout')), 3000);
  });

  mobile.send(JSON.stringify({ from: 'mobile', command: 'setScene', sceneName: 'TestScene' }));
  await wait(100);

  const httpRes = await postJson('/api/mobile-cmd', {
    pairingCode: TEST_CODE,
    command: 'setVolume',
    inputName: 'Mic',
    volumeMul: 0.5
  });

  await wait(100);

  console.log('HTTP mobile-cmd:', httpRes);
  console.log('PC received:', pcReceived);

  const ok =
    pcReceived.some((m) => m.command === 'setScene' && m.sceneName === 'TestScene') &&
    pcReceived.some((m) => m.command === 'setVolume' && m.inputName === 'Mic');

  httpServer.close();
  pc.close();
  mobile.close();
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
