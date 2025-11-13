# --- Build stage ---
FROM node:20-bullseye AS builder
WORKDIR /app

# Install dependencies
COPY package.json package-lock.json ./
RUN npm ci

# Prisma client
COPY prisma ./prisma
RUN npx prisma generate

# Build TypeScript
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# --- Runtime stage ---
FROM node:20-bullseye-slim AS runtime
WORKDIR /app

# OS deps needed by sharp and healthcheck
RUN apt-get update && \
    apt-get install -y --no-install-recommends libvips curl python3 python3-venv build-essential && \
    rm -rf /var/lib/apt/lists/*

# Copy app
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/dist ./dist
COPY package.json ./
COPY python ./python

# Python venv for OCR/LLM helpers
RUN python3 -m venv /app/python/.venv && \
    /app/python/.venv/bin/pip install --upgrade pip && \
    /app/python/.venv/bin/pip install -r /app/python/requirements.txt

# Uploads directory writable
RUN mkdir -p /app/uploads && chown -R node:node /app/uploads

ENV NODE_ENV=production \
    PORT=8080 \
    LLM_BACKEND=python \
    PYTHON_CMD=/app/python/.venv/bin/python \
    NODE_OPTIONS=--experimental-specifier-resolution=node

EXPOSE 8080

# Simple healthcheck against /health
HEALTHCHECK --interval=20s --timeout=3s --retries=5 CMD curl -fsS http://localhost:${PORT}/health || exit 1

USER node

CMD ["node", "--experimental-specifier-resolution=node", "dist/index.js"]

