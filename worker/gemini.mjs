// Shared Gemini transport. A stale proxy connection surfaces as a timeout, so a
// single retry covers the common transient failure without retrying 4xx answers.

async function geminiPost(endpoint, body, key, timeout) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": key },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeout),
      });
    } catch (error) {
      if (attempt >= 1) throw error;
    }
  }
}

const endpointFor = model =>
  "https://generativelanguage.googleapis.com/v1beta/models/" + encodeURIComponent(model) + ":generateContent";

export { geminiPost, endpointFor };
