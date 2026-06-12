FROM node:20-alpine

WORKDIR /app

COPY cloud-relay/package.json cloud-relay/package-lock.json* ./cloud-relay/
WORKDIR /app/cloud-relay
RUN npm install --omit=dev

COPY cloud-relay/server.js cloud-relay/cloud-chat-session.js cloud-relay/mobile-oauth.js ./
COPY pc-app/chat /app/pc-app/chat
COPY pc-app/chat-oauth-apps.js pc-app/electron-user-data.js /app/pc-app/
COPY pc-app/vendor /app/pc-app/vendor
COPY pc-app/mobile /app/pc-app/mobile
COPY pc-app/shared /app/pc-app/shared
COPY pc-app/assets /app/pc-app/assets
COPY SwiftSync/docs /app/pc-app/site

ENV PC_APP_ROOT=/app/pc-app
ENV MOBILE_ROOT=/app/pc-app
ENV NODE_PATH=/app/cloud-relay/node_modules
ENV PORT=8080

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
