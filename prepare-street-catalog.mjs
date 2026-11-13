import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync, gunzipSync } from "node:zlib";

const admin = fileURLToPath(new URL("./dist/client/data/admin/", import.meta.url));
const [source] = process.argv.slice(2);
if (!source) throw new Error("Pass the directory of completed city SOLWEIG runs.");
const catalogPath = path.join(admin, "catalog.json");
const catalog = JSON.parse(readFileSync(catalogPath, "utf8"));
catalog.cityStreetModels ??= {};
const intersects = (a, b) => a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];

for (const city of readdirSync(source, { withFileTypes: true }).filter(entry => entry.isDirectory() && Object.hasOwn(catalog.cities, entry.name))) {
  for (const event of readdirSync(path.join(source, city.name), { withFileTypes: true }).filter(entry => entry.isDirectory())) {
    const src = path.join(source, city.name, event.name, "city-street");
    let manifest;
    try { manifest = JSON.parse(readFileSync(path.join(src, "manifest.json"), "utf8")); }
    catch (error) { if (error.code === "ENOENT") continue; throw error; }
    const expected = catalog.cities[city.name].events[event.name];
    const date = manifest.timeUtc?.slice(0, 10);
    if (!expected?.core || !date || date < expected.core[0] || date > expected.core[1] ||
        manifest.scope !== "city" || manifest.city !== city.name || manifest.event !== event.name || !manifest.cells) {
      throw new Error("Expected a completed full city model for " + city.name + "/" + event.name);
    }
    const root = [city.name, event.name, "city-street"].join("/");
    const dest = path.join(admin, root);
    mkdirSync(dest, { recursive: true });
    const groups = new Map();
    let rows = 0;
    for (const tile of manifest.tiles) {
      const [x, y] = tile.file.replace(".bin", "").split("_").map(Number);
      const key = Math.floor(x / 7600) + "_" + Math.floor(y / 7600);
      const entries = groups.get(key) ?? [];
      const sample = JSON.parse(gunzipSync(readFileSync(path.join(src, tile.file))));
      if (sample.rows.length !== tile.cells || !intersects(tile.bounds, manifest.bounds)) throw new Error("Invalid model tile " + tile.file);
      entries.push({ bounds: tile.bounds, weather: sample.weather, rows: sample.rows });
      rows += tile.cells;
      groups.set(key, entries);
    }
    if (rows !== manifest.cells) throw new Error("Missing model cells");
    const shards = [];
    for (const [key, entries] of groups) {
      const bounds = [
        Math.min(...entries.map(tile => tile.bounds[0])), Math.min(...entries.map(tile => tile.bounds[1])),
        Math.max(...entries.map(tile => tile.bounds[2])), Math.max(...entries.map(tile => tile.bounds[3])),
      ];
      const file = root + "/" + key + ".bin";
      writeFileSync(path.join(admin, file), gzipSync(JSON.stringify(entries)));
      shards.push({ file, bounds });
    }
    for (const previous of catalog.cityStreetModels[city.name]?.[event.name]?.shards ?? []) {
      if (previous.file.startsWith(root + "/") && !shards.some(shard => shard.file === previous.file)) {
        rmSync(path.join(dest, path.basename(previous.file)), { force: true });
      }
    }
    delete manifest.tiles;
    (catalog.cityStreetModels[city.name] ??= {})[event.name] = {
      ...manifest, label: catalog.cities[city.name].adminName + " · city walking network", shards,
    };
    console.log(city.name, event.name, manifest.cells, "cells", manifest.pairedCells, "pairs", shards.length, "shards");
  }
}
writeFileSync(catalogPath, JSON.stringify(catalog) + "\n");
