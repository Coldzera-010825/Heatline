import { method, summarize, validBounds } from "./analysis.mjs";
import { analyzeShade } from "./event-analysis.mjs";
import { evaluateStreetGrid } from "./utci.mjs";
import { matchesSnapshot, requestTime, viewIntent } from "./request-time.mjs";
import { analyzePopulation } from "./london-population.mjs";
import { matchedPoints, residentialTiles } from "./residential-map.mjs";
import { analyzeCityStreet } from "./city-street.mjs";

const missing = {
  station: ["quality-screened NOAA ISD hourly station observations for this event"],
  stationPair: ["a second station with overlapping quality-screened UTC observations"],
  population: ["a cloud-screened Landsat surface-temperature snapshot matching residential population cells inside the administrative boundary"],
  groups: ["local census group counts matched to an available Landsat scene"],
  exposure: ["event-hour weather, terrain and building/canopy heights", "a SOLWEIG pedestrian UTCI simulation matched to a walking network"],
  shade: ["paired sunlit and building-shade UTCI for the same event time", "represented sunlit and shaded route lengths for each paired cell"],
};
const problem = (status, reply) => ({ ok: false, status, reply });
const scope = data => data.cityName + " · " + data.peak.slice(0, 7);
const unavailable = (data, kind, extra = "") => ({
  ...problem("unavailable", scope(data) + " is missing " + missing[kind].join("; ") + ". " + extra),
  missing: missing[kind],
});
const complete = (data, kind, reply, event) => ({
  ok: true, status: "complete", reply, event: { kind, city: data.cityName, eventId: data.event, ...event },
});
const dateLabel = time => time.slice(0, 10) + " " + time.slice(11, 16) + " UTC";
const valueLabel = n => Number.isFinite(n) ? n.toFixed(2) + "°C" : "no matched data";
const inside = (lon, lat, bounds) => !bounds || lon >= bounds[0] && lat >= bounds[1] && lon <= bounds[2] && lat <= bounds[3];
const share = x => (Math.min(1, x) * 100).toFixed(1) + "%";

const streetFeatures = (rows, city) => ({ type: "FeatureCollection", features: rows.map(([lon, lat, value, path_m, ring]) => ({
  type: "Feature", geometry: { type: "Polygon", coordinates: [ring] }, properties: { lon, lat, value, utci: value, path_m, city },
})) });

export async function compareStreet({ regions, event, date, time }, progress, readAdmin) {
  const catalog = await readAdmin("catalog.json");
  if (typeof event !== "string" || !Array.isArray(regions) || regions.length !== 2 || regions[0] === regions[1] ||
      regions.some(city => typeof city !== "string" || !Object.hasOwn(catalog.cities, city))) {
    return problem("clarify", "Choose two different archived cities.");
  }
  const cases = regions.map(city => Object.hasOwn(catalog.streetModels?.[city] ?? {}, event) ? catalog.streetModels[city][event] : null);
  if (cases.some(pilot => !pilot)) return problem("unavailable", "Both cities need walking-network simulations for this historical event.");
  if (cases[0].timeUtc !== cases[1].timeUtc || cases.some(pilot => pilot.gridM !== 100 || pilot.terrainM !== 5 || pilot.engine !== cases[0].engine) ||
      !matchesSnapshot(cases[0].timeUtc, date, time)) {
    return problem("unavailable", "No matched 100 m street pilots for the requested time. The archived model times are " +
      [...new Set(cases.map(pilot => dateLabel(pilot.timeUtc)))].join(" and ") + ".");
  }
  progress("Loading the two same-time SOLWEIG radiation grids…");
  const grids = await Promise.all(cases.map(pilot => readAdmin(pilot.file, "packed-json")));
  progress("Calculating and comparing walking-length-weighted UTCI…");
  const cities = cases.map((pilot, i) => {
    const name = catalog.cities[regions[i]].name;
    const { rows } = evaluateStreetGrid(grids[i], pilot.weather);
    const summary = summarize(rows, pilot.bounds);
    return { name, label: pilot.label, cellCount: summary.cellCount, meanUtci: summary.meanUtci, pathLengthM: summary.pathLengthM,
      strongHeat: summary.strongHeat, distribution: summary.distribution, features: streetFeatures(rows, name) };
  });
  return { ok: true, status: "complete", event: { kind: "street-comparison", timeUtc: cases[0].timeUtc, cities },
    reply: dateLabel(cases[0].timeUtc) + " · " + cities.map(city => city.name + " " + valueLabel(city.meanUtci)).join(" and ") +
      " walking-length-weighted UTCI in the two modelled pilots." };
}

export async function loadArchive(selection, read) {
  const catalog = await read("catalog.json", "json");
  const city = catalog.cities.find(item => item.id === selection?.region);
  const record = city?.cases.find(item => item.id === selection?.event);
  if (!record) return null;
  return read(record.file, "packed-json");
}

function populationSummary(points, temps, bounds, { threshold, bins }) {
  const lengths = Array(bins.length + 1).fill(0);
  let population = 0, matched = 0, sum = 0, above = 0;
  for (let i = 0; i < points.length; i++) {
    const [lon, lat, weight] = points[i];
    if (!inside(lon, lat, bounds)) continue;
    population += weight;
    const temp = temps[i];
    if (!Number.isFinite(temp)) continue;
    matched += weight;
    sum += weight * temp;
    if (temp >= threshold) above += weight;
    const index = bins.findIndex(edge => temp < edge);
    lengths[index === -1 ? bins.length : index] += weight;
  }
  return { population: Math.round(population), matched: Math.round(matched), match: population ? matched / population : 0,
    mean: matched ? sum / matched : null, above: matched ? above / matched : null,
    histogram: matched ? lengths.map(n => n / matched) : [] };
}

function compareResidents(city, snapshot, points, temperatures, census, bounds, body, bins) {
  const labels = city.census.groups;
  const group = body.group ?? "older", reference = body.reference ?? (group === "all" ? "older" : "all");
  if (!Object.hasOwn(labels, group) || !Object.hasOwn(labels, reference) || group === reference) {
    return problem("clarify", "Choose two different supported groups: " + Object.values(labels).join("; ") + ".");
  }
  const rows = [...matchedPoints(points, temperatures, bounds, census, city.census.keys)];
  const totals = Object.fromEntries(Object.keys(labels).map(key => [key, { count: 0, matched: 0, heat: 0, bins: Array(bins.length + 1).fill(0) }]));
  const byDistrict = new Map();
  let matched = 0;
  for (const [, , temperature, weights, , district] of rows) {
    if (Number.isFinite(temperature)) matched++;
    const i = bins.findIndex(edge => temperature < edge);
    for (const [key, total] of Object.entries(totals)) {
      const n = weights[key];
      if (!Number.isFinite(n)) continue;
      total.count += n;
      if (!Number.isFinite(temperature)) continue;
      total.matched += n;
      total.heat += temperature * n;
      total.bins[i === -1 ? bins.length : i] += n;
    }
    if (body.rank && district && Number.isFinite(weights[group])) {
      const total = byDistrict.get(district) ?? { count: 0, matched: 0, heat: 0 };
      const n = weights[group];
      total.count += n;
      if (Number.isFinite(temperature)) {
        total.matched += n;
        total.heat += temperature * n;
      }
      byDistrict.set(district, total);
    }
  }
  if (!matched) return problem("empty", "This area has no Census population cells matched to clear Landsat values.");
  const format = n => Number(n.toFixed(2));
  const groups = Object.fromEntries(Object.entries(totals).map(([key, t]) => [key, {
    label: labels[key], count: Math.round(t.count), matched: Math.round(t.matched), mean: t.matched ? format(t.heat / t.matched) : null,
    coverage: t.count ? t.matched / t.count : null, atLeast45: t.matched ? Math.round(t.bins.at(-1)) : null,
  }]));
  const a = totals[group], b = totals[reference], compared = a.matched && b.matched;
  const delta = compared ? format(a.heat / a.matched - b.heat / b.matched) : null;
  const place = bounds ? "the selected area" : city.adminName;
  const bandLabels = ["<" + bins[0], ...bins.slice(1).map((end, i) => bins[i] + "–" + end), "≥" + bins.at(-1)];
  const ranked = body.rank ? [...byDistrict].filter(([, total]) => total.matched > 0)
    .map(([code, total]) => ({
      code, name: city.census.districts[code], mean: format(total.heat / total.matched),
      matched: Math.round(total.matched), coverage: total.matched / total.count,
    })).sort((a, b) => (body.rankOrder === "asc" ? a.mean - b.mean : b.mean - a.mean) || a.name.localeCompare(b.name)) : null;
  return { ok: true, status: "complete",
    reply: ranked?.length ? ranked[0].name + " had the " + (body.rankOrder === "asc" ? "lowest" : "highest") +
      " matched residential LST for " + labels[group].toLowerCase() + " (" + valueLabel(ranked[0].mean) + ")." :
      ranked ? "No districts have matched residents for this group." :
      compared ? "In " + place + ", matched residential LST was " + valueLabel(groups[group].mean) + " for " +
      labels[group].toLowerCase() + " and " + valueLabel(groups[reference].mean) + " for " + labels[reference].toLowerCase() +
      ". First minus second: " + valueLabel(delta) + "." : "At least one selected group has no matched residents in this area.",
    event: {
      kind: "population", place, timeUtc: snapshot.datetime, inCore: snapshot.inCore, censusYear: city.census.year,
      censusSource: city.census.source, areaUnit: "allocated population cells", areas: rows.length, matched, groups, group, reference, delta,
      ranked, rankOrder: body.rankOrder,
      mapLayers: [["residents", "Surface LST"], ...Object.keys(labels).filter(key => key !== "all").map(key => [
        key, ({ older: "65+ share", limited: "Disability share", poverty: "Poverty share" })[key] ?? labels[key],
      ])],
      distribution: bandLabels.map((label, i) => ({ label, ...Object.fromEntries(Object.entries(totals).map(([key, t]) =>
        [key, t.matched ? t.bins[i] / t.matched : null])) })),
      metricTiles: residentialTiles(rows, city.center[1]),
      method: city.census.method + " " + city.census.source + ". Match allocated residents to QA-screened Landsat LST on the dated overpass.",
    },
  };
}

export async function analyzeArchive(body, progress, read, readAdmin) {
  const data = await loadArchive(body.archiveCase, read);
  if (!data) return problem("clarify", "Choose a city and an event from the case archive.");
  const { kind, bounds } = body;
  if (bounds != null && !validBounds(bounds)) return problem("clarify", "Draw a rectangle with valid coordinates.");
  const catalog = await readAdmin("catalog.json");
  const city = catalog.cities[data.region], event = city.events[data.event];
  const model = event.weather?.[body.model === "era5" ? "era5" : "land"];
  const availableDays = new Set([...(model?.daily ?? []), ...(data.point?.daily ?? []), ...(data.weather?.daily ?? [])].map(row => row.date));
  if (["station", "weather"].includes(kind) && body.date != null && !availableDays.has(body.date)) return problem("clarify", "Choose a UTC date from this event.");
  const date = body.date ?? data.peak;
  switch (kind) {
    case "exposure":
    case "shade": {
      const cityModel = catalog.cityStreetModels?.[data.region]?.[data.event];
      if (cityModel && body.coverage !== "pilot") return analyzeCityStreet(body, cityModel, city, progress, readAdmin);
      if (body.coverage === "city") return problem("unavailable", "Full city radiation inputs are unavailable for this event. Use the outlined model coverage.");
      const models = catalog.streetModels?.[data.region];
      const pilot = models?.[data.event];
      if (!pilot) return unavailable(data, kind, Object.keys(models ?? {}).length ?
        "Choose a case with a modelled walking network to use this analysis." : "Available satellite and regional weather layers cannot fill these inputs.");
      const selection = bounds ?? pilot.bounds;
      if (!matchesSnapshot(pilot.timeUtc, body.date, body.time)) return problem("unavailable", pilot.label + " covers " + dateLabel(pilot.timeUtc) + " only.");
      progress("Loading " + pilot.label + " · " + dateLabel(pilot.timeUtc) + "…");
      const samples = await readAdmin(pilot.file, "packed-json");
      progress("Computing UTCI from modelled radiation and event-hour weather…");
      const grid = evaluateStreetGrid(samples, pilot.weather, (lon, lat) => inside(lon, lat, selection));
      if (kind === "shade") return analyzeShade({ bounds: selection, shadePercent: body.shadePercent ?? 25,
        timeUtc: pilot.timeUtc, place: pilot.label, source: pilot.source,
        coverage: { cells: grid.rows.length, pathM: grid.rows.reduce((sum, row) => sum + row[3], 0), city: false },
      }, progress, () => grid.pairs);
      progress("Weighting pedestrian UTCI by walking length in the selection…");
      const summary = summarize(grid.rows, selection);
      if (!summary) return problem("empty", "No modelled walking-network cells in this selection. Move the selection into the outlined pilot.");
      return { ok: true, status: "complete",
        reply: pilot.label + " · " + dateLabel(pilot.timeUtc) + ": walking-length-weighted UTCI was " + valueLabel(summary.meanUtci) +
          " across " + summary.cellCount + " cells. " + share(summary.strongHeat.pathLengthShare) +
          " of represented walking length was in cells at or above 32°C UTCI.",
        analysis: { ...summary, bounds: selection, scope: "pilot", timeUtc: pilot.timeUtc,
          method: method + " UTCI is evaluated from stored 5 m SOLWEIG mean radiant temperatures and event-hour weather, then aggregated for the selection.",
          source: pilot.engine + " · " + pilot.source, features: streetFeatures(grid.rows, city.name) } };
    }
    case "station": {
      if (!data.stations.length) return unavailable(data, "station");
      const first = body.station ? data.stations.find(item => item.id === body.station) : data.stations[0];
      const second = body.comparison && data.stations.find(item => item.id === body.comparison && item.id !== first?.id);
      if (!first) return problem("clarify", "Choose a station from the selected case.");
      if (body.compare && !second) return unavailable(data, "stationPair");
      progress("Loading quality-screened NOAA ISD observations…");
      const scoped = rows => body.stationPeriod === "day" ? rows.filter(row => row[0].startsWith(date)) : rows;
      const observations = scoped(first.rows);
      const byTime = second ? new Map(scoped(second.rows).map(row => [row[0], row[1]])) : null;
      const rows = observations.filter(row => !byTime || byTime.has(row[0])).map(row => [row[0], row[1], byTime?.get(row[0])]);
      if (!rows.length) return unavailable(data, byTime ? "stationPair" : "station", "Try the full event or another UTC day.");
      progress(second ? "Comparing matched UTC observations…" : "Summarising the observed air-temperature series…");
      const peak = rows.reduce((a, b) => b[1] > a[1] ? b : a);
      const mean = rows.reduce((sum, row) => sum + row[1], 0) / rows.length;
      const difference = second ? rows.reduce((sum, row) => sum + row[1] - row[2], 0) / rows.length : null;
      const reply = second ? first.name + " minus " + second.name + " averaged " + valueLabel(difference) + " across " + rows.length + " matched observations." :
        first.name + " peaked at " + valueLabel(peak[1]) + " on " + dateLabel(peak[0]) + " across " + rows.length + " archived readings.";
      return complete(data, "archive-station", reply, { names: [first.name, second?.name].filter(Boolean), rows, date,
        mean, peak: { temperature: peak[1], time: peak[0] }, difference, count: rows.length,
        method: "NOAA Global Hourly (ISD) station air temperature. Exact UTC matches only. Coverage and instrument siting vary; observed station peaks are distinct from gridded daily maxima." });
    }
    case "weather": {
      const day = model?.daily.find(row => row.date === date);
      const point = data.point?.daily.find(row => row.date === date);
      if (!day && !point) return problem("unavailable", scope(data) + " is missing weather observations or model output for " + date + ".");
      progress("Reading the archived model and reference-point data…");
      const reply = Number.isFinite(day?.values[0]) ? "On " + date + " UTC, the " + city.adminName + " regional model estimate had a population-weighted daily maximum of " +
        valueLabel(day.values[0]) + " (" + share(day.match) + " population matched; " + model.source + ")." :
        point ? "On " + date + " UTC, the reference grid point had a daily maximum of " + valueLabel(point.tmax) +
        ". No matched citywide weather estimate is available for this day." : "No matched regional weather cells inside the boundary on " + date + ".";
      return complete(data, "archive-weather", reply, { date, air: day, source: model?.source, point, summary: data.point?.summary,
        method: "Regional air-temperature context weights valid model cells by GHS-POP 2020 centres within the administrative boundary. Climate normals and P90 refer to the single archived reference grid point." });
    }
    case "population":
    case "groups": {
      const snapshot = event.snapshot;
      if (!snapshot) return unavailable(data, "population");
      if (!matchesSnapshot(snapshot.datetime, body.date, body.time)) {
        return problem("unavailable", "The archived Landsat overpass is " + dateLabel(snapshot.datetime) + ". There is no matched residential LST at the requested time.");
      }
      if (kind === "groups") {
        if (!city.census || !snapshot.census) return unavailable(data, "groups");
        if (data.region === "London" && snapshot.census.file) {
          const result = await analyzePopulation({ ...body, timeUtc: snapshot.datetime }, progress, () => readAdmin(snapshot.census.file, "packed-json"));
          if (result.ok) result.event.inCore = snapshot.inCore;
          return result;
        }
        if (!city.census.file) return unavailable(data, "groups");
        if (body.rank && (!city.census.districts || bounds) || body.borough) {
          return problem("clarify", city.census.districts ? "Choose the full city to rank districts." :
            "District group rankings are unavailable for this city. Compare groups for the city or a drawn area.");
        }
        progress("Applying census group counts to the matched residential grid…");
        const [points, temperatures, census] = await Promise.all([readAdmin(city.population, "packed-json"),
          readAdmin(snapshot.surface, "packed-json"), readAdmin(city.census.file, "packed-json")]);
        return compareResidents(city, snapshot, points, temperatures, census, bounds, body, catalog.comparison.bins);
      }
      progress("Matching GHS-POP 100 m residential cells to clear Landsat pixels…");
      const [points, temps] = await Promise.all([readAdmin(city.population, "packed-json"), readAdmin(snapshot.surface, "packed-json")]);
      if (temps.length !== points.length) throw new Error("Population and surface arrays differ");
      progress("Calculating the population-weighted surface heat and distribution…");
      const surface = populationSummary(points, temps, bounds, catalog.comparison);
      if (!Number.isFinite(surface.mean)) return problem("empty", "No residential cells in this area match valid Landsat temperatures. Try the full administrative area or a different event.");
      return complete(data, "archive-population", (bounds ? "In the drawn part of " : "In ") + city.adminName + ", the " +
        dateLabel(snapshot.datetime) + " Landsat snapshot averaged " + valueLabel(surface.mean) + " across matched residents (" + share(surface.match) +
        " of the estimated residential population)." + (snapshot.inCore ? "" : " This snapshot falls outside the heatwave core."), {
        surface, bins: catalog.comparison.bins, timeUtc: snapshot.datetime, inCore: snapshot.inCore, bounds, place: city.adminName,
        metricTiles: residentialTiles(matchedPoints(points, temps, bounds), city.center[1]),
        method: "Sample quality-screened Landsat LST at the centres of native 100 m GHS-POP 2020 cells inside the boundary and any drawn selection. Divide the sum of LST × estimated residents by matched residents. Coverage includes all resident estimates in the denominator. The estimate describes surface heat near homes, not air temperature, actual activity or health outcomes.",
      });
    }
    default: return problem("clarify", "Choose weather, station observations, population, pedestrian heat or shade.");
  }
}

export async function archiveChat(body, progress, read, run, normalChat) {
  const { message, archiveCase } = body;
  if (typeof message !== "string" || !message.trim() || message.length > 1000) return problem("clarify", "Enter a question about the selected historical case.");
  const data = await loadArchive(archiveCase, read);
  if (!data) return problem("clarify", "Choose a city and event from the case archive.");
  const query = message.normalize("NFKC").toLowerCase();
  const dispatch = (type, extra, reply = "") => ({ ok: true, status: "complete", provider: "local", reply, action: { type, ...extra } });
  if (/\b(?:forecast|tomorrow|current weather|health risks?|heat risks?|deaths?|flood\w*|coolest route|hourly utci)\b|预报|明天|死亡|洪水|最凉路线|高温风险|健康风险/.test(query)) {
    return { ...problem("unsupported", "This historical case does not contain forecasts, health outcomes, flood data or route routing."), provider: "local" };
  }
  const { cities } = await read("catalog.json", "json");
  const names = { London: "伦敦", Paris: "巴黎", Brussels_Uccle: "布鲁塞尔", Amsterdam: "阿姆斯特丹",
    Lille: "里尔", DeBilt: "德比尔特", Portland: "波特兰", Seattle: "西雅图" };
  const mentions = cities.filter(city => query.includes(city.name.toLowerCase()) ||
    query.includes(city.id.toLowerCase()) || query.includes(names[city.id]) ||
    city.id === "Brussels_Uccle" && /\b(?:brussels|uccle)\b/.test(query));
  if ((mentions.length >= 2 && /\b(?:compar\w*|versus|vs)\b|比较|对比/.test(query)) ||
      /\b(?:compare events|compare cities|compare regions|regional comparison|global city comparison)\b|跨城比较/.test(query) ||
      /\b(?:global view|globe|global (?:heat|map)|global era5)\b|全球视图|回到地球/.test(query)) {
    return normalChat(body);
  }
  const requested = requestTime(query, data.peak.slice(0, 4));
  if (requested.invalid) return { ...problem("clarify", "Enter a valid date and time in UTC."), provider: "local" };
  const { date: explicitDate, explicitYear, time } = requested;
  if (mentions.length === 1 && /\b(?:fly|go to|navigate|open .*case|locate)\b|切换城市|飞到/.test(query)) {
    const city = mentions[0];
    const records = city.cases.filter(item => explicitYear && item.peak.startsWith(explicitYear));
    const record = /\b(?:aug(?:ust)?)\b|8\s*月/.test(query) ?
      records.find(item => item.peak.slice(5, 7) === "08") ?? records[0] :
      records.find(item => !item.pointOnly) ?? records[0];
    if (explicitYear && !record) return { ...problem("unavailable", city.name + " has no archived case for " + explicitYear + "."), provider: "local" };
    const event = record?.id;
    return dispatch("open-case", { region: city.id, event }, "Opening the " + city.name + " case.");
  }
  if (mentions.some(city => city.id !== data.region)) {
    return { ...problem("clarify", "Select that study area in Single city case, or ask for a comparison between two named study areas."), provider: "local" };
  }
  if (explicitYear && !data.peak.startsWith(explicitYear)) {
    return { ...problem("clarify", "The selected case is " + scope(data) + ". Choose a " + explicitYear + " event to analyse that year."), provider: "local" };
  }
  const date = explicitDate ?? body.date;
  const view = viewIntent(query);
  if (view) return dispatch("view", { view }, "Switching the grid to " + (view === "bars" ? "3D bars." : "flat view."));
  if (/^(?:show|open|go to|set (?:the )?date to|play|显示|查看)?\s*(?:on\s+)?(?:\d{4}-\d{2}-\d{2}|\d{1,2}\s+[a-z]+(?:\s+\d{4})?|[a-z]+\s+\d{1,2}(?:\s+\d{4})?|(?:\d{4}年)?\d{1,2}月\d{1,2}(?:日|号))[.?!？ ]*$/.test(query) && explicitDate) {
    if (explicitDate < data.start || explicitDate > data.end) return { ...problem("unavailable", "That date is outside the selected case."), provider: "local" };
    return dispatch("archive-day", { date: explicitDate }, "Showing the weather timeline for " + explicitDate + " UTC.");
  }
  const groupPatterns = [
    ["older", /\b(?:older residents|aged 65|65\+|age group|seniors?)\b|老年|年龄|65岁/],
    ["limited", /\b(?:disab\w*|activity limit\w*|limited activities)\b|活动受限|残疾/],
    ["poverty", /\b(?:poverty|low income)\b|贫困|低收入/],
    ["leastDeprived", /\b(?:least deprived|imd (?:deciles )?9)\b/],
    ["deprived", /\b(?:most deprived|imd (?:deciles )?1|deprivation)\b|剥夺/],
    ["all", /\b(?:all(?: usual)? residents|all residents|general population)\b|全体居民/],
  ];
  const namedGroups = groupPatterns.flatMap(([key, pattern]) => {
    const match = query.match(pattern);
    return match ? [[key, match.index]] : [];
  }).sort((a, b) => a[1] - b[1]).map(([key]) => key);
  const rank = /\b(?:boroughs?|districts?)\b|行政区/.test(query) && /\b(?:rank\w*|highest|lowest|hottest|coolest|which)\b|排名|最高|最低/.test(query);
  const groups = namedGroups.some(group => group !== "all") || rank || /\b(?:subgroups?|resident groups|vulnerable (?:people|groups?))\b|脆弱人群/.test(query);
  const show = /\b(?:show|open|switch|display|layer|map)\b|显示|打开|切换|图层/.test(query);
  const stationRequest = /\b(?:stations?|noaa|isd|hourly observations?)\b|气象站|站点/.test(query);
  const compare = /\b(?:compar\w*|versus|another station|other station)\b|比较|对比/.test(query);
  const followUp = /\b(?:what does|what do|tell me|explain|analys\w*|interpret|compar\w*|peak|warmest|summary)\b|说明|分析|解释|比较|最高/.test(query);
  const shadePercentText = query.match(/(-?\d+(?:\.\d+)?)\s*(?:%|percent|per cent)/)?.[1];
  const methodRequest = /\b(?:method|formula|how (?:is|was|do you).*(?:calculat|comput)\w*)\b|计算方法|怎么算/.test(query);
  if (methodRequest) {
    const reply = [
      "The case distinguishes UTC station observations, coarse regional air temperature and dated Landsat surface temperature.",
      "Match clear Landsat LST at GHS-POP 2020 cell centres and weight by estimated residents. Coverage is the fraction of estimated residents with valid temperatures.",
      method + " Use archived SOLWEIG radiation and weather for the selected event time.",
      "Apply the modelled building-shade UTCI to the selected fraction of sunlit path length within each paired cell. Keep event weather and all other paths fixed.",
    ][body.chapter - 1] ?? method;
    return dispatch("method", {}, reply);
  }
  let kind;
  if (/\b(?:shade|shading|shaded)\b|遮荫|遮阴/.test(query) || body.chapter === 4 && shadePercentText !== undefined) kind = "shade";
  else if (groups) kind = "groups";
  else if ((stationRequest || body.layer === "case-noaa" && body.station) && followUp) kind = "station";
  const alias = [
    ["mndwi", /\bmndwi\b/], ["ndwi", /\bndwi\b/], ["ndvi", /\bndvi\b|植被指数/],
    ["lst_c", /\b(?:landsat|lst|surface temperature)\b|地表温度/],
    ["landcover", /\b(?:land[ -]?cover|worldcover)\b|土地覆盖/],
    ["elevation", /\b(?:elevation|terrain|dsm)\b|高程|地形/],
    ["population_count_100m", /\b(?:population|ghs.pop)\b|人口/],
    ["noaa", /\b(?:noaa|stations?|isd)\b|站点/],
    ["air-max", /\b(?:era5.land|air temperature|daily max)\b|气温/],
  ].find(([, pattern]) => pattern.test(query))?.[0];
  if (!kind && show && !alias && /\butci\b/.test(query) && !/\b(?:calculat\w*|analys\w*|comput\w*|in my|in this)\b/.test(query)) {
    return dispatch("archive-layer", { layer: "case-utci", date: explicitDate, time });
  }
  if (!kind && show && alias) {
    const satellite = ["lst_c", "ndvi", "ndwi", "mndwi"].includes(alias);
    if ((explicitDate || time) && satellite && (!data.satellite || !matchesSnapshot(data.satellite.datetime, explicitDate, time))) {
      return { ...problem("unavailable", "This case has no " + alias + " snapshot at the requested time." +
        (data.satellite ? " The archived Landsat overpass is " + dateLabel(data.satellite.datetime) + "." : "")), provider: "local" };
    }
    if (time && !satellite) return { ...problem("clarify", "This map layer is static or uses daily values. Choose a UTC day rather than an hour."), provider: "local" };
    return dispatch("archive-layer", { layer: alias, date: ["air-max", "noaa"].includes(alias) ? explicitDate : undefined });
  }
  if (!kind && (/\b(?:utci|pedestrian heat|walking heat|thermal stress)\b|行人热|街道热|步行热/.test(query) ||
    body.chapter === 3 && /\b(?:heat|exposure|hotspots?)\b|暴露|热点/.test(query))) kind = "exposure";
  if (!kind && /\b(?:population|expos\w*|residents?)\b|人口|暴露/.test(query)) kind = "population";
  if (!kind && /\b(?:weather|temperature|heatwave|anomal\w*|p90)\b|气温|气象|热浪/.test(query)) kind = "weather";
  if (!kind) return { ...problem("clarify", "Try opening LST, analysing station weather, or calculating population exposure for the selected case."), provider: "local" };
  const areaKind = ["shade", "exposure", "population", "groups"].includes(kind);
  const full = /\b(?:full|entire|whole|citywide|all of|study area|administrative area|model coverage|whole pilot)\b|全城|全市|全域|整个|完整样区/.test(query);
  const selected = /\b(?:my selection|selected area|selected rectangle|drawn area|this (?:area|selection|rectangle)|here)\b|选区|框选|这里|这个区域/.test(query);
  if (areaKind && selected && !full && !validBounds(body.bounds)) {
    return { ...problem("clarify", "Draw an area first, or ask for the full available area."), provider: "local" };
  }
  if (kind === "station" && compare && !body.comparison) {
    return { ...problem("clarify", "Choose a second NOAA station in the analysis panel to compare matching UTC hours."), provider: "local" };
  }
  if (time && !areaKind) return { ...problem("clarify", "Choose a UTC day or full event. The station chart shows available hours within that period."), provider: "local" };
  const shadePercent = kind === "shade" ? Number(shadePercentText ?? body.shadePercent ?? 25) : undefined;
  const request = { kind, archiveCase, date: areaKind ? explicitDate : date, time,
    model: body.model, station: body.station, comparison: body.comparison, shadePercent,
    compare: kind === "station" && compare, stationPeriod: kind === "station" && explicitDate ? "day" : body.stationPeriod,
    scope: areaKind && (full || rank) ? "full" : undefined, bounds: areaKind && !full && !rank ? body.bounds : undefined,
    ...(["shade", "exposure"].includes(kind) && /\b(?:whole (?:city|municipality)|citywide|entire city|full city|administrative area)\b|全市|全城|全域/.test(query)
      ? { coverage: "city" } : {}),
    ...(kind === "groups" ? { group: namedGroups[0] ?? body.group, reference: namedGroups[1] ??
      (namedGroups[0] === "all" ? "older" : namedGroups.length ? "all" : body.reference), rank,
      rankOrder: /\b(?:lowest|coolest)\b|最低/.test(query) ? "asc" : "desc" } : {}),
  };
  if (body.dispatch) return dispatch("run-archive", request);
  return { ...(await run(request, progress)), provider: "local" };
}
