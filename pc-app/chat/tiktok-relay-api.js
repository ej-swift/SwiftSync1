const { isEulerConfigured, createWsJwt, sendChat, validateUniqueId } = require('./euler-service');

const JWT_RATE_WINDOW_MS = 60_000;
const JWT_RATE_MAX = 30;
const CHAT_RATE_WINDOW_MS = 60_000;
const CHAT_RATE_MAX = 60;

const jwtRateByIp = new Map();
const chatRateByIp = new Map();

function getClientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) return String(fwd).split(',')[0].trim();
  return req.socket?.remoteAddress || 'unknown';
}

function checkRate(map, ip, windowMs, max) {
  const now = Date.now();
  let entry = map.get(ip);
  if (!entry || now - entry.start > windowMs) {
    entry = { start: now, count: 0 };
    map.set(ip, entry);
  }
  entry.count += 1;
  return entry.count <= max;
}

async function handleTiktokWsJwt(req, res, readJsonBody, jsonResponse) {
  const ip = getClientIp(req);
  if (!checkRate(jwtRateByIp, ip, JWT_RATE_WINDOW_MS, JWT_RATE_MAX)) {
    jsonResponse(res, 429, { ok: false, message: 'Rate limit exceeded' });
    return;
  }

  if (!isEulerConfigured()) {
    jsonResponse(res, 503, { ok: false, message: 'TikTok chat proxy not configured' });
    return;
  }

  try {
    const body = await readJsonBody(req);
    if (!validateUniqueId(body.uniqueId)) {
      jsonResponse(res, 400, { ok: false, message: 'Invalid uniqueId' });
      return;
    }
    const result = await createWsJwt(body.uniqueId);
    jsonResponse(res, 200, { ok: true, jwt: result.jwt, expiresIn: result.expiresIn });
  } catch (err) {
    jsonResponse(res, 400, { ok: false, message: err.message || String(err) });
  }
}

async function handleTiktokChat(req, res, readJsonBody, jsonResponse) {
  const ip = getClientIp(req);
  if (!checkRate(chatRateByIp, ip, CHAT_RATE_WINDOW_MS, CHAT_RATE_MAX)) {
    jsonResponse(res, 429, { ok: false, message: 'Rate limit exceeded' });
    return;
  }

  if (!isEulerConfigured()) {
    jsonResponse(res, 503, { ok: false, message: 'TikTok chat proxy not configured' });
    return;
  }

  try {
    const body = await readJsonBody(req);
    const roomId = String(body.roomId || body.room_id || '').trim();
    const message = String(body.message || '').trim();
    if (!roomId) {
      jsonResponse(res, 400, { ok: false, message: 'roomId required' });
      return;
    }
    if (!message) {
      jsonResponse(res, 400, { ok: false, message: 'message required' });
      return;
    }
    await sendChat(roomId, message);
    jsonResponse(res, 200, { ok: true });
  } catch (err) {
    jsonResponse(res, 400, { ok: false, message: err.message || String(err) });
  }
}

module.exports = { handleTiktokWsJwt, handleTiktokChat };
