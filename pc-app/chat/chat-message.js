/** Normalize chat message shape for PC, mobile, and OBS dock. */

function authorFromUser(user) {
  if (!user || typeof user !== 'object') return '';
  const name =
    user.username ||
    user.displayName ||
    user.display_name ||
    user.name ||
    user.slug ||
    user.nickname;
  return String(name || '').trim();
}

function normalizeChatAuthor(raw) {
  if (!raw || typeof raw !== 'object') return 'unknown';
  if (typeof raw.author === 'string' && raw.author.trim()) return raw.author.trim();
  if (typeof raw.displayName === 'string' && raw.displayName.trim()) return raw.displayName.trim();
  if (typeof raw.username === 'string' && raw.username.trim()) return raw.username.trim();
  if (typeof raw.user === 'string' && raw.user.trim()) return raw.user.trim();
  const nested = authorFromUser(raw.user);
  if (nested) return nested;
  const sender = authorFromUser(raw.sender);
  if (sender) return sender;
  return 'unknown';
}

function joinTextFromMessage(msg) {
  const author = normalizeChatAuthor(msg);
  const text = String(msg?.text || '').trim();
  if (text && / joined/i.test(text)) return text;
  return `${author} joined`;
}

function isJoinLikeText(text) {
  const t = String(text || '');
  if (!t) return false;
  return (
    /\bjoined (the )?(chat|channel|stream|live)\b/i.test(t) ||
    /\bhas joined\b/i.test(t) ||
    /\bwelcome\b.*\bto the stream\b/i.test(t)
  );
}

function isJoinChatMessage(msg) {
  if (!msg || typeof msg !== 'object') return false;
  if (msg.kind === 'join') return true;
  return isJoinLikeText(msg.text);
}

function normalizeChatMessage(msg) {
  if (!msg || typeof msg !== 'object') return null;
  const author = normalizeChatAuthor(msg);
  const kind = msg.kind === 'join' || isJoinLikeText(msg.text) ? 'join' : msg.kind;
  const text =
    kind === 'join' && !String(msg.text || '').trim()
      ? joinTextFromMessage({ ...msg, author })
      : msg.text;
  return {
    ...msg,
    author,
    kind: kind === 'join' ? 'join' : msg.kind,
    text
  };
}

module.exports = {
  normalizeChatAuthor,
  normalizeChatMessage,
  isJoinChatMessage,
  isJoinLikeText
};
