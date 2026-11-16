(() => {
  "use strict";

  const letters = index => (index < 26 ? "" : letters(Math.floor(index / 26) - 1)) + String.fromCharCode(65 + index % 26);
  const palette = ["#f4b371", "#82cad3", "#b6a1e7", "#a3ce8c", "#ef92ac", "#8eafd9", "#e6cf88", "#7ac2a5"];
  const colorAt = index => palette[index] ?? `hsl(${Math.round(index * 137.508) % 360}, 65%, 72%)`;
  const empty = { type: "FeatureCollection", features: [] };

  function results(data) {
    const comparison = data?.districtComparison;
    if (!comparison) return data?.ok ? [{ result: data }] : [];
    return comparison.areas.flatMap(area => {
      const result = area.id === comparison.primaryId ? data : area.map;
      return area.ok && result ? [{ id: area.id, name: area.name, result }] : [];
    });
  }

  function create({ map, read, changed }) {
    const $ = id => document.getElementById(id), A = window.HEATLINE_ARCHIVE, R = window.HEATLINE_RESULTS;
    const controls = $("district-controls"), toggle = $("district-toggle"), level = $("district-level");
    const filter = $("district-filter"), note = $("district-note"), result = $("district-result");
    const single = $("district-single"), compare = $("district-compare"), add = $("district-add");
    const choices = new Map(), masks = new Map();
    const source = "district-areas";
    let region, visible = false, loading = false, disabled = false, catalogue, pending, layers = [], selection, revision = 0;
    let selectedBounds;
    const layer = () => layers.find(item => item.level === selection?.level);
    const open = () => Boolean(visible && selection?.open);
    const units = () => (selection?.ids ?? []).filter(Boolean).map(id => layer()?.units.find(unit => unit.id === id)).filter(Boolean);
    const ready = () => open() && !loading && selection.ids.every(id => id && masks.has(id));
    const payload = () => ready() ? { level: selection.level, ids: [...selection.ids] } : undefined;
    const selectId = index => index === 0 ? "district-first" : index === 1 ? "district-second" : "district-" + (index + 1);
    const defaultIds = mode => mode === "compare" ? ["", ""] : [""];

    function install() {
      map.addSource(source, { type: "geojson", data: empty });
      map.addLayer({ id: source + "-fill", type: "fill", source, paint: { "fill-color": ["get", "color"], "fill-opacity": .09 } });
      map.addLayer({ id: source + "-outline", type: "line", source, paint: { "line-color": ["get", "color"], "line-width": 2.3, "line-opacity": .96 } });
    }

    function syncAvailability() {
      toggle.hidden = !visible;
      toggle.disabled = disabled || !layer();
      toggle.setAttribute("aria-expanded", String(open()));
      controls.hidden = !open();
      const enabled = open() && !disabled && Boolean(layer());
      for (const input of controls.querySelectorAll("input, select, button")) input.disabled = !enabled;
      add.disabled ||= !ready() || selection.ids.length >= layer().units.length;
      $("district-weather").disabled ||= !ready();
    }

    function slot(index) {
      const id = selectId(index);
      const row = R.element("div", null, "district-choice");
      const label = R.element("label");
      label.htmlFor = id;
      const select = R.element("select");
      select.id = id;
      select.onchange = () => { selection.ids[index] = select.value; update(); };
      const remove = R.element("button", "×", "secondary-action district-remove");
      remove.type = "button";
      remove.setAttribute("aria-label", "Remove area " + letters(index));
      remove.onclick = () => {
        selection.ids.splice(index, 1);
        update();
        $(selectId(Math.min(index, selection.ids.length - 1)))?.focus();
      };
      const input = R.element("div", null, "district-choice-input");
      input.append(select, remove);
      row.append(label, input);
      return row;
    }

    function fillUnits() {
      const group = $("district-selects"), item = layer(), values = selection?.ids ?? [];
      const compareMode = selection?.mode === "compare";
      if (group.children.length !== values.length) group.replaceChildren(...values.map((_, i) => slot(i)));
      const query = filter.value.trim().toLowerCase();
      const options = (item?.units ?? []).filter(unit => values.includes(unit.id) ||
        !query || (unit.name + " " + unit.code).toLowerCase().includes(query));
      for (const [index, id] of values.entries()) {
        const row = group.children[index], select = $(selectId(index));
        row.querySelector("label").textContent = compareMode ? "Area " + letters(index) : "Area";
        row.querySelector("button").hidden = values.length <= 2;
        select.replaceChildren(new Option("Choose an area", ""), ...options
          .filter(unit => unit.id === id || !values.includes(unit.id))
          .map(unit => new Option(unit.name + " · " + unit.code + (unit.edge ? " · edge overlap" : ""), unit.id)));
        select.value = id;
      }
      single.setAttribute("aria-pressed", String(!compareMode));
      compare.setAttribute("aria-pressed", String(compareMode));
      add.hidden = !compareMode;
      $("district-level-row").hidden = layers.length < 2;
      $("district-filter-row").hidden = !item || item.units.length <= 120;
      syncAvailability();
    }

    function guidance() {
      const item = layer();
      if (!item) return "Administrative boundaries are unavailable for this case.";
      const coverage = item.full ? "ONS 2021 borough boundaries." : "Results use the portions inside the study area.";
      if (!ready()) return (selection.mode === "compare" ? "Choose a different area for each row. " : "Choose an area to analyse. ") + coverage;
      return coverage;
    }

    function clearShapes() {
      masks.clear();
      selectedBounds = undefined;
      map.getSource(source)?.setData(empty);
    }

    async function paint(frame) {
      const check = ++revision, current = layer(), selected = units();
      clearShapes();
      loading = Boolean(open() && current && selected.length);
      syncAvailability();
      if (!loading) { note.textContent = guidance(); return; }
      note.textContent = "Loading administrative boundaries…";
      try {
        const shapes = await Promise.all(selected.map(async unit => {
          const color = colorAt(selection.ids.indexOf(unit.id));
          const { features } = await read(`districts/${current.asset}-${unit.shard}.geojson`);
          const shape = features.find(feature => feature.id === unit.id);
          if (!shape) throw new Error("Administrative boundary is missing");
          return { ...shape, properties: { ...shape.properties, color } };
        }));
        if (check !== revision) return;
        for (const [index, unit] of selected.entries()) {
          masks.set(unit.id, A.boundaryIndex(shapes[index], unit.bounds));
          const [w, s, e, n] = unit.bounds;
          const [x, y, a, b] = selectedBounds ?? unit.bounds;
          selectedBounds = [Math.min(w, x), Math.min(s, y), Math.max(e, a), Math.max(n, b)];
        }
        map.getSource(source)?.setData({ type: "FeatureCollection", features: shapes });
        loading = false;
        note.textContent = guidance();
        changed(frame ? "frame" : "ready", selectedBounds);
      } catch {
        if (check === revision) note.textContent = "The administrative boundary could not load. Select the area again.";
      } finally {
        if (check === revision) { loading = false; syncAvailability(); }
      }
    }

    async function show(next, on) {
      if (visible === on && region === next && (selection || loading)) return;
      region = next;
      visible = on;
      const check = ++revision;
      clearShapes();
      loading = false;
      selection = undefined;
      layers = [];
      syncAvailability();
      if (!on) return;
      loading = true;
      try {
        pending ??= read("districts/catalog.json").catch(error => { pending = undefined; throw error; });
        catalogue ??= await pending;
        if (check !== revision) return;
        layers = catalogue.cities[next] ?? [];
        if (layers.length && !choices.has(next)) choices.set(next, { open: false, level: layers[0].level, mode: "single", ids: [""] });
        selection = choices.get(next);
        level.replaceChildren(...layers.map(item => new Option(item.label, item.level)));
        if (selection) level.value = selection.level;
        filter.value = "";
        fillUnits();
        void paint(false);
      } catch {
        if (check === revision) { loading = false; syncAvailability(); }
      }
    }

    function update() {
      fillUnits();
      void paint(true);
      changed("selection");
    }

    function setMode(mode) {
      if (selection.mode === mode) return;
      selection.mode = mode;
      selection.ids = mode === "compare" ? [selection.ids[0], ""] : [selection.ids[0]];
      update();
    }

    function reset() {
      if (!open()) return;
      selection.open = false;
      selection.ids = defaultIds(selection.mode);
      update();
    }

    toggle.onclick = () => {
      if (open()) { reset(); return; }
      selection.open = true;
      update();
      $(selectId(0))?.focus();
    };
    single.onclick = () => setMode("single");
    compare.onclick = () => setMode("compare");
    level.onchange = () => {
      selection.level = level.value;
      selection.ids = defaultIds(selection.mode);
      filter.value = "";
      update();
    };
    add.onclick = () => {
      selection.ids.push("");
      update();
      $(selectId(selection.ids.length - 1))?.focus();
    };
    filter.oninput = fillUnits;

    const numeric = (value, unit, signed = false) => Number.isFinite(value) ?
      (signed && value > 0 ? "+" : "") + R.format(value, unit ? 2 : 0) + (unit ? " " + unit : "") : "—";

    function render(data) {
      result.replaceChildren();
      result.hidden = !data;
      if (!data) return;
      const { areas } = data;
      const pair = areas.length === 2;
      result.append(R.element("h2", areas.length > 1 ? "Administrative area comparison" : "Administrative area result"));
      const names = R.element("div", null, "district-names");
      for (const [i, area] of areas.entries()) {
        const card = R.element("div", null, "district-name");
        card.style.setProperty("--district-color", colorAt(i));
        const time = area.time?.replace("T", " ").replace("Z", "") ?? "";
        card.append(R.element("strong", areas.length > 1 ? `${letters(i)} · ${area.name}` : area.name),
          R.element("p", [area.code, time && time + " UTC"].filter(Boolean).join(" · ")));
        if (!data.full) card.append(R.element("p", numeric(area.areaKm2, "km²") + " inside the study area · " + numeric(area.fraction * 100, "%") + " of this unit"));
        if (!area.ok) card.append(R.element("p", area.message));
        names.append(card);
      }
      result.append(names);
      const labels = new Map(areas.flatMap(area => area.metrics.map(([label, , unit]) => [label, unit])));
      if (labels.size) {
        const scroll = R.element("div", null, "district-table-scroll");
        scroll.tabIndex = 0;
        scroll.setAttribute("role", "region");
        scroll.setAttribute("aria-label", "Administrative area measures");
        const table = R.element("table", null, "district-table");
        const head = R.element("thead"), columns = R.element("tr");
        const headers = areas.length === 1 ? ["Result"] : areas.map((_, i) => letters(i));
        for (const text of ["Measure", ...headers, ...(pair ? ["A − B"] : [])]) {
          const th = R.element("th", text);
          th.scope = "col";
          columns.append(th);
        }
        head.append(columns);
        const body = R.element("tbody");
        for (const [label, unit] of labels) {
          const values = areas.map(area => area.metrics.find(metric => metric[0] === label)?.[1]);
          const row = R.element("tr"), th = R.element("th", label);
          th.scope = "row";
          row.append(th, ...values.map(value => R.element("td", numeric(value, unit))));
          if (pair) {
            const [a, b] = values;
            const difference = areas[0].time === areas[1].time && values.every(Number.isFinite) ? a - b : null;
            row.append(R.element("td", numeric(difference, unit === "%" ? "pp" : unit, true)));
          }
          body.append(row);
        }
        table.append(head, body);
        scroll.append(table);
        result.append(scroll);
      }
      const link = R.element("a", data.source, "method-link");
      link.href = data.url;
      result.append(R.element("p", data.attribution), link);
    }

    return {
      install, show, open, payload, active: ready, reset, render,
      clip: id => masks.get(id), bounds: id => id ? layer()?.units.find(unit => unit.id === id)?.bounds : selectedBounds,
      label: () => units().length > 2 ? units().length + " administrative areas" : units().map(unit => unit.name).join(" · "),
      setBusy(value) { disabled = value; syncAvailability(); },
    };
  }

  window.HEATLINE_DISTRICTS = { create, results };
})();
