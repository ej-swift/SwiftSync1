const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { userDataFile, safeMkdirForFile } = require('./electron-user-data');

const FILE_NAME = 'pairing-code.txt';
const QR_FILE_NAME = 'pairing-qr.json';

function readJsonUtf8(filePath) {
  const text = fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '');
  return JSON.parse(text);
}

function writeJsonUtf8(filePath, data) {
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

function resolveQrPath() {
  return userDataFile(QR_FILE_NAME);
}

/** Saved Home-tab QR — only changes when the user taps New Code. */
function getLockedPairingQr() {
  const code = readStoredCode();
  if (!code) return null;
  const filePath = resolveQrPath();
  try {
    if (!fs.existsSync(filePath)) return null;
    const raw = readJsonUtf8(filePath);
    const mobileUrl = String(raw.mobileUrl || '').trim();
    const qrDataUrl = String(raw.qrDataUrl || '').trim();
    if (raw.code !== code || !mobileUrl) return null;
    return { code, mobileUrl, qrDataUrl: qrDataUrl || null };
  } catch {
    return null;
  }
}

function setLockedPairingQr({ code, mobileUrl, qrDataUrl }) {
  const normalized = normalizePairingCode(code);
  const url = String(mobileUrl || '').trim();
  if (!normalized || !url) return null;
  const filePath = safeMkdirForFile(resolveQrPath());
  const payload = {
    code: normalized,
    mobileUrl: url,
    qrDataUrl: String(qrDataUrl || '').trim() || null
  };
  writeJsonUtf8(filePath, payload);
  return payload;
}

function clearLockedPairingQr() {
  const filePath = resolveQrPath();
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch {
    /* ignore */
  }
}
function resolvePairingPath() {
  if (process.env.SWIFTSYNC_PAIRING_CODE_PATH) {
    return process.env.SWIFTSYNC_PAIRING_CODE_PATH;
  }

  return userDataFile(FILE_NAME);
}

function normalizePairingCode(code) {
  const c = String(code || '')
    .trim()
    .toUpperCase();
  return /^[0-9A-F]{8}$/.test(c) ? c : null;
}

function generatePairingCode() {
  return crypto.randomBytes(4).toString('hex').toUpperCase();
}

function readStoredCode() {
  const filePath = resolvePairingPath();
  try {
    if (!fs.existsSync(filePath)) return null;
    return normalizePairingCode(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function writeStoredCode(code) {
  const normalized = normalizePairingCode(code);
  if (!normalized) throw new Error('Invalid pairing code');
  const filePath = safeMkdirForFile(resolvePairingPath());
  fs.writeFileSync(filePath, normalized, 'utf8');
  return normalized;
}

/** Same code every launch until the user clicks New Code on PC. */
function getPersistentPairingCode() {
  const existing = readStoredCode();
  if (existing) return existing;
  return writeStoredCode(generatePairingCode());
}

function rotatePersistentPairingCode() {
  clearLockedPairingQr();
  return writeStoredCode(generatePairingCode());
}

module.exports = {
  getPersistentPairingCode,
  rotatePersistentPairingCode,
  getLockedPairingQr,
  setLockedPairingQr,
  clearLockedPairingQr,
  normalizePairingCode,
  resolvePairingPath
};
