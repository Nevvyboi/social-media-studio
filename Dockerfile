# Debian slim rather than Alpine: sharp ships prebuilt binaries for glibc, and
# building libvips from source in a container is twenty minutes of nothing.
FROM node:20-slim

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev

COPY . .
RUN node scripts/make-source-image.js

CMD ["node", "src/server.js"]
