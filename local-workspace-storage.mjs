// The loopback preview uses the same object API with in-memory storage.
export function localWorkspace() {
  const objects = new Map();
  return {
    async put(key, data, options) {
      if (options?.onlyIf?.get("if-none-match") === "*" && objects.has(key)) return null;
      const bytes = typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data.buffer ??
        data, data.byteOffset ?? 0, data.byteLength).slice();
      objects.set(key, bytes);
      return { key, size: bytes.length };
    },
    async get(key) {
      const data = objects.get(key);
      return data ? new Response(data) : null;
    },
    async delete(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) objects.delete(key);
    },
    async list({ prefix = "", limit = 1000, delimiter } = {}) {
      const found = [], groups = new Set();
      for (const [key, value] of [...objects.entries()].sort(([a], [b]) => a.localeCompare(b))) {
        if (!key.startsWith(prefix)) continue;
        const slash = delimiter ? key.indexOf(delimiter, prefix.length) : -1;
        if (slash >= 0) groups.add(key.slice(0, slash + 1));
        else found.push({ key, size: value.byteLength });
        if (found.length + groups.size >= limit) break;
      }
      return { objects: found, delimitedPrefixes: [...groups] };
    },
  };
}
