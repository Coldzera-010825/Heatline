import { method, validBounds } from "./analysis.mjs";
import { districts, populationGroups } from "./london-population.mjs";
import { matchesSnapshot, requestTime, viewIntent } from "./request-time.mjs";

const layers = ["era5", "lst", "wow", "ndvi", "ndwi", "elevation", "landcover", "utci"];
const actions = ["exposure", "station", "population", "shade", "risk", "navigate", "globe", "layer", "day", "view", "method", "regional", "unsupported", "clarify"];
const scopes = ["selected", "london"];
const eventIds = ["E1_2019-07", "E2_2020-08", "G1_2021-06", "E3_2022-07", "E4_2025-06", "E5_2026-06"];
const regions = {
  London: /\blondon\b|伦敦/, Paris: /\bparis\b|巴黎/, Brussels_Uccle: /\b(?:brussels|uccle)\b|布鲁塞尔/,
  Amsterdam: /\bamsterdam\b|阿姆斯特丹/, Lille: /\blille\b|里尔/, Utrecht: /\butrecht\b|\bde\s*bilt\b|乌得勒支|德比尔特/,
  Portland: /\bportland\b|波特兰/, Seattle: /\bseattle\b|西雅图/,
};
const availability = "Open one of the eight archived city cases. Compare cities uses population-weighted Landsat surface temperature. Pedestrian UTCI and shade require modelled coverage for the selected city and date.";
const instructions = [
  "Use heatline_action to route one action. Supported analyses are London pedestrian UTCI, WOW station weather, Census residential LST, and a paired shade scenario.",
  "Use layer to show era5, lst, wow, ndvi, ndwi, elevation, landcover, or utci. Use view to switch the active grid between flat and bars. Navigate opens London, globe opens global ERA5-Land.",
  "Day is a UTC day from 13 through 19 July 2022 for ERA5-Land or WOW. The LST, population, UTCI and shade results are a single 18 July snapshot.",
  "Exposure requires the existing map selection or an explicit request for the London study area. Never infer a named district polygon. Station requires the selected WOW station. Use compare true if the user requests a second station.",
  "Shade accepts an optional percentage of sunlit route length. Population compares all, older (65+), limited (day-to-day activities limited), deprived (IMD 1–2), and leastDeprived (IMD 9–10). For district results supply its LAD code; set rank true only for rankings across districts.",
  "Regional compares residential Landsat surface heat or same-time street pilot UTCI within one archived event. ERA5 is regional context. Use individual city cases for shade or subgroup analyses.",
  "Use risk for clinical risk requests, unsupported for forecasts, unavailable metrics or locations, rainfall or routing, and clarify for ambiguity.",
].join(" ");

const groupPatterns = [
  ["leastDeprived", /\bleast deprived\b|\bimd\s*(?:deciles?\s*)?9\s*(?:[-–]|to|and)\s*10\b|剥夺程度最低|最不贫困/],
  ["deprived", /\bmost deprived\b|\bhigh deprivation\b|\bimd\s*(?:deciles?\s*)?1\s*(?:[-–]|to|and)\s*2\b|\bdeprived (?:areas?|neighbou?rhoods?|communities)\b|剥夺程度最高|最贫困/],
  ["older", /\b(?:65\s*(?:\+|and over|or older|and older)|elderly|older (?:residents|people|adults))|老年|65\s*岁/],
  ["limited", /\b(?:activit\w* limit\w*|limited (?:day.to.day )?activit\w*|disab\w*)\b|活动受限|残疾/],
  ["all", /\ball (?:usual )?residents\b|\bgeneral population\b|全体居民/],
];

function knownDistricts(query) {
  return Object.entries(districts).filter(([id, name]) => {
    const normalized = query.replaceAll("&", "and");
    if (normalized.includes(id.toLowerCase()) || new RegExp("\\b" + name.toLowerCase() + "\\b").test(normalized)) return true;
    if (["Richmond upon Thames", "Kingston upon Thames"].includes(name)) {
      return new RegExp("\\b" + name.split(" ")[0].toLowerCase() + "\\b").test(normalized);
    }
    return false;
  }).map(([id]) => id);
}

function regionalIntent(query) {
  const pair = Object.entries(regions).flatMap(([region, pattern]) => {
    const match = query.match(pattern);
    return match ? [[region, match.index]] : [];
  }).sort((a, b) => a[1] - b[1]).map(([region]) => region);
  const explicit = /\b(?:compare events|event comparison|regional comparison|compare regions|compare cities|global city comparison)\b|事件对比|跨城比较/.test(query);
  if (!explicit && !(pair.length >= 2 && /\b(?:compar\w*|versus|vs\.?|difference)\b|比较|对比/.test(query))) return;
  const street = /\b(?:utci|pedestrian|street heat|walking heat|thermal stress)\b|步行热|行人热|街道热/.test(query);
  if (pair.length > 2 || /\b(?:shade|air temperature|era5(?:-land)?|age[sd]? 65|deprivation|borough|elderly|older residents|health risk|heat risk|cooling centres?)\b|气温|遮荫|老年|高温风险/.test(query)) {
    return { action: "clarify", reply: "Compare cities supports residential Landsat surface heat and same-time street pilot UTCI. Shade scenarios and subgroup analysis are available in individual city cases where the inputs exist." };
  }
  if (pair.length === 1) return { action: "clarify", reply: "Name a second city to compare in the same event." };
  const years = [...new Set(query.match(/\b(?:19|20)\d{2}\b/g) ?? [])];
  const year = years[0] ?? (pair.some(region => ["Portland", "Seattle"].includes(region)) ? "2021" : street ? "2022" : "2020");
  const event = eventIds.find(id => id.includes(year));
  const northwest = pair.filter(region => ["Portland", "Seattle"].includes(region)).length;
  if (!event || years.length > 1 || (year !== "2021" && northwest) || (year === "2021" && northwest !== pair.length)) {
    return { action: "clarify", reply: "Choose two study areas covered by the same archived event. Portland and Seattle share the June 2021 heat dome; the European areas share the European events." };
  }
  const requested = requestTime(query, year);
  if (requested.invalid) return { action: "clarify", reply: "Enter a valid date and time in UTC." };
  return { action: "regional", event, firstRegion: pair[0], secondRegion: pair[1], metric: street ? "street" : "surface",
    date: requested.date, time: requested.time };
}

function localIntent(message, context) {
  const query = message.normalize("NFKC").toLowerCase();
  const london = /\blondon\b|伦敦/.test(query);
  const datedQuery = query.replace(/\bimd\s*2025\b/g, "");
  const year = datedQuery.match(/\b(?:19|20)\d{2}\b/g) ?? [];
  const requested = requestTime(datedQuery, "2022");
  const { date, day, time } = requested;
  if (/\b(?:forecast|tomorrow|today|next week|current weather|flooding|rainfall|coolest route|hourly utci|berlin|tokyo|new york)\b|预报|明天|洪涝|最凉路线|东京/.test(query)) {
    return { action: "unsupported", strict: true };
  }
  const regional = regionalIntent(query);
  if (regional) return { ...regional, strict: true };
  if (requested.invalid) return { action: "clarify", strict: true, reply: "Enter a valid date and time in UTC." };
  const namedCities = Object.entries(regions).filter(([, pattern]) => pattern.test(query));
  if (namedCities.length === 1 && /\b(?:open|fly|go to|navigate|locate|take me to|zoom to)\b|切换城市|定位|飞到/.test(query) &&
      !/\b(?:layer|lst|land cover|worldcover|era5|ndvi|ndwi|station)\b/.test(query)) {
    const [region] = namedCities[0];
    const event = eventIds.find(id => year[0] && id.includes(year[0]));
    const nw = region === "Seattle" || region === "Portland";
    const pointYear = !nw && ["2018", "2026"].includes(year[0]);
    if (year.length && (!event && !pointYear || event && (event === "G1_2021-06") !== nw)) {
      return { action: "clarify", strict: true, reply: "No archived event for that city and year. Open the city case to see the available dates." };
    }
    const requestedEvent = year[0] === "2018" ? "X1_2018-07" :
      year[0] === "2026" && /\b(?:aug(?:ust)?)\b|8\s*月/.test(query) ? "X2_2026-07" : event;
    return { action: "open-case", region, event: requestedEvent, strict: true };
  }
  if (year.some(value => value !== "2022") ||
      (date && (requested.month !== 7 || day < 13 || day > 19)) ||
      Object.entries(regions).some(([id, pattern]) => id !== "London" && pattern.test(query))) {
    return { action: "unsupported", strict: true };
  }
  if (/\b(?:method|formula|how (?:is|was|do you).*(?:calculat|comput)\w*)\b|计算方法|怎么算/.test(query)) return { action: "method" };
  const view = viewIntent(query);
  if (view) return { action: "view", view, strict: true };
  const snapshot = "2022-07-18T10:52:15Z";
  const sameSnapshot = matchesSnapshot(snapshot, date, time);
  const snapshotUnavailable = { action: "clarify", strict: true, reply: "This analysis uses the 18 July 2022 snapshot at 10:52 UTC. Choose that time or ask without a time." };
  const hourlyUnavailable = { action: "clarify", strict: true, reply: "Choose a UTC day or full event. This command does not select a particular hour." };
  if (london && /\b(?:take me|zoom|navigate|locate|fly|go to|show me london)\b|定位|飞到/.test(query) &&
      !/\b(?:lst|landsat|wow|station|ndvi|ndwi|utci|land cover|layer|analysis)\b|地表温度|图层/.test(query)) {
    return { action: "navigate" };
  }
  const selected = /\b(?:here|this area|this region|selected area|highlighted area|current area|selection|drawn area|selected rectangle)\b|选区|框选|这里|这个区域/.test(query);
  const districtIds = knownDistricts(query);
  const districtQuery = /\b(?:boroughs?|districts?|lad)\b|行政区|哪个区|各区/.test(query);
  const cooling = /\b(?:cool(?:ing)? (?:cent(?:re|er)s?|spaces?|shelters?)|where.*(?:install|build|place|locate).*(?:cool|shade))\b|避暑点|降温点/.test(query);
  const clinical = /\b(?:health risks?|deaths?|hospitali[sz]ations?|mortality|(?:heat|high[- ]temperature) risks?)\b|健康风险|死亡|高温风险|热风险/.test(query);
  if (clinical && !/\b(?:utci|walking heat|street)\b|行人|街道/.test(query)) return { action: "risk", strict: true };
  const namedGroups = groupPatterns.flatMap(([group, pattern]) => {
    const match = query.match(pattern);
    return match ? [[group, match.index]] : [];
  }).sort((a, b) => a[1] - b[1]).map(([group]) => group);
  const populationQuery = namedGroups.length || /\b(?:population|residents?|demograph\w*|census|inequalit\w*|imd)\b|人口|居民|人群|不平等/.test(query);
  const surface = /\b(?:lst|landsat|(?:land )?surface temperatures?|residential heat)\b|地表温度/.test(query);
  const ranking = districtQuery && /\b(?:rank\w*|highest|lowest|hottest|coolest|top|warmest|coldest|which)\b|最高|最低|排名|哪个/.test(query);
  const shadeRequest = /\b(?:shade|shading|shaded)\b|遮[荫阴]|树荫/.test(query) && /\b(?:what if|add|increase|convert|scenario)\b|情景|增加|模拟/.test(query);
  if ((populationQuery && !shadeRequest) || ((districtQuery || districtIds.length) && surface) || (ranking && context.chapter === 2)) {
    if (!sameSnapshot) return snapshotUnavailable;
    if (/\b(?:air temperature|utci|walking heat|pregnan\w*|children|income group)\b|空气温度|气温|行人|儿童/.test(query) || namedGroups.length > 2) {
      return { action: "clarify", strict: true, reply: "London population comparison uses 18 July residential LST for age 65+, activity limitation and IMD groups. Choose one or two supported groups." };
    }
    if (districtIds.length > 1 || districtQuery && !ranking && !districtIds.length) {
      return { action: "clarify", strict: true, reply: "Name one London district, or ask to rank all London districts for a group." };
    }
    if (ranking && /\b(?:gap|difference|increase|change)\b|差值|差异最大/.test(query)) {
      return { action: "clarify", strict: true, reply: "The district ranking orders the selected group’s mean residential LST. To see a group difference, name a district and two groups." };
    }
    const group = namedGroups[0] ?? (ranking ? "all" : "older");
    const reference = namedGroups[1] ?? (group === "all" ? "older" : group === "deprived" ? "leastDeprived" : "all");
    return { action: "population", scope: selected && !ranking && !districtIds.length ? "selected" : "london",
      group, reference, borough: ranking ? undefined : districtIds[0], rank: ranking, rankOrder: /\b(?:lowest|coolest|coldest)\b|最低/.test(query) ? "asc" : "desc",
      scopeNote: cooling ? "cooling" : undefined, strict: Boolean(districtQuery || districtIds.length || cooling) };
  }
  if (cooling) return { action: "clarify", strict: true, reply: "This archive cannot recommend cooling-centre locations; that needs facility and access data." };
  if (/\b(?:era5(?:-land)?|global(?: view| heat| map)?|globe)\b|全球|地球/.test(query)) return time ? hourlyUnavailable : { action: "globe", day };
  const layerAliases = [
    ["lst", /\b(?:landsat|lst|land surface temperatures?|surface temperatures?)\b|地表温度/],
    ["ndvi", /\b(?:ndvi|vegetation index|greenness)\b|植被指数/],
    ["ndwi", /\b(?:ndwi|water index)\b|水体指数/],
    ["elevation", /\b(?:elevation|terrain|dem|nasadem)\b|高程|地形/],
    ["landcover", /\b(?:land[ -]?cover|worldcover)\b|土地覆盖/],
  ];
  const layer = layerAliases.find(([, pattern]) => pattern.test(query))?.[0];
  if (layer && (layer !== "lst" || !/\b(?:population|residents?|ages?|census|65)\b|人口|人群|居民/.test(query))) {
    if (["lst", "ndwi"].includes(layer) && !sameSnapshot) return snapshotUnavailable;
    if (time && !["lst", "ndwi"].includes(layer)) return hourlyUnavailable;
    return { action: "layer", layer };
  }

  const compare = /\b(?:compar\w*|versus|other stations?|another station|difference between)\b|比较|对比/.test(query);
  const station = /\b(?:wow|station|observations?|humidity|dew ?point|wind speed)\b|站点|湿度|风速/.test(query);
  const followUp = /\b(?:what does|what do|tell me|explain|analyse|analyze|interpret|compare)\b|说明|分析|解释|比较/.test(query);
  if (station || (context.layer === "wow" && followUp && context.station)) {
    if (time) return hourlyUnavailable;
    if (compare || followUp || /\b(?:peak|warmer|weather features)\b|最高|特征/.test(query)) return { action: "station", compare, day };
    return { action: "layer", layer: "wow", day };
  }

  const full = /\b(?:full|entire|all of|citywide|greater london|study area|administrative area|all london)\b|全市|全城|全伦敦|研究区/.test(query);
  const district = districtIds.length || /\b(?:kensington|covent garden|holborn|bloomsbury)\b/.test(query);
  if (district && !selected) return { action: "clarify" };
  const scope = full ? "london" : "selected";
  const shadePercent = query.match(/(-?\d+(?:\.\d+)?)\s*(?:%|percent|per cent)/)?.[1];
  const shade = /\b(?:shade|shading|shade scenario|shaded)\b|遮[荫阴]|树荫/.test(query) ||
    (context.chapter === 4 && shadePercent !== undefined);
  if (shade && (shadePercent !== undefined || context.chapter === 4 ||
      /\b(?:scenario|what if|add|convert|increase|intervention|pilot)\b|情景|增加|模拟|样区/.test(query))) {
    return !sameSnapshot ? snapshotUnavailable :
      { action: "shade", scope: selected ? "selected" : (full ? "london" : undefined), shadePercent: shadePercent === undefined ? undefined : Number(shadePercent) };
  }
  const risk = /\b(?:heat|high[- ]temperature) risks?\b|高温风险|热风险/.test(query);
  const exposure = /\b(?:exposure|utci|walking heat|heat stress|pedestrian heat|hotspots?|hottest|how hot)\b|热暴露|行人热|步行热|热应激|热点/.test(query);
  if (risk && !exposure) return { action: "risk" };
  if (exposure || (context.chapter === 3 && followUp && context.hasSelection)) {
    if (!sameSnapshot) return snapshotUnavailable;
    if (/\b(?:switch|turn on|toggle|open|show)\b.*\butci\b|切换.*utci/.test(query) && !selected && !full &&
        !/\b(?:calculat\w*|analys\w*|result)\b/.test(query)) return { action: "layer", layer: "utci" };
    return { action: "exposure", scope: full || (!selected && !context.hasSelection && london) ? "london" : scope,
      requireBounds: selected && !full };
  }
  if (day !== undefined) return time ? hourlyUnavailable : { action: "day", day };
  return { action: "clarify" };
}

async function modelIntent(message, context, key, model) {
  const endpoint = "https://generativelanguage.googleapis.com/v1beta/models/" + encodeURIComponent(model) + ":generateContent";
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": key },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: instructions }] },
      contents: [{ role: "user", parts: [{ text: JSON.stringify({ message, ...context }) }] }],
      tools: [{
        functionDeclarations: [{
          name: "heatline_action",
          description: "Choose one supported Heatline tool and its arguments.",
          parameters: {
            type: "OBJECT",
            properties: {
              action: { type: "STRING", enum: actions },
              scope: { type: "STRING", enum: scopes },
              layer: { type: "STRING", enum: layers },
              view: { type: "STRING", enum: ["flat", "bars"] },
              compare: { type: "BOOLEAN" },
              day: { type: "INTEGER" },
              shadePercent: { type: "NUMBER" },
              group: { type: "STRING", enum: populationGroups },
              reference: { type: "STRING", enum: populationGroups },
              borough: { type: "STRING", enum: Object.keys(districts) },
              rank: { type: "BOOLEAN" },
              rankOrder: { type: "STRING", enum: ["asc", "desc"] },
              event: { type: "STRING", enum: eventIds },
              firstRegion: { type: "STRING", enum: Object.keys(regions) },
              secondRegion: { type: "STRING", enum: Object.keys(regions) },
            },
            required: ["action"],
          },
        }],
      }],
      toolConfig: { functionCallingConfig: { mode: "ANY", allowedFunctionNames: ["heatline_action"] } },
    }),
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) throw new Error("Gemini request failed with status " + response.status);
  const result = await response.json();
  const args = result.candidates?.[0]?.content?.parts?.find(part =>
    part.functionCall?.name === "heatline_action")?.functionCall.args;
  if (!actions.includes(args?.action) || (args.scope && !scopes.includes(args.scope)) ||
      (args.layer && !layers.includes(args.layer)) || (args.view && !["flat", "bars"].includes(args.view)) ||
      (args.group && !populationGroups.includes(args.group)) || (args.reference && !populationGroups.includes(args.reference)) ||
      (args.borough && !Object.hasOwn(districts, args.borough)) || (args.event && !eventIds.includes(args.event)) ||
      [args.firstRegion, args.secondRegion].some(region => region && !Object.hasOwn(regions, region)) ||
      (args.day != null && (!Number.isInteger(args.day) || args.day < 13 || args.day > 19))) {
    throw new Error("Gemini returned an invalid action");
  }
  return args;
}

const ready = (reply, action) => ({ ok: true, status: "complete", reply, action });
const problem = (status, reply) => ({ ok: false, status, reply });

function executeIntent(intent, body, progress, analyze) {
  const { bounds, studyArea, station, comparison } = body;
  const { action, scope, day, shadePercent, compare, group, reference, borough, rank, rankOrder, scopeNote } = intent;
  switch (action) {
    case "exposure":
    case "station":
    case "population":
    case "shade": {
      if (action === "exposure" && scope !== "london" && !bounds && (intent.requireBounds || !studyArea)) {
        return problem("clarify", "Draw a map area or ask to calculate the London study area.");
      }
      if (action === "population" && scope === "selected" && !bounds) {
        return problem("clarify", "Draw an area first, or ask for Greater London or a named district.");
      }
      if (action === "station" && !station) {
        return { ...problem("clarify", "Select a WOW station on the map first."), action: { type: "show-layer", layer: "wow", day } };
      }
      if (action === "station" && compare && !comparison) {
        return { ...problem("clarify", "Choose a second WOW station in the comparison menu."), action: { type: "choose-comparison" } };
      }
      if (body.dispatch === true) {
        return ready("", { type: "run-analysis", kind: action, scope, day, shadePercent, compare,
          group, reference, borough, rank, rankOrder, scopeNote });
      }
      return analyze({
        kind: action, bounds: scope === "london" || rank || borough ? null : bounds, day, station,
        group, reference, borough, rank, rankOrder, scopeNote,
        comparison: compare ? comparison : undefined, shadePercent: shadePercent ?? body.shadePercent ?? 25,
      }, progress);
    }
    case "risk": return analyze({ metric: "risk" }, progress);
    case "navigate": return ready("Opening the London case.", { type: "navigate" });
    case "open-case": return ready("Opening the selected city case.", { type: "open-case", region: intent.region, event: intent.event });
    case "regional": return ready("Opening the city heat exposure comparison.", {
      type: "compare-events", event: intent.event, firstRegion: intent.firstRegion, secondRegion: intent.secondRegion, metric: intent.metric, date: intent.date, time: intent.time,
    });
    case "globe": return ready("Opening the global ERA5-Land layer.", { type: "globe", day });
    case "layer": return ready("Opening the " + ({ lst: "Landsat surface temperature", wow: "WOW observations", ndvi: "NDVI", ndwi: "NDWI",
      elevation: "elevation", landcover: "land cover", utci: "pedestrian UTCI", era5: "ERA5-Land" })[intent.layer] + " layer.", { type: "show-layer", layer: intent.layer, day });
    case "view": return ready("Switching the grid to " + (intent.view === "bars" ? "3D bars." : "flat view."), { type: "view", view: intent.view });
    case "day": return ready("Opening " + day + " July 2022.", { type: "day", day });
    case "method": {
      const methods = {
        1: "Compare paired UTC observation hours, leaving gaps where records are missing. Landsat surface temperature, station air temperature and ERA5-Land daily maxima are distinct measurements.",
        2: "Use a 5 × 5 Landsat LST window at each Census OA’s geometric centroid, then weight by the matched count in each group. IMD 2025 is a retrospective neighbourhood classification.",
        3: method,
        4: "For each paired cell, apply the modeled building-shade UTCI to the selected fraction of sunlit route length, then weight by the total represented route length.",
        5: body.comparisonMetric === "street" ?
          "Compare 100 m SOLWEIG pilot cells with the same UTC model time. Weight cell UTCI by represented walking length. The results apply to the two pilots." :
          "Compare clear Landsat surface-temperature pixels weighted by estimated residents inside the administrative boundary, with date, local solar time and coverage checks.",
      };
      return ready(methods[body.chapter] ?? method);
    }
    case "unsupported": return problem("unsupported", availability);
    default: return problem("clarify", intent.reply ?? "Try “Compare residents aged 65+”, “Rank boroughs for residents aged 65+”, “Calculate pedestrian heat in my selection” or “Compare London and Paris in 2022”.");
  }
}

async function chat(body, progress, env, analyze) {
  const { message, bounds, studyArea, layer, chapter, station, comparison } = body;
  if (typeof message !== "string" || !message.trim() || message.length > 1000) {
    return problem("clarify", "Enter a question about a Heatline city or event (up to 1,000 characters).");
  }
  if (bounds != null && !validBounds(bounds)) {
    return problem("clarify", "Draw a rectangular area with valid map coordinates.");
  }
  const context = {
    hasSelection: Boolean(bounds) || studyArea === true,
    layer: layers.includes(layer) ? layer : undefined,
    chapter: Number.isInteger(chapter) ? chapter : undefined,
    station: typeof station === "string",
    comparison: typeof comparison === "string",
  };
  const key = env.GEMINI_API_KEY?.trim();
  const model = env.GEMINI_MODEL?.trim() || "gemini-3.1-flash-lite";
  let provider = "local";
  let providerWarning;
  const fallback = localIntent(message, context);
  let intent = fallback.strict || fallback.requireBounds ? fallback : undefined;
  if (key && !intent) {
    progress("Identifying the Atlas tool with Gemini…");
    try {
      intent = await modelIntent(message, context, key, model);
      provider = "gemini";
    } catch {
      providerWarning = "Gemini is unavailable. Atlas is using its built-in commands.";
      progress(providerWarning);
    }
  }
  if (!intent) {
    progress("Matching the question to an Atlas tool…");
    intent = fallback;
  }
  const result = await executeIntent(intent, body, progress, analyze);
  return { ...result, provider, providerWarning };
}

export { chat };

