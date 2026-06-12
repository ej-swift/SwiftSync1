const { createChatHub, MAX_MESSAGES } = require('./chat/hub');
const { createTwitchConnector, createTwitchChatClient, normalizeChannel } = require('./chat/twitch');

module.exports = {
  createChatHub,
  createTwitchChatClient,
  createTwitchConnector,
  normalizeChannel,
  MAX_MESSAGES
};
