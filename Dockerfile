# ---- build stage ----
# Alpine is fine here — we only need Node + tsc, no native Ollama binary.
FROM node:22-alpine AS builder

WORKDIR /app

# Install dependencies first (better layer caching)
COPY package*.json ./
RUN npm ci

# Copy source and compile
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# ---- runtime stage ----
# node:22-slim (Debian) is required: the Ollama binary is compiled for glibc,
# which Alpine's musl libc does not provide.
FROM node:22-slim AS runner

# Install curl (used by start.sh readiness probe) and Ollama.
# The Ollama install script detects the arch, downloads the binary, and places
# it at /usr/local/bin/ollama. Systemd setup is silently skipped in Docker.
RUN apt-get update && \
    apt-get install -y --no-install-recommends curl ca-certificates zstd && \
    curl -fsSL https://ollama.com/install.sh | sh && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production

# Model weights are stored here. Point this at an /app/data Railway Volume
# so models survive container restarts and Railway auto-sleep wake-ups.
ENV OLLAMA_MODELS=/app/data/ollama-models

WORKDIR /app

# Only production deps
COPY package*.json ./
RUN npm ci --omit=dev

# Copy compiled output from builder
COPY --from=builder /app/dist ./dist

# Copy repo-shipped static assets (tips, guides, library snapshot, i18n seed).
# These must NOT go in /app/data — Railway mounts a persistent volume there
# (for Ollama model weights) which hides any files baked into the image.
COPY static/ ./static/

# Copy startup script
COPY start.sh ./start.sh
RUN chmod +x ./start.sh

EXPOSE 3000

# start.sh: boots Ollama, waits for it, pulls the model, then execs Node.
CMD ["/app/start.sh"]
