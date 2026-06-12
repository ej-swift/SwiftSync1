const http = require('http');
const { startRelayServer, DEFAULT_PORT } = require('./server');

const RELAY_PORT_CANDIDATES = [4000, 4001, 4002, 4003];

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function probeRelayHealth(port) {
  return new Promise((resolve) => {
    const req = http.get(
      {
        host: '127.0.0.1',
        port,
        path: '/api/health',
        timeout: 2000
      },
      (res) => {
        let body = '';
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.on('end', () => {
          try {
            const json = JSON.parse(body);
            resolve(res.statusCode === 200 && json?.service === 'swiftsync-relay');
          } catch {
            resolve(false);
          }
        });
      }
    );
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
  });
}

function tryFreeRelayPort(port) {
  if (process.platform !== 'win32') return;
  try {
    const { execSync } = require('child_process');
    execSync(
      `powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }"`,
      { stdio: 'ignore', timeout: 10000 }
    );
  } catch {
    /* ignore */
  }
}

async function stopRelayServer(relay) {
  if (!relay || relay.external || relay.attached) return;
  await new Promise((resolve) => {
    let pending = 0;
    const done = () => {
      pending -= 1;
      if (pending <= 0) resolve();
    };
    if (relay.wss) {
      pending += 1;
      relay.wss.close(() => done());
    }
    if (relay.httpServer) {
      pending += 1;
      relay.httpServer.close(() => done());
    }
    if (pending === 0) resolve();
  });
  await delay(150);
}

function makeAttachedRelay(port) {
  return {
    port,
    external: true,
    attached: true,
    wss: null,
    httpServer: null,
    getPairingCode: () => null,
    rotatePairingCode: () => null,
    getLocalIp: () => require('./server').getLocalIpAddress()
  };
}

/**
 * Start the built-in HTTP + WebSocket relay bundled with the PC app.
 * If port 4000 is already serving SwiftSync (prior instance), attach instead of failing.
 */
async function bootRelayServer(options = {}) {
  const ports = options.ports || RELAY_PORT_CANDIDATES;
  const freePorts = options.freePorts === true;

  if (freePorts) {
    for (const port of ports) tryFreeRelayPort(port);
    await delay(350);
  }

  for (const port of ports) {
    const relay = await startRelayServer(port);
    if (!relay.external) {
      return { ...relay, attached: false };
    }
    if (await probeRelayHealth(port)) {
      console.log(`SwiftSync relay already listening on port ${port} — attaching`);
      return makeAttachedRelay(port);
    }
  }

  return {
    port: ports[0] || DEFAULT_PORT,
    external: true,
    attached: false,
    wss: null,
    httpServer: null,
    getPairingCode: () => null,
    rotatePairingCode: () => null
  };
}

module.exports = {
  bootRelayServer,
  stopRelayServer,
  tryFreeRelayPort,
  probeRelayHealth,
  RELAY_PORT_CANDIDATES,
  DEFAULT_PORT
};
