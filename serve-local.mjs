import { createServer } from "node:http";
import { createReadStream, readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { stat } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import worker from "./worker/index.mjs";
import { localWorkspace } from "./local-workspace-storage.mjs";

const root = fileURLToPath(new URL("./dist/client", import.meta.url));
const envFile = fileURLToPath(new URL("./.dev.vars", import.meta.url));
// The regression harness runs without a model so its assertions stay deterministic.
// Values from .dev.vars win over the shell: an empty exported variable used to hide the key.
if (process.env.HEATLINE_OFFLINE !== "1") {
  try {
    Object.assign(process.env, parseEnv(readFileSync(envFile, "utf8")));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}
const env = {
  GEMINI_API_KEY: process.env.GEMINI_API_KEY,
  GEMINI_MODEL: process.env.GEMINI_MODEL,
};
const previewWorkspace = process.env.HEATLINE_LOCAL_WORKSPACE === "1";
if (previewWorkspace) env.WORKSPACE = localWorkspace();
const port = Number(process.env.HEATLINE_PREVIEW_PORT ?? 8788);
const origin = "http://127.0.0.1:" + port;
const types = {
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8", ".json": "application/json",
  ".geojson": "application/geo+json", ".png": "image/png", ".glb": "model/gltf-binary",
};
const ASSETS = {
  async fetch(request) {
    const { pathname } = new URL(request.url);
    const name = resolve(root, "." + decodeURIComponent(pathname === "/" ? "/index.html" : pathname));
    if (!name.startsWith(root + sep)) return new Response("Not found", { status: 404 });
    try {
      const file = await stat(name);
      if (!file.isFile()) return new Response("Not found", { status: 404 });
      return new Response(request.method === "HEAD" ? null : Readable.toWeb(createReadStream(name)), {
        headers: { "Content-Type": types[extname(name)] ?? "application/octet-stream", "Content-Length": file.size },
      });
    } catch (error) {
      if (error.code === "ENOENT" || error.code === "ENOTDIR") return new Response("Not found", { status: 404 });
      throw error;
    }
  },
};

createServer(async (incoming, outgoing) => {
  try {
    const body = ["GET", "HEAD"].includes(incoming.method) ? undefined : Readable.toWeb(incoming);
    const host = incoming.headers.host ?? "127.0.0.1:" + port;
    const headers = new Headers(incoming.headers);
    if (previewWorkspace && !headers.has("oai-authenticated-user-id")) headers.set("oai-authenticated-user-id", "heatline-local-researcher");
    const request = new Request(new URL(incoming.url, "http://" + host), {
      method: incoming.method, headers, ...(body && { body, duplex: "half" }),
    });
    const response = await worker.fetch(request, { ...env, ASSETS });
    if (incoming.url.startsWith("/api/")) console.log(request.method, incoming.url, "->", response.status);
    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    if (!response.body) return outgoing.end();
    const stream = Readable.fromWeb(response.body);
    outgoing.on("close", () => stream.destroy());
    stream.on("error", () => outgoing.destroy());
    stream.pipe(outgoing);
  } catch (error) {
    console.error(error.message);
    outgoing.writeHead(500);
    outgoing.end("Local preview error");
  }
}).listen(port, "127.0.0.1", () => console.log("Heatline: " + origin));
