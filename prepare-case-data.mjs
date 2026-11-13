import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

// Usage: node prepare-case-data.mjs <extracted demo_ready directory>
const input = process.argv[2] && resolve(process.argv[2]);
if (!input) throw new Error("Pass the extracted demo_ready directory.");
const output = join(dirname(fileURLToPath(import.meta.url)), "dist", "client", "data", "cases");
const read = file => JSON.parse(readFileSync(join(input, file), "utf8").replace(/^\uFEFF/, ""));
const write = (file, contents) => {
  const target = join(output, file);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, contents);
};
const json = (file, value) => write(file, file.endsWith(".bin") ? gzipSync(JSON.stringify(value)) : JSON.stringify(value) + "\n");
const published = read("catalog.json");
const pointSummary = read(published.point_reference_summary);
const pointDaily = read(published.point_reference_daily);
const pointByCase = new Map();
for (const item of pointSummary.events) pointByCase.set(item.city + "/" + item.event, { summary: item, daily: [] });
for (const row of pointDaily) pointByCase.get(row.city + "/" + row.event)?.daily.push(row);
const name = id => ({ Brussels_Uccle: "Brussels–Uccle", DeBilt: "De Bilt" })[id] ?? id;
const month = new Intl.DateTimeFormat("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });
const finite = Number.isFinite;
const labels = {
  lst_c: ["Landsat surface temperature", "°C", "USGS Landsat Collection 2"],
  ndvi: ["Landsat NDVI", "", "USGS Landsat · single-scene vegetation index"],
  ndwi: ["Landsat NDWI", "", "USGS Landsat · single-scene water index"],
  mndwi: ["Landsat MNDWI", "", "USGS Landsat · modified water index"],
  elevation: ["Surface elevation", " m", "Copernicus GLO-30 DSM"],
  landcover: ["Land cover", "", "ESA WorldCover 2021 v200 · CC BY 4.0"],
  population_count_100m: ["Resident population · display grid", " people", "GHS-POP 2020 · mean of valid 100 m source pixel counts"],
};
const classNames = { 10: "Tree cover", 20: "Shrubland", 30: "Grassland", 40: "Cropland", 50: "Built-up", 60: "Bare / sparse",
  70: "Snow and ice", 80: "Permanent water", 90: "Herbaceous wetland", 95: "Mangroves", 100: "Moss and lichen" };

function packageLayer(key, info, root) {
  const g = read(info.grid);
  assert.equal(g.crs, "EPSG:3857");
  assert.equal(g.values.length, g.width * g.height);
  const [label, unit, source] = labels[key];
  let minimum = Infinity, maximum = -Infinity;
  for (const v of g.values) if (finite(v)) { minimum = Math.min(minimum, v); maximum = Math.max(maximum, v); }
  const offset = finite(minimum) ? minimum : 0;
  const step = finite(maximum) ? Math.max((maximum - offset) / 65534, key === "landcover" ? 1 : .0001) : 1;
  const packed = Buffer.alloc(g.values.length * 2);
  for (const [i, v] of g.values.entries()) packed.writeUInt16LE(finite(v) ? Math.min(65534, Math.round((v - offset) / step)) : 65535, i * 2);
  const stem = root + "/" + key;
  const image = stem + ".png", numeric = stem + ".grid.bin";
  mkdirSync(dirname(join(output, image)), { recursive: true });
  copyFileSync(join(input, info.image), join(output, image));
  write(numeric, gzipSync(packed));
  return {
    id: key, label, unit, source, image, numeric, width: g.width, height: g.height, bounds: g.bounds,
    coordinates: info.coordinates, range: info.range, match: info.display_valid_fraction, native: info.native,
    classes: info.classes ? Object.entries(info.classes).map(([n, color]) => [Number(n), classNames[n] ?? "Other", color]) : null,
    colors: key === "lst_c" ? ["#45337d", "#d35675", "#fff4ad"] : ["#443765", "#e0d8ae", "#258475"],
    offset, step, aggregation: g.aggregation,
  };
}

function packageWeather(info, bbox, model) {
  if (!info) return null;
  const [west, south, east, north] = bbox;
  const cells = [], ids = new Map();
  for (const { properties: p, geometry } of read(info.geometry).features) {
    const xs = geometry.coordinates[0].map(c => c[0]), ys = geometry.coordinates[0].map(c => c[1]);
    const bounds = [Math.max(west, Math.min(...xs)), Math.max(south, Math.min(...ys)),
      Math.min(east, Math.max(...xs)), Math.min(north, Math.max(...ys))];
    ids.set(p.cell_id, cells.length);
    cells.push({ bounds: bounds[0] < bounds[2] && bounds[1] < bounds[3] ? bounds : null, lon: p.lon, lat: p.lat, population: p.population_2020 });
  }
  const days = {};
  for (const row of read(info.cell_values)) {
    const i = ids.get(row.cell_id);
    if (i === undefined || row.valid_hours !== 24) continue;
    (days[row.date] ??= Array(cells.length).fill(null))[i] = [row.tmax_c, row.tmin_c, row.tmean_c];
  }
  const daily = read(info.daily).map(row => {
    const summary = [0, 0, 0], weights = [0, 0, 0];
    days[row.date]?.forEach((values, i) => values?.forEach((v, j) => {
      if (!finite(v)) return;
      summary[j] += v * cells[i].population;
      weights[j] += cells[i].population;
    }));
    return {
      date: row.date, values: [row.population_weighted_tmax_c, ...summary.slice(1).map((v, j) => weights[j + 1] ? v / weights[j + 1] : null)],
      matched: row.matched_population_2020, population: row.study_bbox_population_2020,
      match: row.population_match_rate, validCells: row.valid_cells, totalCells: row.total_cells,
    };
  });
  assert(daily.length && cells.length);
  return { model, source: info.source, resolution: model === "land" ? "0.1°" : "0.25°", cells, days, daily };
}

function packageStations(event) {
  if (!event.stations || event.station_status !== "downloaded") return [];
  const payload = read(event.stations);
  return payload.metadata.stations.flatMap(item => {
    const valid = payload.observations.filter(r => r.station_id === item.id && r.screen_pass && finite(r.air_temperature_c) &&
      finite(r.longitude) && finite(r.latitude) && (r.longitude || r.latitude));
    if (!valid.length) return [];
    const rows = valid.map(r => {
      const time = new Date(r.time_utc.endsWith("Z") ? r.time_utc : r.time_utc + "Z").toISOString();
      return [time, r.air_temperature_c, r.original_temperature_qc];
    }).sort((a, b) => a[0].localeCompare(b[0]));
    return [{ id: item.id, name: item.name, url: item.url, distanceKm: item.distance_km,
      coordinates: [valid[0].longitude, valid[0].latitude], rows }];
  });
}

const cities = published.cities.map(city => ({
  id: city.id, name: name(city.id), bbox: city.bbox, population: city.population_2020, cases: [],
  layers: Object.entries(city.static).map(([key, data]) => packageLayer(key, data, "static/" + city.id)),
}));
const byCity = new Map(cities.map(city => [city.id, city]));
let rasters = cities.reduce((n, city) => n + city.layers.length, 0);
for (const entry of published.events) {
  const e = read(entry.url), city = byCity.get(e.city);
  const id = e.event, stem = city.id + "/" + id;
  const layers = Object.entries(e.layers).map(([key, data]) => packageLayer(key, data, stem));
  rasters += layers.length;
  const data = {
    region: city.id, event: id, cityName: city.name, bbox: e.bbox, start: e.start, end: e.end, core: [e.core_start, e.core_end],
    peak: e.peak_date, layers, satellite: e.landsat, stations: packageStations(e),
    weather: packageWeather(e.weather, e.bbox, "land"), alternative: packageWeather(e.era5_alternative, e.bbox, "era5"),
    point: pointByCase.get(stem) ?? null, scope: "study-rectangle", population: city.population,
  };
  const label = month.format(new Date(e.peak_date + "T00:00:00Z"));
  const file = stem + "/case.bin";
  city.cases.push({ id, file, label, peak: e.peak_date, pointOnly: false });
  json(file, data);
}

for (const [key, point] of pointByCase) {
  const [region, event] = key.split("/"), city = byCity.get(region);
  if (!city || city.cases.some(c => c.id === event) || !point.daily.length) continue;
  const peak = point.summary.peak_date, file = key + "/case.bin";
  city.cases.push({ id: event, file, label: month.format(new Date(peak + "T00:00:00Z")) + " · reference point", peak, pointOnly: true });
  json(file, { region, event, cityName: city.name, bbox: city.bbox, peak, scope: "reference-point",
    start: point.daily[0].date, end: point.daily.at(-1).date, layers: [], stations: [], weather: null, alternative: null,
    satellite: null, population: city.population, point });
}
for (const city of cities) city.cases.sort((a, b) => b.peak.localeCompare(a.peak));
assert.equal(cities.length, 8);
assert.equal(cities.flatMap(city => city.cases).filter(c => !c.pointOnly).length, 32);
assert.equal(cities.flatMap(city => city.cases).filter(c => c.pointOnly).length, 12);
assert.equal(rasters, 152);
json("catalog.json", { cities, detailed: { region: "London", event: "E3_2022-07" } });
console.log(JSON.stringify({ cities: cities.length, cases: cities.flatMap(city => city.cases).length, rasters }));
