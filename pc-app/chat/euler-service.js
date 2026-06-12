const { postJson } = require('./http-utils');

let sdkClient = null;

function getEnv() {
  return {
    apiKey: String(process.env.EULER_API_KEY || '').trim(),
    accountId: String(process.env.EULER_ACCOUNT_ID || '').trim()
  };
}

function isEulerConfigured() {
  const { apiKey, accountId } = getEnv();
  return !!(apiKey && accountId);
}

function validateUniqueId(uniqueId) {
  const id = String(uniqueId || '')
    .replace(/^@+/, '')
    .trim();
  if (!id || id.length > 64 || !/^[a-zA-Z0-9._]+$/.test(id)) return null;
  return id;
}

async function getSdkClient() {
  if (!isEulerConfigured()) {
    throw new Error('EulerStream not configured on relay (EULER_API_KEY / EULER_ACCOUNT_ID)');
  }
  if (!sdkClient) {
    const mod = require('@eulerstream/euler-api-sdk');
    const EulerStreamApiClient = mod.default || mod;
    sdkClient = new EulerStreamApiClient({ apiKey: getEnv().apiKey });
  }
  return sdkClient;
}

async function createWsJwt(uniqueId) {
  const id = validateUniqueId(uniqueId);
  if (!id) throw new Error('Invalid uniqueId');

  const client = await getSdkClient();
  const { accountId } = getEnv();
  const createJwtResponse = await client.authentication.createJWT(accountId, {
    expireAfter: 60,
    websockets: {
      allowedCreators: [id],
      maxWebSockets: 1
    }
  });

  const jwt = createJwtResponse?.data?.token;
  if (!jwt) throw new Error('Failed to mint EulerStream JWT');
  return { jwt, expiresIn: 60 };
}

async function sendChat(roomId, message) {
  if (!isEulerConfigured()) {
    throw new Error('EulerStream not configured on relay (EULER_API_KEY / EULER_ACCOUNT_ID)');
  }

  const room = String(roomId || '').trim();
  const msg = String(message || '')
    .trim()
    .replace(/\r|\n/g, ' ');
  if (!room) throw new Error('roomId required');
  if (!msg) throw new Error('message required');

  await postJson(
    'https://tiktok.eulerstream.com/webcast/chat',
    { room_id: room, message: msg },
    { headers: { Authorization: `Bearer ${getEnv().apiKey}` } }
  );
}

module.exports = {
  isEulerConfigured,
  createWsJwt,
  sendChat,
  validateUniqueId
};
