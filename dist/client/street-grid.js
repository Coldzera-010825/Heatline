(function () {
  const directory = "data/london-utci/";
  const cache = new Map();
  let manifestRequest;

  async function readJson(file) {
    const response = await fetch(directory + file);
    if (!response.ok) throw new Error("The London pedestrian heat archive could not be loaded.");
    return response.json();
  }

  function manifest() {
    if (!manifestRequest) {
      manifestRequest = readJson("manifest.json").catch(error => {
        manifestRequest = undefined;
        throw error;
      });
    }
    return manifestRequest;
  }

  function chunk(file, geometryFile) {
    if (!cache.has(file)) {
      if (cache.size >= 32) cache.delete(cache.keys().next().value);
      const request = Promise.all([readJson(file), readJson(geometryFile)]).catch(error => {
        if (cache.get(file) === request) cache.delete(file);
        throw error;
      });
      cache.set(file, request);
    }
    return cache.get(file);
  }

  function polygon(packed, index) {
    const southwest = packed.cells[index];
    const northwest = southwest + packed.columns;
    const vertices = packed.vertices;
    return [vertices[southwest], vertices[southwest + 1], vertices[northwest + 1], vertices[northwest], vertices[southwest]];
  }

  function intersects(a, b) {
    return a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
  }

  function paddedBounds(bounds) {
    const [west, south, east, north] = bounds;
    const dx = (east - west) * .15;
    const dy = (north - south) * .15;
    return [west - dx, south - dy, east + dx, north + dy];
  }

  async function load(bounds, zoom) {
    const index = await manifest();
    const detail = zoom >= 12.3;
    const grid = detail ? index.grid : index.overview_grid;
    const fadeDistance = detail ? 550 : 1400;
    const view = paddedBounds(bounds ?? index.bounds);
    const files = detail
      ? index.shards.filter(shard => intersects(view, shard.bounds))
      : [{file: "overview.json", geometry: index.overview_geometry}];
    const groups = await Promise.all(files.map(file => chunk(file.file, file.geometry)));
    const points = [];
    const features = [];
    for (const [rows, packed] of groups) {
      for (const [position, row] of rows.entries()) {
        const [lon, lat, utci, tmrt, sun, path_m, lst, edge] = row;
        if (lon < view[0] || lon > view[2] || lat < view[1] || lat > view[3]) continue;
        const t = Number.isFinite(edge) ? Math.min(1, Math.max(0, edge / fadeDistance)) : 1;
        const properties = {lon, lat, utci, tmrt, sun, path_m, lst: lst ?? null, grid, edgeWeight: t * t * (3 - 2 * t)};
        const feature = {type: "Feature", id: `${lon},${lat}`, properties};
        points.push({...feature, geometry: {type: "Point", coordinates: [lon, lat]}});
        features.push({...feature, geometry: {type: "Polygon", coordinates: [polygon(packed, position)]}});
      }
    }
    return {grid, points: {type: "FeatureCollection", features: points}, features: {type: "FeatureCollection", features}};
  }

  window.HEATLINE_GRID = {load, manifest};
})();
