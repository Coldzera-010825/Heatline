import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import { evaluateStreetGrid } from "./worker/utci.mjs";
import { modelFootprint } from "./worker/study-boundary.mjs";

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
assert.equal(admin.boundaryVersion, "Heatline FUA v3 · 1114");
assert(!admin.cities.DeBilt);
assert.equal(admin.cities.Utrecht.provenance.code, "NL042F");
assert.equal(admin.cities.Paris.populationCount, 12886280);
assert.equal(admin.cities.Seattle.populationCount, 3931216);
assert.equal(admin.cities.Seattle.provenance.code, "USA14F");
assert.equal(Object.values(admin.cities).flatMap(city => Object.values(city.events)).filter(event => !event.pointOnly).length, 32);
for (const [region, city] of Object.entries(admin.cities)) {
  assert.equal(city.cover[100].resolution, region === "London" ? 100 : 500);
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
  close(response.event.surface.population, city.populationCount, 2);
  assert((response.event.packedMap?.rows ?? response.event.metricTiles).length > 0, region + " residential result map");
  const groups = await api({ archiveCase: archiveCase(region, event), kind: "groups", group: "older", reference: "all" });
  assert(groups.ok, JSON.stringify(groups));
  assert(groups.event.groups.older.matched > 0, region);
  assert(groups.event.groups.older.matched <= groups.event.groups.all.matched, region);
  assert((groups.event.metricTiles ?? groups.event.tiles).length > 0, region + " census result map");
  if (city.metroCensus) assert.equal(groups.event.place, city.adminName);
  else if (city.census?.area) assert(groups.event.place.includes(city.census.area));
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
assert(edge.ok && edge.event.surface.population > 0); // Outside the City of Paris, inside its functional urban area.
const parisWeather = await api({ archiveCase: paris, kind: "weather", date: "2020-07-31" });
assert.equal(parisWeather.event.air.population, 12886280.331046);
close(parisWeather.event.air.values[0], 36.939292);
const seattleCore = await api({ archiveCase: archiveCase("Seattle", "G1_2021-06"), kind: "population", date: "2021-06-30" });
assert(seattleCore.ok && seattleCore.event.inCore && seattleCore.event.surface.match < .10);
assert.equal((await api({ archiveCase: paris, kind: "groups", group: "poverty" })).status, "clarify");
assert.equal((await ask("Compare residents aged 65+", paris)).action.kind, "groups");
const parisRank = await api({ archiveCase: paris, kind: "groups", group: "older", rank: true, rankOrder: "asc" });
assert(parisRank.ok && parisRank.event.ranked.length > 20 && parisRank.event.ranked.every((row, i, ranks) =>
  i === 0 || row.mean >= ranks[i - 1].mean));
const suburbanGroups = await api({ archiveCase: paris, kind: "groups", group: "older", reference: "all",
  bounds: [2.224, 48.815, 2.246, 48.83], mapFormat: "compact" });
assert(suburbanGroups.ok && suburbanGroups.event.packedMap.rows.length > 0 && suburbanGroups.event.groups.older.matched > 0);
assert.equal(admin.cities.London.events["E3_2022-07"].snapshot.layer.resolution, 100);
const londonAlias = await api({ archiveCase: archiveCase("London", "london-detail"), kind: "groups", group: "older", reference: "all" });
assert(londonAlias.ok && londonAlias.event.groups.older.matched > 0);
for (const city of ["Seattle", "Portland"]) {
  const result = await api({ archiveCase: archiveCase(city, "G1_2021-06"), kind: "groups", group: "poverty", reference: "limited" });
  assert(result.ok && result.event.groups.poverty.matched > 0 && result.event.groups.limited.matched > 0, city);
}
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
  const footprint = modelFootprint(model);
  const inside = evaluateStreetGrid(grid, model.weather, footprint);
  const full = await api({ archiveCase: caseKey, kind: "exposure", coverage: "pilot" });
  assert(full.ok, JSON.stringify(full));
  assert.equal(full.analysis.cellCount, inside.rows.length);
  assert.equal(full.analysis.timeUtc, model.timeUtc);
  const corner = [model.bounds[0], model.bounds[1], (model.bounds[0] + model.bounds[2]) / 2, (model.bounds[1] + model.bounds[3]) / 2];
  const local = await api({ archiveCase: caseKey, kind: "exposure", coverage: "pilot", bounds: corner });
  assert(local.ok, JSON.stringify(local));
  assert.equal(local.analysis.cellCount, inside.rows.filter(([x, y]) => select(corner, x, y)).length);
  const zero = await api({ archiveCase: caseKey, kind: "shade", coverage: "pilot", shadePercent: 0 });
  if (inside.pairs.length === 0) {
    assert.equal(zero.status, "empty");
    continue;
  }
  assert.equal(zero.event.before, zero.event.after);
  const scenario = await api({ archiveCase: caseKey, kind: "shade", coverage: "pilot", shadePercent: 25 });
  assert.equal(scenario.event.pairedCells, inside.pairs.length);
  const change = inside.pairs.reduce((n, r) => n + .25 * r[3] * (r[6] - r[7]), 0);
  close(scenario.event.reduction, change / inside.pairs.reduce((n, r) => n + r[2], 0), .006);
  const chat = await api({ archiveCase: caseKey, message: "What if 50% of paths were shaded?", dispatch: true }, "chat");
  assert.equal(chat.action.shadePercent, 50);
  console.log(city, full.analysis.cellCount, scenario.event.pairedCells, scenario.event.reduction + "°C");
}
for (const [city, events] of Object.entries(admin.cityStreetModels)) for (const [event, model] of Object.entries(events)) {
  const caseKey = archiveCase(city, event);
  const pilot = admin.streetModels[city][event];
  const full = await api({ archiveCase: caseKey, kind: "exposure" });
  assert(full.ok, JSON.stringify(full));
  assert.equal(full.analysis.scope, model.scope);
  if (model.scope !== "city") assert.equal((await api({ archiveCase: caseKey, kind: "exposure", coverage: "city" })).status, "unavailable");
  const footprint = modelFootprint(model);
  let cellCount = 0, pairCount = 0;
  assert.equal(full.analysis.timeUtc, model.timeUtc);
  assert(full.analysis.mapRows.length > 0);
  const empty = await api({ archiveCase: caseKey, kind: "exposure", bounds: [0, 0, .01, .01] });
  assert.equal(empty.status, "empty");
  const scenario = await api({ archiveCase: caseKey, kind: "shade", shadePercent: 50 });
  assert(scenario.ok && scenario.event.coverage.scope === model.scope && scenario.event.coverage.share <= 1);
  close(scenario.event.selection.reduction, scenario.event.reduction * scenario.event.coverage.share, .011);
  let sample;
  for (const shard of model.shards) {
    const tiles = JSON.parse(gunzipSync(await readFile(new URL("./dist/client/data/admin/" + shard.file, import.meta.url))));
    for (const tile of tiles) {
      const fresh = evaluateStreetGrid(tile, tile.weather);
      assert(fresh.rows.every((row, i) => Math.abs(row[2] - tile.rows[i][2]) <= .01001), city + " full model vs SOLWEIG reference");
      cellCount += fresh.rows.filter(([lon, lat]) => footprint(lon, lat)).length;
      const validPairs = fresh.pairs.filter(([lon, lat]) => footprint(lon, lat));
      pairCount += validPairs.length;
      sample ??= validPairs.find(([lon, lat]) => !select(pilot.bounds, lon, lat));
    }
  }
  assert(sample, city + " model has eligible pairs beyond its pilot");
  assert.equal(full.analysis.cellCount, cellCount);
  assert.equal(scenario.event.coverage.cells, cellCount);
  assert.equal(scenario.event.pairedCells, pairCount);
  const [lon, lat] = sample;
  const neighborhood = [lon - .001, lat - .001, lon + .001, lat + .001];
  const zero = await api({ archiveCase: caseKey, kind: "shade", bounds: neighborhood, shadePercent: 0 });
  assert(zero.ok && zero.event.coverage.scope === model.scope && zero.event.before === zero.event.after, JSON.stringify(zero));
  assert.equal(zero.event.selection.before, zero.event.selection.after);
  const view = await api({ archiveCase: caseKey, kind: "exposure", mapOnly: true, bounds: neighborhood });
  assert.equal(view.analysis.mapResolution, "100 m walking grid");
  assert(view.analysis.mapRows.some(([x, y]) => x === lon && y === lat));
  console.log(city, event, model.cells, "city walking cells,", scenario.event.pairedCells, "eligible shade cells");
}
const londonFull = archiveCase("London");
for (const kind of ["exposure", "shade"]) {
  const response = await fetch(base + "/api/analysis", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/x-ndjson", "Accept-Encoding": "gzip", Origin: base },
    body: JSON.stringify({ kind, archiveCase: londonFull, mapFormat: "compact", shadePercent: 50 }),
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-encoding"), "gzip");
  const stream = (await response.text()).trim().split("\n").map(JSON.parse);
  assert(stream.some(record => record.type === "progress"));
  const result = stream.at(-1);
  assert(result.ok);
  const map = result.analysis ?? result.event;
  assert.match(map.mapResolution, /^500 m/);
  assert(map.mapStep.every(Number.isFinite));
  assert(map.mapRows.length > 1000 && map.mapRows.every(row => Number.isInteger(row[0]) && Number.isInteger(row[1])));
  assert.equal(result.analysis?.cellCount ?? result.event?.pairedCells, kind === "shade" ? 8696 : 129280);
}
assert.equal((await api({ archiveCase: archiveCase("Lille"), kind: "exposure", coverage: "city" })).status, "unavailable");
assert.equal((await api({ archiveCase: archiveCase("Amsterdam", "X1_2018-07"), kind: "shade" })).status, "unavailable");
console.log("Administrative masks, event matching, population and street analysis passed.");
