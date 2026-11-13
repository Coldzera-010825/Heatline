import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import path from "node:path";

const project = path.dirname(fileURLToPath(import.meta.url));
const server = path.join(project, "dist", "server");
const data = path.join(project, "dist", "client", "data", "london-utci");
const manifest = JSON.parse(readFileSync(path.join(data, "manifest.json"), "utf8"));
const adminCatalog = path.join(project, "dist", "client", "data", "admin");
writeFileSync(path.join(adminCatalog, "catalog.bin"), gzipSync(readFileSync(path.join(adminCatalog, "catalog.json"))));

mkdirSync(server, { recursive: true });
for (const file of ["analysis.mjs", "assistant.mjs", "event-analysis.mjs", "london-population.mjs", "case-analysis.mjs",
  "utci.mjs", "utci-coefficients.mjs", "request-time.mjs", "residential-map.mjs", "city-street.mjs"]) {
  copyFileSync(path.join(project, "worker", file), path.join(server, file));
}
copyFileSync(path.join(project, "worker", "index.mjs"), path.join(server, "index.js"));
writeFileSync(path.join(server, "wrangler.json"), JSON.stringify({
  name: "heatline",
  main: "index.js",
  compatibility_date: "2026-05-15",
  assets: { directory: "../client", binding: "ASSETS" },
}, null, 2) + "\n");

// Citywide analysis reads one compressed index with the original archive precision.
const tiles = manifest.shards.map(shard => {
  const rows = JSON.parse(readFileSync(path.join(data, shard.file), "utf8"));
  const packed = Buffer.alloc(rows.length * 12);
  for (const [i, [lon, lat, utci, , , length]] of rows.entries()) {
    const offset = i * 12;
    packed.writeInt32LE(Math.round(lon * 1e6), offset);
    packed.writeInt32LE(Math.round(lat * 1e6), offset + 4);
    packed.writeInt16LE(Math.round(utci * 100), offset + 8);
    packed.writeUInt16LE(Math.round(length * 10), offset + 10);
  }
  return packed;
});
writeFileSync(path.join(data, "analysis-index.bin"), gzipSync(Buffer.concat(tiles)));
rmSync(path.join(data, "analysis-tiles.json"), { force: true });
