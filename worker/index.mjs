import { analyzeArea, validBounds } from "./analysis.mjs";
import { chat } from "./assistant.mjs";
import { analyzePopulation, analyzeShade, analyzeStation } from "./event-analysis.mjs";
import { analyzeArchive, archiveChat, compareStreet } from "./case-analysis.mjs";
import { analyzeCityStreet } from "./city-street.mjs";

const maxBodyBytes = 16 * 1024;
const encoder = new TextEncoder();
const jsonHeaders = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" };

function errorResult(reply) {
  return { ok: false, status: "error", reply };
}

function json(result, status = 200, headers = {}) {
  return new Response(JSON.stringify(result), { status, headers: { ...jsonHeaders, ...headers } });
}

async function readBody(request) {
  const reader = request.body?.getReader();
  if (!reader) return null;
  let size = 0;
  let text = "";
  const decoder = new TextDecoder();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBodyBytes) {
      await reader.cancel();
      return undefined;
    }
    text += decoder.decode(value, { stream: true });
  }
  const body = JSON.parse(text + decoder.decode());
  return body && typeof body === "object" && !Array.isArray(body) ? body : null;
}

async function handleApi(request, url, env) {
  if (request.method !== "POST") {
    return json(errorResult("Use POST for this request."), 405, { Allow: "POST" });
  }
  const origin = request.headers.get("origin");
  if (origin && origin !== url.origin) {
    return json(errorResult("Send analysis requests from the Heatline page."), 403);
  }
  if (!/^application\/json(?:;|$)/i.test(request.headers.get("content-type") ?? "")) {
    return json(errorResult("Send a JSON request body."), 415);
  }
  if (Number(request.headers.get("content-length")) > maxBodyBytes) {
    return json(errorResult("The request is too large."), 413);
  }
  let body;
  try {
    body = await readBody(request);
  } catch {
    return json(errorResult("Send a valid JSON object."), 400);
  }
  if (body === undefined) return json(errorResult("The request is too large."), 413);
  if (!body) return json(errorResult("Send a valid JSON object."), 400);

  const readAsset = async (directory, filename, format = "json") => {
    const resource = new URL("/data/" + directory + "/" + filename, url);
    const response = await env.ASSETS.fetch(new Request(resource));
    if (!response.ok) throw new Error("Missing historical event data asset");
    const content = format === "json" ? response : new Response(response.body.pipeThrough(new DecompressionStream("gzip")));
    return format === "packed-index" ? content.arrayBuffer() : content.json();
  };
  const readEvent = filename => filename === "stations.json" ? readAsset("heatwave", filename) :
    readAsset("heatwave", filename.replace(/\.json$/, ".bin"), "packed-json");
  const readCase = (filename, format) => readAsset("cases", filename, format);
  const readAdmin = (filename, format) => readAsset("admin", filename, format);
  const runArchive = (options, progress) => analyzeArchive(options, progress, readCase, readAdmin);
  async function analyze(options, progress) {
    if (options.coverage === "city" && (options.kind === "shade" || options.kind === "exposure")) {
      if (options.bounds != null && !validBounds(options.bounds)) return { ok: false, status: "clarify", reply: "Draw a valid rectangular area." };
      const catalog = await readAdmin("catalog.json", "json");
      const model = catalog.cityStreetModels?.London?.["E3_2022-07"];
      if (model) return analyzeCityStreet(options, model, catalog.cities.London, progress, readAdmin);
      return { ok: false, status: "unavailable", reply: "Full city radiation inputs are unavailable for this event." };
    }
    switch (options.kind) {
      case "street-comparison": return compareStreet(options, progress, readAdmin);
      case "station": return analyzeStation(options, progress, readEvent);
      case "population": return analyzePopulation(options, progress, readEvent);
      case "shade": return analyzeShade(options, progress, readEvent);
      case "exposure":
      case undefined: return analyzeArea(options, progress, (filename, format) => readAsset("london-utci", filename, format));
      default: return errorResult("Choose a supported Heatline analysis.");
    }
  }
  async function run(progress) {
    try {
      if (Object.hasOwn(body, "archiveCase")) {
        const { region, event } = body.archiveCase ?? {};
        if (region === "London" && ["E3_2022-07", "london-detail"].includes(event) &&
            url.pathname === "/api/analysis" && (event === "london-detail" || body.kind === "groups")) {
          return analyze({ ...body, kind: body.kind === "groups" ? "population" : body.kind }, progress);
        }
        return await (url.pathname === "/api/chat" ?
          archiveChat(body, progress, readCase, runArchive, options => chat(options, progress, env, analyze)) :
          runArchive(body, progress));
      }
      return await (url.pathname === "/api/chat"
        ? chat(body, progress, env, analyze)
        : analyze(body, progress));
    } catch (error) {
      console.error("Heatline analysis failed:", error.message);
      return errorResult("Heatline could not load or analyse the selected case. Try again.");
    }
  }

  if (!/\bapplication\/x-ndjson\b/i.test(request.headers.get("accept") ?? "")) {
    const result = await run(() => {});
    return json(result, result.status === "error" ? 500 : 200);
  }

  let cancelled = false;
  const stream = new ReadableStream({
    start(controller) {
      const send = event => {
        if (!cancelled) controller.enqueue(encoder.encode(JSON.stringify(event) + "\n"));
      };
      run(message => send({ type: "progress", message })).then(result => {
        if (cancelled) return;
        send({ type: "result", ...result });
        controller.close();
      });
    },
    cancel() { cancelled = true; },
  });
  const headers = { ...jsonHeaders, "Content-Type": "application/x-ndjson; charset=utf-8" };
  if (url.pathname === "/api/analysis" && body.mapFormat === "compact" && /\bgzip\b/i.test(request.headers.get("accept-encoding") ?? "")) {
    return new Response(stream.pipeThrough(new CompressionStream("gzip")), {
      headers: { ...headers, "Content-Encoding": "gzip", Vary: "Accept-Encoding" }, encodeBody: "manual",
    });
  }
  return new Response(stream, { headers });
}

export default {
  fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/analysis" || url.pathname === "/api/chat") {
      return handleApi(request, url, env);
    }
    return env.ASSETS.fetch(request);
  },
};
