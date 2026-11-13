(() => {
  const heat = ["#4c337d", "#a44887", "#df615d", "#f8ac63", "#fff4ad"];
  const share = ["#363662", "#575486", "#777da9", "#81bbc1", "#ccedcf"];
  const classes = [
    [10, "Tree cover", "#379565"], [30, "Grassland", "#a7b864"], [40, "Cropland", "#dbac5d"],
    [50, "Built-up", "#b56b82"], [60, "Bare / sparse", "#b7a594"], [80, "Permanent water", "#509fdb"],
    [90, "Herbaceous wetland", "#58bcae"],
  ];
  const layers = {
    era5: { label: "Daily maximum air temperature", source: "Copernicus ERA5-Land · 2 m air temperature · NCSU daily archive", range: [-30, 50], colors: ["#5563a9", "#537db1", "#ad597c", "#f39257", "#fff3a6"], unit: "°C", height: 190000 },
    lst: { label: "Landsat LST", source: "Landsat 9 · 18 Jul 2022 · 10:52 UTC", range: [25, 55], colors: heat, unit: "°C", index: 2 },
    wow: { label: "WOW daily peak air temperature", source: "Met Office WOW · highest available hourly reading per station · UTC", range: [20, 43], colors: heat, unit: "°C" },
    regional: { label: "Landsat surface temperature", source: "Landsat Collection 2 L2 · 100 m display grid · common colour scale", range: [25, 55],
      colors: ["#45337d", "#943c81", "#d35675", "#f2a66c", "#fff4ad"], unit: "°C" },
    "regional-utci": { label: "Walking-network UTCI", source: "SOLWEIG · pilot areas · 100 m walking grids · common colour scale",
      range: [25, 55], colors: heat, unit: "°C" },
    ndvi: { label: "NDVI", source: "Landsat 8 · July 2022 median composite", range: [-1, 1], colors: ["#58357a", "#927495", "#c8b981", "#6fa861", "#307150"], unit: "", index: 3 },
    ndwi: { label: "NDWI", source: "Landsat 9 · 18 Jul 2022 · 10:52 UTC", range: [-1, .5], colors: ["#a65f4a", "#b68968", "#625685", "#438fb0", "#9fd7db"], unit: "", index: 4 },
    elevation: { label: "Elevation", source: "NASADEM · source grid 30 m", range: [-20, 250], colors: ["#35555d", "#518276", "#998d68", "#b99072", "#ead2b4"], unit: " m", index: 5 },
    landcover: { label: "Land cover", source: "ESA WorldCover 2021 v200 · dominant class · © ESA WorldCover project 2021 · CC BY 4.0", classes, index: 6 },
    utci: { label: "Walking-network UTCI", source: "TerraHeat · SOLWEIG + UTCI · 18 Jul 2022 · 10:52 UTC", range: [30, 40], colors: heat, unit: "°C" },
    residents: { label: "Residential surface heat proxy", source: "Census 2021 + Landsat 9 · 18 Jul 2022 · 5 × 5 pixel window", range: [25, 55], colors: heat, unit: "°C" },
    older: { label: "Resident share aged 65+", source: "Census 2021 · share in matched areas", range: [0, 30], colors: share, unit: "%" },
    limited: { label: "Resident share with limited activities", source: "Census 2021 TS038 · share in matched areas", range: [0, 30], colors: share, unit: "%" },
    deprived: { label: "Resident share in IMD deciles 1–2", source: "IMD 2025 applied to Census 2021 residential locations", range: [0, 100], colors: share, unit: "%" },
    leastDeprived: { label: "Resident share in IMD deciles 9–10", source: "IMD 2025 applied to Census 2021 residential locations", range: [0, 100], colors: share, unit: "%" },
    baseline: { label: "Baseline UTCI", source: "Paired pilot · SOLWEIG + UTCI · 18 Jul 2022 · 10:52 UTC", range: [28, 42], colors: heat, unit: "°C" },
    scenario: { label: "Shade scenario UTCI", source: "Paired pilot · length-weighted estimate · 18 Jul 2022 · 10:52 UTC", range: [28, 42], colors: heat, unit: "°C" },
  };
  const empty = { type: "FeatureCollection", features: [] };
  const cache = new Map();
  const londonLayers = ["lst", "wow", "ndvi", "ndwi", "elevation", "landcover"];
  const attr = {
    era5: "Copernicus Climate Change Service · ERA5-Land · NCSU State Climate Office",
    lst: "USGS Landsat 9",
    wow: "Met Office Weather Observations Website (WOW)",
    regional: "USGS Landsat Collection 2 · GHS-POP 2020",
    "regional-utci": "SOLWEIG · walking networks © OpenStreetMap contributors",
    ndvi: "USGS Landsat 8", ndwi: "USGS Landsat 9",
    elevation: "NASA JPL NASADEM",
    landcover: "© ESA WorldCover project 2021 · CC BY 4.0",
    utci: "SOLWEIG · Environment Agency LiDAR · © OpenStreetMap contributors",
    residents: "ONS Census 2021 · USGS Landsat 9",
    older: "ONS Census 2021 TS007A", limited: "ONS Census 2021 TS038",
    deprived: "English Indices of Deprivation 2025 · ONS Census 2021",
    leastDeprived: "English Indices of Deprivation 2025 · ONS Census 2021",
    baseline: "SOLWEIG · Environment Agency LiDAR · © OpenStreetMap contributors",
    scenario: "SOLWEIG · Environment Agency LiDAR · © OpenStreetMap contributors",
  };

  function data(file) {
    if (!cache.has(file)) {
      if (cache.size >= 90) cache.delete(cache.keys().next().value);
      const packed = file !== "london-grid.json" && file !== "stations.json";
      const filename = packed ? file.replace(/\.json$/, ".bin") : file;
      cache.set(file, fetch("data/heatwave/" + filename).then(response => {
        if (!response.ok) throw new Error("Event data is unavailable.");
        return packed ? new Response(response.body.pipeThrough(new DecompressionStream("gzip"))).json() : response.json();
      }).catch(error => {
        cache.delete(file);
        throw error;
      }));
    }
    return cache.get(file);
  }

  function collection(features) {
    return { type: "FeatureCollection", features };
  }

  function cell(west, south, east, north, properties) {
    return { type: "Feature", properties, geometry: { type: "Polygon",
      coordinates: [[[west, south], [east, south], [east, north], [west, north], [west, south]]] } };
  }

  function intersects(a, b) {
    return a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
  }

  async function globalGrid(day) {
    const rows = await data("globe-" + day + ".json");
    const features = rows.flatMap(([lon, lat, value]) => {
      const props = { lon, lat, value, day };
      const original = cell(Math.max(-180, lon - 1), lat - 1, lon + 1, lat + 1, props);
      return lon === -180 ? [original, cell(179, lat - 1, 180, lat + 1, { ...props, lon: 179.5 })] : [original];
    });
    return { features: collection(features), resolution: "2° sampled view" };
  }

  async function londonGrid(layer, bounds, zoom) {
    const { west, north, levels } = await data("london-grid.json");
    const { dx, dy, meters, tiles } = levels[zoom >= 12.3 ? 1 : 0];
    const padded = [bounds[0] - dx * 2, bounds[1] - dy * 2, bounds[2] + dx * 2, bounds[3] + dy * 2];
    const pages = await Promise.all(tiles.filter(tile => intersects(padded, tile.bounds)).map(tile => data(tile.file)));
    const index = layers[layer].index;
    const features = [];
    for (const rows of pages) {
      for (const row of rows) {
        const value = row[index];
        if (!Number.isFinite(value)) continue;
        const [col, r] = row;
        const w = west + col * dx, n = north - r * dy;
        if (intersects(padded, [w, n - dy, w + dx, n])) {
          features.push(cell(w, n - dy, w + dx, n, { lon: w + dx / 2, lat: n - dy / 2, value, meters }));
        }
      }
    }
    return { features: collection(features), resolution: meters + " m display grid" };
  }

  function populationGrid(rows, layer) {
    const index = { residents: 2, older: 3, limited: 5, deprived: 6, leastDeprived: 7 }[layer];
    return collection(rows.map(row => cell(row[0], row[1], row[0] + .0075, row[1] + .0045,
      { value: row[index], count: row[4], temperature: row[2], meters: 500 })));
  }

  function regionalData(file) {
    const key = "events/" + file;
    if (!cache.has(key)) cache.set(key, fetch("data/" + key).then(response => {
      if (!response.ok) throw new Error("Comparison data is unavailable.");
      return file.endsWith(".bin") ? new Response(response.body.pipeThrough(new DecompressionStream("gzip"))).json() : response.json();
    }).catch(error => { cache.delete(key); throw error; }));
    return cache.get(key);
  }

  function regionalGrid(regions, archives, date) {
    return collection(archives.flatMap((archive, index) => archive.cells.flatMap((bounds, i) => {
      const value = archive.values[date]?.[i];
      return Number.isFinite(value) ? [cell(...bounds, { value, date, region: regions[index].name })] : [];
    })));
  }

  function clip(feature, bounds) {
    if (!bounds) return feature;
    const [west, south, east, north] = bounds;
    let points = feature.geometry.coordinates[0].slice(0, -1);
    for (const [axis, edge, sign] of [[0, west, 1], [0, east, -1], [1, south, 1], [1, north, -1]]) {
      if (!points.length) return undefined;
      const clipped = [];
      let prior = points.at(-1);
      for (const point of points) {
        const wasInside = sign * (prior[axis] - edge) >= 0;
        const isInside = sign * (point[axis] - edge) >= 0;
        if (wasInside !== isInside) {
          const fraction = (edge - prior[axis]) / (point[axis] - prior[axis]);
          const crossing = prior.map((value, i) => value + fraction * (point[i] - value));
          crossing[axis] = edge;
          clipped.push(crossing);
        }
        if (isInside) clipped.push(point);
        prior = point;
      }
      points = clipped;
    }
    if (points.length < 3) return undefined;
    return { ...feature, geometry: { type: "Polygon", coordinates: [[...points, points[0]]] } };
  }

  const barFraction = .7;

  function barCutoff(layer) {
    const range = layers[layer]?.range;
    if (!range) return undefined;
    return range[0] + barFraction * (range[1] - range[0]);
  }

  function columns(features, layer) {
    const config = layers[layer];
    const cutoff = barCutoff(layer);
    const eligible = cutoff === undefined ? features.features : features.features.filter(feature => feature.properties.value >= cutoff);
    return collection(eligible.map(feature => {
      const scale = cutoff === undefined ? 0 : Math.min(1, (feature.properties.value - cutoff) / (config.range[1] - cutoff));
      const meters = feature.properties.meters ?? feature.properties.grid ?? 100;
      const tallest = config.height ? config.height * 2.5 : meters >= 500 ? 720 : 320;
      const height = config.classes ? 52 : tallest * (.4 + .6 * scale);
      const { geometry } = feature;
      // Keep clipped borders and holes intact. Shrink only ordinary rectangular cells.
      const rings = geometry.coordinates;
      const ring = rings[0];
      const rectangular = geometry.type === "Polygon" && rings.length === 1 && ring.length === 5 &&
        new Set(ring.map(p => p[0])).size === 2 && new Set(ring.map(p => p[1])).size === 2;
      let column = geometry;
      if (rectangular) {
        const lon = (Math.min(...ring.map(p => p[0])) + Math.max(...ring.map(p => p[0]))) / 2;
        const lat = (Math.min(...ring.map(p => p[1])) + Math.max(...ring.map(p => p[1]))) / 2;
        column = { type: "Polygon", coordinates: [ring.map(([x, y]) => [lon + .66 * (x - lon), lat + .66 * (y - lat)])] };
      }
      return { ...feature, geometry: column, properties: { ...feature.properties, height } };
    }));
  }

  function color(layer) {
    const config = layers[layer];
    if (config.classes) return ["match", ["get", "value"], ...config.classes.flatMap(([code, , c]) => [code, c]), "#867f72"];
    const [min, max] = config.range;
    return ["interpolate", ["linear"], ["get", "value"],
      ...config.colors.flatMap((c, i) => [min + (max - min) * i / (config.colors.length - 1), c])];
  }

  window.HEATLINE_LAYERS = { layers, attr, londonLayers, empty, data, collection, globalGrid, londonGrid, populationGrid, regionalData, regionalGrid, clip, barCutoff, columns, color };
})();
