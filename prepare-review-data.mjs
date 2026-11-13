import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync, gunzipSync } from "node:zlib";
import { districts } from "./worker/london-population.mjs";

// Usage: node prepare-review-data.mjs <Heatline_demo_ready/demo_ready directory>
const input = process.argv[2] && resolve(process.argv[2]);
if (!input) throw new Error("Pass the extracted demo_ready directory.");
const output = join(dirname(fileURLToPath(import.meta.url)), "dist", "client", "data");
const json = file => JSON.parse(readFileSync(join(input, file), "utf8").replace(/^\uFEFF/, ""));
function write(file, data) {
  const target = join(output, file), body = JSON.stringify(data);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, file.endsWith(".bin") ? gzipSync(body) : body + "\n");
}
const round = (n, places = 6) => Number(n.toFixed(places));

const oa = json("london_case/oa_centroid_exposure.geojson");
assert.equal(oa.features.length, 26369);
const people = oa.features.map(({ geometry, properties: p }) => {
  const [lon, lat] = geometry.coordinates;
  assert(geometry.type === "Point" && Number.isFinite(lon) && Number.isFinite(lat) && Object.hasOwn(districts, p.LADCD));
  assert([p.pop_all, p.pop_65plus, p.pop_disabled].every(v => Number.isInteger(v) && v >= 0));
  assert(Number.isInteger(p.imd_decile) && p.imd_decile >= 1 && p.imd_decile <= 10);
  return [lon, lat, Number.isFinite(p.lst_c) ? p.lst_c : null, p.pop_all, p.pop_65plus, p.pop_disabled, p.imd_decile, p.LADCD];
});
assert.equal(people.reduce((n, row) => n + row[3], 0), 8799243);
write("heatwave/population-groups.bin", people);

const official = {
  london: { name: "Heathrow", value: 40.2, date: "2022-07-19" },
  national: { name: "Coningsby", value: 40.3, date: "2022-07-19" },
  source: "Met Office official temperature records",
  url: "https://www.metoffice.gov.uk/research/climate/maps-and-data/uk-climate-extremes",
};
const reference = json("London/E3_2022-07/stations.json");
assert.equal(reference.metadata.stations[0].id, "03770099999");
const referenceRows = reference.observations.filter(row => row.screen_pass && Number.isFinite(row.air_temperature_c) &&
  row.time_utc.slice(0, 10) >= "2022-07-13" && row.time_utc.slice(0, 10) <= "2022-07-19")
  .map(row => [new Date(row.time_utc + (row.time_utc.endsWith("Z") ? "" : "Z")).toISOString().replace(".000Z", "Z"),
    row.air_temperature_c]);
assert.equal(referenceRows.length, 167);
write("heatwave/weather-reference.bin", { official, station: {
  name: "St James’s Park", id: "03770099999", coordinates: [-0.116667, 51.5], source: "NOAA Global Hourly (ISD)",
  url: reference.metadata.stations[0].url, rows: referenceRows,
} });

const sourceStations = json("london_case/live_assets/data/heatwave/stations.json");
const screened = sourceStations.flatMap(station => {
  const [lon, lat] = station.coordinates ?? [];
  if (!Number.isFinite(lon) || !Number.isFinite(lat) || Math.abs(lon) > 180 || Math.abs(lat) > 90 || lon === 0 && lat === 0) return [];
  const observations = JSON.parse(gunzipSync(readFileSync(join(output, "heatwave", "wow", station.id + ".bin"))));
  const index = observations.fields.findIndex(field => field.id === "temperature") + 1;
  if (!index) return [];
  const peaks = {};
  for (const row of observations.rows) {
    const day = Number(row[0].slice(8, 10)), value = row[index];
    if (day < 13 || day > 19 || !Number.isFinite(value)) continue;
    peaks[day] = Math.max(peaks[day] ?? -Infinity, value);
  }
  if (!Object.keys(peaks).length) return [];
  return [{ ...station, peaks, review: Math.max(...Object.values(peaks)) > official.national.value }];
});
write("heatwave/stations.json", screened);

const catalog = json("catalog.json");
const labels = {
  "E1_2019-07": "July 2019 European heatwave", "E2_2020-08": "August 2020 European heatwave",
  "E3_2022-07": "July 2022 European heatwave", "E4_2025-06": "June 2025 European heatwave",
  "E5_2026-06": "June 2026 European heatwave", "G1_2021-06": "June 2021 Pacific Northwest heat dome",
};
const regionName = city => ({ Brussels_Uccle: "Brussels–Uccle", DeBilt: "De Bilt" })[city] ?? city;
const events = {};
for (const entry of catalog.events) {
  const e = json(entry.url);
  assert(Object.hasOwn(labels, e.event) && /^[A-Za-z_]+$/.test(e.city));
  const item = events[e.event] ??= { id: e.event, label: labels[e.event], regions: [] };
  const region = { id: e.city, name: regionName(e.city), bbox: e.bbox, core: [e.core_start, e.core_end], peak: e.peak_date,
    file: e.event + "-" + e.city + ".bin" };
  item.regions.push(region);
  const [w, s, east, n] = e.bbox;
  const cells = [], ids = new Map();
  for (const { properties: p, geometry } of json(e.weather.geometry).features) {
    const ring = geometry.coordinates[0], x = ring.map(row => row[0]), y = ring.map(row => row[1]);
    const b = [Math.max(w, Math.min(...x)), Math.max(s, Math.min(...y)), Math.min(east, Math.max(...x)), Math.min(n, Math.max(...y))];
    if (b[0] >= b[2] || b[1] >= b[3]) continue;
    ids.set(p.cell_id, cells.length);
    cells.push(b.map(v => round(v)));
  }
  const values = {};
  for (const row of json(e.weather.cell_values)) {
    if (!ids.has(row.cell_id) || row.valid_hours !== 24 || !Number.isFinite(row.tmax_c)) continue;
    (values[row.date] ??= Array(cells.length).fill(null))[ids.get(row.cell_id)] = row.tmax_c;
  }
  const daily = json(e.weather.daily).map(row => [row.date, row.population_weighted_tmax_c, row.population_match_rate]);
  assert(daily.length && cells.length);
  write("events/" + region.file, { daily, cells, values, snapshot: {
    time: e.landsat.datetime, inCore: e.landsat.in_core_period, match: e.landsat.statistics?.population_match_rate,
  } });
}
assert.equal(Object.values(events).reduce((n, event) => n + event.regions.length, 0), 32);
write("events/catalog.json", { events: Object.values(events) });
console.log(JSON.stringify({ areas: people.length, stations: screened.length, flagged: screened.filter(s => s.review).length,
  referenceHours: referenceRows.length, comparisonRegions: catalog.events.length }));
