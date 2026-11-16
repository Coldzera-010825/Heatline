import { strToU8, zipSync } from "fflate";
import { fileLimitMiB, groupFields, models, roles, sampleFields, studyLifeDays } from "../dist/client/workspace-contract.js";
import { automaticGrid, bbox, boundsValid, box, crsName, feature, overlapGeometry } from "./workspace-geography.mjs";
import { csvText, normalizeInput, timestamp } from "./workspace-inputs.mjs";
import { computeStudy } from "./workspace-analysis.mjs";
import { exportRaster, pixels } from "./workspace-raster.mjs";
import { narrate } from "./assistant.mjs";

const prefix = "heatline-study/";
const deadline = studyLifeDays * 86400000;
const maxBytes = fileLimitMiB * 1024 * 1024;
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const created = () => new Date().toISOString();
const flags = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" };
const ok = body => Response.json(body, { headers: flags });
const fail = (error, status, headers = flags) => Response.json({ error }, { status, headers });
const message = err => err instanceof Error ? err.message : String(err);
const putJSON = (bucket, key, value, ifMissing) => bucket.put(key, JSON.stringify(value), ifMissing ?
  { onlyIf: new Headers({ "If-None-Match": "*" }) } : {});
const getJSON = async (bucket, key) => (await bucket.get(key))?.json();
const ownerPrefix = owner => prefix + "owner/" + owner + "/";
const studyPrefix = (owner, id) => ownerPrefix(owner) + id + "/";
const studyKey = path => path + "study.json";
const fileKey = (path, id) => path + "files/" + id + ".json";
const runKey = (path, id) => path + "runs/" + id + ".json";
const zipName = text => String(text).replace(/[^a-zA-Z0-9_.-]+/g, "-").slice(0, 85) || "heatline";

async function digest(value) {
  const bytes = await crypto.subtle.digest("SHA-256", typeof value === "string" ? new TextEncoder().encode(value) : value);
  return Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, "0")).join("");
}

async function bounded(request, limit) {
  const declared = Number(request.headers.get("content-length"));
  if (declared > limit) throw new Error("The upload exceeds the " + Math.round(limit / 1048576) + " MiB file limit.");
  const reader = request.body?.getReader();
  if (!reader) throw new Error("The request has no data.");
  const chunks = [];
  let size = 0;
  for (;;) {
    const part = await reader.read();
    if (part.done) break;
    size += part.value.byteLength;
    if (size > limit) {
      await reader.cancel();
      throw new Error("This request exceeds the allowed size.");
    }
    chunks.push(part.value);
  }
  if (!size) throw new Error("The request has no data.");
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result.buffer;
}

async function bodyJSON(request) {
  const body = JSON.parse(new TextDecoder().decode(await bounded(request, 16384)));
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Send a JSON object.");
  return body;
}

const active = study => study && Number(study.expiresAt) > Date.now();
const live = async (bucket, path) => active(await getJSON(bucket, studyKey(path)));
const dateYear = year => Number.isInteger(year) && year >= 1800 && year <= 2200;

async function listing(bucket, path, cap = 30) {
  const { objects } = await bucket.list({ prefix: path, limit: cap });
  const result = [];
  for (let i = 0; i < objects.length; i += 6) {
    const batch = await Promise.all(objects.slice(i, i + 6).map(o => getJSON(bucket, o.key)));
    result.push(...batch.filter(Boolean));
  }
  return result;
}

async function remove(bucket, path, expiryKey) {
  await bucket.delete(studyKey(path));
  for (;;) {
    const { objects } = await bucket.list({ prefix: path, limit: 100 });
    if (!objects.length) break;
    await bucket.delete(objects.map(o => o.key));
  }
  if (expiryKey) await bucket.delete(expiryKey);
}

export async function pruneResearch(bucket) {
  if (!bucket) return;
  const { objects } = await bucket.list({ prefix: prefix + "expiry/", limit: 8 });
  for (const object of objects) {
    const at = Number(object.key.slice((prefix + "expiry/").length).split("/", 1)[0]);
    if (at > Date.now()) break;
    const item = await getJSON(bucket, object.key);
    if (item) await remove(bucket, studyPrefix(item.owner, item.id), object.key);
  }
}

async function catalog(assets, url) {
  const res = await assets.fetch(new Request(new URL("/data/admin/catalog.json", url)));
  return res.json();
}

function metaForUpload(url, study) {
  const q = url.searchParams, role = q.get("role");
  if (!Object.hasOwn(roles, role)) throw new Error("Choose a dataset role.");
  const fileName = (q.get("file") ?? "").replaceAll("\\", "/").split("/").at(-1).trim().slice(0, 160);
  const label = (q.get("label")?.trim() || fileName).slice(0, 96);
  const extension = "." + fileName.split(".").at(-1).toLowerCase();
  if (!fileName || !roles[role].accept.split(",").includes(extension)) throw new Error("This role expects " + roles[role].format + ".");
  const units = q.get("units")?.trim().slice(0, 24) || "";
  const field = q.get("field")?.trim().slice(0, 80) || "";
  const crs = q.get("crs")?.trim().slice(0, 24) || "";
  const year = Number(q.get("year"));
  const at = q.get("time");
  if (role === "lst" && !["C", "K"].includes(units)) throw new Error("Choose Celsius or kelvin for the LST band.");
  if (role === "lst" && timestamp(at) !== study.eventTime) throw new Error("Enter the LST observation time. It must match this study's event time.");
  if (["population", "censusGroups"].includes(role) && !dateYear(year)) throw new Error("Enter a valid population reference year.");
  if (role === "referenceRaster" && !units) throw new Error("Declare the reference raster unit.");
  return { role, fileName, label, crs, field, units, ...(dateYear(year) ? { year } : {}), ...(at ? { at: timestamp(at) } : {}),
    source: q.get("source")?.trim().slice(0, 160) || fileName };
}

async function saveInput(bucket, path, study, meta, bytes, boundary, installing = false) {
  const id = meta.role === "boundary" ? "boundary" : crypto.randomUUID();
  if (id === "boundary" && await getJSON(bucket, fileKey(path, id))) {
    throw new Error("This study already has a boundary. Create a new study to use a different outline.");
  }
  const normalized = await normalizeInput(bytes, meta, study, boundary?.geometry);
  const asset = path + "assets/" + crypto.randomUUID() + "/";
  const raw = asset + "source", data = asset + "data", preview = asset + "preview";
  const entry = { ...meta, id, assets: asset, bytes: bytes.byteLength, sha256: await digest(bytes),
    format: roles[meta.role].format, createdAt: created(), details: normalized.details,
    ...(normalized.grid ? { grid: normalized.grid } : {}),
    ...(id === "boundary" ? { gridCrs: study.gridCrs ?? automaticGrid(normalized.details.bounds) } : {}) };
  if (meta.role === "lst") {
    entry.inputUnits = meta.units;
    entry.units = "°C";
  }
  if (meta.role === "population") entry.units = "people/pixel";
  try {
    if (!installing && !await live(bucket, path)) throw new Error("This study expired or was deleted.");
    // Wait for every write before cleaning up a rejected import.
    const writes = await Promise.allSettled([bucket.put(raw, bytes), bucket.put(data, normalized.grid ? normalized.data :
      JSON.stringify(normalized.data)), putJSON(bucket, preview, normalized.preview)]);
    if (writes.some(w => w.status === "rejected")) throw new Error("The upload could not be stored. Retry the import.");
    if (!installing && !await live(bucket, path)) throw new Error("This study expired or was deleted.");
    if (!await putJSON(bucket, fileKey(path, id), entry, true)) throw new Error("The boundary was saved by another import.");
    return publicFile(entry);
  } catch (err) {
    await bucket.delete([raw, data, preview]);
    throw err;
  }
}

function publicFile({ assets, ...file }) { return file; }

async function createStudy(bucket, owner, request, assets, url) {
  const input = await bodyJSON(request);
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!name || name.length > 80) throw new Error("Enter a study name up to 80 characters.");
  const eventTime = timestamp(input.eventTime), id = crypto.randomUUID();
  const city = input.city || null, path = studyPrefix(owner, id), addedAt = created();
  const expiresAt = Date.now() + deadline, expiry = prefix + "expiry/" + expiresAt + "/" + id + ".json";
  const gridCrs = input.gridCrs ? crsName(input.gridCrs, true) : city === "London" ? "EPSG:27700" : null;
  const study = { id, name, eventTime, city, gridCrs, createdAt: addedAt, expiresAt, expiry };
  let source;
  if (city) {
    const { cities } = await catalog(assets, url);
    if (typeof city !== "string" || !Object.hasOwn(cities, city)) throw new Error("Select a listed city or upload your own boundary.");
    const meta = cities[city];
    const response = await assets.fetch(new Request(new URL("/data/admin/" + meta.boundary, url)));
    if (!response.ok) throw new Error("The selected city boundary could not be read.");
    source = { meta, bytes: await response.arrayBuffer() };
  }
  await putJSON(bucket, expiry, { owner, id });
  try {
    if (source) {
      const label = source.meta.name + " · atlas boundary";
      await saveInput(bucket, path, study, { role: "boundary", fileName: "boundary.geojson", label, source: label, units: "" },
        source.bytes, null, true);
    }
    await putJSON(bucket, studyKey(path), study);
  } catch (err) {
    await remove(bucket, path, expiry);
    throw err;
  }
  return ok({ study });
}

async function workspaceView(bucket, path, study) {
  const [files, runs, boundary] = await Promise.all([
    listing(bucket, path + "files/", 30), listing(bucket, path + "runs/", 60),
    getJSON(bucket, fileKey(path, "boundary")),
  ]);
  return ok({ study: { ...study, gridCrs: boundary?.gridCrs ?? study.gridCrs }, files: files.map(publicFile),
    runs: runs.sort((a, b) => b.createdAt.localeCompare(a.createdAt)) });
}

async function loadInput(bucket, path, id, role) {
  if (typeof id !== "string" || !uuid.test(id)) throw new Error("Select a validated " + roles[role].label.toLowerCase() + " file.");
  const meta = await getJSON(bucket, fileKey(path, id));
  if (!meta || meta.role !== role) throw new Error("The selected file does not match the " + roles[role].label.toLowerCase() + " input.");
  const object = await bucket.get(meta.assets + "data");
  if (!object) throw new Error("A validated input is unavailable. Import it again.");
  return { meta, ...(meta.grid ? { bytes: await object.arrayBuffer() } : { data: await object.json() }) };
}

function streamAnalysis(work) {
  const encoder = new TextEncoder();
  let cancelled = false;
  const stream = new ReadableStream({
    async start(controller) {
      const send = object => { if (!cancelled) controller.enqueue(encoder.encode(JSON.stringify(object) + "\n")); };
      try {
        const run = await work(text => send({ type: "progress", text }));
        send({ type: "result", run });
      } catch (err) {
        send({ type: "error", error: message(err) });
      }
      if (!cancelled) controller.close();
    },
    cancel() { cancelled = true; },
  });
  return new Response(stream, { headers: { ...flags, "Content-Type": "application/x-ndjson; charset=utf-8" } });
}

async function executeRun(bucket, path, study, body, progress, assets, url) {
  const id = body.id, kind = body.model;
  if (typeof id !== "string" || !uuid.test(id) || !Object.hasOwn(models, kind)) throw new Error("Select a supported model and a run identifier.");
  const key = runKey(path, id), existing = await getJSON(bucket, key);
  if (existing?.status === "complete") return existing;
  if (existing) throw new Error("This run identifier was already used. Start a new run.");
  const values = { threshold: body.threshold ?? 45, shadePercent: body.shadePercent ?? 25, group: body.group || "" };
  if (!Number.isFinite(values.shadePercent) || values.shadePercent < 0 || values.shadePercent > 100) {
    throw new Error("Choose a shade conversion between 0 and 100%.");
  }
  if (!Number.isFinite(values.threshold) || values.threshold < -100 || values.threshold > 140) {
    throw new Error("Choose a temperature threshold in °C.");
  }
  if (body.bounds != null && !boundsValid(body.bounds)) throw new Error("Draw a valid rectangle.");
  const boundary = await getJSON(bucket, fileKey(path, "boundary"));
  if (!boundary) throw new Error("Add the study boundary before running a model.");
  const outline = await getJSON(bucket, boundary.assets + "data");
  const selection = body.bounds ? overlapGeometry(outline.geometry, box(body.bounds)) : outline.geometry;
  if (!selection) throw new Error("The selection does not overlap this study.");
  const step = progress;
  step("Reading the selected file versions and verifying their coverage…");
  const data = {};
  for (const role of models[kind].inputs) data[role] = await loadInput(bucket, path, body.files?.[role], role);
  if (kind === "resident" && body.files?.reference && body.files.reference !== body.files.population) {
    data.reference = await loadInput(bucket, path, body.files.reference, "population");
  }
  if (kind === "priority" && !data.censusGroups.meta.details.groups.some(group => group.id === values.group)) {
    throw new Error("Choose a group included in the census counts.");
  }
  const base = { id, model: kind, label: models[kind].label, createdAt: created(), eventTime: study.eventTime };
  if (!await live(bucket, path) || !await putJSON(bucket, key, { ...base, status: "running" }, true)) {
    throw new Error("The study or run is no longer available.");
  }
  const resultKey = path + "results/" + id, viewKey = path + "views/" + id;
  try {
    step(kind === "resident" ? "Matching population pixels to valid surface temperatures…" :
      kind === "shade" ? "Computing UTCI for the walking samples and applying valid shade pairs…" :
        kind === "priority" ? "Combining walking heat and sunlit length with resident group shares…" :
          "Evaluating UTCI and aggregating by represented walking length…");
    const { preview, ...result } = computeStudy(kind, data, selection, values, { ...study, gridCrs: boundary.gridCrs });
    const appBuild = await assets.fetch(new Request(new URL("/build-info.json", url)));
    const revision = appBuild.ok ? (await appBuild.json()).commit : "local";
    const inputs = Object.entries(data).map(([slot, { meta }]) => ({ slot, ...publicFile(meta) }));
    inputs.unshift({ role: "boundary", ...publicFile(boundary) });
    const manifest = { version: 1, runId: id, study: study.name, model: kind, methodVersion: "heatline-research-v1",
      applicationRevision: revision, timeUtc: study.eventTime, gridCrs: boundary.gridCrs, selection: bbox(selection),
      parameters: values, inputs, method: result.basis, outputFields: result.fields };
    const record = { ...base, status: "complete", summary: result.summary, primary: result.primary,
      unit: result.unit, basis: result.basis, count: result.rows.length, previewStride: result.previewStride,
      candidates: result.candidates };
    step("Preparing the result layers and reproducibility manifest…");
    if (!await live(bucket, path)) throw new Error("The study has expired or was deleted.");
    await putJSON(bucket, resultKey, { ...result, manifest, boundary: outline, selection: feature(selection) });
    await putJSON(bucket, viewKey, preview);
    if (!await live(bucket, path)) throw new Error("The study has expired or was deleted.");
    await putJSON(bucket, key, record);
    return record;
  } catch (err) {
    await bucket.delete([resultKey, viewKey]);
    if (await live(bucket, path)) await putJSON(bucket, key, { ...base, status: "failed", error: message(err) });
    throw err;
  }
}

function download(body, content, name) {
  const safe = zipName(name);
  return new Response(body, { headers: { ...flags, "Content-Type": content,
    "Content-Disposition": "attachment; filename=\"" + safe + "\"; filename*=UTF-8''" + encodeURIComponent(name) } });
}

async function exportFile(bucket, meta, format) {
  const name = meta.fileName, stem = name.replace(/\.[^.]+$/, "");
  const mime = { CSV: "text/csv; charset=utf-8", GeoJSON: "application/geo+json", GeoTIFF: "image/tiff" };
  if (format !== "normalized") {
    const raw = await bucket.get(meta.assets + "source");
    return raw ? download(raw.body, mime[meta.format], name) : fail("Original file unavailable.", 404);
  }
  const normalized = await bucket.get(meta.assets + "data");
  if (!normalized) return fail("Validated file unavailable.", 404);
  if (meta.grid) return download(exportRaster(meta.grid, pixels(await normalized.arrayBuffer())), mime.GeoTIFF, stem + "-clipped.tif");
  if (meta.format === "CSV") return download(csvText(meta.role === "samples" ? sampleFields : groupFields, await normalized.json()), mime.CSV, stem + "-validated.csv");
  return download(normalized.body, mime.GeoJSON, stem + "-clipped.geojson");
}

function exportRun(result, format, name) {
  if (format === "geojson") {
    const encoder = new TextEncoder();
    let row = -1;
    const body = new ReadableStream({
      pull(controller) {
        if (row === -1) {
          controller.enqueue(encoder.encode('{"type":"FeatureCollection","features":['));
          row = 0;
        } else if (row >= result.rows.length) {
          controller.enqueue(encoder.encode("]}"));
          controller.close();
        } else {
          const values = result.rows[row], geometry = result.shapes?.[row] ?? { type: "Point", coordinates: values.slice(0, 2) };
          const props = Object.fromEntries(result.fields.slice(2).map((key, i) => [key, values[i + 2]]));
          controller.enqueue(encoder.encode((row ? "," : "") + JSON.stringify(feature(geometry, props))));
          row++;
        }
      },
    });
    return download(body, "application/geo+json", name + ".geojson");
  }
  const rows = csvText(result.fields, result.rows);
  if (format === "csv") return download(rows, "text/csv; charset=utf-8", name + ".csv");
  if (format !== "zip") return fail("Choose CSV, GeoJSON or ZIP.", 400);
  const summary = csvText(["metric", "value", "unit"], result.summary.map(s => [s.label, s.value, s.unit]));
  return download(zipSync({ "manifest.json": strToU8(JSON.stringify(result.manifest, null, 2)), "results.csv": strToU8(rows),
    "summary.csv": strToU8(summary), "study-boundary.geojson": strToU8(JSON.stringify(result.boundary)),
    "selection.geojson": strToU8(JSON.stringify(result.selection)) }, { level: 1 }), "application/zip", name + "-reproducibility.zip");
}

export async function workspace(request, url, env, context) {
  const visitor = request.headers.get("oai-authenticated-user-id");
  const bucket = env.WORKSPACE;
  if (!visitor) return fail("Sign in to open your private research workspace.", 401,
    { ...flags, "X-Heatline-Workspace-Storage": bucket ? "ready" : "unavailable" });
  const origin = request.headers.get("origin");
  if (origin && origin !== url.origin) return fail("Open the research workspace on this site.", 403);
  if (!bucket) return fail("Research storage is unavailable.", 503);
  return workspaceData(request, url, { bucket, owner: await digest(visitor), assets: env.ASSETS,
    onList: () => context?.waitUntil(pruneResearch(bucket).catch(() => {})),
    describe: body => narrate(body, env) });
}

// The authenticated service and the in-tab worker share these model and file operations.
export async function workspaceData(request, url, { bucket, owner, assets, onList, describe }) {
  const [action, id, category, item, verb, extra] = url.pathname.slice("/api/workspace".length).split("/").slice(1);
  const method = request.method;
  try {
    if (!action && method === "GET") {
      onList?.();
      const { delimitedPrefixes } = await bucket.list({ prefix: ownerPrefix(owner), delimiter: "/", limit: 30 });
      const studies = [];
      for (let i = 0; i < delimitedPrefixes.length; i += 6) {
        const batch = await Promise.all(delimitedPrefixes.slice(i, i + 6).map(path => getJSON(bucket, studyKey(path))));
        studies.push(...batch.filter(active));
      }
      const { cities } = await catalog(assets, url);
      return ok({ studies: studies.sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
        cities: Object.entries(cities).map(([id, city]) => ({ id, name: city.name })) });
    }
    if (action === "studies" && !id && method === "POST") return await createStudy(bucket, owner, request, assets, url);
    if (action !== "studies" || !uuid.test(id ?? "") || extra) return fail("Not found.", 404);
    const path = studyPrefix(owner, id), study = await getJSON(bucket, studyKey(path));
    if (!active(study)) return fail("This research study was not found or has expired.", 404);
    if (!category && method === "GET") return await workspaceView(bucket, path, study);
    if (!category && method === "DELETE") {
      await remove(bucket, path, study.expiry);
      return ok({ deleted: true });
    }
    if (category === "files") {
      if (!item && method === "POST") {
        const meta = metaForUpload(url, study), boundary = await getJSON(bucket, fileKey(path, "boundary"));
        if (meta.role !== "boundary" && !boundary) throw new Error("Add a valid study boundary first.");
        const outline = boundary && await getJSON(bucket, boundary.assets + "data");
        return ok({ file: await saveInput(bucket, path, { ...study, gridCrs: boundary?.gridCrs ?? study.gridCrs }, meta,
          await bounded(request, maxBytes), outline) });
      }
      if (method !== "GET" || (item !== "boundary" && !uuid.test(item ?? ""))) return fail("File not found.", 404);
      const file = await getJSON(bucket, fileKey(path, item));
      if (!file) return fail("File not found.", 404);
      if (verb === "preview") return ok(await getJSON(bucket, file.assets + "preview"));
      if (verb === "export") return await exportFile(bucket, file, url.searchParams.get("format"));
    }
    if (category === "runs") {
      if (!item && method === "POST") {
        const body = await bodyJSON(request);
        return streamAnalysis(progress => executeRun(bucket, path, study, body, progress, assets, url));
      }
      if (!uuid.test(item ?? "")) return fail("Run not found.", 404);
      const run = await getJSON(bucket, runKey(path, item));
      if (!run || run.status !== "complete") return fail("Completed run not found.", 404);
      if (verb === "explain" && method === "POST") {
        const { question } = await bodyJSON(request);
        if (typeof question !== "string" || !question.trim() || question.length > 400) throw new Error("Enter a question of up to 400 characters.");
        const fallback = run.summary.map(s => s.label + " " + s.value + s.unit).join(" · ") + ". " + run.basis;
        const explanation = await describe?.({ narrate: { question, digest: { reply: fallback, timeUtc: run.eventTime,
          model: run.label, metrics: run.summary, basis: run.basis } } });
        return ok({ reply: explanation?.ok ? explanation.reply : fallback, mode: explanation?.ok ? "Gemini" : "Run summary" });
      }
      if (method !== "GET") return fail("Run not found.", 404);
      if (verb === "preview") return ok(await getJSON(bucket, path + "views/" + item));
      if (verb === "export") {
        const result = await getJSON(bucket, path + "results/" + item);
        if (result) return exportRun(result, url.searchParams.get("format") ?? "csv", zipName(study.name) + "-" + run.model);
      }
    }
    return fail("Not found.", 404);
  } catch (err) {
    return fail(message(err), 422);
  }
}
