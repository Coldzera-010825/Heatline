import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const [delivery] = process.argv.slice(2);
if (!delivery) throw new Error("Usage: node prepare-district-data.mjs <directory containing manifest.json>");
const output = new URL("./dist/client/data/admin/districts/", import.meta.url);
const load = async file => JSON.parse(await readFile(join(delivery, file), "utf8"));
const write = (file, data) => writeFile(new URL(file, output), JSON.stringify(data) + "\n");
const official = {
  boroughs: ["London boroughs", "https://www.data.gov.uk/dataset/5ca638fa-79d9-4d1f-a9ce-12ac929c8753/local-authority-districts-december-2021-boundaries-uk-bgc", "Contains Ordnance Survey and ONS data © Crown copyright and database right"],
  municipalities: ["Municipalities", "https://gisco-services.ec.europa.eu/distribution/v2/lau/lau-2021-files.html", "© EuroGeographics for the administrative boundaries"],
  arrondissements: ["Paris arrondissements", "https://opendata.paris.fr/explore/dataset/arrondissements/", "Ville de Paris"],
  counties: ["Counties", "https://www.census.gov/geographies/mapping-files/time-series/geo/cartographic-boundary.2021.html", "U.S. Census Bureau"],
  county_subdivisions: ["Census county subdivisions", "https://www.census.gov/geographies/mapping-files/time-series/geo/cartographic-boundary.2021.html", "U.S. Census Bureau"],
  places: ["Census places", "https://www.census.gov/geographies/mapping-files/time-series/geo/cartographic-boundary.2021.html", "U.S. Census Bureau"],
};

function bounds(geometry) {
  const box = [Infinity, Infinity, -Infinity, -Infinity];
  const polygons = geometry.type === "MultiPolygon" ? geometry.coordinates : [geometry.coordinates];
  for (const polygon of polygons) for (const ring of polygon) for (const [lon, lat] of ring) {
    box[0] = Math.min(box[0], lon);
    box[1] = Math.min(box[1], lat);
    box[2] = Math.max(box[2], lon);
    box[3] = Math.max(box[3], lat);
  }
  if (!box.every(Number.isFinite) || box[0] >= box[2] || box[1] >= box[3]) throw new Error("Invalid unit geometry");
  return box;
}

const { layers } = await load("manifest.json");
const catalogue = { delivery: "2026-11-15", cities: {} };
await mkdir(output, { recursive: true });
for (const layer of layers) {
  const { city, level, path, source, year, scale } = layer;
  if (!/^[a-z_]+$/i.test(city) || !Object.hasOwn(official, level)) throw new Error("Unexpected boundary layer");
  const [label, url, attribution] = official[level];
  const full = city === "London";
  const file = full ? "units_full.geojson" : "units_in_study_area.geojson";
  const { features } = await load(join(path, file));
  const ids = new Set();
  const units = [], shapes = [];
  features.sort((a, b) => a.properties.name.localeCompare(b.properties.name, "en", { numeric: true }) ||
    a.properties.source_code.localeCompare(b.properties.source_code));
  for (const { geometry, properties: p } of features) {
    if (ids.has(p.unit_id) || !["Polygon", "MultiPolygon"].includes(geometry?.type) ||
        !p.unit_id.startsWith(`${city}:${level}:`) || !Number.isFinite(p.inside_fraction)) throw new Error(`Invalid unit in ${city}/${level}`);
    ids.add(p.unit_id);
    const unit = { id: p.unit_id, code: p.source_code, name: p.name, bounds: bounds(geometry),
      sourceKm2: p.source_area_km2, areaKm2: p.in_study_area_km2, fraction: Math.min(1, p.inside_fraction),
      edge: p.edge_sliver === true, shard: Math.floor(units.length / 80) };
    units.push(unit);
    shapes.push({ type: "Feature", id: unit.id, properties: { id: unit.id, name: unit.name }, geometry });
  }
  if (units.length !== layer.features) throw new Error(`Unexpected feature count in ${city}/${level}`);
  const asset = `${city}-${level}`;
  for (let i = 0; i < shapes.length; i += 80) {
    await write(`${asset}-${i / 80}.geojson`, { type: "FeatureCollection", features: shapes.slice(i, i + 80) });
  }
  (catalogue.cities[city] ??= []).push({ level, label, asset, source, year, scale, url, attribution, full,
    covered: layer.covered_fraction, note: layer.scope_note, units });
  console.log(city, level, units.length);
}
await write("catalog.json", catalogue);
