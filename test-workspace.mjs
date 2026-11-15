import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { unzipSync } from "fflate";
import { fromArrayBuffer, writeArrayBuffer } from "geotiff";
import worker from "./dist/server/index.js";
import { localWorkspace } from "./local-workspace-storage.mjs";
import { sampleFields } from "./dist/client/workspace-contract.js";
import { csvText, withinUTCI } from "./worker/workspace-inputs.mjs";
import { evaluateStreetGrid } from "./worker/utci.mjs";

const stamp = "2022-07-18T10:52:15Z";
const client = new URL("./dist/client/", import.meta.url);
const admin = new URL("data/admin/", client);
const readData = async name => JSON.parse(await readFile(new URL(name, client), "utf8"));
const outline = (w, s, e, n, properties = {}) => ({ type: "Feature", properties,
  geometry: { type: "Polygon", coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] } });
const source = await readData("data/admin/catalog.json");
const londonModel = source.cityStreetModels.London["E3_2022-07"];
const inLondon = (x, y) => x >= -.145 && x <= -.105 && y >= 51.505 && y <= 51.527;
const classNames = ["sunlit", "building_shade", "canopy_shade", "partial_shade"];
const batches = [];
for (const shard of londonModel.shards) {
  if (shard.bounds[0] > -.105 || shard.bounds[2] < -.145 || shard.bounds[1] > 51.527 || shard.bounds[3] < 51.505) continue;
  batches.push(...JSON.parse(gunzipSync(await readFile(new URL(shard.file, admin)))));
}
const samples = [], expected = [], expectedPairs = [];
for (const tile of batches) {
  const sub = { rows: tile.rows.filter(([x, y]) => inLondon(x, y)) };
  const clean = sub.rows.map(([x, y, base, length, geometry, values]) => [x, y, base, length, geometry,
    values.filter(([tmrt]) => withinUTCI(tmrt, tile.weather.airC, tile.weather.wind))]).filter(row => row[5].length);
  const calc = evaluateStreetGrid({ rows: clean }, tile.weather);
  expected.push(...calc.rows);
  expectedPairs.push(...calc.pairs);
  for (const [x, y, , , , values] of sub.rows) for (const [tmrt, ...metres] of values) {
    for (const [code, m] of metres.entries()) if (m >= .001) samples.push(["sample-" + samples.length, x, y, stamp, m, tmrt,
      tile.weather.airC, tile.weather.humidity, tile.weather.wind, classNames[code], ""]);
  }
}
const csv = csvText(sampleFields, samples);
assert(samples.length > 1000 && samples.length < 100000);

const fixtureDir = process.argv[2];
if (fixtureDir) {
  await mkdir(fixtureDir, { recursive: true });
  await writeFile(join(fixtureDir, "central-london-walking.csv"), csv);
  await writeFile(join(fixtureDir, "central-london-boundary.geojson"), JSON.stringify(outline(-.148, 51.502, -.102, 51.530)));
}

const bucket = localWorkspace();
const env = { WORKSPACE: bucket, ASSETS: {
  async fetch(request) {
    const { pathname } = new URL(request.url);
    try { return new Response(await readFile(new URL("." + pathname, client))); }
    catch { return new Response(null, { status: 404 }); }
  },
} };
async function call(path = "", method = "GET", input, name = "owner-a", origin) {
  const headers = new Headers();
  if (name) headers.set("oai-authenticated-user-id", name);
  if (origin) headers.set("origin", origin);
  if (input && typeof input === "object" && !(input instanceof ArrayBuffer) && !ArrayBuffer.isView(input)) {
    headers.set("content-type", "application/json");
    input = JSON.stringify(input);
  }
  return worker.fetch(new Request("https://heatline.test/api/workspace" + path, { method, headers, body: input }), env,
    { waitUntil(p) { p.catch(() => {}); } });
}
async function checked(response) {
  const r = await response, parsed = await r.json();
  assert.equal(r.status, 200, JSON.stringify(parsed));
  return parsed;
}
const upload = (path, fields, data) => call(path + "/files?" + new URLSearchParams(fields), "POST", data);
async function run(path, request) {
  const response = await call(path + "/runs", "POST", { id: crypto.randomUUID(), ...request });
  assert.equal(response.headers.get("content-type"), "application/x-ndjson; charset=utf-8");
  const items = (await response.text()).trim().split("\n").map(JSON.parse);
  const final = items.at(-1);
  assert(items.some(row => row.type === "progress"), JSON.stringify(items));
  assert.equal(final.type, "result", JSON.stringify(final));
  return final.run;
}

assert.equal((await call("", "GET", undefined, null)).status, 401);
assert.equal((await call("", "GET", undefined, "owner-a", "https://another.test")).status, 403);
const { study: london } = await checked(call("/studies", "POST", { name: "London replay", eventTime: stamp, city: "London" }));
const root = "/studies/" + london.id;
assert.equal((await call(root, "GET", undefined, "another-owner")).status, 404);
assert.equal((await call(root + "/files/boundary/export", "GET", undefined, "another-owner")).status, 404);
assert.equal((await upload(root, { role: "samples", file: "bad.csv" }, "lon,lat\n-0.13,51.51\n")).status, 422);
const { file: model } = await checked(upload(root, { role: "samples", file: "london.csv", label: "London SOLWEIG inputs" }, csv));
assert.equal(model.details.records, samples.length);
const result = await run(root, { model: "shade", files: { samples: model.id }, shadePercent: 25 });
assert.equal(result.count, expected.length);
assert.equal(result.summary.find(m => m.label === "Paired 100 m cells").value, expectedPairs.length);
const length = expected.reduce((m, row) => m + row[3], 0);
const baseline = expected.reduce((m, row) => m + row[2] * row[3], 0) / length;
assert(Math.abs(result.summary[0].value - baseline) < .015);
const baselineRun = await run(root, { model: "shade", files: { samples: model.id }, shadePercent: 0 });
assert.equal(baselineRun.summary.find(m => m.label === "UTCI reduction across the selection").value, 0);
const archive = await call(root + "/runs/" + result.id + "/export?format=zip");
assert.equal(archive.status, 200);
const items = unzipSync(new Uint8Array(await archive.arrayBuffer()));
const manifest = JSON.parse(new TextDecoder().decode(items["manifest.json"]));
assert.equal(manifest.inputs[1].sha256, model.sha256);
assert.equal(manifest.parameters.shadePercent, 25);
assert(items["selection.geojson"] && items["study-boundary.geojson"] && items["results.csv"] && items["summary.csv"]);
const output = await checked(call(root + "/runs/" + result.id + "/export?format=geojson"));
assert.equal(output.features.length, result.count);
assert(output.features.some(f => f.properties.paired === 0 && f.properties.delta_utci_c === null));
assert.equal((await call(root + "/runs/" + result.id + "/export?format=csv", "GET", undefined, "another-owner")).status, 404);
const narration = await checked(call(root + "/runs/" + result.id + "/explain", "POST", { question: "Explain the coverage" }));
assert.match(narration.reply, /Paired 100 m cells/);

const { study: other } = await checked(call("/studies", "POST", { name: "Cardiff custom test area", eventTime: stamp }));
const custom = "/studies/" + other.id;
const perimeter = outline(-3.201, 51.479, -3.195, 51.485);
const area = JSON.stringify(perimeter);
assert.equal((await upload(custom, { role: "population", file: "people.tif", year: 2021 }, "sample")).status, 422);
await checked(upload(custom, { role: "boundary", file: "my-study.geojson" }, area));
const makeRaster = values => writeArrayBuffer(new Float32Array(values), { width: 2, height: 2, GDAL_NODATA: "-9999",
  GeographicTypeGeoKey: 4326, GTModelTypeGeoKey: 2, GTRasterTypeGeoKey: 1, ModelPixelScale: [.002, .002, 0],
  ModelTiepoint: [0, 0, 0, -3.2, 51.484, 0] });
const pop = await checked(upload(custom, { role: "population", year: 2021, file: "count.tif" }, makeRaster([4, 6, 2, 8])));
const lst = await checked(upload(custom, { role: "lst", time: stamp, units: "C", file: "surface.tif" }, makeRaster([35, 44, 52, -9999])));
const residents = await run(custom, { model: "resident", files: { lst: lst.file.id, population: pop.file.id }, threshold: 45 });
assert.equal(residents.summary.find(m => m.label === "Matched resident coverage").value, 60);
assert.equal(residents.summary.find(m => m.label === "Resident-weighted LST").value, 42.33);
const normalized = await call(custom + "/files/" + lst.file.id + "/export?format=normalized");
assert.equal(normalized.status, 200);
const image = await (await fromArrayBuffer(await normalized.arrayBuffer())).getImage();
assert.equal(image.getGeoKeys().GeographicTypeGeoKey, 4326);
assert.deepEqual([...await image.readRasters({ interleave: true })], [35, 44, 52, -9999]);
const table = await checked(upload(custom, { role: "samples", file: "walk.csv" },
  csvText(sampleFields, [["A", -3.1986, 51.4822, stamp, 40, 56, 32, 43, 2, "sunlit", "s-1"],
    ["B", -3.1986, 51.4822, stamp, 25, 30, 32, 43, 2, "building_shade", "s-1"]])));
const census = await checked(upload(custom, { role: "censusAreas", file: "census.geojson" },
  JSON.stringify({ ...perimeter, properties: { area_id: "custom-oa" } })));
const counts = await checked(upload(custom, { role: "censusGroups", file: "groups.csv", year: 2021 },
  "area_id,group_id,group_label,group_count,eligible_count\ncustom-oa,older,Age 65+,60,200\n"));
const priority = await run(custom, { model: "priority", group: "older", files: {
  samples: table.file.id, censusAreas: census.file.id, censusGroups: counts.file.id,
} });
assert(priority.candidates.length && priority.candidates[0].share === .3);
await checked(call(custom, "DELETE"));
assert.equal((await call(custom)).status, 404);
console.log("Workspace validated: " + result.count + " London walking cells agree with the existing model, plus Cardiff raster and field priority runs, owner isolation and exports.");
