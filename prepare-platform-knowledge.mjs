// Rebuild worker/platform-knowledge.mjs from the published methods page and
// DATA-METHODS.md. Run after either source changes:
//
//   node prepare-platform-knowledge.mjs
//
// The generated module is plain data so the Worker never parses HTML at runtime.

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
const HTML_PATH = "dist/client/methods.html";
const MARKDOWN_PATH = "DATA-METHODS.md";
const OUTPUT_PATH = "worker/platform-knowledge.mjs";

// Groups of interchangeable phrasings. If any alias appears in an entry the whole
// group becomes retrievable keywords, so "地表温度" reaches the LST entry.
const aliasGroups = {
  lst: ["lst", "land-surface temperature", "land surface temperature", "surface temperature", "地表温度", "地表热", "表面温度"],
  ndvi: ["ndvi", "vegetation index", "vegetation", "植被", "植被指数"],
  ndwi: ["ndwi", "water index", "open water", "水体"],
  mndwi: ["mndwi", "modified water", "水体指数"],
  utci: ["utci", "thermal stress", "thermal comfort", "热应力", "热舒适", "行人热"],
  solweig: ["solweig", "mean radiant temperature", "辐射温度"],
  era5: ["era5", "era5-land", "reanalysis", "再分析", "气象再分析"],
  population: ["ghs-pop", "population", "residents", "census", "人口", "居民", "普查"],
  worldcover: ["worldcover", "land cover", "land-cover", "土地覆盖", "地表覆盖"],
  elevation: ["elevation", "terrain", "dsm", "dtm", "高程", "地形"],
  imd: ["imd", "deprivation", " deprived", "剥夺", "贫困"],
  fua: ["fua", "functional urban area", "城市功能区"],
  shade: ["shade", "shading", "遮荫", "遮阴", "树荫", "阴影"],
  review: ["priority", "priority score", "rank", "排名", "优先级", "筛查"],
  landsat: ["landsat", "st_b10", "qa_pixel", "卫星"],
  comparison: ["comparison", "compare", "对比", "比较"],
  coverage: ["coverage", "valid", "覆盖", "有效率"],
  limitation: ["limitation", "caveat", "not observed", "cannot", "限制", "局限", "不能", "不代表"],
  cities: ["city", "cities", "study area", "boundary", "城市", "研究区", "边界"],
  weather: ["weather", "temperature", "humidity", "wind", "气温", "湿度", "风速"],
  station: ["station", "wow", "noaa", "气象站", "观测站"],
  atlas: ["atlas", "heatline", "平台", "网站"],
};

const entities = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", mdash: "—",
  ndash: "–", times: "×", minus: "−", plus: "+", deg: "°", hellip: "…", check: "✓",
};

function decode(text) {
  return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, code) => {
    if (code[0] === "#") {
      const value = code[1].toLowerCase() === "x" ? parseInt(code.slice(2), 16) : Number(code.slice(1));
      return Number.isFinite(value) ? String.fromCodePoint(value) : match;
    }
    return entities[code.toLowerCase()] ?? match;
  });
}

function htmlToText(html) {
  return decode(
    html
      .replace(/<(script|style|svg|math|nav)[\s\S]*?<\/\1>/gi, " ")
      .replace(/<span class="citations"[\s\S]*?<\/span>/gi, " ")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(?:p|li|dd|dt|tr|td|th|h2|h3|h4|div|table|figure|figcaption|article|section)>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
  )
    .replace(/[ \t\u00a0]+/g, " ")
    .replace(/ *\n */g, "\n")
    .split("\n")
    .map(line => line.trim())
    .filter(Boolean)
    .join("\n");
}

function markdownToText(markdown) {
  return markdown
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/```[\s\S]*?```/g, block => block.replace(/```\w*/g, "").trim())
    .replace(/[|*_`>#]/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .split("\n")
    .map(line => line.trim())
    .filter(Boolean)
    .join("\n");
}

function keywordsFor(title, text) {
  const words = new Set((title.toLowerCase().match(/[a-z][a-z-]{2,}/g) ?? []));
  const haystack = (title + " " + text).toLowerCase();
  for (const aliases of Object.values(aliasGroups)) {
    if (aliases.some(alias => haystack.includes(alias.trim()))) aliases.forEach(alias => words.add(alias.trim()));
  }
  return [...words].sort();
}

const LIMIT = 1600;

function entry(id, title, body) {
  const text = body.length > LIMIT ? body.slice(0, LIMIT).replace(/\s+\S*$/, "") + "…" : body;
  return { id, title, text, keywords: keywordsFor(title, text) };
}

const html = readFileSync(HTML_PATH, "utf8");
const entries = [];

// Standalone cards carry one method or one dataset each.
for (const match of html.matchAll(/<article([^>]*)>([\s\S]*?)<\/article>/gi)) {
  const id = /\bid="([^"]+)"/.exec(match[1])?.[1];
  const body = match[2];
  const title = htmlToText(/<h[234][^>]*>([\s\S]*?)<\/h[234]>/i.exec(body)?.[1] ?? "").trim();
  const text = htmlToText(body.replace(/<h[234][^>]*>[\s\S]*?<\/h[234]>/i, ""));
  if (!id || !title || text.length < 80) continue;
  entries.push(entry(id, title, text));
}

// The research-use section has no cards, so take its prose directly.
const research = /<section[^>]*id="research-use"[^>]*>([\s\S]*?)<\/section>/i.exec(html)?.[1];
if (research) {
  const text = htmlToText(research.replace(/<h2[^>]*>[\s\S]*?<\/h2>/i, ""));
  if (text.length > 80) entries.push(entry("research-use", "Research use and limitations", text));
}

// DATA-METHODS.md is the maintainer-facing summary and covers the delivery,
// coverage table and rebuild commands in plainer language than the page.
const markdown = readFileSync(MARKDOWN_PATH, "utf8");
const [mainSection, ...rest] = markdown.split(/^## /m);
const markdownText = markdownToText(mainSection);
// The summary is longer than one entry, so keep it in reading-order chunks
// instead of truncating the coverage table away.
const chunks = [];
let current = "";
for (const line of markdownText.split("\n")) {
  if (current.length + line.length > 3000 && current) {
    chunks.push(current);
    current = "";
  }
  current += (current ? "\n" : "") + line;
}
if (current) chunks.push(current);
chunks.forEach((chunk, index) => {
  const suffix = chunks.length > 1 ? " (part " + (index + 1) + ")" : "";
  entries.push(entry("data-methods-" + (index + 1), "Data sources, coverage and calculation" + suffix, chunk));
});
for (const section of rest) {
  const [heading, ...lines] = section.split("\n");
  const text = markdownToText(lines.join("\n"));
  if (text.length > 60) entries.push(entry("md-" + heading.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-"), heading.trim(), text));
}

// The case catalogue is the authoritative list of supported places and events,
// so build the coverage entry from the shipped data rather than prose.
const catalog = JSON.parse(readFileSync("dist/client/data/admin/catalog.json", "utf8"));
const cityNames = Object.values(catalog.cities ?? {}).map(city => city.name);
const eventIds = [...new Set(readdirSync("dist/client/data/events")
  .filter(name => name.endsWith(".bin"))
  .map(name => name.split("-").slice(0, 2).join("-")))].sort();
entries.push(entry("study-areas", "Study areas and archived events",
  "Heatline archives " + cityNames.length + " city cases: " + cityNames.join(", ") + ". " +
  "The dated events are " + eventIds.join(", ") + ", one per heat episode. " +
  "Pedestrian UTCI, Census residential analysis and the paired shade scenario are available where the " +
  "inputs exist; London carries the full walking-network chapter for 2022."));


const seen = new Set();
const unique = entries.filter(item => {
  const key = item.title.toLowerCase();
  if (seen.has(key)) return false;
  seen.add(key);
  return true;
});

const output = `// Generated by prepare-platform-knowledge.mjs from ${HTML_PATH} and ${MARKDOWN_PATH}.
// Do not edit by hand: rerun \`node prepare-platform-knowledge.mjs\` instead.

export const knowledge = ${JSON.stringify(unique, null, 2)};
`;

writeFileSync(OUTPUT_PATH, output);
console.log(`Wrote ${unique.length} knowledge entries to ${OUTPUT_PATH}`);
for (const item of unique) console.log(`  ${item.id}  ${item.title}  (${item.text.length} chars)`);
