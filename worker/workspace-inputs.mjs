import { groupFields, maxTableRows, roles, sampleFields, shadeClasses } from "../dist/client/workspace-contract.js";
import { bbox, clipFeatures, collection, contains, feature, project, spatialFeatures, studyBoundary, wgs } from "./workspace-geography.mjs";
import { normalizeRaster } from "./workspace-raster.mjs";

const decoder = new TextDecoder("utf-8", { fatal: true });
const utcPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/i;
export function timestamp(value) {
  if (typeof value !== "string" || !utcPattern.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new Error("Use an ISO 8601 observation time with an explicit timezone.");
  }
  const [year, month, day] = value.slice(0, 10).split("-").map(Number);
  if (month < 1 || month > 12 || day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate()) {
    throw new Error("The date is outside the selected calendar month.");
  }
  return new Date(value).toISOString();
}

const safeCell = v => {
  const text = String(v ?? "");
  return /[,"\r\n]/.test(text) ? '"' + text.replaceAll('"', '""') + '"' : text;
};
export function csvText(fields, rows) {
  return [fields, ...rows].map(row => row.map(safeCell).join(",")).join("\r\n") + "\r\n";
}

export function readCsv(text) {
  const rows = [], size = text.length;
  let row = [], index = 0;
  while (index < size) {
    let value;
    if (text[index] === '"') {
      index++;
      const pieces = [];
      let end = text.indexOf('"', index);
      while (end >= 0 && text[end + 1] === '"') {
        pieces.push(text.slice(index, end + 1));
        index = end + 2;
        end = text.indexOf('"', index);
      }
      if (end < 0) throw new Error("Unclosed CSV quote on record " + (rows.length + 1) + ".");
      pieces.push(text.slice(index, end));
      value = pieces.join("");
      index = end + 1;
      if (index < size && !",\r\n".includes(text[index])) throw new Error("Unexpected text after a CSV quote.");
    } else {
      const start = index;
      while (index < size && !",\r\n".includes(text[index])) {
        if (text[index] === '"') throw new Error("CSV quotes must begin at the start of a field.");
        index++;
      }
      value = text.slice(start, index);
    }
    row.push(value.trim());
    if (text[index] === ",") {
      index++;
      if (index < size) continue;
      row.push("");
    }
    if (text[index] === "\r") index++;
    if (text[index] === "\n") index++;
    if (row.some(Boolean)) rows.push(row);
    row = [];
    if (rows.length > maxTableRows + 1) throw new Error("This CSV exceeds the 100,000-data-row limit.");
  }
  return rows;
}

export function csvColumns(bytes, fields, required = fields) {
  const [header, ...rows] = readCsv(decoder.decode(bytes));
  if (!header || !rows.length) throw new Error("The CSV needs a header and at least one data row.");
  const names = header.map(s => s.toLowerCase());
  if (new Set(names).size !== names.length) throw new Error("The CSV contains duplicate column names.");
  const missing = required.filter(name => !names.includes(name));
  if (missing.length) throw new Error("Missing CSV columns: " + missing.join(", ") + ".");
  const indices = fields.map(name => names.indexOf(name));
  return rows.map((row, i) => {
    if (row.length !== names.length) throw new Error("CSV record " + (i + 2) + " has the wrong number of fields.");
    return indices.map(index => row[index] ?? "");
  });
}

function finite(value, field, line, lo, hi) {
  const parsed = Number(value);
  if (value === "" || !Number.isFinite(parsed) || parsed < lo || parsed > hi) {
    throw new Error("CSV record " + line + " needs a valid " + field + " between " + lo + " and " + hi + ".");
  }
  return parsed;
}

export const gridKey = (x, y) => Math.floor(x / 100) + "," + Math.floor(y / 100);
export const withinUTCI = (tmrt, air, wind) => tmrt - air >= -30 && tmrt - air <= 70 && wind >= .5;

function inputSamples(bytes, study, limit) {
  const source = csvColumns(bytes, sampleFields, sampleFields.slice(0, 9));
  const inside = contains(limit), seen = new Set(), metres = project(wgs, study.gridCrs);
  const rows = [], previewCells = new Map();
  let total = 0, outside = 0, otherTime = 0, unknownShade = 0, outsideModel = 0;
  for (const [i, [id, lon, lat, time, length, tmrt, air, humidity, wind, shade = "", segment = ""]] of source.entries()) {
    const line = i + 2;
    let at;
    try { at = timestamp(time); } catch (err) { throw new Error("CSV record " + line + ": " + err.message); }
    if (!id || seen.has(id + "\0" + at)) throw new Error("CSV record " + line + " needs a unique sample_id for its time.");
    seen.add(id + "\0" + at);
    const x = finite(lon, "longitude", line, -180, 180), y = finite(lat, "latitude", line, -90, 90);
    const m = finite(length, "represented length (m)", line, .001, 100000);
    const t = finite(tmrt, "mean radiant temperature (°C)", line, -150, 150);
    const a = finite(air, "air temperature (°C)", line, -50, 50);
    const h = finite(humidity, "relative humidity (%)", line, 0, 100);
    const v = finite(wind, "10 m wind speed (m/s)", line, 0, 17);
    if (shade && !shadeClasses.includes(shade)) throw new Error("Invalid shade_class in CSV record " + line + ". Use " + shadeClasses.join(", ") + ".");
    if (at !== study.eventTime) { otherTime++; continue; }
    if (!inside(x, y)) { outside++; continue; }
    rows.push([id, x, y, at, m, t, a, h, v, shade, segment]);
    total += m;
    if (!withinUTCI(t, a, v)) { outsideModel++; continue; }
    if (!shade) unknownShade++;
    const key = gridKey(...metres(x, y));
    const cell = previewCells.get(key) ?? { x, y, sun: 0, building: 0, length: 0, heat: 0 };
    if (shade === "sunlit") cell.sun += m;
    if (shade === "building_shade") cell.building += m;
    cell.length += m;
    cell.heat += m * t;
    previewCells.set(key, cell);
  }
  if (!rows.length) throw new Error("No walking samples match the study boundary and UTC event time " + study.eventTime + ".");
  const stride = Math.max(1, Math.ceil(previewCells.size / 1600));
  const points = [...previewCells].filter((_, i) => i % stride === 0).map(([id, cell]) =>
    feature({ type: "Point", coordinates: [cell.x, cell.y] }, { value: cell.heat / cell.length, cell_id: id, length_m: cell.length }));
  return { data: rows, preview: collection(points), details: {
    records: rows.length, total_m: total, outside, otherTime, unknownShade, outsideModel,
    previewStride: stride, pairedCells: [...previewCells.values()].filter(({ sun, building }) => sun + .0005 >= 20 && building + .0005 >= 20).length,
  } };
}

function inputGroups(bytes) {
  const ids = new Set(), labels = new Map();
  const rows = csvColumns(bytes, groupFields).map(([area, id, label, n, denominator], i) => {
    if (!area || !id || !label || ids.has(area + "\0" + id) || (labels.has(id) && labels.get(id) !== label)) {
      throw new Error("CSV record " + (i + 2) + " needs a unique area_id and group_id pair and a consistent group label.");
    }
    ids.add(area + "\0" + id);
    labels.set(id, label);
    const eligible = finite(denominator, "eligible population", i + 2, 1, 1e9);
    return [area, id, label, finite(n, "group count", i + 2, 0, eligible), eligible];
  });
  return { data: rows, preview: collection([]), details: { records: rows.length, groups: [...labels].map(([id, label]) => ({ id, label })) } };
}

function vectorInput(bytes, role, meta, limit) {
  const document = JSON.parse(decoder.decode(bytes));
  const types = { routes: "line", censusAreas: "area" };
  const list = spatialFeatures(document, { type: types[role], max: 100000 });
  const seen = new Set();
  for (const f of list) {
    if (role === "censusAreas") {
      const id = String(f.properties.area_id ?? "").trim();
      if (!id || seen.has(id)) throw new Error("Census polygons require a unique area_id.");
      seen.add(id);
      f.properties = { ...f.properties, area_id: id };
    }
    if (meta.field) {
      if (!Number.isFinite(f.properties[meta.field])) throw new Error("Every feature needs a numeric " + meta.field + " value.");
      f.properties = { ...f.properties, value: f.properties[meta.field] };
    }
  }
  const data = clipFeatures(list, limit);
  if (!data.features.length) throw new Error("No features intersect the study boundary.");
  return { data, preview: collection(data.features.slice(0, 2200)), details: {
    records: data.features.length, outside: list.length - data.features.length, bounds: bbox(limit),
  } };
}

export async function normalizeInput(bytes, meta, study, bound) {
  const { role } = meta;
  const format = roles[role].format;
  if (role === "boundary") {
    const { feature: outline, bounds } = studyBoundary(JSON.parse(decoder.decode(bytes)));
    return { data: outline, preview: collection([outline]), details: { bounds } };
  }
  if (format === "GeoTIFF") return normalizeRaster(bytes, role, meta, bound);
  if (format === "GeoJSON") return vectorInput(bytes, role, meta, bound);
  return role === "samples" ? inputSamples(bytes, study, bound) : inputGroups(bytes);
}
