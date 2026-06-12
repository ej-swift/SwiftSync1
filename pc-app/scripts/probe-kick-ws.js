const WebSocket = require('ws');
const chatroomId = Number(process.argv[2]) || 668;
const url =
  'wss://ws-us2.pusher.com/app/32cbd69e4b950bf97679?protocol=7&client=js&version=8.4.0-rc2';
const channels = [
  `chatrooms.${chatroomId}.v2`,
  `chatroom_${chatroomId}`,
  `chatrooms.${chatroomId}`
];

const ws = new WebSocket(url);
ws.on('open', () => console.log('open'));
ws.on('message', (raw) => {
  let e;
  try {
    e = JSON.parse(raw);
  } catch {
    return;
  }
  const ev = e.event || '';
  if (
    ev.includes('subscription') ||
    ev.includes('Chat') ||
    ev.includes('chat') ||
    ev === 'pusher:connection_established'
  ) {
    console.log('EVENT', ev, String(e.data || '').slice(0, 160));
  }
  if (e.event === 'pusher:connection_established') {
    for (const ch of channels) {
      ws.send(JSON.stringify({ event: 'pusher:subscribe', data: { channel: ch } }));
    }
  }
});
setTimeout(() => {
  ws.close();
  process.exit(0);
}, 12000);
