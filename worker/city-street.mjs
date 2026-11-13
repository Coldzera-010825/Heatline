import { method, summarize } from "./analysis.mjs";
import { analyzeShade } from "./event-analysis.mjs";
import { matchesSnapshot } from "./request-time.mjs";
import { evaluateStreetGrid } from "./utci.mjs";

const overlaps = (a, b) => a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
const contains = (bounds, x, y) => bounds[0] <= x && x <= bounds[2] && bounds[1] <= y && y <= bounds[3];
const noCells = () => ({ ok: false, status: "empty", reply: "No modelled walking cells in the selected area. Move the selection onto covered routes." });
const detailLimit = 14000;

async function evaluateCityStreet(model, bounds, shade, progress, readAdmin) {
  const shards = model.shards.filter(shard => overlaps(shard.bounds, bounds));
  const rows = [], pairs = [];
  progress("Reading SOLWEIG radiation for the selected part of " + model.label + "…");
  for (let i = 0; i < shards.length; i += 4) {
    const batch = await Promise.all(shards.slice(i, i + 4).map(shard => readAdmin(shard.file, "packed-json")));
    for (const tile of batch.flat()) {
      if (!overlaps(tile.bounds, bounds)) continue;
      const selected = evaluateStreetGrid(tile, tile.weather, (lon, lat) => contains(bounds, lon, lat));
      for (const row of selected.rows) rows.push(row);
      if (shade) for (const row of selected.pairs) pairs.push(row);
      if (shade || rows.length > detailLimit) {
        for (const row of selected.rows) row.length = 4;
      }
      if (pairs.length > detailLimit) {
        for (const row of selected.pairs) row.length = 8;
      }
    }
  }
  progress("Aggregating event-hour UTCI by represented walking length…");
  return { rows, pairs };
}

function streetMap(rows, latitude) {
  const overview = rows.length > detailLimit;
  if (!overview) return {
    mapResolution: "100 m walking grid",
    mapRows: rows.map(([lon, lat, utci, length, ring]) => [lon, lat, utci, length, ring]),
  };
  const dy = 500 / 111195, dx = dy / Math.cos(latitude * Math.PI / 180);
  const grid = new Map();
  for (const [lon, lat, utci, length] of rows) {
    const w = Math.floor(lon / dx) * dx, s = Math.floor(lat / dy) * dy;
    const key = w + ":" + s;
    const cell = grid.get(key) ?? [w, s, 0, 0];
    cell[2] += utci * length;
    cell[3] += length;
    grid.set(key, cell);
  }
  return {
    mapResolution: "500 m map overview · statistics use 100 m cells",
    mapRows: [...grid.values()].map(([w, s, weighted, length]) => [
      w + dx / 2, s + dy / 2, Number((weighted / length).toFixed(2)), Math.round(length),
      [[w, s], [w + dx, s], [w + dx, s + dy], [w, s + dy], [w, s]],
    ]),
  };
}

export async function analyzeCityStreet(body, model, city, progress, readAdmin) {
  if (!matchesSnapshot(model.timeUtc, body.date, body.time)) {
    return { ok: false, status: "unavailable", reply: model.label + " covers " +
      model.timeUtc.slice(0, 16).replace("T", " ") + " UTC." };
  }
  const bounds = body.bounds ?? model.bounds;
  if (body.kind === "shade" && (!Number.isFinite(body.shadePercent ?? 25) || (body.shadePercent ?? 25) < 0 || body.shadePercent > 100)) {
    return { ok: false, status: "clarify", reply: "Choose a shade conversion percentage between 0 and 100." };
  }
  const { rows, pairs } = await evaluateCityStreet(model, bounds, body.kind === "shade", progress, readAdmin);
  if (!rows.length) return noCells();
  if (body.kind === "shade") return analyzeShade({
    bounds, shadePercent: body.shadePercent ?? 25, timeUtc: model.timeUtc, place: city.adminName, source: model.source, latitude: city.center[1],
    coverage: { cells: rows.length, pathM: rows.reduce((sum, row) => sum + row[3], 0), city: true },
    networkHeat: rows.reduce((sum, row) => sum + row[2] * row[3], 0),
  }, progress, () => pairs);

  const map = streetMap(rows, city.center[1]);
  if (body.mapOnly === true) return { ok: true, status: "complete", analysis: map };
  const summary = summarize(rows, bounds);
  return {
    ok: true, status: "complete",
    reply: (body.bounds ? "In the selected area" : "Across the modelled city network") +
      ", walking-length-weighted UTCI was " + summary.meanUtci.toFixed(2) + "°C across " +
      summary.cellCount.toLocaleString("en-GB") + " grid cells.",
    analysis: {
      ...summary, bounds, scope: body.bounds ? "selected" : "city", cityModel: true, timeUtc: model.timeUtc,
      source: model.engine + " · " + model.source,
      method: method + " UTCI is calculated from stored 5 m SOLWEIG radiation and the event-hour weather for each tile.",
      ...map,
    },
  };
}
