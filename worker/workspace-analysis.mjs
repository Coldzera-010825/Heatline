import { models, shadeClasses } from "../dist/client/workspace-contract.js";
import { shadeHeatReduction } from "./event-analysis.mjs";
import { reviewPriority } from "./street-review.mjs";
import { utciAtWeather } from "./utci.mjs";
import { bbox, collection, contains, feature, overlapGeometry, project, ring, wgs } from "./workspace-geography.mjs";
import { blockGeometry, centre, pixels, readCell } from "./workspace-raster.mjs";
import { gridKey, withinUTCI } from "./workspace-inputs.mjs";

const round = (n, digits = 3) => n == null ? null : Number(n.toFixed(digits));
const metric = (label, value, unit = "", digits = 3) => ({ label, value: round(value, digits), unit });
const limitRows = 100000;
const sum = values => values.reduce((total, n) => total + n, 0);

function residentialLayer(pop, lst, active, threshold, output, geometry, primary) {
  const grid = pop.meta.grid, temperatures = pixels(lst.bytes), people = pixels(pop.bytes);
  const mapPoint = project(grid.crs, wgs), toLST = project(grid.crs, lst.meta.grid.crs);
  const preview = new Map(), stride = Math.max(1, Math.ceil(Math.sqrt(people.length / 1400)));
  let covered = 0, matched = 0, weighted = 0, above = 0;
  for (let i = 0; i < people.length; i++) {
    const count = people[i];
    if (!Number.isFinite(count) || count <= 0) continue;
    const x = i % grid.width, y = Math.floor(i / grid.width), point = centre(grid, x, y), coord = mapPoint(...point);
    if (!active(...coord)) continue;
    covered += count;
    const temp = readCell(temperatures, lst.meta.grid, ...toLST(...point));
    const valid = Number.isFinite(temp);
    output.push([round(coord[0], 7), round(coord[1], 7), pop.meta.label, round(count, 6), valid ? round(temp) : null, valid ? Number(temp >= threshold) : null]);
    if (output.length > limitRows) throw new Error("This selection contains more than 100,000 output locations. Draw a smaller area and rerun.");
    if (!valid) continue;
    matched += count;
    weighted += count * temp;
    if (temp >= threshold) above += count;
    if (primary) {
      const col = Math.floor(x / stride) * stride, row = Math.floor(y / stride) * stride;
      const id = col + "," + row, block = preview.get(id) ?? [col, row, 0, 0];
      block[2] += count * temp;
      block[3] += count;
      preview.set(id, block);
    }
  }
  if (!matched) throw new Error("No residents in " + pop.meta.label + " match valid surface temperature in the selected area.");
  const map = [...preview.values()].flatMap(([col, row, heat, count]) => {
    const shape = overlapGeometry(blockGeometry(grid, col, row, Math.min(stride, grid.width - col),
      Math.min(stride, grid.height - row), mapPoint), geometry);
    return shape ? [feature(shape, { value: round(heat / count), residents: round(count, 2) })] : [];
  });
  return { covered, matched, above, mean: weighted / matched, map };
}

function residential(data, limit, options) {
  const rows = [], active = contains(limit), threshold = options.threshold;
  const populations = [data.population, ...(data.reference ? [data.reference] : [])];
  const stats = populations.map((pop, i) => residentialLayer(pop, data.lst, active, threshold, rows, limit, i === 0));
  const summary = stats.flatMap((s, i) => {
    const label = populations.length > 1 ? populations[i].meta.label + " · " : "";
    return [metric(label + "Resident-weighted LST", s.mean, "°C", 2),
      metric(label + "Residents at or above " + threshold + "°C", s.above / s.matched * 100, "%", 1),
      metric(label + "Matched resident coverage", s.matched / s.covered * 100, "%", 1),
      metric(label + "Matched residents", s.matched, "people", 1)];
  });
  if (stats.length === 2) summary.push(metric("Difference in matched resident-weighted LST", stats[0].mean - stats[1].mean, "°C", 2));
  return { summary, rows, fields: ["lon", "lat", "population_layer", "population", "lst_c", "at_or_above_threshold"],
    preview: collection(stats[0].map), primary: "lst_c", unit: "°C", geometry: "point",
    basis: "Population pixels retain their counts. Their centres are used to match land surface temperature in the selection. The threshold share uses matched residents." };
}

function censusIndex(areas, records, group) {
  const matches = new Map(records.filter(([, id]) => id === group).map(row => [row[0], row]));
  const byLatitude = new Map();
  const pieces = areas.features.filter(a => matches.has(a.properties.area_id)).sort((a, b) =>
    a.properties.area_id.localeCompare(b.properties.area_id));
  for (const a of pieces) {
    const bound = bbox(a.geometry);
    const entry = { bounds: bound, inside: contains(a.geometry), row: matches.get(a.properties.area_id) };
    for (let key = Math.floor(bound[1] * 100); key <= Math.floor(bound[3] * 100); key++) {
      const bucket = byLatitude.get(key) ?? [];
      bucket.push(entry);
      byLatitude.set(key, bucket);
    }
  }
  return (x, y) => byLatitude.get(Math.floor(y * 100))?.find(a => x >= a.bounds[0] && x <= a.bounds[2] &&
    y >= a.bounds[1] && y <= a.bounds[3] && a.inside(x, y))?.row;
}

function walking(data, limit, options, study, kind) {
  const cells = new Map(), weather = new Map(), active = contains(limit);
  const metres = project(wgs, study.gridCrs), toMap = project(study.gridCrs, wgs);
  let outsideModel = 0;
  for (const [, x, y, , length, tmrt, airC, humidity, wind, shade] of data.samples.data) {
    if (!active(x, y)) continue;
    if (!withinUTCI(tmrt, airC, wind)) { outsideModel += length; continue; }
    const key = gridKey(...metres(x, y)), w = [airC, humidity, wind].join(",");
    if (!weather.has(w)) {
      if (weather.size >= 512) weather.clear();
      weather.set(w, utciAtWeather({ airC, humidity, wind }));
    }
    const cell = cells.get(key) ?? { length: [0, 0, 0, 0, 0], heat: [0, 0, 0, 0, 0], x, y };
    const code = shadeClasses.indexOf(shade), type = code < 0 ? 4 : code;
    cell.length[type] += length;
    cell.heat[type] += weather.get(w)(tmrt) * length;
    cells.set(key, cell);
  }
  if (!cells.size) throw new Error("There are no walking samples with valid UTCI inputs in this selection.");
  const lookup = kind === "priority" ? censusIndex(data.censusAreas.data, data.censusGroups.data, options.group) : null;
  const fields = ["lon", "lat", "cell_id", "walking_m", "sunlit_m", "building_shade_m", "canopy_shade_m",
    "partial_shade_m", "unclassified_m", "baseline_utci_c"];
  if (kind === "shade") fields.push("paired", "scenario_utci_c", "delta_utci_c");
  if (kind === "priority") fields.push("area_id", "group_count", "eligible_count", "resident_share", "priority_score");
  const primary = kind === "shade" ? "scenario_utci_c" : kind === "priority" ? "priority_score" : "baseline_utci_c";
  const unit = kind === "priority" ? "points" : "°C";
  const rows = [], shapes = [], candidates = new Map(), preview = [];
  let lengthAll = 0, netHeat = 0, paired = 0, pairedLength = 0, pairedDelta = 0, knownLength = 0;
  for (const [id, c] of cells) {
    const [east, north] = id.split(",").map(n => Number(n) * 100);
    const geom = { type: "Polygon", coordinates: [ring([east, north, east + 100, north + 100]).map(p => toMap(...p))] };
    const shape = overlapGeometry(geom, limit);
    if (!shape) continue;
    const centre = toMap(east + 50, north + 50);
    const [x, y] = active(...centre) ? centre : [c.x, c.y];
    const length = sum(c.length), heat = sum(c.heat), baseline = heat / length;
    lengthAll += length;
    netHeat += heat;
    const [sun, building] = c.length, good = sun + .0005 >= 20 && building + .0005 >= 20;
    const row = [round(x, 7), round(y, 7), id, round(length), ...c.length.map(n => round(n)), round(baseline)];
    const props = { cell_id: id, walking_m: round(length), value: round(baseline), baseline_utci_c: round(baseline), missing: false };
    if (kind === "shade") {
      const delta = good ? shadeHeatReduction(sun, c.heat[0] / sun, c.heat[1] / building, options.shadePercent) : 0;
      if (good) { paired++; pairedLength += length; pairedDelta += delta; }
      row.push(Number(good), round((heat - delta) / length), good ? round(delta / length) : null);
      Object.assign(props, { value: row.at(-2), scenario_utci_c: row.at(-2), delta_utci_c: row.at(-1), carried: !good });
    }
    if (lookup) {
      const area = lookup(x, y);
      const share = area ? area[3] / area[4] : null;
      const score = area ? reviewPriority(baseline, sun / length, share) : null;
      row.push(area?.[0] ?? null, area?.[3] ?? null, area?.[4] ?? null, round(share, 6), round(score, 6));
      Object.assign(props, { value: round(score, 6), area_id: area?.[0] ?? null, resident_share: round(share, 6), missing: !area });
      if (area) {
        knownLength += length;
        if (score > 0 && score > (candidates.get(area[0])?.score ?? 0)) {
          candidates.set(area[0], { id, lon: x, lat: y, score: round(score, 6), area: area[0], share, baseline, group: area[2] });
        }
      }
    }
    rows.push(row);
    shapes.push(shape);
    preview.push(feature(shape, props));
  }
  if (!lengthAll) throw new Error("No valid walking cells intersect the selected area.");
  if (kind === "shade" && !paired) throw new Error("No selected 100 m cell has at least 20 m each of sunlit and building-shaded walking length.");
  if (lookup && !knownLength) throw new Error("No selected walking cells match census polygons and counts for this resident group.");
  const summary = [metric("Baseline length-weighted UTCI", netHeat / lengthAll, "°C", 2),
    metric("Modelled walking length", lengthAll / 1000, "km", 2), metric("Modelled 100 m cells", rows.length, "", 0)];
  if (outsideModel) summary.push(metric("Walking length outside the UTCI input domain", outsideModel, "m", 1));
  if (kind === "shade") summary.push(metric("Scenario length-weighted UTCI", (netHeat - pairedDelta) / lengthAll, "°C", 2),
    metric("UTCI reduction across the selection", pairedDelta / lengthAll, "°C", 2),
    metric("Walking length in paired cells", 100 * pairedLength / lengthAll, "%", 1), metric("Paired 100 m cells", paired, "", 0));
  if (lookup) summary.push(metric("Walking length matched to census areas", 100 * knownLength / lengthAll, "%", 1));
  const stride = Math.max(1, Math.ceil(preview.length / 2400));
  return { summary, rows, shapes, fields, primary, unit, geometry: "polygon",
    preview: collection(preview.filter((_, i) => i % stride === 0)), previewStride: stride,
    candidates: [...candidates.values()].sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, 5),
    basis: kind === "shade" ? "Building shade replaces the selected proportion of sunlit route length in cells with 20 m of each class. Unpaired length carries its baseline forward." :
      lookup ? "The score combines UTCI between 32 and 46°C, sunlit route share and the resident group share in the cell’s census area." :
      "UTCI is evaluated for each input sample, then aggregated on the 100 m metric grid by represented length." };
}

export function computeStudy(kind, data, limit, options, study) {
  if (!Object.hasOwn(models, kind)) throw new Error("Choose a supported analysis.");
  return kind === "resident" ? residential(data, limit, options) : walking(data, limit, options, study, kind);
}
