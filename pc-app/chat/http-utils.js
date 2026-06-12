const https = require('https');
const http = require('http');

/** Chromium fetch via Electron main (kick.com blocks Node TLS). */
let electronFetchJson = null;

function setElectronFetchJson(fn) {
  electronFetchJson = typeof fn === 'function' ? fn : null;
}

function hostNeedsElectronFetch(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    // Only the kick.com site blocks Node TLS — api.kick.com / id.kick.com work with Node.
    return host === 'kick.com' || host === 'www.youtube.com' || host === 'youtube.com' || host === 'm.youtube.com';
  } catch {
    return false;
  }
}

function unwrapIpcInvokeError(err) {
  const msg = String(err?.message || err);
  const match = msg.match(/Error invoking remote method '[^']+':\s*(.+)/i);
  return match ? match[1].trim() : msg;
}

function fetchJsonNode(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const lib = parsed.protocol === 'https:' ? https : http;
    const reqOpts = {
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: `${parsed.pathname}${parsed.search}`,
      method: opts.method || 'GET',
      headers: {
        'User-Agent': opts.userAgent || 'SwiftSync/1.0',
        Accept: 'application/json',
        ...(opts.headers || {})
      },
      timeout: opts.timeout || 15000
    };

    const req = lib.request(reqOpts, (res) => {
      let body = '';
      res.on('data', (chunk) => {
        body += chunk;
      });
      res.on('end', () => {
        if (res.statusCode && res.statusCode >= 400) {
          reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0, 200)}`));
          return;
        }
        try {
          resolve(JSON.parse(body || '{}'));
        } catch (e) {
          reject(new Error(`Bad JSON: ${e.message}`));
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });

    if (opts.body) {
      req.write(opts.body);
    }
    req.end();
  });
}

function fetchTextNode(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const lib = parsed.protocol === 'https:' ? https : http;
    const reqOpts = {
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: `${parsed.pathname}${parsed.search}`,
      method: opts.method || 'GET',
      headers: {
        'User-Agent': opts.userAgent || 'SwiftSync/1.0',
        Accept: 'text/html,application/xhtml+xml',
        ...(opts.headers || {})
      },
      timeout: opts.timeout || 15000
    };

    const req = lib.request(reqOpts, (res) => {
      let body = '';
      res.on('data', (chunk) => {
        body += chunk;
      });
      res.on('end', () => {
        if (res.statusCode && res.statusCode >= 400) {
          reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0, 200)}`));
          return;
        }
        resolve(body);
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });
    req.end();
  });
}

async function fetchJson(url, opts = {}) {
  if (electronFetchJson && hostNeedsElectronFetch(url)) {
    try {
      return await electronFetchJson(url, opts);
    } catch (err) {
      try {
        return await fetchJsonNode(url, opts);
      } catch {
        throw new Error(unwrapIpcInvokeError(err));
      }
    }
  }
  return fetchJsonNode(url, opts);
}

async function fetchText(url, opts = {}) {
  if (electronFetchJson && hostNeedsElectronFetch(url)) {
    try {
      return await electronFetchJson(url, { ...opts, parseJson: false });
    } catch (err) {
      try {
        return await fetchTextNode(url, opts);
      } catch {
        throw new Error(unwrapIpcInvokeError(err));
      }
    }
  }
  return fetchTextNode(url, opts);
}

function postJson(url, body, opts = {}) {
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  return fetchJson(url, {
    ...opts,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(opts.headers || {})
    },
    body: payload
  });
}

/** OAuth token endpoints — Node fetch fails in packaged Electron main on Windows. */
function postFormUrlEncoded(url, params, opts = {}) {
  const body =
    params instanceof URLSearchParams ? params.toString() : new URLSearchParams(params).toString();
  return fetchJsonNode(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
      ...(opts.headers || {})
    },
    body,
    timeout: opts.timeout || 20000,
    userAgent: opts.userAgent || 'SwiftSync/1.0'
  });
}

module.exports = {
  fetchJson,
  fetchJsonNode,
  fetchText,
  fetchTextNode,
  postJson,
  postFormUrlEncoded,
  setElectronFetchJson,
  unwrapIpcInvokeError
};
