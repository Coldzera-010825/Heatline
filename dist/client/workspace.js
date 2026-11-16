import { fileLimitMiB, groupFields, models, roles, sampleFields } from "./workspace-contract.js";
import { isPlatformQuestion } from "./atlas-question.js";
import { openGuestWorkspace } from "./workspace-guest.js";

const $ = id => document.getElementById(id);
const apiRoot = "/api/workspace";
const guestMode = new URLSearchParams(location.search).get("guest") === "1";
let guestFetch;
const workspaceFetch = (path, init) => guestMode ? (guestFetch ??= openGuestWorkspace())(path, init) : fetch(apiRoot + path, init);
const state = { study: null, files: [], runs: [], picks: {}, model: "resident", selected: "", run: null, busy: false, bounds: null };
const empty = { type: "FeatureCollection", features: [] };
const terrainColors = ["#513982", "#9f4e82", "#d96961", "#f4a266", "#fff0a6"];
const priorityColors = ["#294268", "#4b76a1", "#6db7b6", "#b9e5a4", "#fff5bd"];
const shadeColors = ["#d46870", "#b68672", "#9b8f7b", "#95c9ab", "#dcf9bd"];
const number = n => new Intl.NumberFormat("en-GB", { maximumFractionDigits: 2 }).format(n);
const time = t => t.replace("T", " ").replace(/\.\d+Z$/, " UTC");
const option = (text, value) => new Option(text, value);
const studyPath = () => "/studies/" + state.study.id;
const buttons = ids => ids.map($);
let map, loaded = false, draw = false, anchor, dragStart, layer = empty, outline = empty, selection = empty, pins = empty, mark;
let mapVersion = 0, viewVersion = 0;

function node(tag, text, className) {
  const n = document.createElement(tag);
  if (text != null) n.textContent = text;
  if (className) n.className = className;
  return n;
}

async function api(path, method = "GET", body) {
  const response = await workspaceFetch(path, { method, ...(body !== undefined && {
    headers: { "Content-Type": typeof body === "object" && !(body instanceof File) ? "application/json" : "application/octet-stream" },
    body: body instanceof File ? body : JSON.stringify(body),
  }) });
  if (!response.ok) {
    const info = await response.json().catch(() => ({}));
    const error = new Error(info.error ?? "The research workspace request could not be completed.");
    error.status = response.status;
    throw error;
  }
  return response.json();
}

function status(id, text = "", error = false) {
  $(id).textContent = text;
  $(id).dataset.error = String(error);
}

function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const link = node("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

function bindExport(id, path) {
  const link = $(id);
  link.href = guestMode ? "#" : apiRoot + path;
  if (!guestMode) return;
  link.onclick = async event => {
    event.preventDefault();
    try {
      const response = await workspaceFetch(path);
      if (!response.ok) throw new Error((await response.json()).error);
      const filename = response.headers.get("Content-Disposition")?.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
      downloadBlob(await response.blob(), filename ? decodeURIComponent(filename) : "heatline-export");
    } catch (err) { status("run-status", err.message, true); }
  };
}

function busy(value) {
  state.busy = value;
  for (const b of buttons(["new-study", "studies", "delete-study", "model", "draw-selection", "atlas-question"])) b.disabled = value;
  $("import-data").disabled = value || !state.study;
  $("draw-selection").disabled ||= !boundaryFile() || !loaded;
  $("run-analysis").disabled = value || needs().some(r => !r.ready);
}

function boundaryFile() { return state.files.find(f => f.role === "boundary"); }
function filesFor(role) { return state.files.filter(f => f.role === role); }
function fileFor(role) {
  const files = filesFor(role);
  return files.find(f => f.id === state.picks[role]) ?? files.at(-1);
}

function needs(kind = state.model) {
  const samples = fileFor("samples")?.details;
  const validSamples = samples ? samples.records - samples.outsideModel : 0;
  const items = ["boundary", ...models[kind].inputs].map(role => ({ role, label: roles[role].label,
    ready: role === "samples" ? validSamples > 0 : Boolean(fileFor(role)) }));
  if (kind === "shade") items.push({ role: "samples", label: "Sun and building-shade pairs", ready: Boolean(samples?.pairedCells) });
  if (kind === "priority") items.push({ role: "samples", label: "Sun and shade classification", ready: Boolean(samples &&
    samples.unknownShade < validSamples) });
  return items;
}

function showNeeds(target, kind) {
  target.replaceChildren(...needs(kind).map(({ label, ready }) => {
    const row = node("div", null, "requirement");
    row.dataset.ready = ready;
    row.append(node("span", ready ? "✓" : "○", "requirement-mark"), node("span", label), node("small", ready ? "Ready" : "Needed"));
    return row;
  }));
}

function pickedField(id, label, control) {
  const row = node("div");
  const title = node("label", label);
  title.htmlFor = id;
  control.id = id;
  row.append(title, control);
  return row;
}

function renderAnalysis() {
  $("model").value = state.model;
  $("model-help").textContent = models[state.model].help;
  showNeeds($("readiness"), state.model);
  const excluded = fileFor("samples")?.details.outsideModel;
  if (state.model !== "resident" && excluded) $("readiness").append(node("small",
    number(excluded) + " sample records fall outside the UTCI model range.", "quiet"));
  const fields = $("model-inputs");
  fields.replaceChildren();
  for (const role of models[state.model].inputs) {
    const updates = filesFor(role);
    if (updates.length < 2) continue;
    const select = node("select");
    select.replaceChildren(...updates.map(f => option(f.label, f.id)));
    select.value = fileFor(role).id;
    select.onchange = () => { state.picks[role] = select.value; renderAnalysis(); };
    fields.append(pickedField("pick-" + role, roles[role].label, select));
  }
  if (state.model === "resident") {
    const comparison = filesFor("population").filter(f => f.id !== fileFor("population")?.id);
    if (comparison.length) {
      const select = node("select");
      select.replaceChildren(option("None", ""), ...comparison.map(f => option(f.label, f.id)));
      select.value = comparison.some(f => f.id === state.picks.reference) ? state.picks.reference : "";
      select.onchange = () => { state.picks.reference = select.value; };
      fields.append(pickedField("comparison-population", "Compare with", select));
    }
    const threshold = node("input");
    Object.assign(threshold, { type: "number", min: -100, max: 140, step: "any", value: state.threshold ?? 45 });
    threshold.oninput = () => { state.threshold = threshold.valueAsNumber; };
    fields.append(pickedField("heat-threshold", "LST threshold (°C)", threshold));
  }
  if (state.model === "shade") {
    const amount = node("input");
    Object.assign(amount, { type: "number", min: 0, max: 100, step: "any", value: state.shadePercent ?? 25 });
    amount.oninput = () => { state.shadePercent = amount.valueAsNumber; };
    fields.append(pickedField("shade-percentage", "Sunlit length converted (%)", amount));
  }
  if (state.model === "priority") {
    const groups = fileFor("censusGroups")?.details.groups ?? [];
    const select = node("select");
    select.replaceChildren(...groups.map(g => option(g.label, g.id)));
    if (groups.some(g => g.id === state.group)) select.value = state.group;
    state.group = select.value;
    select.onchange = () => { state.group = select.value; };
    fields.append(pickedField("census-group", "Resident group", select));
  }
  busy(state.busy);
}

function renderStudy() {
  $("study-name").textContent = state.study?.name ?? "Create a study";
  const f = boundaryFile();
  $("study-description").textContent = state.study ?
    [time(state.study.eventTime), f?.gridCrs ?? "Boundary needed",
      guestMode ? "This tab" : "Expires " + new Date(state.study.expiresAt).toLocaleDateString("en-GB")].join(" · ") :
    "Set a boundary and an event time to begin.";
  $("delete-study").hidden = !state.study;
  $("fit-study").disabled = !f;
  $("map-placeholder").hidden = Boolean(f);
  $("map-placeholder").textContent = state.study ? "Import a study boundary to place your data." : "Create a study to preview your data.";
  $("file-count").textContent = state.files.length;
  $("dataset-note").textContent = state.files.length ? "Choose a validated layer to see its coverage." : "Import data to preview it in the study area.";
  $("dataset-list").replaceChildren(...state.files.map(file => {
    const b = node("button", null, "dataset");
    b.type = "button";
    b.setAttribute("aria-pressed", String(file.id === state.selected));
    const content = node("span");
    const detail = file.details.valid != null ? " · " + number(file.details.valid) + " pixels" :
      file.details.records != null ? " · " + number(file.details.records) + " records" : "";
    content.append(node("b", file.label), node("small", roles[file.role].label + detail));
    b.append(node("span", null, "data-dot"), content);
    b.onclick = () => selectLayer(file).catch(err => status("run-status", err.message, true));
    return b;
  }));
  const selected = state.files.find(item => item.id === state.selected);
  $("file-actions").hidden = !selected;
  if (selected) {
    const path = studyPath() + "/files/" + selected.id + "/export";
    bindExport("export-original", path);
    bindExport("export-normalized", path + "?format=normalized");
  }
  renderAnalysis();
}

function redraw() {
  if (!loaded) return;
  for (const [id, payload] of Object.entries({ outline, layer, selection, pins })) map.getSource(id).setData(payload);
}

function fitStudy() {
  const bounds = boundaryFile()?.details.bounds;
  if (loaded && bounds) map.fitBounds(bounds, { padding: 62, maxZoom: 16.5, duration: 0 });
}

function mapInit() {
  if (!window.mapboxgl || !window.TERRAHEAT_MAPBOX_TOKEN) {
    status("selection-note", "Mapbox is unavailable. Data and results remain downloadable.");
    return;
  }
  mapboxgl.accessToken = window.TERRAHEAT_MAPBOX_TOKEN;
  map = new mapboxgl.Map({ container: "workspace-map", style: "mapbox://styles/mapbox/dark-v11",
    projection: "mercator", center: [-.128, 51.511], zoom: 9.5 });
  map.addControl(new mapboxgl.NavigationControl({ visualizePitch: true }), "top-right");
  map.on("load", () => {
    for (const id of ["outline", "layer", "selection", "pins"]) map.addSource(id, { type: "geojson", data: empty });
    map.addLayer({ id: "study-area-fill", source: "outline", type: "fill", paint: { "fill-color": "#d58756", "fill-opacity": .09 } });
    map.addLayer({ id: "study-data-fill", source: "layer", type: "fill", filter: ["==", ["geometry-type"], "Polygon"],
      paint: { "fill-color": ["coalesce", ["get", "colour"], "#bf8b67"], "fill-opacity": ["case", ["boolean", ["get", "carried"], false], .28, .69] } });
    map.addLayer({ id: "study-data-line", source: "layer", type: "line", filter: ["==", ["geometry-type"], "LineString"],
      paint: { "line-color": ["coalesce", ["get", "colour"], "#e7b889"], "line-width": 2 } });
    map.addLayer({ id: "study-data-point", source: "layer", type: "circle", filter: ["==", ["geometry-type"], "Point"],
      paint: { "circle-color": ["coalesce", ["get", "colour"], "#ee9d6a"], "circle-radius": 4, "circle-stroke-width": 1, "circle-stroke-color": "#302015" } });
    map.addLayer({ id: "study-area-border", source: "outline", type: "line", paint: { "line-color": "#f3ba86", "line-width": 2 } });
    map.addLayer({ id: "study-selection", source: "selection", type: "line", paint: { "line-color": "#ffddb1", "line-width": 2, "line-dasharray": [3, 2] } });
    map.addLayer({ id: "study-priority-points", source: "pins", type: "circle", paint: { "circle-color": "#f6b876", "circle-radius": 8, "circle-stroke-width": 2, "circle-stroke-color": "#23170f" } });
    map.addLayer({ id: "study-priority-labels", source: "pins", type: "symbol", layout: { "text-field": ["get", "rank"], "text-size": 11, "text-allow-overlap": true }, paint: { "text-color": "#302015" } });
    loaded = true;
    redraw();
    fitStudy();
    busy(state.busy);
  });
  map.on("mousedown", event => {
    if (draw && event.originalEvent.button === 0) dragStart = { point: event.point, corner: event.lngLat.toArray() };
  });
  map.on("mousemove", event => {
    if (!dragStart || event.point.dist(dragStart.point) < 8) return;
    map.getSource("selection").setData(areaBetween(dragStart.corner, event.lngLat.toArray()).shape);
  });
  map.on("mouseup", event => {
    const start = dragStart;
    dragStart = null;
    if (draw && start && event.point.dist(start.point) >= 8) finishDraw(start.corner, event.lngLat.toArray());
  });
  map.on("click", event => {
    if (!loaded) return;
    if (draw) {
      const p = event.lngLat.toArray();
      if (!anchor) {
        anchor = p;
        status("selection-note", "Select the opposite corner.");
      } else finishDraw(anchor, p);
      return;
    }
    const hits = map.queryRenderedFeatures(event.point, { layers: ["study-priority-points", "study-data-fill", "study-data-line", "study-data-point"] });
    const item = hits[0]?.properties;
    if (!item) return;
    mark?.remove();
    const panel = node("div");
    panel.append(node("b", item.cell_id ?? item.segment_id ?? item.sample_id ?? $("map-layer-label").textContent));
    const value = item.shown_value ?? item.value;
    if (Number.isFinite(value)) panel.append(node("div", number(value) + (item.units ? " " + item.units : "")));
    if (item.carried) panel.append(node("small", "Baseline carried forward"));
    if (item.missing) panel.append(node("small", "No matched value"));
    mark = new mapboxgl.Popup({ offset: 10 }).setLngLat(event.lngLat).setDOMContent(panel).addTo(map);
  });
}

function areaBetween(a, b) {
  const west = Math.min(a[0], b[0]), south = Math.min(a[1], b[1]);
  const east = Math.max(a[0], b[0]), north = Math.max(a[1], b[1]);
  return { bounds: [west, south, east, north], shape: { type: "Feature", geometry: {
    type: "Polygon", coordinates: [[[west, south], [east, south], [east, north], [west, north], [west, south]]],
  } } };
}

function finishDraw(start, end) {
  const { bounds, shape } = areaBetween(start, end);
  if (bounds[0] === bounds[2] || bounds[1] === bounds[3]) { redraw(); return; }
  state.bounds = bounds;
  selection = shape;
  $("clear-selection").hidden = false;
  setDraw(false);
}

function setDraw(enable) {
  draw = enable;
  anchor = dragStart = null;
  $("draw-selection").setAttribute("aria-pressed", String(enable));
  if (loaded) {
    map.dragPan[enable ? "disable" : "enable"]();
    map.getCanvas().style.cursor = enable ? "crosshair" : "";
  }
  if (enable) status("selection-note", "Drag a rectangle or click two opposite corners.");
  else {
    status("selection-note", state.bounds ? "Runs use the part of this selection inside the study boundary." : "");
    redraw();
  }
}

function clearSelection() {
  state.bounds = null;
  selection = empty;
  setDraw(false);
  $("clear-selection").hidden = true;
}

function displayLayer(raw, options) {
  $("map-layer-label").textContent = options.label;
  const values = raw.features.map(f => f.properties?.[options.value ?? "value"]).filter(Number.isFinite);
  $("workspace-legend").hidden = !values.length;
  $("result-view").hidden = !(options.controls && values.length);
  if (!values.length) { layer = raw; redraw(); return; }
  const min = options.min ?? Math.min(...values), max = options.max ?? Math.max(...values);
  const colors = options.colors ?? terrainColors;
  const range = max - min || 1;
  layer = { ...raw, features: raw.features.map(f => {
    const value = f.properties?.[options.value ?? "value"];
    const c = Math.min(colors.length - 1, Math.max(0, Math.floor((value - min) / range * colors.length)));
    return { ...f, properties: { ...f.properties, colour: Number.isFinite(value) ? colors[c] : "#6e655f",
      shown_value: value ?? null, units: options.unit, missing: !Number.isFinite(value),
      carried: Boolean(f.properties?.carried && options.value === "scenario_utci_c") } };
  }) };
  $("legend-label").textContent = options.label + (options.unit ? " · " + options.unit : "");
  $("legend-ramp").style.background = "linear-gradient(90deg," + colors.join(",") + ")";
  $("legend-limits").replaceChildren(node("span", number(min)), node("span", number(max)));
  $("legend-note").textContent = options.note ?? "";
  redraw();
}

async function selectLayer(file) {
  if (!state.study) return;
  const version = ++mapVersion, path = studyPath();
  state.selected = file.id;
  renderStudy();
  const data = await api(path + "/files/" + file.id + "/preview");
  if (version !== mapVersion) return;
  pins = empty;
  if (file.role === "boundary") {
    outline = data;
    displayLayer(empty, { label: "Study boundary" });
    fitStudy();
  } else {
    const note = file.role === "samples" ? (file.details.previewStride > 1 ? "Sampled 100 m view" : "100 m grid") + " · weighted by walking length" :
      file.grid ? "Preview clipped to the study boundary" : "";
    displayLayer(data, { label: file.label, unit: file.role === "population" ? "people / displayed block" :
      file.role === "samples" ? "Tmrt · °C" : file.units, note });
  }
}

function renderResults() {
  const run = state.run;
  $("results-empty").hidden = Boolean(run);
  $("result-card").hidden = !run;
  const completed = state.runs.filter(r => r.status === "complete");
  $("run-history").hidden = !completed.length;
  $("run-list").replaceChildren(...completed.map(r => option(r.label + " · " + new Date(r.createdAt).toLocaleTimeString("en-GB"), r.id)));
  if (!run) return;
  $("run-list").value = run.id;
  $("result-time").textContent = time(run.eventTime);
  $("result-title").textContent = run.label;
  $("result-metrics").replaceChildren(...run.summary.map(({ label, value, unit }) => {
    const row = node("div", null, "metric");
    row.append(node("span", label), node("strong", number(value) + (unit ? " " + unit : "")));
    return row;
  }));
  $("result-method").textContent = run.basis;
  for (const [id, format] of [["result-csv", "csv"], ["result-map", "geojson"], ["result-zip", "zip"]]) {
    bindExport(id, studyPath() + "/runs/" + run.id + "/export?format=" + format);
  }
  const candidate = $("priority-locations");
  candidate.hidden = !run.candidates?.length;
  candidate.replaceChildren();
  if (!candidate.hidden) {
    candidate.append(node("h3", "Priority locations"));
    for (const [i, site] of run.candidates.entries()) {
      const button = node("button", (i + 1) + " · " + number(site.score) + " points", "button");
      button.type = "button";
      button.onclick = () => { if (loaded) map.jumpTo({ center: [site.lon, site.lat], zoom: 15.5 }); };
      candidate.append(button);
    }
  }
}

async function showRun(run) {
  state.run = run;
  state.selected = "";
  renderStudy();
  renderResults();
  const version = ++mapVersion, data = await api(studyPath() + "/runs/" + run.id + "/preview");
  if (version !== mapVersion) return;
  state.runLayer = data;
  viewResult(run.primary);
}

function viewResult(value) {
  const run = state.run;
  if (!run || !state.runLayer) return;
  state.selected = "";
  renderStudy();
  const label = { scenario_utci_c: "Shade scenario UTCI", baseline_utci_c: "Baseline UTCI",
    delta_utci_c: "UTCI reduction", priority_score: "Field priority score", lst_c: "Resident-weighted LST" }[value] ?? run.label;
  const property = run.model === "resident" || run.model === "priority" ? "value" : value;
  pins = { type: "FeatureCollection", features: (run.candidates ?? []).map((p, i) => ({
    type: "Feature", geometry: { type: "Point", coordinates: [p.lon, p.lat] }, properties: { rank: String(i + 1), cell_id: p.id, value: p.score, units: "points" },
  })) };
  displayLayer(state.runLayer, { value: property, label, unit: run.unit, controls: run.model === "shade",
    colors: value === "delta_utci_c" ? shadeColors : value === "priority_score" ? priorityColors : terrainColors,
    note: (value === "scenario_utci_c" ? "Dim cells carry baseline UTCI. " : value === "delta_utci_c" ? "Gray cells lack a shade pair. " : "") +
      (run.previewStride > 1 ? "Sampled map preview · export for every cell" : run.model === "resident" ? "Overview weights LST by residents" : "100 m walking cells") });
  for (const button of $("result-view").querySelectorAll("button")) button.setAttribute("aria-pressed", String(button.dataset.value === value));
}

async function listStudies(prefer) {
  const data = await api("");
  $("studies").replaceChildren(option("Select a study", ""), ...data.studies.map(s => option(s.name, s.id)));
  $("new-city").replaceChildren(option("Upload my own boundary", ""), ...data.cities.map(city => option(city.name, city.id)));
  const next = data.studies.find(s => s.id === prefer) ?? data.studies[0];
  $("studies").value = next?.id ?? "";
  await openStudy(next?.id ?? "");
}

async function openStudy(id) {
  const version = ++viewVersion;
  ++mapVersion;
  mark?.remove();
  state.runLayer = null;
  state.selected = "";
  outline = layer = pins = empty;
  clearSelection();
  $("atlas-thread").replaceChildren(node("p", "Ask Atlas to run the selected analysis or explain a completed result.", "quiet"));
  $("atlas-mode").textContent = "";
  status("run-status");
  const data = id ? await api("/studies/" + id) : { study: null, files: [], runs: [] };
  if (version !== viewVersion) return;
  Object.assign(state, data, { picks: {}, run: null });
  renderStudy();
  renderResults();
  displayLayer(empty, { label: "Study boundary" });
  if (boundaryFile()) await selectLayer(boundaryFile());
}

function scalarField(parent, id, label, type = "text", props = {}) {
  const input = node("input");
  Object.assign(input, { type }, props);
  parent.append(pickedField(id, label, input));
  return input;
}

function showImport(role) {
  if (!state.study) return;
  $("import-form").reset();
  $("import-model").value = state.model;
  $("role").replaceChildren(...Object.entries(roles).map(([id, r]) => option(r.label, id)));
  for (const item of $("role").options) item.disabled = boundaryFile() ? item.value === "boundary" : item.value !== "boundary";
  $("role").value = !boundaryFile() ? "boundary" : role && role !== "boundary" ? role : models[state.model].inputs[0];
  status("import-status");
  updateImport();
  $("import-dialog").showModal();
}

function updateImport() {
  const role = $("role").value, info = roles[role], fields = $("import-metadata");
  $("import-file").accept = info.accept;
  $("role-hint").textContent = info.format + " · " + info.hint + " " + fileLimitMiB + " MiB per file.";
  showNeeds($("import-requirements"), $("import-model").value);
  const schema = role === "samples" ? sampleFields : role === "censusGroups" ? groupFields : null;
  $("schema-fields").hidden = !schema;
  $("schema-fields").textContent = schema?.join(", ") ?? "";
  $("download-template").hidden = !schema;
  fields.replaceChildren();
  if (role === "lst") {
    const unit = node("select");
    unit.replaceChildren(option("Celsius (°C)", "C"), option("Kelvin (K)", "K"));
    fields.append(pickedField("file-units", "Temperature unit", unit));
    scalarField(fields, "file-time", "Observation time (UTC)", "datetime-local",
      { value: state.study.eventTime.slice(0, 19), required: true, step: "1" });
  }
  if (role === "population" || role === "censusGroups") {
    scalarField(fields, "file-year", "Population reference year", "number", { min: 1800, max: 2200, required: true, placeholder: "2021" });
  }
  if (role === "referenceRaster") scalarField(fields, "file-units", "Value unit", "text", { required: true, placeholder: "°C", maxLength: 24 });
  if (role === "referenceVector") scalarField(fields, "file-field", "Numeric property (optional)", "text", { placeholder: "value" });
  if (info.format === "GeoTIFF") scalarField(fields, "file-crs", "CRS override for missing tags (optional)", "text", { placeholder: "EPSG:27700" });
}

function atlasTurn(text, isUser = false) {
  const p = node("p", text, "atlas-turn" + (isUser ? " user" : ""));
  $("atlas-thread").append(p);
  p.scrollIntoView({ block: "nearest" });
}

async function explain(question) {
  if (!state.run) throw new Error("Run an analysis before asking about a result.");
  const data = await api(studyPath() + "/runs/" + state.run.id + "/explain", "POST", { question });
  $("atlas-mode").textContent = data.mode;
  atlasTurn(data.reply);
}

async function explainMethod(message) {
  if (guestMode) {
    const info = await api("/methods", "POST", { message });
    $("atlas-mode").textContent = "Methods";
    atlasTurn(info.reply);
    return;
  }
  const response = await fetch("/api/chat", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message }) });
  if (!response.ok) throw new Error("The methods answer is unavailable.");
  const info = await response.json();
  if (!info.ok) throw new Error(info.reply || "The methods answer is unavailable.");
  $("atlas-mode").textContent = info.provider === "gemini" ? "Gemini" : "Methods";
  atlasTurn(info.reply);
}

function runBody() {
  const kind = state.model;
  const files = Object.fromEntries(models[kind].inputs.map(role => [role, fileFor(role)?.id]));
  if (kind === "resident" && filesFor("population").some(f => f.id === state.picks.reference && f.id !== files.population)) {
    files.reference = state.picks.reference;
  }
  return { id: crypto.randomUUID(), model: kind, files, bounds: state.bounds,
    threshold: state.threshold ?? 45, shadePercent: state.shadePercent ?? 25, group: state.group };
}

async function runAnalysis(question) {
  if (state.busy || !state.study) return;
  const missing = needs().filter(s => !s.ready);
  if (missing.length) throw new Error("Required inputs are missing: " + missing.map(s => s.label).join(", ") + ".");
  const body = runBody();
  if (![body.threshold, body.shadePercent].every(Number.isFinite)) throw new Error("Enter a valid analysis parameter.");
  busy(true);
  status("run-status", "Opening the analysis request…");
  try {
    const response = await workspaceFetch(studyPath() + "/runs", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error((await response.json()).error);
    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
    let pending = "", result;
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      pending += part.value;
      const lines = pending.split("\n");
      pending = lines.pop();
      for (const line of lines.filter(Boolean)) {
        const item = JSON.parse(line);
        if (item.type === "progress") status("run-status", item.text);
        if (item.type === "error") throw new Error(item.error);
        if (item.type === "result") result = item.run;
      }
    }
    if (!result) throw new Error("The analysis stopped before producing a result.");
    state.runs.unshift(result);
    await showRun(result);
    status("run-status", "Run complete. Results are ready to export.");
    if (question) await explain(question);
  } finally { busy(false); }
}

for (const id of ["model", "import-model"]) $(id).replaceChildren(...Object.entries(models).map(([id, model]) => option(model.label, id)));
$("new-event").value = new Date().toISOString().slice(0, 16);
$("model").onchange = () => { state.model = $("model").value; status("run-status"); renderAnalysis(); };
$("studies").onchange = () => openStudy($("studies").value).catch(err => status("run-status", err.message, true));
$("new-study").onclick = () => { status("study-form-status"); $("study-dialog").showModal(); };
for (const b of document.querySelectorAll("[data-close]")) b.onclick = () => $(b.dataset.close).close();
$("study-form").onsubmit = async event => {
  event.preventDefault();
  const submit = event.target.querySelector('[type="submit"]');
  submit.disabled = true;
  status("study-form-status", guestMode ? "Creating study in this tab…" : "Creating private study…");
  try {
    const { study } = await api("/studies", "POST", { name: $("new-name").value, eventTime: $("new-event").value + "Z",
      city: $("new-city").value, gridCrs: $("new-crs").value });
    await listStudies(study.id);
    $("study-dialog").close();
    if (!boundaryFile()) showImport("boundary");
  } catch (err) { status("study-form-status", err.message, true); }
  finally { submit.disabled = false; }
};
$("delete-study").onclick = () => { status("delete-status"); $("delete-dialog").showModal(); };
$("confirm-delete").onclick = async () => {
  $("confirm-delete").disabled = true;
  try { await api(studyPath(), "DELETE"); $("delete-dialog").close(); await listStudies(); }
  catch (err) { status("delete-status", err.message, true); }
  finally { $("confirm-delete").disabled = false; }
};
$("import-data").onclick = () => showImport();
$("analysis-guide").onclick = () => state.study ? showImport(needs().find(r => !r.ready)?.role) : $("new-study").click();
$("role").onchange = () => { $("import-file").value = ""; status("import-status"); updateImport(); };
$("import-model").onchange = () => {
  const missing = needs($("import-model").value).find(r => !r.ready);
  if (missing && boundaryFile()) { $("role").value = missing.role; $("import-file").value = ""; }
  updateImport();
};
$("download-template").onclick = () => {
  const role = $("role").value;
  const schema = role === "samples" ? sampleFields : groupFields;
  const sample = role === "samples" ? ["s-001", "-0.1275", "51.5090", state.study.eventTime, 5, 57, 34, 42, 2, "sunlit", "seg-01"]
    : ["area-01", "older", "Residents aged 65+", 40, 200];
  downloadBlob(new Blob([schema.join(",") + "\n" + sample.join(",") + "\n"], { type: "text/csv" }), "heatline-" + role + "-template.csv");
};
$("import-form").onsubmit = async event => {
  event.preventDefault();
  const file = $("import-file").files[0];
  if (!file) return;
  if (file.size > fileLimitMiB * 1048576) { status("import-status", "This file exceeds " + fileLimitMiB + " MiB.", true); return; }
  const role = $("role").value;
  const params = new URLSearchParams({ role, file: file.name, label: $("file-label").value, source: $("file-source").value });
  for (const key of ["units", "field", "year", "crs", "time"]) {
    const value = $("file-" + key)?.value;
    if (value) params.set(key, key === "time" ? value + "Z" : value);
  }
  $("validate-file").disabled = true;
  status("import-status", guestMode ? "Checking coordinates and validating your file in this tab…" :
    "Uploading, checking coordinates and validating your file…");
  try {
    const { file: saved } = await api(studyPath() + "/files?" + params, "POST", file);
    state.files = state.files.concat(saved);
    $("import-dialog").close();
    await selectLayer(saved);
    status("run-status", saved.label + " passed validation.");
  } catch (err) { status("import-status", err.message, true); }
  finally { $("validate-file").disabled = false; }
};
$("fit-study").onclick = fitStudy;
$("draw-selection").onclick = () => setDraw(!draw);
$("clear-selection").onclick = clearSelection;
$("run-analysis").onclick = () => runAnalysis().catch(err => status("run-status", err.message, true));
$("run-list").onchange = () => {
  const run = state.runs.find(r => r.id === $("run-list").value);
  if (run) showRun(run).catch(err => status("run-status", err.message, true));
};
for (const button of $("result-view").querySelectorAll("button")) button.onclick = () => viewResult(button.dataset.value);
$("atlas-form").onsubmit = async event => {
  event.preventDefault();
  const q = $("atlas-question").value.trim();
  if (!q || state.busy) return;
  $("atlas-question").value = "";
  atlasTurn(q, true);
  try {
    if (isPlatformQuestion(q)) { await explainMethod(q); return; }
    if (!state.study) { atlasTurn("Create or open a study before running a calculation."); return; }
    const investigate = /\b(explain|meaning|coverage|why|how much|what does)\b|解释|说明|覆盖率|为什么|结果怎么样/i.test(q);
    const go = /\b(run|analy[sz]e|calculate|compute|simulate|show)\b|运行|计算|分析|模拟|查看/i.test(q);
    if (investigate && !go) { await explain(q); return; }
    const model = /shade|遮荫|遮阴/i.test(q) ? "shade" : /priority|核查/i.test(q) ? "priority" :
      /population|residen|lst|人口|居民|地表温度/i.test(q) ? "resident" : /utci|walk|pedestrian|行人|步行/i.test(q) ? "walking" : null;
    if (model || go) {
      if (model) state.model = model;
      const percentage = q.match(/(\d+(?:\.\d+)?)\s*%/);
      if (state.model === "shade" && percentage) state.shadePercent = Number(percentage[1]);
      renderAnalysis();
      await runAnalysis(q);
    } else atlasTurn("Ask me to run an analysis, change the shade percentage or explain a completed run.");
  } catch (err) { atlasTurn(err.message); }
};

if (guestMode) {
  $("guest-notice").hidden = false;
  $("studies-label").textContent = "Guest studies";
  $("workspace-mode-link").textContent = "Private workspace";
  $("workspace-mode-link").href = "workspace.html";
  $("workspace-mode-link").hidden = false;
}
try {
  const access = await api("");
  $("workspace-gate").hidden = true;
  $("workspace-shell").hidden = false;
  $("workspace-mode-link").hidden = false;
  mapInit();
  $("studies").replaceChildren(option("Select a study", ""), ...access.studies.map(s => option(s.name, s.id)));
  $("new-city").replaceChildren(option("Upload my own boundary", ""), ...access.cities.map(city => option(city.name, city.id)));
  const selected = access.studies[0]?.id ?? "";
  $("studies").value = selected;
  await openStudy(selected);
} catch (err) {
  $("workspace-shell").hidden = true;
  $("workspace-gate").hidden = false;
  status("gate-message", err.message, err.status !== 401);
  $("workspace-sign-in").hidden = guestMode || err.status !== 401;
  $("workspace-guest").hidden = $("guest-description").hidden = guestMode;
}
