const crypto = require('crypto');

function generatePkce() {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

function randomState() {
  return crypto.randomBytes(16).toString('hex');
}

module.exports = { generatePkce, randomState };
