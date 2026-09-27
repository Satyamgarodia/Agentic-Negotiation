FROM node:20-slim
WORKDIR /worker
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY worker.js ./
# WebRTC RTP needs UDP. Run this container with --network host (or on a VM
# with UDP open) so ICE candidates are directly reachable by WhatsApp.
CMD ["node", "worker.js"]
