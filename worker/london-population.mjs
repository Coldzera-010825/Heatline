import { validBounds } from "./analysis.mjs";

// GLA borough names keyed by the ONS LAD codes carried by the 2021 OA lookup.
// https://www.london.gov.uk/sites/default/files/affordable_housing_starts_and_completions_-_end_of_june_22.pdf
const districtNames = [
  "City of London", "Barking and Dagenham", "Barnet", "Bexley", "Brent", "Bromley", "Camden", "Croydon",
  "Ealing", "Enfield", "Greenwich", "Hackney", "Hammersmith and Fulham", "Haringey", "Harrow", "Havering",
  "Hillingdon", "Hounslow", "Islington", "Kensington and Chelsea", "Kingston upon Thames", "Lambeth", "Lewisham",
  "Merton", "Newham", "Redbridge", "Richmond upon Thames", "Southwark", "Sutton", "Tower Hamlets",
  "Waltham Forest", "Wandsworth", "Westminster",
];
export const districts = Object.fromEntries(districtNames.map((name, i) => ["E090000" + String(i + 1).padStart(2, "0"), name]));
export const populationLabels = {
  all: "All usual residents", older: "Residents aged 65+", limited: "Residents with limited day-to-day activities",
  deprived: "Residents in IMD deciles 1–2", leastDeprived: "Residents in IMD deciles 9–10",
};
export const populationGroups = Object.keys(populationLabels);
const bins = [30, 35, 40, 45, Infinity];
const bandLabels = ["<30", "30–35", "35–40", "40–45", "≥45"];
const round = (value, places = 2) => Number(value.toFixed(places));
const problem = (status, reply) => ({ ok: false, status, reply });
const within = (lon, lat, bounds) => !bounds || lon >= bounds[0] && lon <= bounds[2] && lat >= bounds[1] && lat <= bounds[3];
const newTotal = () => ({ count: 0, matched: 0, matchedAreas: 0, sum: 0, bands: [0, 0, 0, 0, 0] });

function add(total, n, temp, band) {
  total.count += n;
  if (!n || band < 0) return;
  total.matched += n;
  total.matchedAreas++;
  total.sum += n * temp;
  total.bands[band] += n;
}

function describe(total) {
  return {
    count: total.count, matched: total.matched, matchedAreas: total.matchedAreas,
    mean: total.matched ? round(total.sum / total.matched) : null,
    coverage: total.count ? total.matched / total.count : null,
    atLeast45: total.matched ? total.bands[4] : null,
  };
}

async function analyzePopulation({ bounds, group = "older", reference = "all", borough, rank = false, rankOrder = "desc", scopeNote }, progress, readEvent) {
  if (bounds != null && !validBounds(bounds)) return problem("clarify", "Draw a valid rectangular area.");
  if (!populationGroups.includes(group) || !populationGroups.includes(reference) || group === reference) {
    return problem("clarify", "Choose two different groups from the London population menu.");
  }
  if ((borough != null && !Object.hasOwn(districts, borough)) || typeof rank !== "boolean" || (rank && borough) ||
      !["asc", "desc"].includes(rankOrder)) {
    return problem("clarify", "Choose a London district or rank all London districts.");
  }
  if ((rank || borough) && bounds) return problem("clarify", "Choose a district scope or a drawn area.");
  progress("Loading 2021 Census areas and matched Landsat values…");
  const records = await readEvent("population-groups.json");
  progress(rank ? "Calculating resident-weighted LST by district…" : "Weighting surface temperatures for each resident group…");
  const totals = Object.fromEntries(populationGroups.map(key => [key, newTotal()]));
  const byDistrict = new Map(), tiles = new Map();
  let areas = 0, matched = 0;
  const districtExtent = [Infinity, Infinity, -Infinity, -Infinity];
  for (const [lon, lat, temp, count, older, limited, decile, lad] of records) {
    if ((borough && borough !== lad) || !within(lon, lat, bounds)) continue;
    areas++;
    const band = Number.isFinite(temp) ? bins.findIndex(edge => temp < edge) : -1;
    const deprived = decile <= 2 ? count : 0, leastDeprived = decile >= 9 ? count : 0;
    const weights = { all: count, older, limited, deprived, leastDeprived };
    for (const key of populationGroups) add(totals[key], weights[key], temp, band);
    if (rank) {
      if (!byDistrict.has(lad)) byDistrict.set(lad, newTotal());
      add(byDistrict.get(lad), weights[group], temp, band);
    }
    if (borough) {
      districtExtent[0] = Math.min(districtExtent[0], lon);
      districtExtent[1] = Math.min(districtExtent[1], lat);
      districtExtent[2] = Math.max(districtExtent[2], lon);
      districtExtent[3] = Math.max(districtExtent[3], lat);
    }
    if (band < 0) continue;
    matched++;
    const x = Math.floor(lon / .0075), y = Math.floor(lat / .0045), tileKey = x + ":" + y;
    const tile = tiles.get(tileKey) ?? { x, y, count: 0, older: 0, limited: 0, deprived: 0, leastDeprived: 0, sum: 0 };
    tile.count += count;
    tile.older += older;
    tile.limited += limited;
    tile.deprived += deprived;
    tile.leastDeprived += leastDeprived;
    tile.sum += temp * count;
    tiles.set(tileKey, tile);
  }
  if (!totals.all.matched) return problem("empty", "No Census areas with matched Landsat LST were found in this area.");
  const groups = Object.fromEntries(populationGroups.map(key => [key, { label: populationLabels[key], ...describe(totals[key]) }]));
  const ranked = rank ? [...byDistrict].filter(([, total]) => total.matched > 0)
    .sort((a, b) => (rankOrder === "desc" ? 1 : -1) * (b[1].sum / b[1].matched - a[1].sum / a[1].matched) ||
      districts[a[0]].localeCompare(districts[b[0]]))
    .map(([code, total]) => ({ code, name: districts[code], ...describe(total) })) : null;
  const a = groups[group], b = groups[reference];
  const groupText = label => label[0].toLowerCase() + label.slice(1);
  const delta = a.matched && b.matched ? round(totals[group].sum / a.matched - totals[reference].sum / b.matched) : null;
  const place = borough ? districts[borough] : bounds ? "the drawn area" : "Greater London";
  const format = n => n.toLocaleString("en-GB");
  let reply;
  if (ranked?.length) {
    const first = ranked[0];
    reply = first.name + " had the " + (rankOrder === "desc" ? "highest" : "lowest") + " matched mean residential surface temperature for " + groupText(a.label) +
      ": " + first.mean.toFixed(2) + "°C (" + format(first.matched) + " matched residents). " +
      "The ranking uses the 18 July Landsat snapshot, not air temperature or heat risk.";
  } else if (ranked) {
    reply = "No London districts have matched records for this group.";
  } else if (delta != null) {
    reply = "In " + place + ", matched mean residential LST was " + a.mean.toFixed(2) + "°C for " + groupText(a.label) +
      " and " + b.mean.toFixed(2) + "°C for " + groupText(b.label) + ". " +
      (delta === 0 ? "The difference rounds to 0.00°C." : "The first group was " + Math.abs(delta).toFixed(2) + "°C " +
        (delta > 0 ? "higher." : "lower.")) + " This is a single 18 July surface-temperature snapshot.";
  } else {
    reply = "At least one selected group has no matched residents in " + place + ". Other available group results are shown below.";
  }
  if (scopeNote === "cooling") reply += " This archive cannot recommend cooling-centre locations; that needs facility and access data.";
  return {
    ok: true, status: "complete", reply,
    event: {
      kind: "population", timeUtc: "2022-07-18T10:52:15Z", areas, matched, delta, place, group, reference, groups,
      all: groups.all, older: groups.older, borough, ranked, rankOrder, bounds,
      districtExtent: borough ? districtExtent : undefined,
      distribution: bandLabels.map((label, i) => ({
        label, ...Object.fromEntries(populationGroups.map(key => [key,
          groups[key].matched ? totals[key].bands[i] / groups[key].matched : null])),
      })),
      tiles: [...tiles.values()].filter(tile => tile.count >= 100).map(tile => [
        round(tile.x * .0075, 6), round(tile.y * .0045, 6), round(tile.sum / tile.count),
        round(100 * tile.older / tile.count, 1), tile.count, round(100 * tile.limited / tile.count, 1),
        round(100 * tile.deprived / tile.count, 1), round(100 * tile.leastDeprived / tile.count, 1),
      ]),
      method: "ONS Census 2021 TS007A (age) and TS038 (day-to-day activities); OA geometric centroid with a 5 × 5 Landsat 9 LST pixel window on 18 July 2022 at 10:52 UTC. Means weight each matched OA by the count in the selected group. IMD 2025 deciles classify English neighbourhoods and are applied retrospectively to the snapshot. All residents includes the subgroups. LST represents the surface at residential locations, not personal exposure or health risk.",
    },
  };
}

export { analyzePopulation };
