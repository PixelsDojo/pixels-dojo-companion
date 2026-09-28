/**
 * Ollama client service.
 *
 * Wraps the Ollama /api/generate endpoint. Designed to fail gracefully:
 * network errors and non-2xx responses surface as OllamaUnavailableError,
 * which callers can catch and convert to an appropriate HTTP response without
 * crashing the server.
 */

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

export class OllamaUnavailableError extends Error {
  constructor(reason: string) {
    super(`Ollama is not reachable: ${reason}`);
    this.name = "OllamaUnavailableError";
  }
}

// ---------------------------------------------------------------------------
// Config (resolved once at module load so missing vars surface early)
// ---------------------------------------------------------------------------

function getConfig() {
  const ollamaUrl = process.env.OLLAMA_URL;
  if (!ollamaUrl) {
    throw new Error("OLLAMA_URL environment variable is not set");
  }
  const model = process.env.OLLAMA_MODEL ?? "qwen2.5:3b";
  return { ollamaUrl, model };
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

/**
 * Send a prompt to the configured Ollama instance and return the text response.
 *
 * @throws {OllamaUnavailableError} when Ollama cannot be reached or returns an error status.
 */
export async function askOllama(prompt: string, options?: { numPredict?: number }): Promise<string> {
  const { ollamaUrl, model } = getConfig();
  const endpoint = `${ollamaUrl.replace(/\/$/, "")}/api/generate`;

  const numPredict = options?.numPredict ?? 150;

  let response: Response;

  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, prompt, stream: false, options: { temperature: 0.3, num_predict: numPredict } }),
    });
  } catch (err) {
    // Network-level failure (ECONNREFUSED, DNS failure, timeout, …)
    const reason =
      err instanceof Error ? err.message : "unknown network error";
    throw new OllamaUnavailableError(reason);
  }

  if (!response.ok) {
    throw new OllamaUnavailableError(
      `HTTP ${response.status} from ${endpoint}`
    );
  }

  // Ollama returns { response: "...", ... } for non-streaming requests
  const body = (await response.json()) as { response?: string };

  if (typeof body.response !== "string") {
    throw new OllamaUnavailableError(
      "Unexpected response shape from Ollama (missing 'response' field)"
    );
  }

  return body.response;
}
