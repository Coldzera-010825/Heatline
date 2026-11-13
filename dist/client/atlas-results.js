(() => {
  const colors = ["#f6ab79", "#82c9d0"];
  const format = (n, digits = 2) => Number(n).toLocaleString("en-GB", { maximumFractionDigits: digits });
  const percent = value => value > 0 && value < .0005 ? "<0.1%" : (100 * value).toFixed(1) + "%";
  const distance = m => m < 1000 ? format(m, 0) + " m" : format(m / 1000) + " km";
  const reducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
  function element(tag, text, className) {
    const item = document.createElement(tag);
    if (text != null) item.textContent = text;
    if (className) item.className = className;
    return item;
  }

  function button(text, click) {
    const item = element("button", text);
    item.type = "button";
    item.onclick = click;
    return item;
  }

  function typeText(node, text, onUpdate = () => {}, { interval = 15, maximum = 3900 } = {}) {
    const letters = Array.from(text);
    if (reducedMotion() || !letters.length) {
      node.textContent = text;
      onUpdate();
      return Promise.resolve();
    }
    const duration = Math.min(maximum, Math.max(480, letters.length * interval));
    const start = performance.now();
    let shown = 0;
    node.textContent = "";
    node.setAttribute("aria-busy", "true");
    node.classList.add("typing-text");
    return new Promise(resolve => {
      function tick(now) {
        const count = Math.min(letters.length, Math.max(1, Math.ceil((now - start) / duration * letters.length)));
        if (count !== shown) {
          node.textContent = letters.slice(0, count).join("");
          shown = count;
          onUpdate();
        }
        if (count < letters.length) requestAnimationFrame(tick);
        else {
          node.classList.remove("typing-text");
          node.removeAttribute("aria-busy");
          resolve();
        }
      }
      requestAnimationFrame(tick);
    });
  }

  function table(label, rows) {
    const result = element("table");
    result.setAttribute("aria-label", label);
    for (const [key, value] of rows) {
      const row = result.insertRow();
      const heading = element("th", key);
      heading.scope = "row";
      row.append(heading, element("td", value));
    }
    return result;
  }

  function details(title, ...paragraphs) {
    const item = element("details");
    item.append(element("summary", title), ...paragraphs.filter(Boolean).map(text => element("p", text)));
    return item;
  }

  function options(items, onChange, active = items[0][0]) {
    const row = element("div", null, "result-options");
    for (const [value, label] of items) {
      const item = button(label, () => {
        onChange(value);
        for (const [i, child] of [...row.children].entries()) child.setAttribute("aria-pressed", String(items[i][0] === value));
      });
      item.setAttribute("aria-pressed", String(value === active));
      row.append(item);
    }
    return row;
  }

  function bars(title, groups) {
    const panel = element("div", null, "bar-chart");
    panel.append(element("strong", title));
    for (const [index, [label, ...values]] of groups.entries()) {
      const row = element("div", null, "bar-chart-row");
      row.style.setProperty("--bar-delay", Math.min(index, 8) * 55 + "ms");
      row.append(element("span", label));
      const group = element("div");
      values.forEach((value, i) => {
        const series = element("div", null, "bar-series");
        const line = element("span", null, "bar-track");
        const fill = element("i");
        fill.style.width = (Number.isFinite(value) ? 100 * value : 0) + "%";
        fill.style.background = colors[i];
        line.append(fill);
        series.append(line, element("span", Number.isFinite(value) ? percent(value) : "—"));
        group.append(series);
      });
      row.append(group);
      panel.append(row);
    }
    return panel;
  }

  function svgNode(tag, attributes, value) {
    const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
    for (const [key, v] of Object.entries(attributes)) node.setAttribute(key, v);
    if (value != null) node.textContent = value;
    return node;
  }

  function seriesLegend(names) {
    const row = element("div", null, "plot-legend");
    names.forEach((name, index) => {
      const label = element("span", name);
      label.style.setProperty("--series-color", colors[index]);
      row.append(label);
    });
    return row;
  }

  function lineChart(chart, day, names) {
    const values = chart.rows.flatMap(row => row.slice(1)).filter(Number.isFinite);
    const card = element("div", null, "line-chart");
    card.append(element("strong", chart.label + " (" + chart.unit + ")"));
    if (!values.length) {
      card.append(element("p", "No observations in this period."));
      return card;
    }
    const low = Math.min(...values), high = Math.max(...values);
    const padding = Math.max(.05, .1 * (high - low));
    const min = low - padding, max = high + padding;
    const start = Date.UTC(2022, 6, day ?? 13);
    const end = start + (day ? 1 : 7) * 86400000;
    const x = time => 41 + (Date.parse(time) - start) / (end - start) * 261;
    const y = value => 87 - (value - min) / (max - min) * 72;
    const svg = svgNode("svg", { viewBox: "0 0 322 113", role: "img",
      "aria-label": chart.label + " in " + chart.unit + " from " + (day ? day + " July" : "13 to 19 July") + ", UTC" });
    for (const value of [min, (min + max) / 2, max]) {
      svg.append(svgNode("line", { x1: 41, x2: 302, y1: y(value), y2: y(value), stroke: "#4b4239" }));
      svg.append(svgNode("text", { x: 35, y: y(value) + 3, "text-anchor": "end", fill: "#bcb0a3" }, format(value, 1)));
    }
    const labels = day ? ["00h", "06h", "12h", "18h", "24h"] : ["13 Jul", "15 Jul", "17 Jul", "19 Jul"];
    labels.forEach((label, i) => {
      svg.append(svgNode("text", { x: 41 + 261 * i * (day ? .25 : 2 / 7), y: 103,
        "text-anchor": "middle", fill: "#c7b6a4" }, label));
    });
    names.forEach((name, series) => {
      let path = "", previous;
      for (const row of chart.rows) {
        const time = Date.parse(row[0]), value = row[series + 1];
        if (!Number.isFinite(value)) { previous = undefined; continue; }
        const px = x(row[0]).toFixed(2), py = y(value).toFixed(2);
        path += (time - previous === 3600000 ? "L" : "M") + px + " " + py + " ";
        const point = svgNode("circle", { class: "chart-dot", cx: px, cy: py, r: chart.rows.length > 48 ? 1.1 : 2.2, fill: colors[series] });
        point.append(svgNode("title", {}, name + " · " + row[0].slice(5, 16).replace("T", " ") + " UTC · " + value + " " + chart.unit));
        svg.append(point);
        previous = time;
      }
      svg.prepend(svgNode("path", { class: "chart-line", pathLength: 1, d: path, fill: "none", stroke: colors[series], "stroke-width": 1.6 }));
    });
    card.append(svg);
    return card;
  }

  function stationPlots(charts, day, names, weather = true) {
    const plots = element("div", null, "station-plots");
    if (names.length > 1) plots.append(seriesLegend(names));
    const temperature = charts.find(field => field.id === "temperature");
    if (temperature) plots.append(lineChart(temperature, day, names));
    const fields = charts.filter(field => field.id !== "temperature" && field.rows.some(row => row.slice(1).some(Number.isFinite)));
    if (fields.length && weather) {
      const control = element("select");
      control.setAttribute("aria-label", "Weather variable for the UTC time series");
      for (const field of fields) control.add(new Option(field.label, field.id));
      const graph = element("div", null, "station-weather");
      control.onchange = () => {
        delete graph.dataset.firstReveal;
        graph.replaceChildren(lineChart(fields.find(field => field.id === control.value), day, names));
      };
      control.onchange();
      graph.dataset.firstReveal = "";
      plots.append(control, graph);
    }
    return plots;
  }

  function observations(data, day) {
    const rows = data.rows.filter(row => !day || row[0].startsWith("2022-07-" + day));
    const charts = data.fields.map((field, i) => ({ ...field, rows: rows.map(row => [row[0], row[i + 1]]) }));
    const plots = stationPlots(charts, day, [data.name]);
    plots.classList.add("station-preview");
    return plots;
  }

  function weatherReference(data) {
    const { official, station } = data;
    const card = element("div", null, "reference-card");
    const lead = element("div", null, "reference-peak");
    const source = element("a", "Met Office");
    source.href = official.url;
    source.target = "_blank";
    source.rel = "noopener noreferrer";
    lead.append(element("strong", official.london.value.toFixed(1) + "°C"), element("span", "Heathrow · 19 July"), source);
    const peak = station.rows.reduce((best, row) => row[1] > best[1] ? row : best);
    const chart = lineChart({ label: station.name + " · hourly air temperature", unit: "°C", rows: station.rows }, undefined, [station.name]);
    const archive = element("a", station.source);
    archive.href = station.url;
    archive.target = "_blank";
    archive.rel = "noopener noreferrer";
    const credit = element("p", null, "data-note");
    credit.append(archive, document.createTextNode(" · Peak hourly reading " + peak[1].toFixed(1) + "°C, " +
      peak[0].slice(8, 10) + " July " + peak[0].slice(11, 16) + " UTC. Different station from Heathrow."));
    card.append(lead, chart, credit);
    return card;
  }

  function regionalWeather({ regions, archives, dates, date }, focus) {
    const panel = element("div");
    const stats = element("div", null, "regional-summary");
    const names = regions.map(region => region.name);
    const series = archives.map(archive => new Map(archive.daily.map(row => [row[0], row])));
    regions.forEach((region, i) => {
      const row = series[i].get(date);
      const card = element("div", null, "regional-stat");
      card.style.setProperty("--series-color", colors[i]);
      const place = button(region.name + " ↗", () => focus(region.bbox));
      place.className = "secondary-action";
      place.title = "Zoom to the " + region.name + " study rectangle";
      card.append(place, element("strong", Number.isFinite(row?.[1]) ? row[1].toFixed(2) + "°C" : "No data"),
        element("small", (Number.isFinite(row?.[2]) ? percent(Math.min(1, row[2])) + " population matched" : "No matched population") +
          " · GHS-POP 2020 · study rectangle"));
      stats.append(card);
    });
    const chart = element("div", null, "line-chart");
    chart.append(element("strong", "Population-weighted daily maximum 2 m air temperature (°C)"));
    const values = series.flatMap(byDate => dates.map(day => byDate.get(day)?.[1])).filter(Number.isFinite);
    if (values.length) {
      const min = Math.floor(Math.min(...values) / 5) * 5;
      const max = Math.max(min + 5, Math.ceil(Math.max(...values) / 5) * 5);
      const x = i => 32 + 272 * i / Math.max(1, dates.length - 1);
      const y = v => 91 - 74 * (v - min) / (max - min);
      const svg = svgNode("svg", { viewBox: "0 0 322 118", role: "img",
        "aria-label": "Daily maximum 2 m air temperature series for " + names.join(" and ") + ", UTC" });
      for (const v of [min, (min + max) / 2, max]) {
        svg.append(svgNode("line", { x1: 32, x2: 304, y1: y(v), y2: y(v), stroke: "#564335" }),
          svgNode("text", { x: 28, y: y(v) + 3, "text-anchor": "end", fill: "#d6c2af" }, format(v, 1)));
      }
      const selected = x(dates.indexOf(date));
      svg.append(svgNode("line", { x1: selected, x2: selected, y1: 12, y2: 91, stroke: "#f3d4ae", "stroke-dasharray": "2 3" }));
      for (const i of new Set([0, Math.floor((dates.length - 1) / 2), dates.length - 1])) {
        const t = dates[i].slice(5).replace("-", "/");
        svg.append(svgNode("text", { x: x(i), y: 108, "text-anchor": "middle", fill: "#d6c2af" }, t));
      }
      series.forEach((byDate, i) => {
        let path = "", previous = false;
        dates.forEach((day, j) => {
          const value = byDate.get(day)?.[1];
          if (!Number.isFinite(value)) { previous = false; return; }
          path += (previous ? "L" : "M") + x(j) + " " + y(value);
          previous = true;
          if (day === date) {
            const dot = svgNode("circle", { cx: x(j), cy: y(value), r: 3.5, fill: colors[i] });
            dot.append(svgNode("title", {}, names[i] + " · " + day + " · " + value.toFixed(2) + "°C"));
            svg.append(dot);
          }
        });
        svg.prepend(svgNode("path", { class: "chart-line", pathLength: 1, d: path, fill: "none", stroke: colors[i], "stroke-width": 1.9 }));
      });
      chart.append(svg);
    }
    panel.append(stats, seriesLegend(names), chart, element("p",
      "ERA5-Land model estimates. The chart weights valid cells by matched 2020 population. The map shows the cell values. " +
      "Missing cells are left blank. Study rectangles include surrounding areas.", "data-note"));
    return panel;
  }

  function render(result, callbacks) {
    const nodes = [];
    const analysis = result.analysis;
    const event = result.event;
    if (analysis) {
      const { cellCount, pathLengthM, meanUtci, minUtci, maxUtci, strongHeat, method, source, hotspots, stress, distribution } = analysis;
      nodes.push(element("h2", "Pedestrian heat exposure"), element("p", result.reply), table("Area heat statistics", [
        ["Model time", analysis.timeUtc.slice(0, 16).replace("T", " ") + " UTC"],
        ["Mean UTCI", format(meanUtci) + "°C"], ["Cell UTCI range", format(minUtci) + "–" + format(maxUtci) + "°C"],
        ["100 m cells", format(cellCount, 0)], ["Represented walking length", distance(pathLengthM)],
        ["Walking length in cells ≥32°C UTCI", percent(strongHeat.pathLengthShare)],
      ]));
      const spotList = element("div", null, "result-options");
      hotspots.slice(0, 3).forEach((spot, i) => spotList.append(button("Hotspot " + (i + 1) + " · " + format(spot.utci) + "°C", () => callbacks.hotspot(spot))));
      nodes.push(spotList);
      if (distribution?.length) nodes.push(bars("Walking length by 1°C UTCI interval", distribution.map(band => [band.from + "–" + (band.from + 1) + "°C", band.share])));
      const thresholds = details("Standard UTCI heat-stress categories");
      const reference = element("a", "Bröde et al. (2012), Table 3");
      reference.href = "https://doi.org/10.1007/s00484-011-0454-1";
      reference.target = "_blank";
      reference.rel = "noopener noreferrer";
      thresholds.append(bars("Walking length by heat stress", stress.map(band => [band.label, band.share])), reference);
      nodes.push(thresholds, details("How this was calculated", method, source));
    } else if (event.kind === "station") {
      const { day, hours, peaks, charts, associations, comparisonFields, referenceComparison, method } = event;
      nodes.push(element("h2", peaks.length === 2 ? "Station comparison" : "Station heat analysis"), element("p", result.reply));
      nodes.push(table("Station observations", [
        [peaks.length === 2 ? "Shared temperature hours" : "Observed temperature hours", format(hours, 0)],
        ...peaks.map(peak => [peak.name + " peak", format(peak.peak, 1) + "°C · " + peak.time.slice(8, 10) + " Jul " + peak.time.slice(11, 16) + " UTC"]),
      ]), stationPlots(charts, day, peaks.map(peak => peak.name)));
      if (comparisonFields.length) {
        nodes.push(table("Matched-hour mean differences, first minus second station", comparisonFields.map(field =>
          [field.label + " · " + field.hours + " h", format(field.meanDifference) + " " + field.unit])));
      } else if (associations.length) {
        nodes.push(table("Correlation with observed air temperature", associations.map(field =>
          [field.label + " · " + field.hours + " h", "r = " + field.r.toFixed(2)])));
      }
      if (referenceComparison?.some(row => row.hours)) {
        nodes.push(table("WOW minus NOAA St James’s Park at matching UTC times", referenceComparison.map(row =>
          [row.name + " · " + row.hours + " matched hours", row.hours ? format(row.difference) + "°C" : "No overlap"])));
      }
      nodes.push(details("Observation quality and method", method));
    } else if (event.kind === "population") {
      const { groups, group, reference, ranked, rankOrder } = event;
      nodes.push(element("h2", ranked ? "District ranking" : "Residential surface heat · " + event.place), element("p", result.reply));
      if (ranked) {
        const rankRows = ranked.map((entry, i) => [
          (i + 1) + ". " + entry.name,
          entry.mean.toFixed(2) + "°C · " + format(entry.matched, 0) + " matched (" + percent(entry.coverage) + ")",
        ]);
        const ranking = table((rankOrder === "asc" ? "Lowest" : "Highest") + " district mean LST", rankRows.slice(0, 5));
        ranking.className = "district-rank";
        nodes.push(ranking);
        if (rankRows.length > 5) {
          const more = details("All " + rankRows.length + " districts with matched residents");
          more.append(table("Complete district LST ranking", rankRows));
          nodes.push(more);
        }
      }
      const estimates = table("Census group estimates and matching coverage", Object.values(groups).map(item => [
        item.label,
        item.mean == null ? "No matched data" : item.mean.toFixed(2) + "°C · " + format(item.matched, 0) + " matched (" + percent(item.coverage) + ")",
      ]));
      estimates.className = "group-estimates";
      const date = event.timeUtc.slice(0, 16).replace("T", " ") + " UTC";
      nodes.push(estimates, element("p", format(event.matched, 0) + " of " + format(event.areas, 0) + " " +
        (event.areaUnit ?? "Output Areas") + " matched to Landsat on " + date + " · " +
        (event.censusYear ?? 2021) + " population baseline." + (event.inCore === false ? " Overpass outside the heatwave core." : ""), "data-note"));
      if (!ranked && groups[group].atLeast45 != null) {
        nodes.push(element("p", format(groups[group].atLeast45, 0) + " of " + format(groups[group].matched, 0) +
          " matched residents in the first group had a residential LST estimate ≥45°C.", "data-note"));
      }
      nodes.push(options(event.mapLayers, callbacks.layer, callbacks.variant),
        seriesLegend([groups[group].label, groups[reference].label]),
        bars("Share of matched residents by LST band (°C)", event.distribution.map(band => [band.label, band[group], band[reference]])),
        details("How this was calculated", event.method));
    } else if (event.kind === "shade") {
      nodes.push(element("h2", "Shade scenario"), element("p", result.reply), table("Eligible cells · baseline and shade scenario", [
        ["Baseline UTCI", format(event.before) + "°C"], ["Scenario UTCI", format(event.after) + "°C"],
        ["Scenario reduction · route-weighted", format(event.reduction) + "°C"],
        ["Existing sun vs building shade · median paired contrast", format(event.medianShadeContrast) + "°C"],
        ["Paired 100 m cells", format(event.pairedCells, 0)],
        ["Walking length in paired cells", distance(event.networkM)],
        ...(event.coverage ? [
          ["Modelled walking length in selection", distance(event.coverage.pathM)],
          ["Modelled length with eligible pairs", percent(event.coverage.share)],
        ] : []),
        ["Currently sunlit length in paired cells", distance(event.sunM)],
        ["Sunlit length converted to shade", distance(event.convertedM)],
      ]), options([["baseline", "Baseline map"], ["scenario", "Scenario map"]], callbacks.layer, callbacks.variant),
        details("Scenario assumptions and formula", event.method, event.formula, event.source));
      nodes.splice(2, 0, element("p", "The dashed outline marks a drawn selection. Coloured cells have eligible sun–shade pairs. " +
        (event.coverage?.city ? "Uncoloured routes have no eligible pair or no modelled path." : "Paired inputs cover only the outlined pilot."), "data-note"));
      if (event.selection) nodes.splice(4, 0, table("Whole modelled selection · other routes fixed", [
        ["Baseline UTCI", format(event.selection.before) + "°C"],
        ["Scenario UTCI", format(event.selection.after) + "°C"],
        ["Scenario reduction · route-weighted", format(event.selection.reduction) + "°C"],
      ]));
    }
    return nodes;
  }

  window.HEATLINE_RESULTS = { element, button, table, details, bars, seriesLegend, format, distance, reducedMotion, typeText, observations, weatherReference, regionalWeather, render };
})();
