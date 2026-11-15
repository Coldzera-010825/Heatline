import { validBounds } from "./analysis.mjs";
import { evaluateCityStreet } from "./city-street.mjs";
import { shadeHeatReduction } from "./event-analysis.mjs";
import { matchesSnapshot } from "./request-time.mjs";
import { intersection, overlaps, streetFeatures, streetManifest } from "./review-streets.mjs";
import { modelFootprint } from "./study-boundary.mjs";
import { evaluateStreetGrid } from "./utci.mjs";

const detailLimit = 6000;
const groups = {
  all: ["All walking routes", "Check where people walk, wait or queue and how long they remain there."],
  older: ["Residents aged 65+", "Check where older adults wait or rest and whether the shaded approach and seating are accessible."],
  children: ["Residents aged 0–14", "Check where children and carers wait near entrances and crossings at the relevant time."],
  limited: ["Residents with limited daily activities", "Check step-free access, crossing delays, walking space and seating at the actual waiting location."],
};
const round = (n, digits = 2) => Number(n.toFixed(digits));
const problem = (status, reply, missing) => ({ ok: false, status, reply, ...(missing ? { missing } : {}) });
const inside = (lon, lat, b) => lon >= b[0] && lon <= b[2] && lat >= b[1] && lat <= b[3];
const id = (lon, lat) => `${lon},${lat}`;
const rankOrder = (a, b) => (b.priority?.score ?? 0) - (a.priority?.score ?? 0) ||
  b.baseline - a.baseline || b.sunM - a.sunM || a.id.localeCompare(b.id);

export function reviewPriority(utci, sunShare, residentShare) {
  return 100 * Math.max(0, Math.min(1, (utci - 32) / (46 - 32))) * sunShare * residentShare;
}

async function censusFor(meta, focus, read) {
  if (focus === "all") return null;
  const [packed, areas] = await Promise.all([
    read(meta.file + ".bin", "packed-index"), read(meta.file + "-areas.bin", "packed-json"),
  ]);
  return { cells: new Int32Array(packed), areas, column: 2 + meta.groups.indexOf(focus),
    source: meta.source, year: meta.year, unit: meta.unit };
}

function fieldPriority(census, row) {
  if (!census) return null;
  const [lon, lat, utci, length, , [sun]] = row;
  const x = Math.round(lon * 1e7), y = Math.round(lat * 1e7);
  const { cells } = census;
  let left = 0, right = cells.length / 3 - 1;
  while (left <= right) {
    const mid = Math.floor((left + right) / 2);
    const i = mid * 3;
    const difference = x - cells[i] || y - cells[i + 1];
    if (difference < 0) right = mid - 1;
    else if (difference > 0) left = mid + 1;
    else {
      const area = census.areas[cells[i + 2]];
      const [areaId, residents] = area;
      const count = area[census.column];
      if (count == null) return null;
      const share = count / residents;
      return { score: reviewPriority(utci, sun / length, share), areaId, count, residents, share };
    }
  }
  return null;
}

async function gridFor(model, selection, progress, read, area) {
  if (model.shards) return evaluateCityStreet(model, selection, true, detailLimit, progress, read, true, area);
  const grid = await read(model.file, "packed-json");
  const footprint = modelFootprint(model);
  progress("Evaluating the event-hour UTCI and shade lengths…");
  return evaluateStreetGrid(grid, model.weather, (lon, lat) => inside(lon, lat, selection) && footprint(lon, lat) && (!area || area.contains(lon, lat)), true);
}

function inspect(row, pair, percent, priority) {
  const [lon, lat, baseline, total, , lengths] = row;
  const [sun, building, canopy, partial] = lengths;
  const change = pair ? shadeHeatReduction(pair[3], pair[6], pair[7], percent) / total : null;
  return { id: id(lon, lat), coordinates: [lon, lat], baseline, totalM: round(total, 1), sunM: round(sun, 1),
    buildingShadeM: round(building, 1), canopyShadeM: round(canopy, 1), partialShadeM: round(partial, 1),
    sunShare: sun / total, scenario: change == null ? baseline : round(baseline - change),
    reduction: change == null ? null : round(change),
    priority: priority ? { ...priority, score: round(priority.score, 6) } : null };
}

function nearest(rows, point, latitude) {
  const cos = Math.cos(latitude * Math.PI / 180);
  let best, distance = Infinity;
  for (const row of rows) {
    const [x, y, , , ring] = row;
    if (ring && modelFootprint({ boundaryClipped: true, geometry: { type: "Polygon", coordinates: [ring] } })(...point)) return row;
    const delta = Math.hypot((x - point[0]) * cos, y - point[1]);
    if (delta < distance) { distance = delta; best = row; }
  }
  return distance <= .00065 ? best : undefined;
}

function summarize(rows, paired, percent, latitude, census) {
  const detail = rows.length <= detailLimit;
  const dy = 500 / 111195, dx = dy / Math.max(.15, Math.cos(latitude * Math.PI / 180));
  const cells = [], coarse = new Map(), candidates = [];
  let total = 0, baseline = 0, sun = 0, matched = 0, matchedHeat = 0, change = 0, censusLength = 0;
  for (const row of rows) {
    const [lon, lat, value, length, ring, shadeLengths] = row;
    const pair = paired.get(id(lon, lat));
    const priority = fieldPriority(census, row);
    const reduction = pair ? shadeHeatReduction(pair[3], pair[6], pair[7], percent) : 0;
    const heat = value * length;
    total += length;
    baseline += heat;
    sun += shadeLengths[0];
    change += reduction;
    if (pair) { matched += length; matchedHeat += heat; }
    if (priority) censusLength += length;
    const score = priority?.score ?? null;
    const rank = census ? score ?? 0 : value;
    const last = candidates.at(-1);
    if (shadeLengths[0] > 0 && (!census || rank > 0) && (candidates.length < 5 || rank >= (census ? last.priority.score : last.baseline))) {
      const item = inspect(row, pair, percent, priority);
      const previous = priority ? candidates.findIndex(other => other.priority.areaId === priority.areaId) : -1;
      if (previous === -1) candidates.push(item);
      else if (rankOrder(item, candidates[previous]) < 0) candidates[previous] = item;
      candidates.sort(rankOrder);
      if (candidates.length > 5) candidates.pop();
    }
    if (detail) {
      cells.push([lon, lat, value, pair ? round((heat - reduction) / length) : value,
        pair ? round(reduction / length) : null, ring, Number(Boolean(pair)), score == null ? null : round(score, 4)]);
    } else {
      const x = Math.floor(lon / dx), y = Math.floor(lat / dy);
      const key = x + ":" + y;
      const group = coarse.get(key) ?? [x, y, 0, 0, 0, 0, null];
      group[2] += heat;
      group[3] += length;
      group[4] += reduction;
      if (pair) group[5] += length;
      if (score != null) group[6] = Math.max(group[6] ?? 0, score);
      coarse.set(key, group);
    }
  }
  const grid = detail ? { metres: 100, cells } : {
    metres: 500, step: [dx, dy], cells: [...coarse.values()].map(([x, y, heat, length, delta, coverage, score]) =>
      [x, y, round(heat / length), round((heat - delta) / length), coverage ? round(delta / length) : null,
        null, round(coverage / length, 5), score == null ? null : round(score, 4)]),
  };
  return {
    grid, candidates, cellCount: rows.length, pathM: round(total, 1), sunM: round(sun, 1), sunShare: sun / total,
    baseline: round(baseline / total), scenario: matched ? round((baseline - change) / total) : null,
    reduction: matched ? round(change / total) : null, pairedCells: paired.size, pairedM: round(matched, 1),
    pairedShare: matched / total,
    pairedBaseline: matched ? round(matchedHeat / matched) : null,
    pairedScenario: matched ? round((matchedHeat - change) / matched) : null,
    censusShare: census ? censusLength / total : null,
  };
}

export async function analyzeStreetReview(body, progress, read, area) {
  const catalog = await read("catalog.json");
  const { region, event } = body.archiveCase ?? {};
  if (typeof region !== "string" || typeof event !== "string" || !Object.hasOwn(catalog.cities, region) ||
      !Object.hasOwn(catalog.cities[region].events, event)) {
    return problem("clarify", "Choose a city and heatwave from the case archive.");
  }
  const city = catalog.cities[region];
  const model = catalog.cityStreetModels?.[region]?.[event] ?? catalog.streetModels?.[region]?.[event];
  if (!model) {
    const missing = ["a walking network with mean radiant temperature", "matched event-hour weather", "modelled shade lengths on a common grid"];
    return problem("unavailable", `${city.name} needs ${missing.join(", ")} for this case.`, missing);
  }
  if (!matchesSnapshot(model.timeUtc, body.date, body.time)) {
    return problem("unavailable", `This review uses the model snapshot at ${model.timeUtc.replace("T", " ").replace("Z", " UTC")}.`);
  }
  if (body.bounds != null && !validBounds(body.bounds)) return problem("clarify", "Draw an area with valid coordinates.");
  const selection = intersection(body.bounds ?? model.bounds, model.bounds);
  if (!validBounds(selection)) return problem("empty", "This selection is outside the available walking model.");
  if (body.kind === "review-streets") {
    if (!validBounds(body.viewport)) return problem("clarify", "Choose a valid map view to inspect streets.");
    const manifest = await streetManifest(region, event, model.timeUtc, read);
    if (!manifest) return problem("unavailable", "Street geometry needs OSM way IDs and a georeferenced shade split for this model time.",
      ["timestamp-matched street shade geometry"]);
    return streetFeatures(manifest, selection, body.viewport, read, area);
  }

  const percent = body.shadePercent ?? 25;
  if (!Number.isFinite(percent) || percent < 0 || percent > 100) return problem("clarify", "Use a shade percentage from 0 to 100.");
  const focus = typeof body.focus === "string" && Object.hasOwn(groups, body.focus) ? body.focus : "all";
  const [group, siteCheck] = groups[focus];
  if (focus !== "all" && !city.reviewCensus?.groups.includes(focus)) {
    return problem("unavailable", `${city.name} needs small-area census data for ${group.toLowerCase()} to rank field priorities.`,
      ["matched census group data"]);
  }
  const point = body.point;
  let bounds = selection;
  if (point != null) {
    if (!Array.isArray(point) || point.length !== 2 || !point.every(Number.isFinite) || !inside(...point, selection) || area && !area.contains(...point)) {
      return problem("clarify", "Pick a location inside the selected study area.");
    }
    const span = .0011 / Math.max(.15, Math.cos(point[1] * Math.PI / 180));
    const around = [point[0] - span, point[1] - .0011, point[0] + span, point[1] + .0011];
    if (!overlaps(selection, around)) return problem("empty", "This point is outside the walking model.");
    bounds = intersection(selection, around);
  }
  progress("Checking model time, terrain and walking-network coverage…");
  const [grid, census] = await Promise.all([gridFor(model, bounds, progress, read, area), censusFor(city.reviewCensus, focus, read)]);
  if (!grid.rows.length) return problem("empty", "No valid walking cells in this selection. Move the area onto a covered route.");
  const pairs = new Map(grid.pairs.map(pair => [id(pair[0], pair[1]), pair]));
  if (point) {
    const row = nearest(grid.rows, point, point[1]);
    if (!row) return problem("empty", "No modelled 100 m walking cell at this location.");
    return { ok: true, cell: inspect(row, pairs.get(id(row[0], row[1])), percent, fieldPriority(census, row)), timeUtc: model.timeUtc };
  }
  progress("Calculating baseline and paired shade across the selected walking network…");
  const result = summarize(grid.rows, pairs, percent, city.center[1], census);
  const streets = await streetManifest(region, event, model.timeUtc, read);
  const checks = [siteCheck, "Verify the actual sun and shade at the study time, including shade access and any detour.",
    "Confirm clear walking width, access rights, utilities and site safety before investigating an intervention."];
  const recommendation = "Where field observations confirm regular use and gaps in shade, assess shading a waiting location or connecting existing shade.";
  const label = area?.place ?? model.label;
  return { ok: true, status: "complete", reply: `${label} has ${result.cellCount.toLocaleString("en-GB")} modelled walking cells. ` +
      `The baseline length-weighted UTCI is ${result.baseline.toFixed(2)}°C. ` +
      (result.pairedCells ? `${(result.pairedShare * 100).toFixed(1)}% of this walking length has valid sun and building-shade pairs.` : "This selection has baseline UTCI and needs paired sun and building-shade input for a scenario."),
    review: { ...result, region, event, focus, group, checks, recommendation, label, source: model.source, engine: model.engine,
      census: census ? { year: census.year, source: census.source, unit: census.unit } : null,
      timeUtc: model.timeUtc, scope: area ? "administrative area" : model.scope ?? "pilot", bounds: selection, shadePercent: percent,
      streets: streets ? { terrainM: streets.terrainM, osmSnapshots: streets.osmSnapshots, source: streets.source,
        routeParts: streets.routeParts, rasterTiles: streets.rasterTiles } : null } };
}
