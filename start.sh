#!/bin/sh
# Startup script for the pixels-assistant container.
# Runs Ollama and the Node API server in the same container.
#
# Order of operations:
#   1. Ensure the model-storage directory exists (Railway volume mounts here)
#   2. Start ollama serve in the background
#   3. Wait until Ollama's HTTP API responds (up to 30 s)
#   4. Pull the model — no-op if it's already in OLLAMA_MODELS cache
#   5. Seed the wiki_entries table — INSERT OR REPLACE makes this idempotent
#   6. exec into the Node server (becomes PID 1; Ollama stays as background sibling)

set -e

MODEL="${OLLAMA_MODEL:-qwen2.5:3b}"
MODELS_DIR="${OLLAMA_MODELS:-/app/data/ollama-models}"

# ---- 1. Ensure model cache directory exists ----
mkdir -p "$MODELS_DIR"

# ---- 2. Start Ollama in the background ----
echo "[start.sh] Starting Ollama server (model cache: $MODELS_DIR)..."
ollama serve &

# ---- 3. Wait for Ollama to accept connections ----
echo "[start.sh] Waiting for Ollama to be ready..."
MAX_WAIT=30
ELAPSED=0
until curl -sf http://localhost:11434/api/version > /dev/null 2>&1; do
  if [ "$ELAPSED" -ge "$MAX_WAIT" ]; then
    echo "[start.sh] ERROR: Ollama did not start within ${MAX_WAIT}s" >&2
    exit 1
  fi
  sleep 1
  ELAPSED=$((ELAPSED + 1))
done
echo "[start.sh] Ollama is ready (${ELAPSED}s)."

# ---- 4. Pull the model (skipped automatically if digest already matches) ----
echo "[start.sh] Pulling model '${MODEL}' (no-op if already cached)..."
ollama pull "$MODEL"
echo "[start.sh] Model '${MODEL}' is ready."

# ---- 5. Seed the wiki (idempotent — INSERT OR REPLACE on topic) ----
# Uses the compiled output (dist/db/seed.js) because ts-node is a dev
# dependency and is not installed in the production image.
echo "[start.sh] Seeding wiki_entries..."
node dist/db/seed.js
echo "[start.sh] Seed complete."

# ---- 6. Hand off to Node (replaces this shell as the main process) ----
echo "[start.sh] Starting Node server..."
exec node dist/index.js
