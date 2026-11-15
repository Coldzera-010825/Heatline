const coordinateScale = 1e7;
const segmentLimit = 10000;

export const overlaps = (a, b) => a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3];
export const intersection = (a, b) => [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.min(a[3], b[3])];
const inside = (lon, lat, b) => lon >= b[0] && lon <= b[2] && lat >= b[1] && lat <= b[3];

export async function streetManifest(region, event, time, read) {
  const directory = `street-review/${region}/${event}/`;
  const manifest = await read(directory + "manifest.json").catch(() => null);
  return manifest?.version === 1 && manifest.city === region && manifest.event === event && manifest.timeUtc === time
    ? { ...manifest, directory } : null;
}

function lineBounds(line) {
  const box = [Infinity, Infinity, -Infinity, -Infinity];
  for (const [x, y] of line) {
    box[0] = Math.min(box[0], x);
    box[1] = Math.min(box[1], y);
    box[2] = Math.max(box[2], x);
    box[3] = Math.max(box[3], y);
  }
  return box;
}

function interpolate(a, b, t) {
  return a.map((value, i) => value + t * (b[i] - value));
}

function cutAt(line, distance) {
  const index = line.findIndex(point => point[2] >= distance);
  if (index <= 0) return index === 0 ? line[0] : line.at(-1);
  const previous = line[index - 1], next = line[index];
  return interpolate(previous, next, (distance - previous[2]) / (next[2] - previous[2]));
}

function edgeInside(a, b, box) {
  let start = 0, end = 1;
  for (const axis of [0, 1]) {
    const delta = b[axis] - a[axis];
    if (delta === 0) {
      if (a[axis] < box[axis] || a[axis] > box[axis + 2]) return null;
      continue;
    }
    const enter = (box[axis] - a[axis]) / delta, exit = (box[axis + 2] - a[axis]) / delta;
    start = Math.max(start, Math.min(enter, exit));
    end = Math.min(end, Math.max(enter, exit));
    if (start >= end) return null;
  }
  return [interpolate(a, b, start), interpolate(a, b, end)];
}

function clipLine(line, box) {
  if (line.every(([x, y]) => inside(x, y, box))) return [line];
  const pieces = [];
  for (let i = 1; i < line.length; i++) {
    const edge = edgeInside(line[i - 1], line[i], box);
    if (!edge) continue;
    const previous = pieces.at(-1);
    if (previous && Math.abs(previous.at(-1)[2] - edge[0][2]) < 1e-6) previous.push(edge[1]);
    else pieces.push(edge);
  }
  return pieces;
}

function districtClipper(area, window) {
  if (!area) return line => [line];
  const { geometry } = area;
  const polygons = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
  const edges = [];
  for (const polygon of polygons) for (const ring of polygon) for (let i = 1; i < ring.length; i++) {
    const a = ring[i - 1], b = ring[i], bounds = lineBounds([a, b]);
    if (overlaps(bounds, window)) edges.push({ a, b, bounds });
  }
  return line => {
    const pieces = [];
    for (let i = 1; i < line.length; i++) {
      const a = line[i - 1], b = line[i], bounds = lineBounds([a, b]);
      const dx = b[0] - a[0], dy = b[1] - a[1], cuts = [0, 1];
      for (const edge of edges) {
        if (!overlaps(bounds, edge.bounds)) continue;
        const ex = edge.b[0] - edge.a[0], ey = edge.b[1] - edge.a[1];
        const determinant = dx * ey - dy * ex;
        if (!determinant) continue;
        const x = edge.a[0] - a[0], y = edge.a[1] - a[1];
        const t = (x * ey - y * ex) / determinant, u = (x * dy - y * dx) / determinant;
        if (t > 0 && t < 1 && u >= 0 && u <= 1) cuts.push(t);
      }
      cuts.sort((a, b) => a - b);
      for (let j = 1; j < cuts.length; j++) {
        const start = cuts[j - 1], end = cuts[j];
        if (end - start < 1e-10 || !area.contains(...interpolate(a, b, (start + end) / 2))) continue;
        const p = interpolate(a, b, start), q = interpolate(a, b, end);
        const previous = pieces.at(-1);
        if (previous && Math.abs(previous.at(-1)[2] - p[2]) < 1e-6) previous.push(q);
        else pieces.push([p, q]);
      }
    }
    return pieces;
  };
}

export async function streetFeatures(manifest, selection, viewport, read, area) {
  const empty = { type: "FeatureCollection", features: [] };
  if (!overlaps(selection, viewport)) return { ok: true, streets: empty };
  const window = intersection(selection, viewport);
  if (window[2] - window[0] > .065 || window[3] - window[1] > .048) {
    return { ok: false, status: "zoom", reply: "Zoom in to inspect individual OSM walking segments." };
  }
  const clipDistrict = districtClipper(area, window);
  for (const tile of manifest.tiles.filter(tile => overlaps(tile.bounds, window))) {
    const data = await read(manifest.directory + tile.file, "packed-json");
    for (const [part, [way, name, vertices, runs]] of data.ways.entries()) {
      const line = [];
      for (let i = 0; i < vertices.length; i += 3) {
        line.push([vertices[i + 1] / coordinateScale, vertices[i + 2] / coordinateScale, vertices[i]]);
      }
      if (!overlaps(lineBounds(line), window)) continue;
      let start = 0;
      for (let i = 0; i < runs.length; i += 2) {
        const end = runs[i], code = runs[i + 1];
        if (end > start && code < 4) {
          const run = [cutAt(line, start), ...line.filter(point => point[2] > start && point[2] < end), cutAt(line, end)];
          if (overlaps(lineBounds(run), window)) {
            for (const [piece, clipped] of clipLine(run, area ? window : selection).flatMap(clipDistrict).entries()) {
              if (!overlaps(lineBounds(clipped), window)) continue;
              const id = `${tile.id}:${way}:${part}:${i / 2}:${piece}`;
              const coordinates = clipped.map(([x, y]) => [x, y]);
              const lengthM = Math.round(clipped.at(-1)[2] - clipped[0][2]) / 10;
              if (!lengthM) continue;
              empty.features.push({ type: "Feature", id, geometry: { type: "LineString", coordinates }, properties: {
                id, osmWayId: String(way), name: data.names[name], shadeClass: manifest.classes[code], code, lengthM,
              } });
              if (empty.features.length > segmentLimit) return { ok: false, status: "zoom", reply: "Zoom in to inspect the streets in this area." };
            }
          }
        }
        start = end;
      }
    }
  }
  return { ok: true, streets: empty, timeUtc: manifest.timeUtc };
}
