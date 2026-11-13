(() => {
  const R = window.HEATLINE_RESULTS;
  const cache = new Map(), earth = 6378137;
  const airColors = ["#4c337d", "#a44887", "#df615d", "#f8ac63", "#fff4ad"];
  const chartColors = ["#f6ab79", "#82c9d0", "#b7acdc"];
  const airKinds = { "air-max": ["Daily maximum 2 m air temperature", 0, [15, 45]],
    "air-min": ["Daily minimum 2 m air temperature", 1, [0, 32]],
    "air-mean": ["Daily mean 2 m air temperature", 2, [10, 38]] };
  const finite = Number.isFinite;
  const percent = n => finite(n) ? (100 * Math.min(1, n)).toFixed(1) + "%" : "—";
  const degrees = n => finite(n) ? n.toFixed(2) + "°C" : "No matched data";
  const labelDay = date => new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "UTC" }).format(new Date(date + "T00:00:00Z"));

  function read(file, type = file.endsWith(".bin") ? "json-gzip" : "json", directory = "cases") {
    const key = directory + "/" + file;
    if (!cache.has(key)) {
      if (cache.size >= 45) cache.delete(cache.keys().next().value);
      cache.set(key, fetch("data/" + key).then(response => {
        if (!response.ok) throw new Error("Case asset unavailable");
        if (type === "json") return response.json();
        const decoded = new Response(response.body.pipeThrough(new DecompressionStream("gzip")));
        return type === "grid" ? decoded.arrayBuffer().then(buffer => new DataView(buffer)) : decoded.json();
      }).catch(error => { cache.delete(key); throw error; }));
    }
    return cache.get(key);
  }

  const readAdmin = (file, type) => read(file, type, "admin");
  const model = state => state.model === "era5" ? state.data.alternative : state.data.weather;
  const weatherEvidence = state => state.event?.weather?.[state.model];
  function dates(state) {
    return [...new Set([...(model(state)?.daily ?? []), ...(state.data.point?.daily ?? [])].map(r => r.date))].sort();
  }

  function layers(state, detail = false) {
    const snapshot = state.event?.snapshot;
    const cover = state.admin.cover[detail ? "100" : "500"];
    const items = [snapshot?.layer, ...Object.values(state.event?.layers ?? {}), cover, ...Object.values(state.admin.layers)].filter(Boolean).map(layer => {
      const satellite = state.data.layers.some(item => item.id === layer.id) ? state.data.satellite : null;
      const source = satellite && layer.id !== "lst_c" ? [layer.source, satellite.datetime.slice(0, 10),
        satellite.in_core_period ? "event core snapshot" : "outside event core"].join(" · ") : layer.source;
      return { ...layer, type: "raster", source, range: layer.classes ? undefined : layer.range, colors: layer.classes ? undefined : layer.colors };
    });
    const weather = model(state);
    if (weather) items.push(...Object.entries(airKinds).map(([id, [label, index, range]]) => ({
      id, label: label + " · regional context", type: "air", index, source: weather.source + " · " + weather.resolution, range, unit: "°C", colors: airColors, height: 2900,
    })));
    if (state.data.stations.length) items.push({ id: "noaa", label: "NOAA station peak air temperature", type: "station", range: [15, 43],
      colors: airColors, unit: "°C", source: "NOAA Global Hourly (ISD) · maximum available reading · UTC" });
    return items;
  }

  const polygon = ([w, s, e, n], properties = {}) => ({
    type: "Feature", properties, geometry: { type: "Polygon", coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] },
  });
  const polygons = geometry => geometry.type === "MultiPolygon" ? geometry.coordinates : [geometry.coordinates];
  function clipToBoundary(feature, boundary) {
    const result = window.polygonClipping.intersection(polygons(feature.geometry), polygons(boundary.geometry));
    if (!result.length) return null;
    return { ...feature, geometry: result.length === 1 ? { type: "Polygon", coordinates: result[0] } :
      { type: "MultiPolygon", coordinates: result } };
  }

  function boundaryIndex(boundary, bbox) {
    const [, south, , north] = bbox, size = 64, buckets = Array.from({ length: size }, () => []);
    const row = lat => Math.max(0, Math.min(size - 1, Math.floor((lat - south) / (north - south) * size)));
    for (const poly of polygons(boundary.geometry)) for (const ring of poly) for (let i = 1; i < ring.length; i++) {
      const [a, b] = [ring[i - 1], ring[i]];
      const edge = [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1]), a, b];
      for (let j = row(edge[1]); j <= row(edge[3]); j++) buckets[j].push(edge);
    }
    const contains = (x, y) => {
      let inside = false;
      for (const [, , , , a, b] of buckets[row(y)]) {
        if ((a[1] > y) !== (b[1] > y) && x < (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
      }
      return inside;
    };
    return {
      contains,
      clip(feature, [w, s, e, n]) {
        for (let j = row(s); j <= row(n); j++) {
          if (buckets[j].some(edge => edge[0] <= e && edge[2] >= w && edge[1] <= n && edge[3] >= s)) return clipToBoundary(feature, boundary);
        }
        return contains(w, s) ? feature : null;
      },
    };
  }
  const lon = x => x / earth * 180 / Math.PI;
  const lat = y => Math.atan(Math.sinh(y / earth)) * 180 / Math.PI;
  const readValue = (grid, meta, x, y) => {
    const n = grid.getUint16((y * meta.width + x) * 2, true);
    return n === 65535 ? null : meta.offset + n * meta.step;
  };
  function sample(grid, meta, location) {
    const [w, s, e, n] = meta.bounds;
    const mx = location.lng / 180 * Math.PI * earth;
    const my = Math.asinh(Math.tan(location.lat / 180 * Math.PI)) * earth;
    const x = Math.floor((mx - w) / (e - w) * meta.width);
    const y = Math.floor((n - my) / (n - s) * meta.height);
    return x >= 0 && x < meta.width && y >= 0 && y < meta.height ? readValue(grid, meta, x, y) : null;
  }
  function rasterColumns(grid, meta, boundary) {
    const features = [], [w, s, e, n] = meta.bounds;
    const dx = (e - w) / meta.width, dy = (n - s) / meta.height;
    const stride = Math.max(1, Math.ceil(Math.sqrt(meta.width * meta.height / 4500)));
    for (let y = 0; y < meta.height; y += stride) for (let x = 0; x < meta.width; x += stride) {
      const endX = Math.min(x + stride, meta.width), endY = Math.min(y + stride, meta.height);
      let sum = 0, count = 0, mode;
      const classes = meta.classes ? new Map() : null;
      for (let j = y; j < endY; j++) for (let i = x; i < endX; i++) {
        const v = readValue(grid, meta, i, j);
        if (v == null) continue;
        if (classes) {
          classes.set(v, (classes.get(v) ?? 0) + 1);
          if (mode === undefined || classes.get(v) > classes.get(mode)) mode = v;
        }
        sum += v;
        count++;
      }
      if (!count) continue;
      const bounds = [lon(w + x * dx), lat(n - endY * dy), lon(w + endX * dx), lat(n - y * dy)];
      const feature = polygon(bounds, { value: mode ?? sum / count, meters: Math.max(dx, dy) * stride });
      const clipped = boundary ? boundary.clip(feature, bounds) : feature;
      if (clipped) features.push(clipped);
    }
    return features;
  }
  function airGrid(state, meta) {
    const weather = model(state), day = weather?.days[state.date];
    return day ? weather.cells.flatMap((cell, i) => {
      const value = day[i]?.[meta.index];
      if (!cell.bounds || !finite(value)) return [];
      const clipped = state.clip.clip(polygon(cell.bounds, { value, date: state.date }), cell.bounds);
      return clipped ? [clipped] : [];
    }) : [];
  }

  function chart(title, rows, labels, selectedDay, dateOnly = true) {
    const panel = R.element("div", null, "line-chart");
    panel.append(R.element("strong", title));
    const time = rows.map(row => Date.parse(row[0]));
    const values = rows.flatMap(row => row.slice(1)).filter(finite);
    if (!values.length) return panel;
    const low = Math.floor(Math.min(...values) / 5) * 5, high = Math.max(low + 5, Math.ceil(Math.max(...values) / 5) * 5);
    const min = time[0], max = time.at(-1);
    const x = n => min === max ? 168 : 35 + 266 * (n - min) / (max - min);
    const y = n => 95 - 79 * (n - low) / (high - low);
    const svgNode = (name, attributes) => {
      const node = document.createElementNS("http://www.w3.org/2000/svg", name);
      Object.entries(attributes).forEach(([k, v]) => node.setAttribute(k, v));
      return node;
    };
    const svg = svgNode("svg", { viewBox: "0 0 322 118", role: "img", "aria-label": title });
    for (const n of [low, (high + low) / 2, high]) {
      const line = svgNode("line", { x1: 35, x2: 301, y1: y(n), y2: y(n), stroke: "#57453a" });
      const text = svgNode("text", { x: 30, y: y(n) + 3, "text-anchor": "end", fill: "#cdb9a6" });
      text.textContent = R.format(n, 1);
      svg.append(line, text);
    }
    if (selectedDay && min <= Date.parse(selectedDay) && Date.parse(selectedDay) <= max) {
      const selected = x(Date.parse(selectedDay));
      svg.append(svgNode("line", { x1: selected, x2: selected, y1: 14, y2: 95, stroke: "#f0c9a4", "stroke-dasharray": "2 3" }));
    }
    for (const i of new Set([0, Math.floor((rows.length - 1) / 2), rows.length - 1])) {
      const text = svgNode("text", { x: x(time[i]), y: 111, "text-anchor": "middle", fill: "#cdb9a6" });
      text.textContent = dateOnly ? labelDay(rows[i][0].slice(0, 10)) : rows[i][0].slice(5, 16).replace("T", " ");
      svg.append(text);
    }
    labels.forEach((label, index) => {
      let path = "";
      const maxGap = dateOnly ? 86400000 : 5400000;
      const color = chartColors[index];
      rows.forEach((row, i) => {
        const v = row[index + 1];
        if (!finite(v)) return;
        const linked = finite(rows[i - 1]?.[index + 1]) && time[i] - time[i - 1] <= maxGap;
        const next = finite(rows[i + 1]?.[index + 1]) && time[i + 1] - time[i] <= maxGap;
        if (!linked && !next) svg.append(svgNode("circle", { cx: x(time[i]), cy: y(v), r: 2.5, fill: color }));
        else path += (linked ? "L" : "M") + x(time[i]) + " " + y(v);
      });
      if (path) svg.append(svgNode("path", { class: "chart-line", pathLength: 1, d: path, fill: "none", stroke: color, "stroke-width": 1.8 }));
    });
    const legend = R.element("div", null, "plot-legend");
    labels.forEach((label, i) => {
      const item = R.element("span", label);
      item.style.setProperty("--series-color", chartColors[i]);
      legend.append(item);
    });
    panel.append(svg, legend);
    return panel;
  }

  function pointDetails(point, selected) {
    if (!point?.daily?.length) return;
    const { summary, daily } = point;
    const details = R.details("Reference point · climate normals and P90",
      "One grid point, not the full study area. The archived 1991–2020 climatology is supplied with the data; the original 30-year sequence is not included.");
    details.append(R.table("Reference-grid event summary", [
      ["Peak Tmax · " + summary.peak_date, degrees(summary.peak_tmax_c)],
      ["Peak anomaly relative to 1991–2020", degrees(summary.peak_anom_c)],
      ["15-day heat above P90", finite(summary.w15_excess_heat_degday_p90) ? R.format(summary.w15_excess_heat_degday_p90, 1) + "°C·days" : "No data"],
    ]), chart("Reference-grid Tmax, climatology and 90th percentile", daily.map(d => [d.date, d.tmax, d.tmax_mean_1991_2020, d.tmax_p90_1991_2020]),
      ["Tmax", "1991–2020 mean", "P90"], selected));
    const day = daily.find(row => row.date === selected);
    if (day) details.append(R.table("Reference-grid variables on " + selected, [
      ["Relative humidity", finite(day.rh_mean) ? R.format(day.rh_mean, 1) + "%" : "No data"],
      ["ERA5 apparent Tmax", degrees(day.era5_app_tmax)],
      ["ERA5 maximum wind", finite(day.era5_wind_max) ? R.format(day.era5_wind_max, 1) + " km/h" : "No data"],
      ["ERA5 shortwave radiation", finite(day.era5_sw_sum) ? R.format(day.era5_sw_sum, 2) + " MJ/m²" : "No data"],
    ]));
    return details;
  }

  function preview(state, stage) {
    const panel = R.element("div"), weather = weatherEvidence(state), snapshot = state.event?.snapshot;
    if (stage === 0) {
      const { core, window } = state.event;
      panel.append(R.element("p", (core ? "Event core · " + labelDay(core[0]) + "–" + labelDay(core[1]) :
        "Reference-point archive · " + labelDay(window[0]) + "–" + labelDay(window[1])) + " · UTC", "data-note"));
    }
    if (stage === 0 && weather) {
      const day = weather.daily.find(row => row.date === state.date);
      panel.append(R.element("p", (day ? "Population-weighted Tmax " + degrees(day.values[0]) + " · " + percent(day.match) + " matched · " : "") +
        weather.source + ". Regional weather context within the administrative boundary.", "data-note"),
      chart("Daily 2 m air temperature · regional context (°C)", weather.daily.map(row => [row.date, ...row.values]), ["Tmax", "Tmin", "Tmean"], state.date));
    }
    if (stage === 0 && state.data.point) {
      const details = pointDetails(state.data.point, state.date);
      if (details) { details.open = state.data.scope === "reference-point"; panel.append(details); }
    }
    if (stage < 2 && snapshot) {
      panel.append(R.element("p", "Landsat " + snapshot.datetime.slice(0, 16).replace("T", " ") + " UTC · " +
        (snapshot.inCore ? "event-core snapshot" : "outside the event core") +
        " · " + percent(snapshot.summary.match) + " of estimated residents matched.", "data-note"));
    }
    if (stage === 1) panel.append(R.element("p", snapshot?.census?.coverage > 0 ?
      state.admin.census.source + " · " + percent(snapshot.census.coverage) + " of allocated census residents match this overpass." :
      snapshot ? "The overpass has no valid match for the available census groups." : "No Landsat overpass available for this case.", "data-note"));
    return panel;
  }

  function stationPreview(state) {
    const station = state.data.stations.find(s => s.id === state.station);
    if (!station) return R.element("p", "No screened NOAA ISD station archive for this event. Use the model series or reference point above.", "data-note");
    const rows = state.stationPeriod === "day" ? station.rows.filter(row => row[0].startsWith(state.date)) : station.rows;
    const panel = R.element("div");
    const source = R.element("a", "NOAA Global Hourly (ISD)");
    source.href = station.url;
    source.target = "_blank";
    source.rel = "noopener noreferrer";
    const label = R.element("p", null, "data-note");
    label.append(source, document.createTextNode(" · " + rows.length + " valid readings · UTC"));
    panel.append(label);
    if (rows.length) panel.append(chart(station.name + " · air temperature (°C)", rows.map(row => row.slice(0, 2)), [station.name], undefined, false));
    return panel;
  }

  function result(payload) {
    const e = payload.event;
    const title = { "archive-weather": "Event weather", "archive-station": "Station observations", "archive-population": "Population exposure" }[e.kind];
    const nodes = [R.element("h2", title + " · " + e.city), R.element("p", payload.reply)];
    if (e.air?.values.some(finite)) nodes.push(R.table("Population-weighted 2 m model air temperature", [
      ["Daily Tmax · " + e.date, degrees(e.air.values[0])],
      ...(e.air.values.length > 1 ? [["Daily Tmin", degrees(e.air.values[1])], ["Daily Tmean", degrees(e.air.values[2])]] : []),
      ["GHS-POP 2020 matched", R.format(e.air.matched, 0) + " · " + percent(e.air.match)],
      ["Model cells with data", e.air.validCells + " / " + e.air.totalCells],
      ["Model", e.source],
    ]));
    if (e.surface) nodes.push(R.table("Residential surface heat · Landsat", [
      ["Population-weighted LST", degrees(e.surface.mean)],
      ["Landsat overpass", e.timeUtc.slice(0, 16).replace("T", " ") + " UTC"],
      ["Snapshot scope", e.inCore ? "Event core" : "Outside event core"],
      ["Matched GHS-POP 2020", R.format(e.surface.matched, 0) + " · " + percent(e.surface.match)],
      ["Share of matched residents at ≥45°C LST", percent(e.surface.above)],
    ]));
    if (e.surface?.histogram?.length) nodes.push(R.bars("Share of matched residents by LST band (°C)", bins(e.bins).map((band, i) => [band, e.surface.histogram[i]])));
    if (e.kind === "archive-station") nodes.push(chart("Observed station air temperature (°C)", e.rows, e.names, undefined, false));
    if (e.point) nodes.push(R.table("Single reference grid point", [
      ["Daily Tmax · " + e.date, degrees(e.point.tmax)], ["Tmax anomaly", degrees(e.point.tmax_anom)],
      ["1991–2020 P90", degrees(e.point.tmax_p90_1991_2020)],
    ]));
    nodes.push(R.details("How this was calculated", e.method, e.missingLST));
    return nodes;
  }

  const bins = values => ["<" + values[0], ...values.slice(1).map((n, i) => values[i] + "–" + n), "≥" + values.at(-1)];
  window.HEATLINE_ARCHIVE = { read, readAdmin, model, dates, layers, labelDay, polygon, boundaryIndex, clipToBoundary, sample, rasterColumns, airGrid, preview, stationPreview, result, bins };
})();
