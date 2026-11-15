(() => {
  "use strict";

  const $ = id => document.getElementById(id);
  const R = window.HEATLINE_RESULTS, L = window.HEATLINE_LAYERS;
  const shades = ["#ffc371", "#7dcbd0", "#96d09b", "#baa5cf"];
  const modes = { baseline: ["Baseline walking UTCI", 2], scenario: ["Shade scenario UTCI", 3],
    reduction: ["UTCI reduction", 4], priority: ["Field priority", 7] };
  const priorityColors = [[0, "#294268"], [2, "#4b76a1"], [6, "#6db7b6"], [12, "#b9e5a4"], [25, "#fff5bd"]];
  const priorityTop = priorityColors.at(-1)[0];
  const priorityMethod = "Field priorities combine modelled heat, the sunlit fraction of walking length and the selected group’s share of local residents.";
  const num = (value, digits = 1) => R.format(value, digits);
  const temp = value => Number.isFinite(value) ? num(value, 2) + "°C" : "Unavailable";
  const utc = time => time ? time.replace("T", " ").replace("Z", " UTC") : "Model time unavailable";
  const metres = value => num(value) + " m";
  const pct = value => num(value * 100) + "%";
  const point = (coordinates, properties = {}) => ({ type: "Feature", geometry: { type: "Point", coordinates }, properties });
  const plural = (count, noun) => num(count, 0) + " " + noun;
  const intersects = (a, b) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1];
  const intersect = (a, b) => [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.min(a[3], b[3])];
  const section = (title, ...children) => {
    const block = R.element("section");
    block.append(R.element("h3", title), ...children);
    return block;
  };

  function measures(rows) {
    const list = R.element("dl", null, "review-measures");
    for (const [label, value] of rows) {
      const line = R.element("div");
      line.append(R.element("dt", label), R.element("dd", value));
      list.append(line);
    }
    return list;
  }

  function locationRows(item) {
    if (!item) return [];
    const coordinates = item.coordinates.map(n => n.toFixed(5)).join(", ");
    if (item.street) {
      return [["OSM way", item.osmWayId], ["Segment", item.id], ["Location (lon, lat)", coordinates],
        ["Modelled shade", item.shadeClass], ["Length of this segment", metres(item.lengthM)]];
    }
    const rows = [["100 m cell", item.id], ["Centre (lon, lat)", coordinates], ["Represented walking length", metres(item.totalM)],
      ["Sunlit length", metres(item.sunM) + " · " + pct(item.sunShare)], ["Building shade", metres(item.buildingShadeM)],
      ["Canopy shade", metres(item.canopyShadeM)], ["Partial shade", metres(item.partialShadeM)],
      ["Baseline UTCI", temp(item.baseline)],
      ["Scenario UTCI", item.reduction == null ? temp(item.scenario) + " · baseline carried forward" : temp(item.scenario)],
      ["UTCI reduction", item.reduction == null ? "No valid shade pair" : temp(item.reduction)]];
    if (item.priority) {
      const p = item.priority;
      rows.push(["Census area", p.areaId], ["Group share of area residents", `${num(p.count, 0)} / ${num(p.residents, 0)} · ${pct(p.share)}`],
        ["Field priority score", num(p.score, 2)]);
    }
    return rows;
  }

  function summaryRows(result) {
    return [["Baseline UTCI", temp(result.baseline)], ["Scenario UTCI", temp(result.scenario)],
      ["UTCI reduction", temp(result.reduction)], ["Modelled walking cells", num(result.cellCount, 0)],
      ["Covered walking length", num(result.pathM / 1000, 2) + " km"], ["Sunlit share", pct(result.sunShare)],
      ["Walking length in paired cells", pct(result.pairedShare)],
      ...(result.census ? [["Walking length matched to census areas", pct(result.censusShare)]] : [])];
  }

  function evidenceText(result, item) {
    if (item?.street) return `${item.name || "This walking segment"} has ${metres(item.lengthM)} in ${item.shadeClass} at ${utc(result.timeUtc)}.`;
    if (item) {
      const heat = `The selected cell has ${temp(item.baseline)} UTCI and ${metres(item.sunM)} of modelled sunlit walking network (${pct(item.sunShare)} of its covered length).`;
      return item.priority ? heat + ` ${result.group} account for ${pct(item.priority.share)} of residents in census area ${item.priority.areaId}. The field priority score is ${num(item.priority.score, 2)}.` : heat;
    }
    return `Across ${result.label}, baseline walking-length-weighted UTCI is ${temp(result.baseline)}. ` +
      `${pct(result.pairedShare)} of covered walking length has a sun and building-shade pair.`;
  }

  function briefing({ result, location, summary }) {
    const body = R.element("article");
    const url = new URL("methods.html#review", window.location.href);
    const source = R.element("a", "Heatline Data & Methods");
    source.href = url.href;
    const scope = result.bounds.map(n => n.toFixed(5)).join(", ");
    body.append(R.element("h1", result.label + " · street review"),
      R.element("p", utc(result.timeUtc)),
      section("Study area and assumptions", measures([["Case", result.event], ["Coverage", result.scope],
        ["Bounds (W, S, E, N)", scope], ["Sunlit length converted", num(result.shadePercent) + "%"], ["Field-check focus", result.group]])),
      section("Area results", measures(summaryRows(result))),
      section("Location reviewed", ...(location ? [R.element("p", location.name || "Selected walking cell"), measures(locationRows(location))] :
        [R.element("p", "The briefing covers the selected walking network.")])),
      section("Finding", R.element("p", summary)),
      section("Field checks and possible action", R.element("p", result.recommendation), (() => {
        const list = R.element("ul");
        list.append(...result.checks.map(text => R.element("li", text)));
        return list;
      })()),
      section("Data and methods", R.element("p", [result.engine, result.source].filter(Boolean).join(" · ")),
        R.element("p", "The scenario keeps unpaired routes at baseline and applies the paired building-shade contrast to the stated share of sunlit route length. Field checks cover use, access and site conditions."),
        ...(result.census ? [R.element("p", `${result.census.source} · ${result.census.unit}. ${priorityMethod} Census counts describe residence. Street use is checked on site.`)] : []),
        ...(result.streets ? [R.element("p", `${result.streets.terrainM} m modelled street shade · ${result.streets.source} · OSM ${result.streets.osmSnapshots.join(", ")}`)] : []), source));
    return body;
  }

  function standalone(body) {
    return "<!doctype html><html lang=\"en\"><meta charset=\"utf-8\"><title>Heatline field review</title>" +
      "<style>body{margin:0;color:#281e15;background:#fbf6ed;font:15px/1.55 system-ui}article{max-width:790px;margin:auto;padding:32px}h1,h3{break-after:avoid}dl{margin:8px 0}dl div{display:grid;grid-template-columns:1fr 1fr;gap:16px;border-bottom:1px solid #dbcdbb;padding:4px 0}dd{margin:0;text-align:right}a{color:#844023}@media print{article{padding:0}body{background:white}li,dl div{break-inside:avoid}@page{margin:16mm}}</style>" +
      body.outerHTML + "</html>";
  }

  function create({ map, context, census, active, canInspect, request, focusMap, narrate }) {
    let analysis, location, snapshot, gridInView, inputKey, pendingLocation;
    let layer = "baseline", showStreets = false, revision = 0, mapRequest = 0;
    const source = (name, content = L.empty) => map.getSource(name)?.setData(content);
    const draft = () => {
      snapshot = undefined;
      $("review-report").disabled = true;
      for (const button of document.querySelectorAll(".review-briefing-link")) button.disabled = true;
    };
    const status = message => { $("review-status").textContent = message; };
    const mapStatus = (message = "") => {
      $("review-map-status").hidden = !message;
      $("review-map-status").textContent = message;
    };
    const input = () => ({ ...context(), focus: $("review-focus").value });
    const key = options => JSON.stringify([options.archiveCase, options.bounds ?? null, options.districts ?? null, options.shadePercent, options.focus]);

    function install() {
      const under = map.getStyle().layers.find(item => item.type === "symbol")?.id;
      for (const name of ["review-grid", "review-street-segments", "review-pins", "review-selection"]) {
        map.addSource(name, { type: "geojson", data: L.empty });
      }
      map.addLayer({ id: "review-grid-fill", type: "fill", source: "review-grid",
        paint: { "fill-color": L.color("utci"), "fill-opacity": ["case", ["get", "unavailable"], .13, ["get", "carried"], .30, .68] } }, under);
      map.addLayer({ id: "review-sampled-streets", type: "line", source: "review-street-segments",
        layout: { "line-join": "round", "line-cap": "round" }, paint: {
          "line-width": ["interpolate", ["linear"], ["zoom"], 14, 1.5, 16, 2.7, 18, 4.5], "line-opacity": .92,
          "line-color": ["match", ["get", "code"], 0, shades[0], 1, shades[1], 2, shades[2], shades[3]] } });
      map.addLayer({ id: "review-pin-dots", type: "circle", source: "review-pins",
        paint: { "circle-radius": 9, "circle-color": "#f4b371", "circle-stroke-color": "#37271b", "circle-stroke-width": 1.6 } });
      map.addLayer({ id: "review-pin-labels", type: "symbol", source: "review-pins",
        layout: { "text-field": ["get", "rank"], "text-size": 11, "text-allow-overlap": true }, paint: { "text-color": "#251a12" } });
      map.addLayer({ id: "review-selected-point", type: "circle", source: "review-selection",
        paint: { "circle-color": "#fff3d1", "circle-radius": 5, "circle-stroke-color": "#40231e", "circle-stroke-width": 1.5 } });
      map.on("click", e => {
        if (!active() || !analysis || !canInspect() || e.defaultPrevented) return;
        const hits = map.queryRenderedFeatures(e.point, { layers: ["review-sampled-streets", "review-pin-dots", "review-grid-fill"] });
        const hit = hits.find(feature => feature.layer.id === "review-sampled-streets") ?? hits[0];
        if (!hit) return;
        e.preventDefault();
        if (hit.layer.id === "review-sampled-streets") {
          revision++;
          location = { ...hit.properties, street: true, coordinates: e.lngLat.toArray() };
          draft();
          revealLocation();
        } else if (hit.layer.id === "review-pin-dots") pick(hit.geometry.coordinates, true);
        else pick(e.lngLat.toArray());
      });
    }

    function revealLocation() {
      renderLocation();
      if ($("review-location").offsetParent) $("review-location").scrollIntoView({ block: "nearest" });
    }

    function renderLocation() {
      const node = $("review-location");
      node.replaceChildren();
      if (!location) { source("review-selection"); return; }
      node.append(R.element("h3", location.street ? location.name || "Unnamed walking segment" : "Selected 100 m cell"), measures(locationRows(location)));
      if (!snapshot) status("Location selected. Run AI Analyze to update the briefing.");
      source("review-selection", L.collection([point(location.coordinates)]));
    }

    function renderGrid() {
      if (!analysis || !active()) return;
      const { review } = analysis;
      const grid = gridInView ?? review.grid;
      const [, valueIndex] = modes[layer];
      const clip = context().clip;
      const features = [];
      for (const row of grid.cells) {
        const [x, y] = row;
        const step = grid.step;
        const w = step ? x * step[0] : null, s = step ? y * step[1] : null;
        const ring = step ? [[w, s], [w + step[0], s], [w + step[0], s + step[1]], [w, s + step[1]], [w, s]] : row[5];
        if (!ring) continue;
        const value = row[valueIndex];
        let cell = { type: "Feature", geometry: { type: "Polygon", coordinates: [ring] }, properties: {
          value: value ?? 0, unavailable: value == null, carried: layer === "scenario" && !row[6],
        } };
        if (context().bounds) cell = L.clip(cell, review.bounds);
        if (cell && step && clip) {
          cell = clip.clip(cell, [w, s, w + step[0], s + step[1]]);
        }
        if (cell) features.push(cell);
      }
      source("review-grid", L.collection(features));
      const colors = layer === "priority" ? ["interpolate", ["linear"], ["get", "value"], ...priorityColors.flat()] :
        layer === "reduction" ? ["interpolate", ["linear"], ["get", "value"], -2, "#dc785a", 0, "#827878", 1, "#a3dbbd", 3, "#e4ffce"] : L.color("utci");
      map.setPaintProperty("review-grid-fill", "fill-color", ["case", ["get", "unavailable"], "#8d8a87", colors]);
      $("review-map-label").textContent = modes[layer][0] + (layer === "priority" ? " · " + review.group : "");
      $("review-map-ramp").style.background = layer === "priority"
        ? "linear-gradient(90deg," + priorityColors.map(([value, color]) => color + " " + value / priorityTop * 100 + "%").join(",") + ")"
        : layer === "reduction" ? "" : "linear-gradient(90deg," + L.layers.utci.colors.join(",") + ")";
      $("review-map-ramp").dataset.mode = layer;
      const [min, max] = L.layers.utci.range;
      const range = layer === "priority" ? "0 to ≥" + priorityTop + " points" : layer === "reduction" ? "≤−2 to ≥3°C" : `≤${min} to ≥${max}°C`;
      const resolution = grid.metres === 500 ? layer === "priority" ? "500 m overview · peak 100 m score" : "500 m overview" : "100 m walking cells";
      $("review-map-caption").textContent = `${range} · ${resolution} · ${utc(review.timeUtc)}`;
      const coverage = { scenario: "Dim cells carry forward baseline UTCI. Brighter cells contain valid shade pairs.",
        reduction: "Gray marks cells without a valid shade pair.", priority: "Census residence weights · gray marks no census match." };
      $("review-map-coverage").textContent = coverage[layer] ?? "";
      $("review-map-coverage").hidden = !coverage[layer];
      for (const button of document.querySelectorAll("[data-review-layer]")) {
        button.setAttribute("aria-pressed", String(button.dataset.reviewLayer === layer));
        const mode = button.dataset.reviewLayer;
        button.hidden = mode === "priority" && !review.censusShare;
        button.disabled = mode === "priority" ? !review.censusShare : mode !== "baseline" && !review.pairedCells;
      }
      $("review-street-toggle").setAttribute("aria-pressed", String(showStreets));
      $("review-street-toggle").disabled = !review.streets;
      $("review-street-toggle").title = review.streets ? "Sun, building shade, canopy shade and partial shade" : "Timestamp-matched street geometry needed for this case";
    }

    function paint() {
      const show = active() && Boolean(analysis);
      $("review-map-tools").hidden = !show;
      if (!show) {
        for (const name of ["review-grid", "review-street-segments", "review-pins", "review-selection"]) source(name);
        return;
      }
      renderGrid();
      source("review-pins", L.collection(analysis.review.candidates.map((item, index) => point(item.coordinates, { rank: String(index + 1) }))));
      renderLocation();
    }

    function render() {
      $("review-report").disabled = !snapshot;
      const summary = $("review-summary"), candidates = $("review-candidates");
      summary.replaceChildren();
      candidates.replaceChildren();
      if (analysis) {
        const result = analysis.review;
        summary.append(R.element("h2", "Selected walking network"), measures(summaryRows(result)));
        summary.append(R.element("p", "A shade comparison needs at least 20 m each of sunlit and building-shaded routes in the same 100 m cell. Other cells carry forward their baseline UTCI.", "data-note"));
        if (!result.streets) summary.append(R.element("p", "Street linework requires a shade split for this model time. Grid review is available.", "data-note"));
        if (result.census && !result.candidates.length) candidates.append(R.element("p", result.censusShare
          ? "No census-matched cell reaches a positive field priority score in this area."
          : "No walking cells match this census group in the selected area.", "data-note"));
        if (result.candidates.length) {
          const list = R.element("div", null, "review-candidate-list");
          list.append(...result.candidates.map((item, i) => R.button(item.priority
            ? `${i + 1} · ${num(item.priority.score, 2)} points · ${pct(item.priority.share)} resident share · ${temp(item.baseline)}`
            : `${i + 1} · ${temp(item.baseline)} · ${metres(item.sunM)} sunlit`, () => pick(item.coordinates, true))));
          candidates.append(R.element("h3", result.census ? "Field priorities · " + result.group : "Hot sunlit cells"), list);
        }
      }
      paint();
    }

    async function viewport() {
      if (!analysis || !active()) return;
      const current = ++mapRequest;
      const b = map.getBounds().toArray().flat();
      const result = analysis.review;
      const viewBounds = intersect(result.bounds, b);
      const detail = intersects(result.bounds, b) && viewBounds[2] - viewBounds[0] <= .065 && viewBounds[3] - viewBounds[1] <= .048;
      gridInView = undefined;
      source("review-street-segments");
      mapStatus(showStreets ? detail ? "Loading the modelled shade on walking routes…" : "Zoom in to inspect street shade." : "");
      const base = input();
      const checks = [detail && result.grid.metres === 500 ? request({ ...base, kind: "review", bounds: viewBounds }) : null,
        detail && showStreets ? request({ ...base, kind: "review-streets", viewport: b }) : null];
      const [detailed, streets] = await Promise.allSettled(checks);
      if (current !== mapRequest || !active() || analysis?.review !== result) return;
      if (detailed.value?.ok) gridInView = detailed.value.review.grid;
      renderGrid();
      if (streets.value?.ok) {
        source("review-street-segments", streets.value.streets);
        mapStatus(streets.value.streets.features.length ? "Amber sun · blue building shade · green canopy · violet partial shade" : "No modelled streets in this view.");
      } else if (streets.value) mapStatus(streets.value.reply);
      else if (streets.status === "rejected") mapStatus("Street shade could not load. Move the map to retry.");
    }

    async function pick(coordinates, move) {
      if (!analysis || !canInspect()) return;
      const check = ++revision;
      const match = analysis.review.candidates.find(item => item.id === coordinates.join(","));
      draft();
      status("Reading the evidence at this location…");
      const load = match ? Promise.resolve({ ok: true, cell: match }) : request({ ...input(), kind: "review", point: coordinates });
      pendingLocation = load;
      try {
        const data = await load;
        if (check !== revision || !active()) return;
        if (!data.ok) { status(data.reply); return; }
        location = data.cell;
        revealLocation();
        if (move) focusMap(location.coordinates);
      } catch {
        if (check === revision && active()) status("This cell could not load. Select it again to retry.");
      } finally {
        if (pendingLocation === load) pendingLocation = undefined;
      }
    }

    async function analyze(question, progress) {
      if (pendingLocation) await pendingLocation;
      const options = input();
      const stamp = key(options), check = ++revision;
      draft();
      status("Checking the selected model and location…");
      if (stamp !== inputKey || !analysis) {
        const data = await request({ ...options, kind: "review" }, progress);
        if (check !== revision || !active()) return;
        if (!data.ok) { status(data.reply); return { ok: false, text: data.reply }; }
        analysis = data;
        inputKey = stamp;
        gridInView = undefined;
        if (!data.review.pairedCells) layer = "baseline";
        if (data.review.censusShare) layer = "priority";
        showStreets = showStreets && Boolean(data.review.streets);
        if (!location) location = data.review.candidates[0];
        render();
        void viewport();
      }
      const result = analysis.review;
      const evidence = evidenceText(result, location);
      progress("Preparing the evidence and field checks…");
      const summary = await narrate(question, { reply: evidence, timeUtc: result.timeUtc, region: result.region,
        baseline: result.baseline, scenario: result.scenario, reduction: result.reduction,
        pairedSharePct: Number((result.pairedShare * 100).toFixed(1)), location, group: result.group,
        ...(result.census ? { census: result.census, censusCoverage: result.censusShare, priorityMethod,
          interpretation: "The census measures where people live. The score screens locations for a field visit." } : {}) });
      if (check !== revision || !active()) return;
      snapshot = { id: check, result, location, summary: summary ?? evidence };
      render();
      status("Briefing ready. Pick another location to review its evidence.");
      return { ok: true, briefingId: check, generated: Boolean(summary), text: snapshot.summary + "\n\n" + result.checks[0] + " " + result.recommendation };
    }

    function reset(message = "") {
      revision++;
      mapRequest++;
      analysis = location = inputKey = gridInView = pendingLocation = undefined;
      layer = "baseline";
      showStreets = false;
      draft();
      status(message);
      render();
    }

    function restore() {
      const meta = census();
      const focus = $("review-focus");
      for (const option of focus.options) option.disabled = option.value !== "all" && !meta?.groups.includes(option.value);
      if (focus.selectedOptions[0].disabled) focus.value = "all";
      $("review-focus-note").textContent = meta
        ? `${meta.source}. Resident groups change the field priorities. The UTCI maps show the thermal conditions.`
        : "This case needs matched census data for resident-group priorities.";
      const options = input();
      $("review-context").textContent = num(options.shadePercent) + "% of sunlit length converted using the Act 4 assumption.";
      if (analysis && key(options) !== inputKey) reset("Configuration changed. Run AI Analyze to update the briefing.");
      else paint();
    }

    function openReport(expected) {
      if (!snapshot || expected != null && expected !== snapshot.id) return false;
      $("review-briefing-content").replaceChildren(briefing(snapshot));
      if (!$("review-briefing").open) $("review-briefing").showModal();
      return true;
    }

    $("review-focus").onchange = () => reset("Run AI Analyze to rank the walking cells for this selection.");
    for (const button of document.querySelectorAll("[data-review-layer]")) button.onclick = () => {
      layer = button.dataset.reviewLayer;
      renderGrid();
    };
    $("review-street-toggle").onclick = () => {
      showStreets = !showStreets;
      renderGrid();
      if (showStreets && map.getZoom() < 13.7) {
        const coordinates = location?.coordinates ?? analysis.review.candidates[0]?.coordinates;
        if (coordinates) focusMap(coordinates);
      }
      void viewport();
    };
    $("review-report").onclick = () => openReport();
    $("review-download").onclick = () => {
      if (!snapshot) return;
      const url = URL.createObjectURL(new Blob([standalone(briefing(snapshot))], { type: "text/html;charset=utf-8" }));
      const link = R.element("a");
      link.download = `Heatline-${snapshot.result.region}-${snapshot.result.event}-review.html`;
      link.href = url;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    };
    $("review-print").onclick = () => {
      if (!snapshot) return;
      const frame = R.element("iframe");
      frame.title = "Printable Heatline briefing";
      frame.style.cssText = "position:fixed;width:1px;height:1px;border:0;inset:auto 0 0 auto";
      frame.addEventListener("load", () => {
        frame.contentWindow.addEventListener("afterprint", () => frame.remove(), { once: true });
        frame.contentWindow.print();
      }, { once: true });
      frame.srcdoc = standalone(briefing(snapshot));
      document.body.append(frame);
    };

    return { install, paint, restore, reset, viewport, analyze, openReport, ready: () => Boolean(analysis),
      checks: () => snapshot?.result.checks.join(" ") };
  }

  window.HEATLINE_REVIEW = { create };
})();
