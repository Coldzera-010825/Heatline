import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import { evaluateStreetGrid } from "./worker/utci.mjs";

const base = process.argv[2] ?? "http://127.0.0.1:8788";
const admin = JSON.parse(await readFile(new URL("./dist/client/data/admin/catalog.json", import.meta.url)));
const api = async (body, endpoint = "analysis") => {
  const response = await fetch(base + "/api/" + endpoint, {
    method: "POST", headers: { "Content-Type": "application/json", Origin: base }, body: JSON.stringify(body),
  });
  assert.equal(response.status, 200, await response.clone().text());
  return response.json();
};
const close = (actual, expected, tolerance = .001) => assert(Math.abs(actual - expected) <= tolerance, actual + " vs " + expected);
const archiveCase = (region, event = "E3_2022-07") => ({ region, event });
const select = (bounds, lon, lat) => lon >= bounds[0] && lon <= bounds[2] && lat >= bounds[1] && lat <= bounds[3];
assert.equal(Object.keys(admin.cities).length, 8);
for (const [region, city] of Object.entries(admin.cities)) {
  assert.equal(city.cover[100].resolution, 100);
  assert.equal(city.cover[500].resolution, 500);
  const feature = JSON.parse(await readFile(new URL("./dist/client/data/admin/" + city.boundary, import.meta.url)));
  assert(["Polygon", "MultiPolygon"].includes(feature.geometry.type), region);
  assert(feature.geometry.coordinates.flat(3).length > 12, "Study rectangle: " + region);
  const [event, record] = Object.entries(city.events).find(([, r]) => r.snapshot?.summary.match > .8);
  const response = await api({ archiveCase: archiveCase(region, event), kind: "population" });
  assert(response.ok, JSON.stringify(response));
  close(response.event.surface.mean, record.snapshot.summary.mean);
  close(response.event.surface.match, record.snapshot.summary.match, .000002);
  assert.equal(response.event.timeUtc, record.snapshot.datetime);
  assert.equal(response.event.surface.population, city.populationCount);
  const wrongDate = await api({ archiveCase: archiveCase(region, event), kind: "population", date: "2018-01-01" });
  assert.equal(wrongDate.status, "unavailable");
}
const paris = archiveCase("Paris", "E2_2020-08");
const ask = (message, archiveCase, context = {}) => api({ message, archiveCase, dispatch: true, ...context }, "chat");
assert.deepEqual((await ask("Switch to 3D bars", paris)).action, { type: "view", view: "bars" });
assert.equal((await ask("显示2020年8月7日 10:40 的地表温度", paris)).action.layer, "lst_c");
const wrongOverpass = await ask("Show Landsat LST on 8 August 2020", paris);
assert.equal(wrongOverpass.status, "unavailable");
assert.match(wrongOverpass.reply, /2020-08-07 10:40 UTC/);
assert.equal((await ask("Show Landsat LST on 2020-08-07T10:40+02:00", paris)).status, "clarify");
assert.equal((await ask("Show me London's LST")).action.layer, "lst");
assert.equal((await ask("Show London LST on 17 July 2022")).status, "clarify");
assert.equal((await ask("Calculate pedestrian UTCI in my selection", undefined, { chapter: 3, studyArea: true })).status, "clarify");
assert.equal((await ask("Calculate pedestrian UTCI", undefined, { chapter: 3, studyArea: true })).action.kind, "exposure");
const amsterdam = archiveCase("Amsterdam");
assert.match((await ask("Calculate pedestrian UTCI in my selection", amsterdam, { chapter: 3 })).reply, /Draw an area first/);
assert.equal((await ask("Calculate UTCI for the full model coverage", amsterdam, { chapter: 3 })).action.scope, "full");
const bounds = [2.335, 48.85, 2.365, 48.87];
const drawn = await api({ archiveCase: paris, kind: "population", bounds });
assert(drawn.ok && drawn.event.surface.population < admin.cities.Paris.populationCount / 4);
const distant = await api({ archiveCase: paris, kind: "population", bounds: [-1, 50, 0, 52] });
assert.equal(distant.status, "empty");
const edge = await api({ archiveCase: paris, kind: "population", bounds: [2.224, 48.815, 2.246, 48.83] });
assert.equal(edge.status, "empty"); // Inside former study rectangle, outside the City of Paris.
assert.equal((await api({ archiveCase: paris, kind: "groups" })).status, "unavailable");
const regional = await api({ message: "Compare Landsat residential heat exposure in Paris and Amsterdam in 2020", dispatch: true }, "chat");
assert.deepEqual(regional.action, { type: "compare-events", event: "E2_2020-08", firstRegion: "Paris", secondRegion: "Amsterdam", metric: "surface" });
const pairedStreet = await api({ message: "Compare Portland and Seattle walking UTCI in 2021", dispatch: true }, "chat");
assert.equal(pairedStreet.action.metric, "street");
assert.equal(pairedStreet.action.event, "G1_2021-06");
const streetCompare = await api({ kind: "street-comparison", event: "G1_2021-06", regions: ["Portland", "Seattle"] });
assert(streetCompare.ok, JSON.stringify(streetCompare));
assert.equal(streetCompare.event.timeUtc, "2021-06-28T20:00:00Z");
assert(streetCompare.event.cities.every(city => city.features.features.length === city.cellCount));
assert.equal((await api({ kind: "street-comparison", event: "G1_2021-06", regions: ["Portland", "Seattle"], date: "2021-06-29" })).status, "unavailable");
const timedComparison = await ask("Compare Portland and Seattle walking UTCI on 28 June 2021 at 8:00 pm UTC");
assert.equal(timedComparison.action.date, "2021-06-28");
assert.equal(timedComparison.action.time, "20:00");
assert.equal((await api({ kind: "street-comparison", event: "G1_2021-06", regions: ["Portland", "Seattle"], date: "2021-06-28", time: "21:00" })).status, "unavailable");
assert.equal((await api({ message: "Open the Amsterdam case", dispatch: true }, "chat")).action.region, "Amsterdam");
assert.equal(Object.keys(admin.streetModels).length, 8);
assert.equal(Object.values(admin.streetModels).reduce((n, items) => n + Object.keys(items).length, 0), 32);
for (const [city, events] of Object.entries(admin.streetModels)) for (const [event, model] of Object.entries(events)) {
  const grid = JSON.parse(gunzipSync(await readFile(new URL("./dist/client/data/admin/" + model.file, import.meta.url))));
  const fresh = evaluateStreetGrid(grid, model.weather);
  // Compare to the independently calculated SOLWEIG raster UTCI, rounded to two decimals.
  assert.equal(fresh.rows.length, grid.rows.length);
  assert.equal(fresh.pairs.length, grid.pairs.length);
  assert(fresh.rows.every((row, i) => Math.abs(row[2] - grid.rows[i][2]) <= .01001), city + " differs from SOLWEIG reference");
  const caseKey = archiveCase(city, event);
  const full = await api({ archiveCase: caseKey, kind: "exposure" });
  assert(full.ok, JSON.stringify(full));
  assert.equal(full.analysis.cellCount, grid.rows.length);
  assert.equal(full.analysis.timeUtc, model.timeUtc);
  const corner = [model.bounds[0], model.bounds[1], (model.bounds[0] + model.bounds[2]) / 2, (model.bounds[1] + model.bounds[3]) / 2];
  const local = await api({ archiveCase: caseKey, kind: "exposure", bounds: corner });
  assert(local.ok, JSON.stringify(local));
  assert.equal(local.analysis.cellCount, grid.rows.filter(([x, y]) => select(corner, x, y)).length);
  const zero = await api({ archiveCase: caseKey, kind: "shade", shadePercent: 0 });
  if (grid.pairs.length === 0) {
    assert.equal(zero.status, "empty");
    continue;
  }
  assert.equal(zero.event.before, zero.event.after);
  const scenario = await api({ archiveCase: caseKey, kind: "shade", shadePercent: 25 });
  assert.equal(scenario.event.pairedCells, grid.pairs.length);
  const change = fresh.pairs.reduce((n, r) => n + .25 * r[3] * (r[6] - r[7]), 0);
  close(scenario.event.reduction, change / fresh.pairs.reduce((n, r) => n + r[2], 0), .006);
  const chat = await api({ archiveCase: caseKey, message: "What if 50% of paths were shaded?", dispatch: true }, "chat");
  assert.equal(chat.action.shadePercent, 50);
  console.log(city, full.analysis.cellCount, scenario.event.pairedCells, scenario.event.reduction + "°C");
}
assert.equal((await api({ archiveCase: archiveCase("Amsterdam", "X1_2018-07"), kind: "shade" })).status, "unavailable");
console.log("Administrative masks, event matching, population and street analysis passed.");
