(() => {
  "use strict";

  function create({ map, read, changed }) {
    const $ = id => document.getElementById(id), A = window.HEATLINE_ARCHIVE, R = window.HEATLINE_RESULTS;
    const controls = $("district-controls"), level = $("district-level"), filter = $("district-filter");
    const first = $("district-first"), second = $("district-second"), note = $("district-note"), result = $("district-result");
    const choices = new Map(), colors = ["#f4b371", "#82cad3"];
    const source = "district-areas", empty = { type: "FeatureCollection", features: [] };
    let region, active = false, loading = false, disabled = false, catalogue, pending, layers, selections, revision = 0;
    let outlineClip, selectedBounds;
    const layer = () => layers?.find(item => item.level === selections?.level);
    const units = () => [selections?.first, selections?.second].map(id => layer()?.units.find(unit => unit.id === id));
    const activeArea = () => active && Boolean(selections?.first);
    const payload = () => activeArea() ? { level: selections.level, first: selections.first, second: selections.second || undefined } : undefined;

    function install() {
      map.addSource(source, { type: "geojson", data: empty });
      map.addLayer({ id: source + "-fill", type: "fill", source, paint: { "fill-color": ["get", "color"], "fill-opacity": .09 } });
      map.addLayer({ id: source + "-outline", type: "line", source, paint: { "line-color": ["get", "color"], "line-width": 2.3, "line-opacity": .96 } });
    }

    function available() {
      return Boolean(active && !disabled && !loading && layer());
    }

    function syncAvailability() {
      for (const item of [level, filter, first]) item.disabled = !available();
      second.disabled = !available() || !activeArea();
      $("district-weather").disabled = !available() || !activeArea();
    }

    function fillUnits() {
      const options = layer()?.units ?? [];
      const query = filter.value.trim().toLowerCase();
      const visible = options.filter(unit => !query || (unit.name + " " + unit.code).toLowerCase().includes(query) ||
        selections.first === unit.id || selections.second === unit.id);
      const put = (select, value, exclude, caption) => {
        select.replaceChildren(new Option(caption, ""));
        for (const unit of visible) {
          if (unit.id === exclude) continue;
          select.add(new Option(`${unit.name} · ${unit.code}${unit.edge ? " \u00b7 edge overlap" : ""}`, unit.id));
        }
        select.value = value;
      };
      put(first, selections.first, undefined, "Use the current map scope");
      put(second, selections.second, selections.first, "No comparison");
      $("district-filter-row").hidden = options.length <= 120;
      syncAvailability();
    }

    function guidance() {
      const item = layer(), [a, b] = units();
      if (!item) return "Administrative boundaries are unavailable for this case.";
      if (!a) return `Choose an area to scope the analysis. ${item.full ? "ONS 2021 borough boundaries" : "Areas clipped to the metropolitan study boundary"}.`;
      return `${a.name}${b ? " and " + b.name : ""}. ${item.full ? "ONS borough boundaries" : "Results use the portions inside the study area"}.`;
    }

    async function paint(frame = false) {
      const check = ++revision, current = layer();
      outlineClip = selectedBounds = undefined;
      map.getSource(source)?.setData(empty);
      const [a, b] = units();
      if (!active || !a || !current) return;
      loading = true;
      note.textContent = "Loading administrative boundaries…";
      syncAvailability();
      try {
        const shapes = await Promise.all([a, b].filter(Boolean).map(async (unit, i) => {
          const { features } = await read(`districts/${current.asset}-${unit.shard}.geojson`);
          const shape = features.find(feature => feature.id === unit.id);
          if (!shape) throw new Error("Administrative boundary is missing");
          return { ...shape, properties: { ...shape.properties, color: colors[i] } };
        }));
        if (check !== revision) return;
        outlineClip = A.boundaryIndex(shapes[0], a.bounds);
        const [x, y, e, n] = a.bounds, other = b?.bounds ?? a.bounds;
        selectedBounds = [Math.min(x, other[0]), Math.min(y, other[1]), Math.max(e, other[2]), Math.max(n, other[3])];
        map.getSource(source)?.setData({ type: "FeatureCollection", features: shapes });
        note.textContent = guidance();
        if (frame) changed("frame", selectedBounds);
      } catch {
        if (check === revision) note.textContent = "The administrative boundary could not load. Select the area again.";
      } finally {
        if (check === revision) { loading = false; syncAvailability(); }
      }
    }

    async function show(next, visible) {
      controls.hidden = !visible;
      if (active === visible && region === next && layers) return;
      region = next;
      active = visible;
      const check = ++revision;
      loading = false;
      outlineClip = selectedBounds = undefined;
      map.getSource(source)?.setData(empty);
      if (!visible) return;
      loading = true;
      syncAvailability();
      try {
        pending ??= read("districts/catalog.json").catch(error => { pending = undefined; throw error; });
        catalogue ??= await pending;
        if (check !== revision) return;
        layers = catalogue.cities[next] ?? [];
        if (!choices.has(next)) choices.set(next, { level: layers[0]?.level, first: "", second: "" });
        selections = choices.get(next);
        level.replaceChildren(...layers.map(item => new Option(item.label, item.level)));
        level.value = selections.level;
        $("district-level-row").hidden = layers.length < 2;
        filter.value = "";
        loading = false;
        fillUnits();
        note.textContent = guidance();
        void paint();
      } catch {
        if (check === revision) { note.textContent = "Administrative boundaries could not load. Reopen the city case to retry."; syncAvailability(); }
      }
    }

    function updateSelection() {
      fillUnits();
      note.textContent = guidance();
      changed("selection");
      void paint(true);
    }

    function reset() {
      if (!activeArea()) return;
      selections.first = selections.second = "";
      updateSelection();
    }

    level.onchange = () => { selections.level = level.value; selections.first = selections.second = filter.value = ""; updateSelection(); };
    first.onchange = () => {
      selections.first = first.value;
      if (!first.value || first.value === selections.second) selections.second = "";
      updateSelection();
    };
    second.onchange = () => { selections.second = second.value; updateSelection(); };
    filter.oninput = fillUnits;

    const numeric = (value, unit, signed = false) => Number.isFinite(value) ?
      (signed && value > 0 ? "+" : "") + R.format(value, unit ? 2 : 0) + (unit ? " " + unit : "") : "—";

    function render(data) {
      result.replaceChildren();
      result.hidden = !data;
      if (!data) return;
      const [a, b] = data.areas;
      result.append(R.element("h2", b ? "Administrative area comparison" : "Administrative area result"));
      const names = R.element("div", null, "district-names");
      for (const [i, area] of data.areas.entries()) {
        const card = R.element("div", null, "district-name");
        const time = area.time?.replace("T", " ").replace("Z", "") ?? "";
        card.append(R.element("strong", `${i ? "B" : "A"} · ${area.name}`),
          R.element("p", [area.code, time && time + " UTC"].filter(Boolean).join(" · ")));
        if (!data.full) card.append(R.element("p", numeric(area.areaKm2, "km²") + " inside the study area · " + numeric(area.fraction * 100, "%") + " of this unit"));
        if (!area.ok) card.append(R.element("p", area.message));
        names.append(card);
      }
      result.append(names);
      const labels = new Map([...a.metrics, ...(b?.metrics ?? [])].map(([label, , unit]) => [label, unit]));
      if (labels.size) {
        const table = R.element("table", null, "district-table");
        const head = R.element("thead"), columns = R.element("tr");
        for (const text of b ? ["Measure", "A", "B", "A − B"] : ["Measure", "A"]) columns.append(R.element("th", text));
        head.append(columns);
        const body = R.element("tbody");
        for (const [label, unit] of labels) {
          const first = a.metrics.find(metric => metric[0] === label)?.[1];
          const second = b?.metrics.find(metric => metric[0] === label)?.[1];
          const row = R.element("tr");
          row.append(R.element("th", label), R.element("td", numeric(first, unit)));
          if (b) row.append(R.element("td", numeric(second, unit)), R.element("td", numeric(
            a.time === b.time && Number.isFinite(first) && Number.isFinite(second) ? first - second : null, unit === "%" ? "pp" : unit, true)));
          body.append(row);
        }
        table.append(head, body);
        result.append(table);
      }
      const link = R.element("a", data.source, "method-link");
      link.href = data.url;
      result.append(R.element("p", data.attribution + (b && data.kind !== "weather" ? ". The detailed result map shows area A." : "")), link);
    }

    return { install, show, payload, active: activeArea, clip: () => outlineClip, bounds: () => selectedBounds,
      label: () => units().filter(Boolean).map(unit => unit.name).join(" · "), reset, render,
      setBusy(value) { disabled = value; syncAvailability(); } };
  }

  window.HEATLINE_DISTRICTS = { create };
})();
