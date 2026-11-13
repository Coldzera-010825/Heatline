import { validBounds } from "./analysis.mjs";
export { analyzePopulation } from "./london-population.mjs";

const snapshot = "2022-07-18T10:52:15Z";
const round = (value, places = 2) => Number(value.toFixed(places));
const validStation = id => typeof id === "string" && /^(?:\d{1,16}|[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/i.test(id);
const inside = (lon, lat, bounds) => !bounds ||
  (lon >= bounds[0] && lat >= bounds[1] && lon <= bounds[2] && lat <= bounds[3]);
const problem = (status, reply) => ({ ok: false, status, reply });

function correlation(pairs) {
  if (pairs.length < 6) return null;
  const n = pairs.length;
  const means = pairs.reduce(([x, y], [a, b]) => [x + a / n, y + b / n], [0, 0]);
  let xx = 0;
  let yy = 0;
  let xy = 0;
  for (const [a, b] of pairs) {
    const x = a - means[0];
    const y = b - means[1];
    xx += x * x;
    yy += y * y;
    xy += x * y;
  }
  return xx > 0 && yy > 0 ? round(xy / Math.sqrt(xx * yy)) : null;
}

const stationFields = new Set(["temperature", "humidity", "dewpoint", "wind", "gust", "pressure"]);
const interpretation = {
  humidity: "Relative humidity depends on both temperature and moisture. It can fall as air warms even when moisture changes little. Humidity also affects how efficiently sweat can evaporate.",
  dewpoint: "Dew point tracks atmospheric moisture more directly than relative humidity.",
  wind: "Wind can alter convective and evaporative heat exchange for people outdoors. Its association with air temperature alone does not identify the effect on pedestrian heat stress.",
};

async function analyzeStation({ station, comparison, day }, progress, readEvent) {
  if (!validStation(station)) return problem("clarify", "Select a WOW station on the map first.");
  if (comparison != null && (!validStation(comparison) || station === comparison)) {
    return problem("clarify", "Select a different WOW station to compare over the same hours.");
  }
  if (day != null && (!Number.isInteger(day) || day < 13 || day > 19)) {
    return problem("clarify", "Choose a day between 13 and 19 July 2022 or the entire heatwave.");
  }
  progress("Loading the selected WOW observations…");
  const [stations, reference] = await Promise.all([readEvent("stations.json"), readEvent("weather-reference.json")]);
  const selectedIds = comparison ? [station, comparison] : [station];
  if (selectedIds.some(id => !stations.some(s => s.id === id))) {
    return problem("clarify", "Choose stations from the London event map.");
  }
  const series = await Promise.all(selectedIds.map(id => readEvent("wow/" + id + ".json")));
  progress(comparison ? "Aligning observations from both stations by UTC hour…" : "Matching temperature and weather variables by UTC hour…");
  const dayPrefix = day == null ? null : "2022-07-" + day;
  const indexes = series.map(data => Object.fromEntries(data.fields.map(({ id }, i) => [id, i + 1])));
  const rows = series.map((data, i) => new Map(data.rows
    .filter(row => (!dayPrefix || row[0].startsWith(dayPrefix)) && Number.isFinite(row[indexes[i].temperature]))
    .map(row => [row[0], row])));
  const times = [...rows[0].keys()].filter(time => rows.every(table => table.has(time))).sort();
  if (!times.length) {
    return problem("empty", comparison ? "The two stations have no overlapping air-temperature records in this period." :
      "This station has no air-temperature observations in this period.");
  }
  const fields = series[0].fields.filter(({ id }) => stationFields.has(id) && indexes.every(index => index[id]));
  const comparisonFields = [];
  const associations = [];
  const charts = [];
  for (const field of fields) {
    const values = times.map(time => rows.map((table, i) => table.get(time)[indexes[i][field.id]] ?? null));
    const matched = values.map(v => v.every(Number.isFinite) ? v : v.map(() => null));
    const pairs = matched.filter(v => v.every(Number.isFinite));
    if (!pairs.length) continue;
    charts.push({ ...field, rows: times.map((time, i) => [time, ...matched[i]]) });
    if (comparison) {
      comparisonFields.push({
        ...field, hours: pairs.length,
        meanDifference: round(pairs.reduce((sum, [a, b]) => sum + a - b, 0) / pairs.length),
      });
    } else if (field.id !== "temperature") {
      const paired = matched.flatMap(([value], i) => value == null ? [] : [[rows[0].get(times[i])[indexes[0].temperature], value]]);
      const r = correlation(paired);
      if (r != null) associations.push({ ...field, hours: paired.length, r, interpretation: interpretation[field.id] });
    }
  }
  const peaks = rows.map((table, i) => {
    const values = times.map(time => table.get(time)[indexes[i].temperature]);
    const peak = Math.max(...values);
    const peakIndex = values.indexOf(peak);
    return { name: series[i].name, peak: round(peak), time: times[peakIndex], mean: round(values.reduce((sum, value) => sum + value, 0) / values.length) };
  });
  const top = [...associations].filter(x => x.interpretation).sort((a, b) => Math.abs(b.r) - Math.abs(a.r))[0];
  const temperatureDifference = comparisonFields.find(field => field.id === "temperature")?.meanDifference;
  let message = comparison
    ? "Across " + times.length + " shared UTC hours, " + peaks[0].name + " averaged " + Math.abs(temperatureDifference).toFixed(2) +
      "°C " + (temperatureDifference >= 0 ? "warmer" : "cooler") + " than " + peaks[1].name + ". Each plot uses hours with both observations present."
    : peaks[0].name + " reached " + peaks[0].peak.toFixed(1) + "°C at " + timesLabel(peaks[0].time) + ". " +
      (top ? top.label + " had r = " + top.r.toFixed(2) + " over " + top.hours + " paired hours. " + top.interpretation :
        "There are too few paired weather observations to estimate a reliable temperature association.");
  const stationReviews = selectedIds.map(id => stations.find(item => item.id === id)).filter(item => item.review).map(item => item.name);
  if (stationReviews.length) message += " Review flag: " + stationReviews.join(" and ") +
    " reported an event peak above the Met Office UK record; station exposure and timing should be checked.";
  const noaa = new Map(reference.station.rows);
  const referenceComparison = rows.map((table, i) => {
    const differences = [...table].flatMap(([time, row]) =>
      noaa.has(time) ? [row[indexes[i].temperature] - noaa.get(time)] : []);
    return { name: peaks[i].name, hours: differences.length, difference: differences.length ?
      round(differences.reduce((sum, value) => sum + value, 0) / differences.length) : null };
  });
  return {
    ok: true, status: "complete", reply: message,
    event: { kind: "station", day, hours: times.length, peaks, charts, associations, comparisonFields, referenceComparison, stationReviews,
      method: "WOW community observations, screened for valid coordinates and available temperatures. Unusual peaks are flagged for review, not corrected. The independent NOAA St James’s Park comparison uses exact UTC observation times; site differences are not a calibration error. Pearson correlations do not establish a heatwave driver." },
  };
}

function timesLabel(time) {
  return time.slice(8, 10) + " July, " + time.slice(11, 16) + " UTC";
}

async function analyzeShade({ bounds, shadePercent, timeUtc = snapshot, place = "the central London pilot", source, coverage, latitude, networkHeat }, progress, readEvent) {
  if (bounds != null && !validBounds(bounds)) return problem("clarify", "Draw a valid rectangular area.");
  if (!Number.isFinite(shadePercent) || shadePercent < 0 || shadePercent > 100) {
    return problem("clarify", "Choose a shade conversion percentage between 0 and 100.");
  }
  progress("Finding cells with paired sun and building shade…");
  const records = await readEvent("shade-pairs.json");
  const rows = records.filter(([lon, lat]) => inside(lon, lat, bounds));
  if (!rows.length) return problem("empty", "No eligible 100 m cells here have at least 20 m each of sunlit and building-shaded paths. " +
    (coverage?.city ? "Try a different area or view baseline UTCI in At street level." : "Pairing is available only in " + place + "."));
  progress("Calculating length-weighted baseline and shade scenario UTCI…");
  let total = 0;
  let sunTotal = 0;
  let converted = 0;
  let baseline = 0;
  let scenario = 0;
  const overview = rows.length > 14000, grid = new Map();
  const dy = 500 / 111195, dx = dy / Math.cos((latitude ?? rows[0][1]) * Math.PI / 180);
  const features = [];
  for (const [lon, lat, length, sunLength, shadeLength, base, sun, shade, ring] of rows) {
    const changed = shadePercent / 100 * sunLength;
    const difference = changed * (sun - shade);
    total += length;
    sunTotal += sunLength;
    converted += changed;
    baseline += base * length;
    scenario += base * length - difference;
    if (overview) {
      const w = Math.floor(lon / dx) * dx, s = Math.floor(lat / dy) * dy;
      const key = w + ":" + s;
      const cell = grid.get(key) ?? { w, s, length: 0, changed: 0, base: 0, scenario: 0 };
      cell.length += length;
      cell.changed += changed;
      cell.base += base * length;
      cell.scenario += base * length - difference;
      grid.set(key, cell);
    } else features.push({ type: "Feature", id: lon + "," + lat, geometry: { type: "Polygon", coordinates: [ring] },
      properties: { lon, lat, path_m: round(length, 1), sun_m: round(sunLength, 1), shade_m: round(shadeLength, 1),
        converted_m: round(changed, 1), baseline: round(base), scenario: round(base - difference / length),
        reduction: round(difference / length), sun: round(sun), shade: round(shade) } });
  }
  for (const { w, s, length, changed, base, scenario } of grid.values()) {
    features.push({ type: "Feature", geometry: { type: "Polygon", coordinates: [[[w, s], [w + dx, s], [w + dx, s + dy], [w, s + dy], [w, s]]] },
      properties: { path_m: round(length, 1), converted_m: round(changed, 1), baseline: round(base / length), scenario: round(scenario / length), meters: 500 } });
  }
  const before = round(baseline / total);
  const after = round(scenario / total);
  const reduction = round((baseline - scenario) / total);
  const selection = coverage?.city && Number.isFinite(networkHeat) ? {
    before: round(networkHeat / coverage.pathM),
    after: round((networkHeat - (baseline - scenario)) / coverage.pathM),
    reduction: round((baseline - scenario) / coverage.pathM),
  } : undefined;
  const contrasts = rows.map(row => row[6] - row[7]).sort((a, b) => a - b);
  const medianShadeContrast = round((contrasts[Math.floor((contrasts.length - 1) / 2)] + contrasts[Math.floor(contrasts.length / 2)]) / 2);
  return {
    ok: true, status: "complete",
    reply: "Converting " + shadePercent + "% of the modeled sunlit walking length gives " + after.toFixed(2) +
      "°C length-weighted UTCI, compared with " + before.toFixed(2) + "°C at baseline. The estimated change is " +
      (reduction > 0 ? "−" : reduction < 0 ? "+" : "") + Math.abs(reduction).toFixed(2) + "°C across " + rows.length.toLocaleString("en-GB") + " paired cells." +
      (coverage ? " This covers " + (100 * Math.min(1, total / coverage.pathM)).toFixed(1) + "% of modelled walking length in the selection." : " The estimate applies to the paired pilot routes in this selection."),
    event: {
      kind: "shade", timeUtc, place, source, before, after, reduction, medianShadeContrast, shadePercent, pairedCells: rows.length,
      networkM: Math.round(total), sunM: Math.round(sunTotal), convertedM: Math.round(converted),
      selection,
      coverage: coverage && { ...coverage, pathM: Math.round(coverage.pathM), share: Math.min(1, total / coverage.pathM) },
      mapResolution: overview ? "500 m paired overview · statistics use 100 m cells" : "100 m paired grid",
      features: { type: "FeatureCollection", features },
      method: "For each eligible 100 m cell, convert the stated fraction of existing modeled sunlit walking length to the cell’s modeled building-shade UTCI. Keep the rest of the network and the event weather fixed. The calculation uses cells with at least 20 m of both sunlit and building-shaded route. This is a single-time estimate with existing radiation inputs and no new shade geometry simulation." +
        (rows.length < 10 ? " Fewer than ten cells are eligible in this selection; the result represents only those cells." : ""),
      formula: "Scenario UTCI = Σ[baseline UTCI × route length − fraction × sunlit length × (sunlit UTCI − building-shade UTCI)] / Σ[route length]",
    },
  };
}

export { analyzeShade, analyzeStation };
