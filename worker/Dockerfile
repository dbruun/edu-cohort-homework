FROM node:20-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src

ENV NODE_ENV=production

# The archive is streamed to a temporary directory, so the job needs writable
# ephemeral storage sized for the largest supported import.
USER node

CMD ["node", "src/index.js"]
