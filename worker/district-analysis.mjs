import { validBounds } from "./analysis.mjs";
import { modelFootprint } from "./study-boundary.mjs";
import { intersection } from "./review-streets.mjs";

const problem = (status, reply) => ({ ok: false, status, reply });
const supported = new Set(["weather", "population", "groups", "exposure", "shade", "review", "review-streets"]);
const contains = (box, x, y) => x >= box[0] && x <= box[2] && y >= box[1] && y <= box[3];
const temp = (label, value) => [label, value, "°C"];
const percent = (label, fraction) => [label, fraction == null ? null : fraction * 100, "%"];
const count = (label, value) => [label, value, ""];
const length = (label, metres) => [label, metres == null ? null : metres / 1000, "km"];

function measures(kind, result) {
  if (!result.ok) return [];
  const { event, analysis, review } = result;
  switch (kind) {
    case "weather":
      return [temp("Weighted daily maximum air temperature", event.air.values[0]), temp("Weighted daily minimum air temperature", event.air.values[1]),
        temp("Weighted daily mean air temperature", event.air.values[2]), count("Matched residents", event.air.matched),
        count("Total estimated residents", event.air.population), percent("Population matched", event.air.match), count("Valid weather grid cells", event.air.validCells)];
    case "population":
      return [temp("Resident-weighted LST", event.surface.mean), percent("Matched residents at or above 45°C LST", event.surface.above),
        count("Matched residents", event.surface.matched), count("Total estimated residents", event.surface.population), percent("Population matched", event.surface.match)];
    case "groups": {
      const group = event.groups[event.group], reference = event.groups[event.reference];
      return [temp(group.label + " · weighted LST", group.mean), temp(reference.label + " · weighted LST", reference.mean),
        temp("Group gap within area", event.delta), count("Selected group · matched residents", group.matched),
        count("Selected group · total residents", group.count), percent("Selected group · coverage", group.coverage),
        count("Reference group · matched residents", reference.matched), count("Reference group · total residents", reference.count),
        percent("Reference group · coverage", reference.coverage)];
    }
    case "exposure":
      return [temp("Length-weighted walking UTCI", analysis.meanUtci), count("Modelled 100 m cells", analysis.cellCount),
        length("Modelled walking length", analysis.pathLengthM), percent("Modelled length at or above 32°C UTCI", analysis.strongHeat.pathLengthShare)];
    case "shade":
      return [temp("UTCI reduction across modelled length", event.selection?.reduction), temp("Baseline UTCI across modelled length", event.selection?.before),
        temp("Scenario UTCI across modelled length", event.selection?.after), temp("UTCI reduction on paired length", event.reduction),
        percent("Modelled length with a shade pair", event.coverage?.share), count("Paired 100 m cells", event.pairedCells),
        length("Modelled walking length", event.coverage?.pathM)];
    case "review":
      return [temp("Baseline length-weighted UTCI", review.baseline), temp("Scenario length-weighted UTCI", review.pairedCells ? review.scenario : null),
        percent("Modelled length with a shade pair", review.pairedShare), percent("Sunlit share of modelled length", review.sunShare),
        count("Modelled 100 m cells", review.cellCount), length("Modelled walking length", review.pathM),
        ...(review.census ? [["Highest field priority score", review.candidates[0]?.priority?.score, "points"],
          percent("Modelled length matched to census", review.censusShare)] : [])];
    default: return [];
  }
}

export async function analyzeDistricts(body, progress, read, runArea) {
  const selection = body.districts;
  const region = body.archiveCase?.region, event = body.archiveCase?.event;
  if (typeof region !== "string" || typeof event !== "string" || !supported.has(body.kind) ||
      typeof selection?.level !== "string" || typeof selection.first !== "string" ||
      (selection.second != null && (typeof selection.second !== "string" || selection.second === selection.first))) {
    return problem("clarify", "Choose one or two different administrative areas from the same boundary layer.");
  }
  if (body.bounds != null && !validBounds(body.bounds)) return problem("clarify", "Choose valid map bounds.");
  const { cities } = await read("districts/catalog.json");
  const layer = Object.hasOwn(cities, region) && cities[region].find(item => item.level === selection.level);
  const detail = body.kind === "review-streets" || body.point != null || body.bounds != null;
  const ids = [selection.first, ...(!detail && selection.second ? [selection.second] : [])];
  const units = layer && ids.map(id => layer.units.find(unit => unit.id === id));
  if (!units || units.some(unit => !unit)) return problem("clarify", "The selected administrative area is unavailable for this city or layer.");
  let primary;
  const areas = [];
  for (const [index, unit] of units.entries()) {
    const box = body.bounds ? intersection(body.bounds, unit.bounds) : unit.bounds;
    const { features } = await read(`districts/${layer.asset}-${unit.shard}.geojson`);
    const geometry = features.find(feature => feature.id === unit.id)?.geometry;
    if (!geometry) throw new Error("Missing registered administrative area geometry");
    const mask = modelFootprint({ boundaryClipped: true, geometry });
    const area = { ...unit, bounds: box, geometry, contains: (x, y) => contains(box, x, y) && mask(x, y) };
    const place = layer.full ? unit.name : unit.name + " within the study area";
    progress(`Reading the data for ${place}…`);
    const result = validBounds(box) ? await runArea({ ...body, rank: false, borough: undefined, bounds: box }, { ...area, place, full: layer.full },
      index === 0 ? progress : () => {}) : problem("empty", "The map view does not intersect this area.");
    if (index === 0) primary = result;
    if (detail) return result;
    areas.push({ name: unit.name, id: unit.id, code: unit.code, place, areaKm2: unit.areaKm2, sourceKm2: unit.sourceKm2,
      fraction: unit.fraction, time: result.event?.timeUtc ?? result.event?.date ?? result.analysis?.timeUtc ?? result.review?.timeUtc,
      ok: result.ok, message: result.ok ? undefined : result.reply, metrics: measures(body.kind, result) });
  }
  return { ...primary, districtComparison: { kind: body.kind, layer: layer.label, source: layer.source, url: layer.url,
    attribution: layer.attribution, full: layer.full, areas } };
}

function weatherIndex(cells, step) {
  const index = new Map();
  const column = value => Math.floor(value / step);
  for (const [i, { geometry }] of cells.entries()) {
    const rings = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
    const box = [Infinity, Infinity, -Infinity, -Infinity];
    for (const polygon of rings) for (const [lon, lat] of polygon[0]) {
      box[0] = Math.min(box[0], lon); box[1] = Math.min(box[1], lat);
      box[2] = Math.max(box[2], lon); box[3] = Math.max(box[3], lat);
    }
    const test = modelFootprint({ boundaryClipped: true, geometry });
    for (let col = column(box[0]); col <= column(box[2]); col++) for (let row = column(box[1]); row <= column(box[3]); row++) {
      const key = `${col}:${row}`, choices = index.get(key) ?? [];
      choices.push({ i, box, test });
      index.set(key, choices);
    }
  }
  return (x, y) => index.get(`${column(x)}:${column(y)}`)?.find(({ box, test }) => contains(box, x, y) && test(x, y))?.i;
}

export async function districtWeather(weather, city, area, date, read) {
  const day = weather?.days?.[date];
  if (!day || !weather.cells?.length) return null;
  const locate = weatherIndex(weather.cells, Number.parseFloat(weather.resolution) || .1);
  let population = 0, matched = 0;
  const sums = [0, 0, 0], valid = new Set(), found = new Set();
  const add = (lon, lat, weight) => {
    if (!area.contains(lon, lat) || weight <= 0) return;
    population += weight;
    const index = locate(lon, lat);
    if (index == null) return;
    found.add(index);
    const row = day[index];
    if (!row?.every(Number.isFinite)) return;
    matched += weight;
    valid.add(index);
    for (let i = 0; i < sums.length; i++) sums[i] += weight * row[i];
  };
  if (city.populationPacked) {
    const raw = await read(city.populationPacked, "packed-index"), size = raw.byteLength / 12;
    const x = new Int32Array(raw, 0, size), y = new Int32Array(raw, size * 4, size), people = new Float32Array(raw, size * 8, size);
    for (let i = 0; i < size; i++) add(x[i] / 1e7, y[i] / 1e7, people[i]);
  } else if (city.population) {
    for (const [x, y, weight] of await read(city.population, "packed-json")) add(x, y, weight);
  }
  return matched ? { values: sums.map(n => n / matched), population: Math.round(population), matched: Math.round(matched),
    match: matched / population, validCells: valid.size, totalCells: found.size, resolution: weather.resolution } : null;
}
