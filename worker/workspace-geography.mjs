import proj4 from "proj4";
import clip from "polygon-clipping";
import { modelFootprint } from "./study-boundary.mjs";

const metreProjections = {
  "EPSG:27700": "+proj=tmerc +lat_0=49 +lon_0=-2 +k=0.9996012717 +x_0=400000 +y_0=-100000 +ellps=airy +towgs84=446.448,-125.157,542.06,0.1502,0.247,0.8421,-20.4894 +units=m",
  "EPSG:3035": "+proj=laea +lat_0=52 +lon_0=10 +x_0=4321000 +y_0=3210000 +ellps=GRS80 +units=m",
  "EPSG:28992": "+proj=sterea +lat_0=52.15616055555555 +lon_0=5.38763888888889 +k=0.9999079 +x_0=155000 +y_0=463000 +ellps=bessel +towgs84=565.4171,50.3319,465.5524,-0.398957,0.343988,-1.8774,4.0725 +units=m",
  "ESRI:54009": "+proj=moll +lon_0=0 +x_0=0 +y_0=0 +datum=WGS84 +units=m",
};
for (const [name, definition] of Object.entries(metreProjections)) proj4.defs(name, definition);
export const wgs = "EPSG:4326";

export function crsName(value, metres = false) {
  const name = String(value || "").trim().toUpperCase().replace(/^(\d+)$/, "EPSG:$1");
  const utm = /^EPSG:32([67])(0[1-9]|[1-5][0-9]|60)$/.exec(name);
  if (utm && !proj4.defs(name)) proj4.defs(name, "+proj=utm +zone=" + Number(utm[2]) +
    (utm[1] === "7" ? " +south" : "") + " +datum=WGS84 +units=m");
  if (utm || Object.hasOwn(metreProjections, name) || (!metres && [wgs, "EPSG:3857"].includes(name))) return name;
  throw new Error("Unsupported coordinate reference system. Use WGS 84, WGS 84 UTM, British National Grid, EPSG:3035, EPSG:28992, or ESRI:54009.");
}

export function project(from, to) {
  if (from === to) return (x, y) => [x, y];
  const transform = proj4(from, to);
  return (x, y) => transform.forward([x, y]);
}

export function automaticGrid(bounds) {
  const lat = (bounds[1] + bounds[3]) / 2;
  const lon = (bounds[0] + bounds[2]) / 2;
  return crsName(32600 + Math.max(1, Math.min(60, Math.floor((lon + 180) / 6) + 1)) + (lat < 0 ? 100 : 0), true);
}

export function positions(geometry) {
  const levels = { Point: 0, MultiPoint: 1, LineString: 1, MultiLineString: 2, Polygon: 2, MultiPolygon: 3 };
  const level = levels[geometry?.type];
  if (level === undefined) throw new Error("Use GeoJSON points, lines or polygons with a coordinate array.");
  const coords = level === 0 ? [geometry.coordinates] : geometry.coordinates.flat(level - 1);
  if (!coords.length) throw new Error("The geometry has no coordinates.");
  return coords;
}

export function bbox(geometry, transform = (x, y) => [x, y]) {
  const result = [Infinity, Infinity, -Infinity, -Infinity];
  for (const [lon, lat] of positions(geometry)) {
    const [x, y] = transform(lon, lat);
    result[0] = Math.min(x, result[0]);
    result[1] = Math.min(y, result[1]);
    result[2] = Math.max(x, result[2]);
    result[3] = Math.max(y, result[3]);
  }
  return result;
}

export const overlaps = (a, b) => a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
export const boundsValid = a => Array.isArray(a) && a.length === 4 && a.every(Number.isFinite) &&
  a[0] >= -180 && a[1] >= -90 && a[2] <= 180 && a[3] <= 90 && a[0] < a[2] && a[1] < a[3];
export const ring = ([l, b, r, t]) => [[l, b], [r, b], [r, t], [l, t], [l, b]];
export const geometry = polygons => polygons.length === 1 ? { type: "Polygon", coordinates: polygons[0] } :
  { type: "MultiPolygon", coordinates: polygons };
export const polygons = g => g.type === "Polygon" ? [g.coordinates] : g.coordinates;
export const box = bounds => ({ type: "Polygon", coordinates: [ring(bounds)] });
export const feature = (geometry, properties = {}) => ({ type: "Feature", geometry, properties });
export const collection = features => ({ type: "FeatureCollection", features });
export const contains = g => modelFootprint({ boundaryClipped: true, geometry: g });
export const overlapGeometry = (a, b) => {
  const found = clip.intersection(polygons(a), polygons(b));
  return found.length ? geometry(found) : null;
};

export function spatialFeatures(document, { type, max = 20000 } = {}) {
  if (document?.crs && !/(?:4326|CRS84)$/i.test(document.crs.properties?.name ?? "")) {
    throw new Error("GeoJSON must use WGS 84 longitude and latitude.");
  }
  const list = document?.type === "FeatureCollection" ? document.features : document?.type === "Feature"
    ? [document] : [feature(document)];
  if (!Array.isArray(list) || !list.length) throw new Error("The GeoJSON contains no features.");
  let size = 0;
  return list.map((entry, i) => {
    const g = entry?.geometry;
    const types = type === "area" ? ["Polygon", "MultiPolygon"] : type === "line" ? ["LineString", "MultiLineString"] : null;
    if (types && !types.includes(g?.type)) throw new Error("Feature " + (i + 1) + " must use " + types.join(" or ") + ".");
    const coords = positions(g);
    if (coords.some(p => !Array.isArray(p) || !Number.isFinite(p[0]) || !Number.isFinite(p[1]) ||
      Math.abs(p[0]) > 180 || Math.abs(p[1]) > 90)) throw new Error("Invalid WGS 84 coordinates in feature " + (i + 1) + ".");
    size += coords.length;
    if (size > max) throw new Error("The layer contains too many vertices. Simplify it within the study area and retry.");
    if (g.type.endsWith("Polygon")) for (const poly of polygons(g)) for (const part of poly) {
      if (part.length < 4 || part[0][0] !== part.at(-1)[0] || part[0][1] !== part.at(-1)[1]) {
        throw new Error("Feature " + (i + 1) + " has an unclosed polygon ring.");
      }
    }
    return feature(g, entry.properties ?? {});
  });
}

export function studyBoundary(document) {
  const areas = spatialFeatures(document, { type: "area" });
  const g = geometry(clip.union(...areas.map(a => polygons(a.geometry))));
  const bounds = bbox(g);
  if (!boundsValid(bounds)) throw new Error("The boundary must enclose a valid study area.");
  return { feature: feature(g, { role: "Study boundary" }), bounds };
}

function cutSegment(a, b, rings, inside) {
  const [x, y] = a, dx = b[0] - x, dy = b[1] - y;
  const cuts = [0, 1];
  for (const path of rings) for (let i = 1; i < path.length; i++) {
    const [px, py] = path[i - 1], sx = path[i][0] - px, sy = path[i][1] - py;
    const cross = dx * sy - dy * sx;
    if (cross === 0) continue;
    const t = ((px - x) * sy - (py - y) * sx) / cross;
    const u = ((px - x) * dy - (py - y) * dx) / cross;
    if (t > 0 && t < 1 && u >= 0 && u <= 1) cuts.push(t);
  }
  const at = t => [x + t * dx, y + t * dy];
  cuts.sort((p, q) => p - q);
  const parts = [];
  for (let i = 1; i < cuts.length; i++) if (cuts[i] > cuts[i - 1] && inside(...at((cuts[i] + cuts[i - 1]) / 2))) {
    parts.push([at(cuts[i - 1]), at(cuts[i])]);
  }
  return parts;
}

export function clipFeatures(list, limit) {
  const inside = contains(limit), boundary = bbox(limit), rings = polygons(limit).flat();
  return collection(list.flatMap(({ geometry: g, properties }) => {
    if (!overlaps(bbox(g), boundary)) return [];
    if (g.type.endsWith("Polygon")) {
      const result = overlapGeometry(g, limit);
      return result ? [feature(result, properties)] : [];
    }
    if (g.type === "Point") return inside(...g.coordinates) ? [feature(g, properties)] : [];
    if (g.type === "MultiPoint") {
      const coordinates = g.coordinates.filter(p => inside(...p));
      return coordinates.length ? [feature({ ...g, coordinates }, properties)] : [];
    }
    const lines = g.type === "LineString" ? [g.coordinates] : g.coordinates;
    const parts = [];
    for (const line of lines) for (let i = 1; i < line.length; i++) {
      for (const part of cutSegment(line[i - 1], line[i], rings, inside)) {
        const end = parts.at(-1)?.at(-1);
        if (end && Math.abs(end[0] - part[0][0]) < 1e-10 && Math.abs(end[1] - part[0][1]) < 1e-10) parts.at(-1).push(part[1]);
        else parts.push(part);
      }
    }
    return parts.length ? [feature(parts.length === 1 ? { type: "LineString", coordinates: parts[0] } :
      { type: "MultiLineString", coordinates: parts }, properties)] : [];
  }));
}
