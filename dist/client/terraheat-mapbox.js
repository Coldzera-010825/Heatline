(() => {
  "use strict";
  const $ = id => document.getElementById(id);
  const L = window.HEATLINE_LAYERS, R = window.HEATLINE_RESULTS, A = window.HEATLINE_ARCHIVE;
  const globe = { center: [11, 28], zoom: 1.35, pitch: 0, bearing: 0 };
  const london = { center: [-.11, 51.505], zoom: 9.35, pitch: 25, bearing: -12 };
  const street = { center: [-.1205, 51.5155], zoom: 14.85, pitch: 51, bearing: -19 };
  const europe = { center: [1.2, 50.2], zoom: 5.45, pitch: 0, bearing: 0 };
  const pilot = [-.1312, 51.5088, -.1101, 51.5224];
  const populationGroups = { deprived: "IMD 1–2 · most deprived areas", leastDeprived: "IMD 9–10 · least deprived areas",
    older: "Residents aged 65+", limited: "Residents with limited activities", all: "All usual residents" };
  const populationLayers = ["residents", "older", "limited", "deprived", "leastDeprived"];
  const chapters = [
    ["event", "The heatwave", "How hot did London get?", "Explore London’s surface temperature, landscape and hourly weather observations.",
      "Landsat LST measures the surface at one overpass. WOW community stations and the NOAA St James’s Park reference record air temperature. Heathrow’s official peak is shown separately.",
      ["Open WOW observations", "Show land cover", "Open Landsat LST"]],
    ["exposure", "Who was exposed?", "Did residential heat differ by group?", "Compare age, activity limitation and neighbourhood deprivation groups using the same London Landsat snapshot.",
      "Use the 5 × 5 Landsat LST pixel window around each 2021 Census Output Area’s geometric centroid. IMD 2025 describes neighbourhoods and is applied retrospectively to 18 July 2022.",
      ["Compare IMD deciles 1–2 and 9–10", "Which borough had the highest LST for residents aged 65+?"]],
    ["street", "At street level", "Where was it hottest to walk?", "Draw an area or use the study area to calculate heat exposure along the walking network.",
      "The TerraHeat archive combines SOLWEIG mean radiant temperature with air temperature, humidity and wind to estimate UTCI. Each result weights 100 m cells by represented walking-network length.",
      ["Calculate pedestrian heat in my selection", "Calculate UTCI for the London study area"]],
    ["shade", "What-if shade", "What if more streets had shade?", "Estimate the change in length-weighted UTCI if some sunlit walking routes had shade.",
      "Paired cells contain at least 20 m of sunlit paths and 20 m of building-shaded paths. Their median within-cell UTCI difference was 6.01°C across 159 cells on 18 July 2022 at 10:52 UTC.",
      ["What if 25% of sunlit paths were shaded?", "Add shade to 50% of sunlit walking routes"]],
    ["compare", "Compare cities", "How did heat exposure differ?", "Compare residential surface heat or walking heat stress during the same historical event.",
      "Residential heat matches clear Landsat pixels to GHS-POP 2020 within city boundaries. A difference requires same-day, in-event overpasses within 90 minutes of local solar time and at least 80% population coverage in both cities. Walking heat uses same-time SOLWEIG pilots and weights 100 m cells by walking length.",
      ["Compare Paris and Amsterdam in 2020", "Compare Portland and Seattle walking UTCI in 2021"]],
  ];
  const globalChapter = ["globe", "", "July heat around the world", "Replay daily maximum air temperature over land from 13 to 19 July 2022.",
    "The globe replays daily maximum air temperature on 13–19 July 2022 as regional context. City markers open their own historical event archives. Each layer and analysis shows its actual date.",
    ["Open the Amsterdam case", "Compare Paris and Amsterdam in 2020", "Show 18 July"]];
  if (!window.mapboxgl || !window.TERRAHEAT_MAPBOX_TOKEN || !L || !R || !A || !window.polygonClipping) {
    $("map-status").textContent = "Mapbox could not load. Check your connection.";
    return;
  }
  mapboxgl.accessToken = window.TERRAHEAT_MAPBOX_TOKEN;
  let map;
  try {
    map = new mapboxgl.Map({
      container: "map", style: "mapbox://styles/mapbox/dark-v11", projection: "globe", ...globe,
      antialias: true, attributionControl: false,
    });
  } catch {
    $("map-status").textContent = "The 3D map could not start. Try a browser with WebGL enabled.";
    return;
  }
  let ready = false, stage = -1, day = 19, cityLayer = "lst", view = "flat", playback;
  let popup, hover, gridKey, gridRequest = 0, drawnGrid = L.empty, barsGrid, resolution = "";
  let stations = [], activeStation, comparison, observationRequest = 0, pairByCell = new Map();
  let drawing = false, corner, busy = false, analysisRun = 0;
  let regionalState, regionalLoading = false, regionalRequest = 0, regionalFrame;
  const detailedEvent = "london-detail";
  const lastCase = new Map();
  let adminCatalog, detailedClip;
  let caseCatalog, caseRegion = "London", caseEvent = detailedEvent, caseLoading = false, caseRequest = 0;
  let archiveState, archiveFrame, archiveImage, archiveGrid, archivePlayback;
  let globeRotation = true, spinning = false, globalFront = 0, pendingFrame;
  const globeSlots = ["a", "b"].map(id => ({
    fill: "globe-fill-" + id, extrusion: "globe-extrusion-" + id, grid: "globe-grid-" + id, bars: "globe-bars-" + id,
  }));
  const beacons = new Map();
  const areas = new Map([[1, { chosen: true }], [2, { chosen: false }], [3, { chosen: false }]]);
  const results = new Map(), variants = { 1: "residents", 3: "scenario" };
  const compactLayout = matchMedia("(max-width:980px)");
  const phoneLayout = matchMedia("(max-width:600px)");
  const motionPreference = matchMedia("(prefers-reduced-motion: reduce)");
  const area = () => areas.get(stage);
  const usingArchive = () => Boolean(archiveState) && stage >= 0 && stage < 4;
  const archiveLayer = () => archiveState?.layers.find(layer => layer.id === archiveState.selected[stage]);
  const adminPath = file => "data/admin/" + file;
  const streetKeys = ["case-utci", "case-baseline", "case-scenario"];
  const clipFeature = (clip, feature) => {
    if (!clip) return feature;
    if (feature.geometry.type !== "Polygon") return feature;
    const [ring] = feature.geometry.coordinates;
    const xs = ring.map(p => p[0]), ys = ring.map(p => p[1]);
    return clip.clip(feature, [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]);
  };
  function chapter() {
    const row = chapters[stage] ?? globalChapter;
    if (!usingArchive()) return row;
    const city = archiveState.admin.adminName;
    const content = [
      ["How hot did " + city + " get?", "Explore available weather, station and satellite evidence for this historical case.",
        "Landsat LST is a surface snapshot. NOAA observations measure station air temperature; gridded air temperature is regional context.",
        ["Analyse event weather", "Open Landsat LST"]],
      ["Who was exposed?", "Estimate residential surface heat inside " + city + ", or draw a smaller area to inspect its distribution.",
        "Match native 100 m GHS-POP 2020 cells to quality-screened Landsat surface temperature. Subgroup comparisons require local census counts.",
        ["Calculate population exposure", "Compare residents aged 65+"]],
      ["Where was it hottest to walk?", "Draw an area or use the model coverage to calculate heat exposure along the walking network.",
        "SOLWEIG estimates radiation using terrain, buildings and canopy. UTCI adds air temperature, humidity and wind. We weight the 100 m cells by represented walking length.",
        ["Calculate pedestrian UTCI", "Show land cover"]],
      ["What if more streets had shade?", "Estimate how the UTCI along walking routes would change if some sunlit length had building shade.",
        "Keep the same event time and weather. Use only 100 m cells with at least 20 m of modelled walking length in both sun and building shade.",
        ["What if 25% of paths were shaded?", "Open NDVI"]],
    ][stage];
    return [row[0], row[1], ...content];
  }
  const stationDay = () => $("station-period").value === "day" ? day : undefined;
  function visible(id, on) {
    const value = on ? "visible" : "none";
    if (map.getLayer(id) && map.getLayoutProperty(id, "visibility") !== value) map.setLayoutProperty(id, "visibility", value);
  }

  function layerKey() {
    if (stage < 0) return "era5";
    if (stage === 4) {
      if (!regionalState) return null;
      return regionalState.metric === "street" ? (regionalState.street ? "regional-utci" : null) : "regional";
    }
    if (usingArchive() && stage >= 2 && results.has(stage) && !archiveState.contextLayer[stage]) {
      return stage === 2 ? "case-utci" : "case-" + variants[3];
    }
    if (usingArchive()) return archiveLayer() ? "case-" + archiveLayer().id : null;
    if (stage === 0) return cityLayer;
    if (stage === 1) return results.has(1) ? variants[1] : "lst";
    if (stage === 2) return results.has(2) ? "utci" : null;
    return results.has(3) ? variants[3] : null;
  }

  function cameraPadding() {
    if (stage < 0 && compactLayout.matches) {
      const intro = $("intro"), guide = $("guide"), masthead = document.querySelector(".masthead");
      if (phoneLayout.matches) {
        const top = Math.min(innerHeight * .48, (intro.offsetHeight ? intro.getBoundingClientRect().bottom : masthead.offsetHeight) + 7);
        const legend = $("legend-hl");
        const bottom = Math.min(innerHeight * .38, legend.hidden ? 54 : innerHeight - legend.getBoundingClientRect().top + 6);
        return { top, bottom, left: 14, right: 14 };
      }
      return { top: masthead.offsetHeight + 12, bottom: 82,
        left: intro.offsetWidth ? intro.getBoundingClientRect().right + 12 : 18,
        right: guide.offsetWidth ? innerWidth - guide.getBoundingClientRect().left + 12 : 18 };
    }
    if (compactLayout.matches) {
      const panel = $($("app").dataset.panel === "atlas" ? "guide" : "analysis-panel");
      const bottom = panel.offsetHeight ? innerHeight - panel.getBoundingClientRect().top + 8 : 60;
      return { top: document.querySelector(".masthead").offsetHeight + 7, left: 16, bottom: Math.min(bottom, innerHeight * .55), right: 16 };
    }
    return {
      top: 68,
      left: (stage < 0 ? $("intro") : $("analysis-panel")).offsetWidth + 36,
      bottom: 68,
      right: $("guide").offsetWidth + 36,
    };
  }

  function move(camera, animate = true) {
    const options = { ...camera, padding: cameraPadding() };
    if (animate && !R.reducedMotion()) map.flyTo({ ...options, duration: 1550, curve: 1.16 });
    else map.jumpTo(options);
  }

  function frameBounds([west, south, east, north], maxZoom = 14.7, pitch = view === "bars" ? 44 : 25, bearing = -12, animate = true) {
    const padding = cameraPadding();
    const legend = $("legend-hl");
    syncLegendClearance();
    if (stage === 4) padding.top += 52;
    const maxBottom = stage === 4 ? Math.max(0, innerHeight - padding.top - 85) : innerHeight * .63;
    if (!legend.hidden) padding.bottom = Math.max(padding.bottom, Math.min(maxBottom, innerHeight - legend.getBoundingClientRect().top + 12));
    map.fitBounds([[west, south], [east, north]], {
      padding, maxZoom, pitch, bearing, duration: !animate || R.reducedMotion() ? 0 : 1450,
    });
  }

  // As in TerraHeat, each linear move hands off to the next on moveend.
  function spinGlobe() {
    if (!ready || stage >= 0 || !globeRotation || R.reducedMotion() || document.hidden || map.getZoom() > 2.2 || map.isMoving()) return;
    const { lng, lat } = map.getCenter();
    spinning = true;
    map.easeTo({ center: [lng + 12, lat], duration: 6000, easing: t => t }, { heatlineSpin: true });
  }

  function updateGlobeRotation() {
    const button = $("spin-globe");
    button.hidden = stage >= 0 || R.reducedMotion();
    button.setAttribute("aria-pressed", String(globeRotation && !R.reducedMotion()));
    if (spinning && (!globeRotation || R.reducedMotion() || document.hidden)) map.stop();
    else requestAnimationFrame(spinGlobe);
  }

  function syncLegendClearance() {
    const legend = $("legend-hl"), app = $("app");
    if (stage < 0 || !compactLayout.matches) {
      legend.style.removeProperty("--legend-clearance");
      app.style.removeProperty("--workspace-switch-bottom");
      app.style.removeProperty("--workspace-bottom");
    } else {
      const nav = $("chapter-nav").getBoundingClientRect(), switcher = $("panel-switch").getBoundingClientRect();
      if (switcher.height) {
        const clearance = (nav.height ? Math.ceil(innerHeight - nav.top) : 24) + 6;
        app.style.setProperty("--workspace-switch-bottom", clearance + "px");
        app.style.setProperty("--workspace-bottom", (clearance + Math.ceil(switcher.height) + 6) + "px");
      }
      const panel = $(app.dataset.panel === "atlas" ? "guide" : "analysis-panel");
      const { top, height } = panel.getBoundingClientRect();
      if (height) legend.style.setProperty("--legend-clearance", Math.ceil(innerHeight - top + 10) + "px");
    }
  }

  function focusStations(first, second) {
    const a = stations.find(station => station.id === first);
    const b = stations.find(station => station.id === second);
    if (!a) return;
    popup?.remove();
    hover?.remove();
    if (b) frameBounds(rectangle(a.coordinates, b.coordinates), 13.25, 33);
    else move({ center: a.coordinates, zoom: 13.3, pitch: 42, bearing: -15 });
  }

  function showPopup(position, text, transient = false) {
    if (transient) {
      hover ??= new mapboxgl.Popup({ offset: 10, closeButton: false, closeOnClick: false, className: "hover-popup" });
      hover.setLngLat(position).setText(text);
      if (!hover.isOpen()) hover.addTo(map);
      return;
    }
    hover?.remove();
    popup?.remove();
    popup = new mapboxgl.Popup({ offset: 11, maxWidth: "292px" }).setLngLat(position).setText(text).addTo(map);
  }

  function gridLabel(p, detail = false) {
    const key = layerKey(), spec = L.layers[key];
    if (!spec) return "";
    if (spec.classes) return "Land cover · " + (spec.classes.find(([code]) => code === p.value)?.[1] ?? "Other");
    const label = (key === "era5" ? p.day + " Jul · " : p.city ? p.city + " · " : "") +
      spec.label + " " + R.format(p.value) + spec.unit;
    if (!detail) return label;
    if (key === "case-utci") return label + "\n100 m cell · " + R.distance(p.path_m) + " represented walking network";
    if (key === "utci") {
      const pair = pairByCell.get(Number(p.lon).toFixed(6) + "," + Number(p.lat).toFixed(6));
      return [label, p.grid === 500 ? "500 m overview cell" : "100 m walking-network cell",
        R.distance(p.path_m) + " represented walking network",
        Number.isFinite(p.sun) && R.format(p.sun, 1) + "% modeled sunlit path",
        Number.isFinite(p.lst) && R.format(p.lst, 1) + "°C co-located Landsat LST",
        pair && "Pilot pair · " + R.format(pair[6]) + "°C sun / " + R.format(pair[7]) + "°C building shade"].filter(Boolean).join("\n");
    }
    if (["scenario", "baseline", "case-scenario", "case-baseline"].includes(key)) return [label,
      "Baseline " + R.format(p.baseline) + "°C · Scenario " + R.format(p.scenario) + "°C",
      R.distance(p.converted_m) + " sunlit route length converted"].join("\n");
    if (populationLayers.includes(key)) return [label, key !== "residents" ? R.format(p.temperature) + "°C residential LST" : "",
      R.format(p.count, 0) + " matched usual residents"].filter(Boolean).join("\n");
    return label;
  }

  function addLayers() {
    map.setFog({ "space-color": "#070706", "star-intensity": .18, "horizon-blend": .08, color: "#1b1a18", "high-color": "#312a25" });
    const style = map.getStyle();
    const symbol = style.layers.find(layer => layer.type === "symbol")?.id;
    const roads = style.layers.find(layer => layer.type === "line" && /(road|street|transport)/i.test(layer.id))?.id ?? symbol;
    map.addSource("boundary", { type: "geojson", data: "data/greater-london-boundary.geojson" });
    for (const id of ["metric-grid", "metric-bars", "analysis-area", "wow-stations", "heat-hotspots", "regional-areas", "street-model-area",
      "archive-study-area", "archive-station-points"]) map.addSource(id, { type: "geojson", data: L.empty });
    const blank = document.createElement("canvas");
    blank.width = blank.height = 1;
    for (const id of ["archive-image", "compare-image-a", "compare-image-b"]) {
      map.addSource(id, { type: "image", url: blank.toDataURL(), coordinates: [[0, 1], [1, 1], [1, 0], [0, 0]] });
      map.addLayer({ id: id + "-layer", type: "raster", source: id, layout: { visibility: "none" },
        paint: { "raster-opacity": .84, "raster-fade-duration": 300, "raster-resampling": "nearest" } }, roads);
    }
    map.addLayer({ id: "archive-study-line", type: "line", source: "archive-study-area", layout: { visibility: "none" },
      paint: { "line-color": "#f8cfa7", "line-width": 1.5, "line-dasharray": [4, 2] } }, symbol);
    map.addLayer({ id: "street-model-line", type: "line", source: "street-model-area", layout: { visibility: "none" },
      paint: { "line-color": "#ffd297", "line-width": 2.4, "line-dasharray": [2, 1] } }, symbol);
    map.addLayer({ id: "archive-station-point", type: "circle", source: "archive-station-points", layout: { visibility: "none" },
      paint: { "circle-radius": ["case", ["any", ["get", "selected"], ["get", "compared"]], 8, 5],
        "circle-color": ["case", ["get", "selected"], "#ffe0ae", ["get", "compared"], "#82c9d0", ["has", "value"],
          ["interpolate", ["linear"], ["get", "value"], 15, "#4c337d", 29, "#df615d", 43, "#fff4ad"], "#807b74"],
        "circle-stroke-color": "#2a1d18", "circle-stroke-width": 1.5 } });
    map.addSource("city-pins", { type: "geojson", data: L.empty });
    map.addLayer({ id: "metric-fill", type: "fill", source: "metric-grid", layout: { visibility: "none" },
      paint: { "fill-color": "#a76c53", "fill-opacity": .73, "fill-antialias": false } }, roads);
    map.addLayer({ id: "boundary-line", type: "line", source: "boundary", paint: {
      "line-color": "#ffcc9d", "line-width": 1.2, "line-opacity": .77 } }, symbol);
    if (style.sources.composite) {
      map.addLayer({ id: "london-buildings", type: "fill-extrusion", source: "composite", "source-layer": "building", minzoom: 13,
        filter: ["==", ["get", "extrude"], "true"], paint: { "fill-extrusion-color": "#433a34",
          "fill-extrusion-height": ["coalesce", ["get", "height"], 0], "fill-extrusion-base": ["coalesce", ["get", "min_height"], 0],
          "fill-extrusion-opacity": .72 } }, symbol);
    }
    map.addLayer({ id: "metric-extrusion", type: "fill-extrusion", source: "metric-bars", layout: { visibility: "none" },
      paint: { "fill-extrusion-color": "#a76c53", "fill-extrusion-height": ["get", "height"], "fill-extrusion-opacity": .87 } }, symbol);
    const globeColor = L.color("era5");
    for (const slot of globeSlots) {
      map.addSource(slot.grid, { type: "geojson", data: L.empty });
      map.addSource(slot.bars, { type: "geojson", data: L.empty });
      map.addLayer({ id: slot.fill, type: "fill", source: slot.grid, layout: { visibility: "none" },
        paint: { "fill-color": globeColor, "fill-opacity": 0, "fill-opacity-transition": { duration: 0 }, "fill-antialias": false } }, roads);
      map.addLayer({ id: slot.extrusion, type: "fill-extrusion", source: slot.bars, layout: { visibility: "none" },
        paint: { "fill-extrusion-color": globeColor, "fill-extrusion-height": ["get", "height"],
          "fill-extrusion-opacity": 0, "fill-extrusion-opacity-transition": { duration: 0 } } }, symbol);
    }
    map.addModel("heatline-hotspot-arrow", new URL("hotspot-arrow.glb", location.href).href);
    map.addLayer({ id: "heat-hotspot-arrows", type: "model", source: "heat-hotspots",
      layout: { "model-id": "heatline-hotspot-arrow", visibility: "none" },
      paint: { "model-scale": ["interpolate", ["exponential", .61], ["zoom"],
        8, ["literal", [42, 42, 42]], 12, ["literal", [5.6, 5.6, 5.6]], 15, ["literal", [1.55, 1.55, 1.55]], 18, ["literal", [.8, .8, .8]]] } }, symbol);
    map.addLayer({ id: "heat-hotspot-dot", type: "circle", source: "heat-hotspots", layout: { visibility: "none" },
      paint: { "circle-radius": 4.5, "circle-color": "#ffc785", "circle-stroke-width": 1.5, "circle-stroke-color": "#48291c" } });
    map.addLayer({ id: "heat-hotspot-label", type: "symbol", source: "heat-hotspots", layout: { visibility: "none",
      "text-field": ["get", "label"], "text-size": 12, "text-anchor": "top", "text-offset": [0, .7] },
      paint: { "text-color": "#ffe4bc", "text-halo-color": "#20140e", "text-halo-width": 2 } });
    map.addLayer({ id: "area-fill", type: "fill", source: "analysis-area", paint: { "fill-color": "#f5a461", "fill-opacity": .08 } }, symbol);
    map.addLayer({ id: "area-line", type: "line", source: "analysis-area",
      paint: { "line-color": "#ffd09b", "line-width": 2, "line-dasharray": [3, 1] } }, symbol);
    map.addLayer({ id: "regional-outline", type: "line", source: "regional-areas", filter: ["==", ["geometry-type"], "Polygon"],
      layout: { visibility: "none" }, paint: { "line-color": ["get", "accent"], "line-width": 1.6, "line-dasharray": [3, 2] } });
    map.addLayer({ id: "regional-label", type: "symbol", source: "regional-areas", filter: ["==", ["geometry-type"], "Point"],
      layout: { visibility: "none", "text-field": ["get", "name"], "text-size": 13, "text-anchor": "bottom",
        "text-offset": [0, -.35], "text-allow-overlap": true },
      paint: { "text-color": ["get", "accent"], "text-halo-color": "#1c1612", "text-halo-width": 1.8 } });
    map.addLayer({ id: "station-point", type: "circle", source: "wow-stations", layout: { visibility: "none" },
      paint: { "circle-radius": ["case", ["!=", ["get", "state"], 0], 7, 4.5],
        "circle-color": ["match", ["get", "state"], 1, "#ffe0ae", 2, "#7cced7",
          ["case", ["has", "value"], L.color("wow"), "#827b71"]],
        "circle-stroke-color": ["case", ["get", "review"], "#ffe0a6", "#231a19"],
        "circle-stroke-width": ["case", ["get", "review"], 1.9, 1.25] } });
    map.addLayer({ id: "pin-glow", type: "circle", source: "city-pins", paint: {
      "circle-color": "#ff6b56", "circle-radius": 16, "circle-blur": .75, "circle-opacity": .75 } });
    map.addLayer({ id: "pin", type: "circle", source: "city-pins", paint: {
      "circle-color": "#ffa97d", "circle-radius": 4.8, "circle-stroke-color": "#fff2d6", "circle-stroke-width": 1.25 } });
    map.addLayer({ id: "pin-name", type: "symbol", source: "city-pins", layout: {
      "text-field": ["get", "name"], "text-size": 12, "text-offset": [0, -1.1], "text-anchor": "bottom" },
      paint: { "text-color": "#fff3db", "text-halo-color": "#1a1412", "text-halo-width": 2.2 } });
    for (const id of ["pin", "pin-name"]) map.on("click", id, e => {
      e.preventDefault();
      if (!busy && !caseLoading && e.features?.[0]?.properties.region) chooseCase(e.features[0].properties.region);
    });
    map.on("click", "station-point", e => {
      if (busy || drawing) return;
      const item = e.features[0].properties;
      selectStation(item.id);
      showPopup(e.lngLat, [item.name, Number.isFinite(item.value) ?
        day + " Jul UTC · peak hourly reading " + R.format(item.value, 1) + "°C" : "No valid air temperature on " + day + " Jul UTC",
        item.review ? "Event peak flagged for review" : "WOW community observations"].join("\n"));
    });
    map.on("click", "archive-station-point", e => {
      if (busy || drawing || !usingArchive()) return;
      const item = e.features[0]?.properties;
      if (!item) return;
      e.preventDefault();
      selectArchiveStation(item.id);
      const period = archiveState.stationPeriod === "day" ? archiveState.date + " UTC" : "the full archived event";
      showPopup(e.lngLat, item.name + "\nNOAA ISD · " + (Number.isFinite(item.value) ?
        R.format(item.value, 1) + "°C peak reading in " + period : "No reading in " + period));
    });
    const globalGridLayers = globeSlots.flatMap(slot => [slot.fill, slot.extrusion]);
    const currentGridLayer = id => !globalGridLayers.includes(id) || [globeSlots[globalFront].fill, globeSlots[globalFront].extrusion].includes(id);
    for (const id of ["metric-fill", "metric-extrusion", ...globalGridLayers]) {
      map.on("mousemove", id, e => {
        if (currentGridLayer(id) && !drawing && !popup?.isOpen() && e.features?.length) showPopup(e.lngLat, gridLabel(e.features[0].properties), true);
      });
      map.on("click", id, e => {
        if (currentGridLayer(id) && !drawing && !e.defaultPrevented && e.features?.length) showPopup(e.lngLat, gridLabel(e.features[0].properties, true));
      });
    }
    for (const id of ["heat-hotspot-dot", "heat-hotspot-label"]) map.on("click", id, e => {
      if (!drawing && e.features?.length) showPopup(e.features[0].geometry.coordinates, "UTCI hotspot · " + e.features[0].properties.label);
    });
    for (const id of ["pin", "pin-name", "station-point", "archive-station-point", "metric-fill", "metric-extrusion", ...globalGridLayers, "heat-hotspot-dot", "heat-hotspot-label"]) {
      map.on("mouseenter", id, () => { if (!drawing) map.getCanvas().style.cursor = "pointer"; });
      map.on("mouseleave", id, () => {
        if (!drawing) map.getCanvas().style.cursor = "";
        hover?.remove();
      });
    }
    map.on("click", selectCorner);
    map.on("mousemove", e => {
      if (drawing && corner) drawOutline(rectangle(corner, e.lngLat.toArray()));
      else if (!drawing && !popup?.isOpen()) showArchiveSample(e, true);
    });
    map.on("click", e => { if (!drawing && !e.defaultPrevented) showArchiveSample(e, false); });
    map.on("moveend", event => {
      if (event.heatlineSpin) spinning = false;
      if (stage < 0) requestAnimationFrame(spinGlobe);
      else if (!event.heatlineSpin && layerKey() !== "wow") refreshGrid();
    });
    map.on("movestart", event => {
      if (stage < 0 && event.originalEvent) {
        globeRotation = false;
        updateGlobeRotation();
      }
    });
    ready = true;
    $("map-status").textContent = "";
    initializeCases();
    L.data("shade-pairs.json").then(rows => {
      pairByCell = new Map(rows.map(row => [row[0].toFixed(6) + "," + row[1].toFixed(6), row]));
    }).catch(() => {});
  }

  function updateCaseHeader() {
    const comparisonMode = stage === 4;
    $("view-mode").value = comparisonMode ? "comparison" : "single";
    $("case-city").value = caseRegion;
    $("case-city-picker").hidden = $("case-city-separator").hidden = comparisonMode || stage < 0;
    $("case-period").textContent = stage < 0 ? (adminCatalog ? Object.keys(adminCatalog.cities).length + " cities · 2018–2026" : "City archive") :
      comparisonMode ? (regionalState?.event.label ?? "Historical events") :
      archiveState ? archiveState.record.label.replace(" · reference point", "") : "July 2022";
    $("enter-label").textContent = "EXPLORE " + (adminCatalog?.cities[caseRegion]?.name ?? "London").toUpperCase();
    const city = caseCatalog?.cities.find(item => item.id === caseRegion);
    const eventOptions = city?.cases.map(record => new Option(record.label +
      (city.id === "London" && record.id === "E3_2022-07" ? " · comparable city data" : ""), record.id)) ?? [];
    if (caseRegion === "London") eventOptions.unshift(new Option("July 2022 · detailed London case", detailedEvent));
    $("case-event").replaceChildren(...eventOptions);
    $("case-event").value = caseEvent;
  }

  function setCaseUrl() {
    const url = new URL(location.href);
    if (stage === 4 && regionalState) {
      url.searchParams.delete("city");
      url.searchParams.delete("event");
      url.searchParams.set("compareEvent", regionalState.event.id);
      url.searchParams.set("a", regionalState.regions[0].id);
      url.searchParams.set("b", regionalState.regions[1].id);
      url.searchParams.set("metric", regionalState.metric);
      for (const [key, value] of [["date", regionalState.requestDate], ["time", regionalState.requestTime]]) {
        if (value) url.searchParams.set(key, value);
        else url.searchParams.delete(key);
      }
    } else {
      for (const key of ["compareEvent", "a", "b", "metric", "date", "time"]) {
        if (stage !== 4) url.searchParams.delete(key);
      }
    }
    if (stage >= 0 && stage < 4 && archiveState) {
      url.searchParams.set("city", caseRegion);
      url.searchParams.set("event", caseEvent);
    } else if (stage !== 4) {
      url.searchParams.delete("city");
      url.searchParams.delete("event");
    }
    url.hash = chapter()[0];
    if (url.href !== location.href) history.replaceState(null, "", url);
  }

  function initializeCases() {
    const anchor = location.hash.slice(1), index = anchor === "outlook" ? 3 : chapters.findIndex(row => row[0] === anchor);
    const url = new URL(location.href), region = url.searchParams.get("city"), event = url.searchParams.get("event");
    const deepCase = Boolean(region) && index !== 4;
    if (!deepCase) openChapter(index, false);
    Promise.all([A.read("catalog.json"), A.readAdmin("catalog.json")]).then(async ([catalog, admin]) => {
      const boundary = await A.readAdmin(admin.cities.London.boundary);
      detailedClip = A.boundaryIndex(boundary, admin.cities.London.bbox);
      caseCatalog = catalog;
      adminCatalog = admin;
      const cityEntries = Object.entries(admin.cities);
      map.getSource("city-pins").setData(L.collection(cityEntries.map(([region, city]) => ({
        type: "Feature", geometry: { type: "Point", coordinates: city.center }, properties: { name: city.name, region },
      }))));
      $("city-cases").replaceChildren(...cityEntries.map(([region, city]) => R.button(city.name, () => chooseCase(region))));
      $("case-city").replaceChildren(...catalog.cities.map(city => new Option(city.name, city.id)));
      updateCaseHeader();
      updateControls();
      if (deepCase) {
        const city = catalog.cities.find(item => item.id === region);
        const chapterIndex = index < 0 ? 0 : index;
        if (city) {
          const available = !event || (region === "London" && event === detailedEvent) || city.cases.some(record => record.id === event);
          const opened = await chooseCase(region, available ? event : undefined, chapterIndex, false);
          if (opened && !available) reportAnalysis("That event is unavailable for " + city.name + ". Showing its default case instead.");
        } else {
          openChapter(-1, false);
          $("map-status").textContent = "That city is not in this archive. Choose one of the cities above.";
        }
      } else if (index === 4 && stage === 4) loadRegional({
        event: url.searchParams.get("compareEvent") || undefined, firstRegion: url.searchParams.get("a") || undefined,
        secondRegion: url.searchParams.get("b") || undefined, metric: url.searchParams.get("metric") === "street" ? "street" : "surface",
        date: url.searchParams.get("date") || undefined, time: url.searchParams.get("time") || undefined,
      });
      else if (stage === 0 && cityLayer === "landcover") refreshGrid();
    }).catch(() => {
      if (deepCase) openChapter(-1, false);
      const message = "The city archive could not load. The detailed London case is still available.";
      if (stage < 0) $("map-status").textContent = message;
      else if (stage === 4) $("regional-result").textContent = message;
      else reportAnalysis(message);
    });
  }

  function registerArchiveLayers() {
    archiveState.layers = A.layers(archiveState, map.getZoom() >= 12.3);
    for (const layer of archiveState.layers) {
      L.layers["case-" + layer.id] = layer;
      L.attr["case-" + layer.id] = layer.source;
    }
    for (const key of streetKeys) {
      L.layers[key] = { ...L.layers[key.slice(5)], source: archiveState.street ? archiveState.street.engine + " · " +
        archiveState.street.timeUtc.slice(0, 16).replace("T", " ") + " UTC · central pilot" : "" };
      L.attr[key] = archiveState.street?.source;
    }
  }

  async function chooseCase(region, event, index = 0, animate = true) {
    if (!ready) return false;
    const city = caseCatalog?.cities.find(item => item.id === region);
    if (!city && region !== "London") return false;
    if (event && !(region === "London" && event === detailedEvent) && !city?.cases.some(record => record.id === event)) return false;
    const id = ++caseRequest;
    stopArchivePlayback();
    if (drawing) setDrawing(false);
    caseLoading = true;
    updateControls();
    try {
      const requested = event ?? lastCase.get(region) ?? (region === "London" ? detailedEvent : null);
      const record = requested === detailedEvent ? undefined :
        city?.cases.find(item => item.id === requested) ?? city?.cases.find(item => item.id === "E3_2022-07") ??
        city?.cases.find(item => !item.pointOnly);
      const admin = adminCatalog?.cities[region];
      const street = adminCatalog?.streetModels?.[region]?.[record?.id];
      const [data, boundary] = record ? await Promise.all([A.read(record.file), A.readAdmin(admin.boundary)]) : [];
      if (id !== caseRequest) return;
      if (!data && region !== "London") throw new Error("Administrative area unavailable");
      const nextEvent = record?.id ?? detailedEvent;
      const changed = caseRegion !== region || caseEvent !== nextEvent;
      caseRegion = region;
      caseEvent = nextEvent;
      lastCase.set(region, nextEvent);
      if (changed) {
        results.clear();
        for (const [chapter, selected] of [[1, true], [2, false], [3, false]]) areas.set(chapter, { chosen: selected });
        variants[1] = "residents";
        variants[3] = "scenario";
        $("shade-percent").value = "25";
        $("shade-value").value = "25%";
      }
      if (data && (changed || !archiveState)) {
        const event = admin.events[record.id], snapshotLayer = event.snapshot ? "lst_c" : "landcover";
        archiveState = { city, admin, boundary, clip: A.boundaryIndex(boundary, admin.bbox), event, street,
          otherStreet: Boolean(adminCatalog.streetModels?.[region]), record, data, date: data.peak, model: "land",
          selected: [snapshotLayer, snapshotLayer, "landcover", "landcover"], contextLayer: {}, station: data.stations[0]?.id, stationPeriod: "event" };
        registerArchiveLayers();
        map.getSource("archive-study-area").setData(L.collection([boundary]));
        map.getSource("street-model-area").setData(street ? L.collection([{ type: "Feature", geometry: street.geometry, properties: {} }]) : L.empty);
      } else if (!data) archiveState = undefined;
      caseLoading = false;
      $("map-status").textContent = "";
      await openChapter(index, animate, undefined, true);
      return true;
    } catch {
      if (id !== caseRequest) return;
      updateCaseHeader();
      const message = "This case could not load. Choose another event or try again.";
      if (stage < 0) $("map-status").textContent = message;
      else reportAnalysis(message);
      return false;
    } finally {
      if (id === caseRequest) { caseLoading = false; updateControls(); }
    }
  }

  function updateArchiveControls() {
    if (!usingArchive()) return;
    const state = archiveState, { data } = state;
    const layer = $("archive-layer"), resultLayer = stage === 2 ? "case-utci" : "case-" + variants[3];
    const options = state.layers.map(item => new Option(item.label, item.id));
    if (stage >= 2 && results.has(stage)) options.unshift(new Option(L.layers[resultLayer].label, resultLayer));
    layer.replaceChildren(...options);
    if (!state.layers.some(item => item.id === state.selected[stage])) state.selected[stage] = state.layers[0]?.id;
    layer.value = stage >= 2 && results.has(stage) && !state.contextLayer[stage] ? resultLayer : state.selected[stage];
    $("archive-model-row").hidden = !data.alternative || stage !== 0;
    $("archive-model").replaceChildren(new Option("ERA5-Land · 0.1°", "land"),
      ...(data.alternative ? [new Option("ERA5 · 0.25° alternative", "era5")] : []));
    $("archive-model").value = state.model;
    const dates = A.dates(state);
    if (!dates.includes(state.date)) state.date = dates.includes(data.peak) ? data.peak : dates[0];
    $("archive-timeline").hidden = !dates.length || stage !== 0;
    $("archive-time-note").hidden = stage !== 0;
    $("archive-time-note").textContent = "The UTC day controls weather and station context. Satellite layers keep their overpass date.";
    $("archive-date").replaceChildren(...dates.map(date => {
      const core = state.event.core;
      const index = core ? Math.round((Date.parse(date) - Date.parse(core[0])) / 86400000) + 1 : 0;
      return new Option(date + (core ? index > 0 && date <= core[1] ? " · event day " + index : " · context" : ""), date);
    }));
    $("archive-date").value = state.date ?? "";
    $("archive-weather").hidden = $("archive-stations").hidden = stage !== 0;
    $("archive-compare-stations").hidden = data.stations.length < 2;
    $("archive-preview").replaceChildren(A.preview(state, stage));
    if (stage === 0) {
      const station = $("archive-station"), other = $("archive-station-other");
      station.replaceChildren(...(data.stations.length ? data.stations.map(s => new Option(s.name, s.id)) : [new Option("No station archive", "")]));
      station.value = state.station ?? "";
      other.replaceChildren(new Option("Choose a second station", ""), ...data.stations.filter(s => s.id !== state.station).map(s => new Option(s.name, s.id)));
      other.hidden = $("archive-station-other-label").hidden = data.stations.length < 2;
      other.value = state.comparison ?? "";
      $("archive-period").value = state.stationPeriod;
      $("archive-station-preview").replaceChildren(A.stationPreview(state));
    }
    updateControls();
  }

  function setArchiveDate(date, { modelChanged = false } = {}) {
    if (!usingArchive() || !A.dates(archiveState).includes(date)) return false;
    const dayChanged = archiveState.date !== date;
    if (!dayChanged && !modelChanged) return true;
    archiveState.date = date;
    if (results.get(0)?.event?.kind !== "archive-station" || (dayChanged && archiveState.stationPeriod === "day")) {
      results.delete(0);
      if (stage === 0) { reportAnalysis(); renderResult(); setStep("area"); }
    }
    updateArchiveControls();
    popup?.remove();
    hover?.remove();
    refreshGrid();
    return true;
  }

  function chooseArchiveLayer(id) {
    if (!usingArchive()) return false;
    if (streetKeys.includes(id) && results.has(stage)) archiveState.contextLayer[stage] = false;
    else {
      if (!archiveState.layers.some(item => item.id === id)) return false;
      archiveState.selected[stage] = id;
      if (stage >= 2) archiveState.contextLayer[stage] = true;
    }
    popup?.remove();
    hover?.remove();
    clearGrid();
    updateArchiveControls();
    refreshGrid();
    if (stage === 2) showHotspots(layerKey() === "case-utci" ? results.get(2)?.analysis : undefined);
    if (stage === 0) suggestions();
    return true;
  }

  function selectArchiveStation(id) {
    archiveState.station = id || undefined;
    if (archiveState.comparison === archiveState.station) archiveState.comparison = undefined;
    if (results.get(0)?.event?.kind === "archive-station") results.delete(0);
    reportAnalysis();
    renderResult();
    setStep(results.has(0) ? "result" : "area");
    chooseArchiveLayer("noaa");
  }

  function stopArchivePlayback() {
    clearInterval(archivePlayback);
    archivePlayback = undefined;
    $("archive-play").textContent = "▶";
    $("archive-play").setAttribute("aria-label", "Play archived dates");
  }

  function playArchive() {
    if (archivePlayback) return stopArchivePlayback();
    const dates = A.dates(archiveState);
    let i = dates.indexOf(archiveState.date) + 1;
    if (i >= dates.length) i = 0;
    $("archive-play").textContent = "Ⅱ";
    $("archive-play").setAttribute("aria-label", "Pause archived dates");
    const next = () => {
      if (i >= dates.length || !setArchiveDate(dates[i++])) stopArchivePlayback();
    };
    next();
    archivePlayback = setInterval(next, 1250);
  }

  function detailedCover() {
    return !usingArchive() && layerKey() === "landcover" && adminCatalog?.cities.London.cover[map.getZoom() >= 12.3 ? "100" : "500"];
  }

  async function refreshArchiveGrid() {
    const state = archiveState, key = layerKey(), cover = detailedCover();
    const meta = cover ? { ...cover, type: "raster" } : usingArchive() && archiveLayer();
    if (cover) { L.layers.landcover = meta; L.attr.landcover = meta.source; }
    if (!meta && !streetKeys.includes(key)) { updateVisibility(); return; }
    const result = results.get(stage);
    const frame = [caseRegion, caseEvent, key, state?.model, meta?.type === "raster" ? meta.image : state?.date,
      meta?.type === "station" ? [state.station, state.comparison, state.stationPeriod] : "", result?.run, view].join("/");
    if (archiveFrame === frame && gridKey === key) { updateBars(); updateVisibility(); return; }
    const request = ++gridRequest;
    legendStatus("Loading case layer…");
    try {
      let features = [];
      if (streetKeys.includes(key)) {
        const source = key === "case-utci" ? result?.analysis?.features : result?.event?.features;
        features = (source?.features ?? []).flatMap(feature => {
          const cell = area()?.bounds ? A.clipToBoundary(feature, A.polygon(area().bounds)) : feature;
          return cell ? [{ ...cell, properties: { ...cell.properties, value: key === "case-utci" ? cell.properties.utci : cell.properties[key.slice(5)] } }] : [];
        });
      } else if (meta.type === "raster") {
        const buffer = await A.readAdmin(meta.numeric, "grid");
        if (request !== gridRequest || key !== layerKey()) return;
        if (archiveImage !== meta.image) {
          map.getSource("archive-image").updateImage({ url: adminPath(meta.image), coordinates: meta.coordinates });
          archiveImage = meta.image;
        }
        archiveGrid = buffer;
        if (view === "bars") features = A.rasterColumns(buffer, meta, cover ? detailedClip : state.clip);
      } else if (meta.type === "air") features = A.airGrid(state, meta);
      else {
        const points = state.data.stations.map(station => {
          const values = station.rows.filter(row => state.stationPeriod !== "day" || row[0].startsWith(state.date)).map(row => row[1]);
          return { type: "Feature", geometry: { type: "Point", coordinates: station.coordinates },
            properties: { id: station.id, name: station.name, selected: station.id === state.station, compared: station.id === state.comparison,
              ...(values.length ? { value: Math.max(...values) } : {}) } };
        });
        map.getSource("archive-station-points").setData(L.collection(points));
      }
      if (request !== gridRequest || key !== layerKey()) return;
      archiveFrame = frame;
      gridKey = key;
      drawnGrid = L.collection(features);
      barsGrid = undefined;
      resolution = streetKeys.includes(key) ? "100 m walking grid" : meta.type === "air" ? "administrative boundary" : "";
      map.getSource("metric-grid").setData(drawnGrid);
      map.setPaintProperty("metric-fill", "fill-color", L.color(key));
      map.setPaintProperty("metric-extrusion", "fill-extrusion-color", L.color(key));
      updateBars();
      legendStatus(!streetKeys.includes(key) && meta.type === "air" && !features.length ? "No valid cells for this UTC day." : "");
    } catch {
      if (request !== gridRequest) return;
      legendStatus("This case layer could not load. Try switching layers.");
    }
    updateVisibility();
  }

  function showArchiveSample(event, transient) {
    const cover = detailedCover(), meta = cover || (usingArchive() && archiveLayer());
    if ((!cover && meta?.type !== "raster") || streetKeys.includes(layerKey()) || gridKey !== layerKey() || !archiveGrid) return;
    if (!(cover ? detailedClip : archiveState.clip)?.contains(event.lngLat.lng, event.lngLat.lat)) {
      if (transient) hover?.remove();
      return;
    }
    const value = A.sample(archiveGrid, meta, event.lngLat);
    if (!Number.isFinite(value)) { if (transient) hover?.remove(); return; }
    const label = meta.classes ? meta.classes.find(([n]) => n === value)?.[1] ?? "Other" : R.format(value, 2) + meta.unit;
    showPopup(event.lngLat, meta.label + " · " + label + "\nDisplay preview, not an analysis sample", transient);
  }

  function legendStatus(message = "") {
    $("grid-status").textContent = message;
    $("grid-status").hidden = !message;
  }

  function updateVisibility() {
    const key = layerKey(), spec = L.layers[key];
    const grid = gridKey === key && drawnGrid.features.length > 0;
    const archiveRaster = (usingArchive() || detailedCover()) && spec?.type === "raster";
    const archiveStation = usingArchive() && spec?.type === "station";
    visible("metric-fill", grid && !archiveRaster && key !== "regional");
    visible("archive-image-layer", archiveRaster && gridKey === key);
    visible("archive-study-line", usingArchive());
    visible("street-model-line", usingArchive() && stage >= 2 && Boolean(archiveState.street));
    visible("archive-station-point", archiveStation && gridKey === key);
    visible("metric-extrusion", grid && view === "bars" && Boolean(barsGrid?.features.length));
    for (const [i, slot] of globeSlots.entries()) {
      const show = stage < 0 && (i === globalFront || Boolean(pendingFrame));
      visible(slot.fill, show);
      visible(slot.extrusion, show && view === "bars");
    }
    visible("london-buildings", !usingArchive() && (stage === 2 || stage === 3) && (!grid || view === "flat"));
    visible("station-point", key === "wow");
    visible("regional-outline", stage === 4 && Boolean(regionalState));
    visible("regional-label", stage === 4 && Boolean(regionalState));
    for (const [i, slot] of ["a", "b"].entries()) visible("compare-image-" + slot + "-layer",
      key === "regional" && Boolean(regionalState.regions[i].snapshot?.summary.matched));
    updateStationBeacons(key);
    visible("boundary-line", !usingArchive() && (stage === 0 || stage === 1 || (stage === 2 && results.get(2)?.analysis?.scope === "london")));
    for (const id of ["pin", "pin-glow", "pin-name"]) visible(id, stage < 0);
    $("legend-hl").hidden = !spec;
    $("timeline-hl").hidden = stage >= 0 && key !== "wow";
    $("layer-controls").hidden = stage !== 0;
    $("map-controls").hidden = stage > 0 || usingArchive();
    $("grid-view-toggle").hidden = !spec || key === "wow" || archiveStation;
    $("bar-note").hidden = view !== "bars" || !spec || key === "wow" || archiveStation;
    const cutoff = L.barCutoff(key);
    if (!$("bar-note").hidden) {
      $("bar-note").textContent = cutoff === undefined ? "Equal-height bars by land-cover class" :
        "3D bars ≥ " + R.format(cutoff, 3) + spec.unit + " · exaggerated heights" +
        (grid && !barsGrid?.features.length ? " · none in view" : "");
    }
    $("view-flat").setAttribute("aria-pressed", String(view === "flat"));
    $("view-bars").setAttribute("aria-pressed", String(view === "bars"));
    const useDays = stage < 0 || key === "wow";
    $("day").disabled = $("play-days").disabled = busy || !useDays;
    $("day").value = String(useDays ? day : 18);
    $("day-value").value = (useDays ? day : 18) + " Jul";
    $("timeline-hl").title = useDays ? "" : "This layer uses its archived date shown above.";
    const switcher = $("panel-switch");
    switcher.hidden = stage < 0 && !compactLayout.matches;
    $("show-analysis-panel").textContent = stage < 0 ? "Explore" : "Analysis";
    $("show-analysis-panel").setAttribute("aria-controls", stage < 0 ? "intro" : "analysis-panel");
    const boundaryCredit = usingArchive() ? archiveState.admin.provenance.source :
      stage === 4 && regionalState ? [...new Set(regionalState.regions.map(r => r.provenance.source))].join(" / ") : "";
    $("layer-credit").textContent = [L.attr[key] ?? "© OpenStreetMap contributors", boundaryCredit && "Boundaries: " + boundaryCredit].filter(Boolean).join(" · ");
    if (!spec) return;
    $("legend-label").textContent = spec.label;
    $("legend-ramp").hidden = $("legend-ends").hidden = !spec.colors;
    $("legend-classes").hidden = !spec.classes;
    $("legend-stations").hidden = key !== "wow";
    if (spec.colors) {
      $("legend-ramp").style.background = "linear-gradient(90deg," + spec.colors.join(",") + ")";
      $("legend-ends").replaceChildren(...spec.range.map((n, i) => R.element("span", (i ? "≥" : "≤") + n + spec.unit)));
    }
    if (spec.classes) $("legend-classes").replaceChildren(...spec.classes.map(([, name, color]) => {
      const li = R.element("li", name);
      li.style.setProperty("--swatch", color);
      return li;
    }));
    const visibleDay = globeSlots[globalFront].day;
    const time = key === "era5" && visibleDay ? visibleDay + " Jul 2022 UTC" : key === "wow" ? day + " Jul 2022 UTC" :
      key === "regional" ? regionalState.sharedDate ?? "Dated overpasses" :
      key === "regional-utci" ? regionalState.street.timeUtc.slice(0, 16).replace("T", " ") + " UTC" :
      archiveStation ? archiveState.stationPeriod === "day" ? archiveState.date + " UTC" : "Full archived event · UTC" :
      usingArchive() && !archiveRaster && !streetKeys.includes(key) ? archiveState.date + " UTC" : "";
    $("provenance").textContent = [time, spec.source,
      key === "era5" ? globeSlots[globalFront].resolution : resolution].filter(Boolean).join(" · ");
  }

  function paintGlobalMix(mix) {
    for (const [i, slot] of globeSlots.entries()) {
      const opacity = i === globalFront ? 1 - mix : mix;
      if (slot.opacity === opacity) continue;
      slot.opacity = opacity;
      map.setPaintProperty(slot.fill, "fill-opacity", .73 * opacity);
      map.setPaintProperty(slot.extrusion, "fill-extrusion-opacity", .87 * opacity);
    }
  }

  function cancelGlobalFrame() {
    pendingFrame?.controller.abort();
    pendingFrame = undefined;
    paintGlobalMix(0);
  }

  function prepareGlobeBars(slot) {
    if (!slot.data || slot.hasBars || view !== "bars") return;
    map.getSource(slot.bars).setData(L.columns(slot.data, "era5"));
    slot.hasBars = true;
  }

  function waitForGlobeSource(slot, signal) {
    return new Promise(resolve => {
      const done = success => {
        clearTimeout(timeout);
        map.off("sourcedata", check);
        signal.removeEventListener("abort", check);
        resolve(success);
      };
      const loaded = () => map.isSourceLoaded(slot.grid) && (view !== "bars" || map.isSourceLoaded(slot.bars));
      const check = () => {
        if (signal.aborted) done(false);
        else if (loaded()) done(true);
      };
      const timeout = setTimeout(() => done(!signal.aborted && loaded()), 6500);
      map.on("sourcedata", check);
      signal.addEventListener("abort", check, { once: true });
      check();
    });
  }

  async function loadGlobalFrame(frame) {
    const { day: target, controller: { signal } } = frame;
    const front = globeSlots[globalFront], back = globeSlots[1 - globalFront];
    legendStatus("Loading layer…");
    try {
      if (back.day !== target) {
        const data = await L.globalGrid(target);
        if (signal.aborted) return false;
        back.day = undefined;
        back.data = data.features;
        back.resolution = data.resolution;
        back.hasBars = false;
        map.getSource(back.grid).setData(back.data);
        map.getSource(back.bars).setData(L.empty);
      }
      prepareGlobeBars(back);
      // Keep the old frame in view while Mapbox prepares the buffer, as in TerraHeat.
      paintGlobalMix(.001);
      updateVisibility();
      if (!await waitForGlobeSource(back, signal)) throw new Error("The frame did not load");
      if (signal.aborted) return false;
      back.day = target;
      legendStatus();
      if (front.day && !R.reducedMotion() && !document.hidden) {
        await new Promise(resolve => {
          const start = performance.now();
          const tick = now => {
            if (signal.aborted) { resolve(); return; }
            const progress = Math.min(1, (now - start) / 900);
            paintGlobalMix(progress * progress * (3 - 2 * progress));
            if (progress < 1) requestAnimationFrame(tick);
            else resolve();
          };
          requestAnimationFrame(tick);
        });
      }
      if (signal.aborted) return false;
      globalFront = 1 - globalFront;
      pendingFrame = undefined;
      paintGlobalMix(0);
      updateVisibility();
      const next = target < 19 ? target + 1 : 13;
      L.data("globe-" + next + ".json").catch(() => {});
      return true;
    } catch {
      if (signal.aborted) return false;
      pendingFrame = undefined;
      paintGlobalMix(0);
      if (front.day) day = front.day;
      updateVisibility();
      legendStatus("This frame could not load. Select the day to retry.");
      return false;
    }
  }

  function showGlobalDay() {
    if (pendingFrame?.day === day) return pendingFrame.promise;
    cancelGlobalFrame();
    if (globeSlots[globalFront].day === day) {
      legendStatus();
      updateVisibility();
      return Promise.resolve(true);
    }
    const frame = { day, controller: new AbortController() };
    pendingFrame = frame;
    frame.promise = loadGlobalFrame(frame);
    return frame.promise;
  }

  function clearGrid() {
    gridRequest++;
    gridKey = undefined;
    resolution = "";
    drawnGrid = L.empty;
    barsGrid = undefined;
    archiveFrame = archiveGrid = undefined;
    for (const id of ["metric-grid", "metric-bars"]) map.getSource(id).setData(L.empty);
    legendStatus();
    updateVisibility();
  }

  function updateBars() {
    if (view === "bars" && !barsGrid && gridKey) {
      barsGrid = L.columns(drawnGrid, gridKey);
      map.getSource("metric-bars").setData(barsGrid);
    }
  }

  async function refreshGrid() {
    if (!ready) return;
    if (stage < 0) return showGlobalDay();
    if (usingArchive() || detailedCover()) {
      if (usingArchive()) registerArchiveLayers();
      return refreshArchiveGrid();
    }
    if (stage === 4) return refreshRegionalGrid();
    const key = layerKey();
    if (!key || key === "wow") { updateVisibility(); return; }
    const id = ++gridRequest, bounds = map.getBounds().toArray().flat(), zoom = map.getZoom(), result = results.get(stage);
    legendStatus("Loading layer…");
    try {
      let grid;
      if (key === "utci") {
        const { scope, bounds: selection, cellCount } = result.analysis;
        const [w, s, e, n] = selection;
        const fullCity = scope === "london";
        const clipped = fullCity ? bounds : [Math.max(bounds[0], w), Math.max(bounds[1], s), Math.min(bounds[2], e), Math.min(bounds[3], n)];
        const valid = clipped[0] < clipped[2] && clipped[1] < clipped[3];
        const detail = zoom >= 12.3 || (!fullCity && cellCount <= 12000);
        const level = valid ? await window.HEATLINE_GRID.load(clipped, detail ? Math.max(zoom, 12.3) : zoom) : { features: L.empty };
        const features = level.features.features.filter(({ properties: p }) =>
          fullCity || !detail || (p.lon >= w && p.lon <= e && p.lat >= s && p.lat <= n));
        grid = { resolution: detail ? "100 m walking grid" : "500 m overview · zoom for 100 m", features: L.collection(features.map(feature =>
          ({ ...feature, properties: { ...feature.properties, value: feature.properties.utci } }))) };
      } else if (key === "baseline" || key === "scenario") {
        grid = { resolution: "100 m paired grid", features: L.collection(result.event.features.features.map(feature => ({
          ...feature, properties: { ...feature.properties, value: feature.properties[key] },
        }))) };
      } else if (populationLayers.includes(key)) {
        grid = { resolution: "500 m display grid", features: L.populationGrid(result.event.tiles, key) };
      } else grid = await L.londonGrid(key, bounds, zoom);
      if (id !== gridRequest || key !== layerKey()) return;
      const selectedBounds = area()?.bounds;
      const filtered = selectedBounds && result ? grid.features.features.map(feature => L.clip(feature, selectedBounds)).filter(Boolean) : grid.features.features;
      drawnGrid = L.collection(filtered.map(feature => clipFeature(detailedClip, feature)).filter(Boolean));
      gridKey = key;
      resolution = grid.resolution;
      barsGrid = undefined;
      map.getSource("metric-grid").setData(drawnGrid);
      map.setPaintProperty("metric-fill", "fill-color", L.color(key));
      map.setPaintProperty("metric-extrusion", "fill-extrusion-color", L.color(key));
      updateBars();
      legendStatus(drawnGrid.features.length ? "" : "No valid grid cells in this view.");
    } catch {
      if (id !== gridRequest || key !== layerKey()) return;
      clearGrid();
      legendStatus("This layer could not load. Choose it again to retry.");
    }
    updateVisibility();
  }

  function setView(value) {
    const key = layerKey();
    if (!L.layers[key] || key === "wow" || L.layers[key].type === "station") return false;
    view = value === "bars" ? "bars" : "flat";
    popup?.remove();
    hover?.remove();
    if (stage < 0) globeSlots.forEach(prepareGlobeBars);
    if (stage === 4 || usingArchive() || detailedCover()) refreshGrid();
    else updateBars();
    updateVisibility();
    updateHotspotHeight();
    const pitch = stage < 0 ? 24 : 48;
    if (view === "bars" && map.getPitch() < pitch - 6) {
      if (stage < 0 && spinning) map.stop();
      map.easeTo({ pitch, duration: R.reducedMotion() ? 0 : 520 });
    }
    return true;
  }

  function updateHotspotHeight() {
    const [overview, streetLevel] = view === "bars" ? [440, 205] : [64, 15];
    map.setPaintProperty("heat-hotspot-arrows", "model-translation", ["interpolate", ["linear"], ["zoom"],
      8, ["literal", [0, 0, overview]], 15, ["literal", [0, 0, streetLevel]]]);
  }

  function showHotspots(analysis) {
    const features = (analysis?.hotspots ?? []).slice(0, 3).map((spot, i) => ({
      type: "Feature", geometry: { type: "Point", coordinates: spot.coordinates },
      properties: { label: (i + 1) + " · " + R.format(spot.utci) + "°C" },
    }));
    map.getSource("heat-hotspots").setData(L.collection(features));
    for (const id of ["heat-hotspot-arrows", "heat-hotspot-dot", "heat-hotspot-label"]) visible(id, features.length > 0);
    if (features.length) updateHotspotHeight();
  }

  function stopPlayback() {
    if (playback) clearTimeout(playback.timer);
    playback = undefined;
    $("play-days").textContent = "▶";
    $("play-days").setAttribute("aria-label", "Play heatwave days");
  }

  function setDay(value) {
    if (!Number.isInteger(value) || value < 13 || value > 19) return;
    day = value;
    $("day").value = String(day);
    $("day-value").value = day + " Jul";
    popup?.remove();
    hover?.remove();
    if (stage < 0) return showGlobalDay();
    if (layerKey() === "wow") {
      $("station-period").value = "day";
      results.delete(0);
      renderResult();
      updateStationPoints();
      updateVisibility();
      return renderObservations();
    }
  }

  function playDays() {
    if (playback) { stopPlayback(); return; }
    const run = playback = {};
    $("play-days").textContent = "Ⅱ";
    $("play-days").setAttribute("aria-label", "Pause heatwave days");
    async function advance(next) {
      const started = performance.now();
      const loaded = await setDay(next);
      if (playback !== run) return;
      if (loaded === false) { stopPlayback(); return; }
      run.timer = setTimeout(() => {
        if (playback !== run) return;
        if (next === 19) stopPlayback();
        else advance(next + 1);
      }, Math.max(240, 1250 - (performance.now() - started)));
    }
    advance(day >= 19 ? 13 : day + 1);
  }

  function updateStationBeacons(key = layerKey()) {
    const archive = key === "case-noaa";
    const data = archive ? archiveState.data.stations : stations;
    const selected = archive ? [[archiveState.station, "selected"], [archiveState.comparison, "comparison"]] :
      key === "wow" ? [[activeStation, "selected"], [comparison, "comparison"]] : [];
    for (const [id, marker] of beacons) {
      if (selected.some(([station]) => station === id)) continue;
      marker.remove();
      beacons.delete(id);
    }
    for (const [id, state] of selected) {
      if (!id) continue;
      const station = data.find(item => item.id === id);
      if (!station) continue;
      let marker = beacons.get(id);
      if (!marker) {
        const root = R.element("div", null, "station-marker");
        root.setAttribute("aria-hidden", "true");
        const beacon = R.element("span", null, "station-beacon");
        beacon.append(R.element("i"));
        root.append(beacon);
        marker = new mapboxgl.Marker({ element: root, anchor: "center" }).setLngLat(station.coordinates).addTo(map);
        beacons.set(id, marker);
      }
      marker.setLngLat(station.coordinates);
      marker.getElement().firstElementChild.dataset.state = state;
    }
  }

  function updateStationPoints() {
    map.getSource("wow-stations").setData(L.collection(stations.map(item => ({
      type: "Feature", geometry: { type: "Point", coordinates: item.coordinates },
      properties: { id: item.id, name: item.name, review: Boolean(item.review), value: item.peaks?.[day],
        state: item.id === activeStation ? 1 : item.id === comparison ? 2 : 0 },
    }))));
    updateStationBeacons();
  }

  function stationChoices() {
    const select = $("station"), other = $("comparison-station");
    select.replaceChildren(new Option("Select a station", ""));
    other.replaceChildren(new Option("Select another station", ""));
    for (const item of stations) {
      const label = item.name + (item.review ? " · review flag" : "");
      select.add(new Option(label, item.id));
      if (item.id !== activeStation) other.add(new Option(label, item.id));
    }
    select.value = activeStation ?? "";
    other.value = comparison ?? "";
    updateControls();
  }

  async function loadStations() {
    try {
      if (!stations.length) stations = (await L.data("stations.json")).slice().sort((a, b) => a.name.localeCompare(b.name));
      updateStationPoints();
      stationChoices();
    } catch {
      $("station-observations").textContent = "WOW observations are unavailable in this copy. Use the event weather reference or another map layer.";
    }
  }

  function selectStation(id) {
    activeStation = id || undefined;
    if (comparison === activeStation) comparison = undefined;
    $("station-compare").hidden = true;
    results.delete(0);
    stationChoices();
    updateStationPoints();
    renderResult();
    renderObservations();
    suggestions();
    if (compactLayout.matches) selectPanel("analysis");
  }

  async function renderObservations() {
    const id = ++observationRequest, node = $("station-observations");
    const quality = $("station-quality"), info = stations.find(item => item.id === activeStation);
    quality.hidden = !info;
    quality.dataset.review = String(Boolean(info?.review));
    quality.textContent = info?.review ? "Review flag: an hourly peak exceeded the official UK record. Check station siting and nearby observations." :
      "WOW community observations. Compare with the independent NOAA reference over matching UTC hours.";
    if (node.dataset.station !== (activeStation ?? "")) node.replaceChildren();
    node.dataset.station = activeStation ?? "";
    if (!activeStation) return;
    try {
      const data = await L.data("wow/" + activeStation + ".json");
      if (id === observationRequest) node.replaceChildren(R.observations(data, stationDay()));
    } catch {
      if (id === observationRequest) {
        node.textContent = "This station’s observation series could not load.";
        return false;
      }
    }
  }

  async function showWeatherReference() {
    const node = $("weather-reference");
    if (node.firstElementChild) return;
    try {
      node.replaceChildren(R.weatherReference(await L.data("weather-reference.json")));
    } catch {
      node.textContent = "The NOAA reference could not load. Reopen the chapter to retry.";
    }
  }

  function frameRegional(animate = true) {
    const [a, b] = regionalState.regions.map(region => regionalState.metric === "street" && region.pilot ? region.pilot.bounds : region.bbox);
    frameBounds([Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])],
      10.4, view === "bars" ? 35 : 0, 0, animate);
  }

  function comparisonPreview(city, bounds, street) {
    const preview = R.element("div", null, "comparison-preview");
    if (!street) {
      if (!city.snapshot?.summary.matched) return preview;
      const image = R.element("img");
      image.src = adminPath(city.snapshot.layer.image);
      image.alt = city.name + " Landsat surface temperature map";
      image.decoding = "async";
      preview.append(image);
      return preview;
    }
    const ns = "http://www.w3.org/2000/svg", node = document.createElementNS(ns, "svg");
    const [w, s, e, n] = bounds, width = 100 * (e - w) * Math.cos((s + n) * Math.PI / 360) / (n - s);
    const spec = L.layers["regional-utci"];
    node.setAttribute("viewBox", "0 0 " + width + " 100");
    node.setAttribute("role", "img");
    node.setAttribute("aria-label", city.name + " walking-network UTCI map");
    const rgb = color => [1, 3, 5].map(offset => parseInt(color.slice(offset, offset + 2), 16));
    for (const feature of street.features.features) {
      const { value } = feature.properties;
      const [min, max] = spec.range;
      const position = Math.max(0, Math.min(1, (value - min) / (max - min))) * (spec.colors.length - 1);
      const a = rgb(spec.colors[Math.floor(position)]), b = rgb(spec.colors[Math.ceil(position)]);
      const color = a.map((v, i) => Math.round(v + (b[i] - v) * (position % 1)));
      const polygon = document.createElementNS(ns, "path");
      const path = feature.geometry.coordinates.map(ring => "M" + ring.map(([lon, lat]) =>
        [((lon - w) / (e - w) * width).toFixed(2), ((n - lat) / (n - s) * 100).toFixed(2)].join(",")).join("L") + "Z").join("");
      polygon.setAttribute("d", path);
      polygon.setAttribute("fill", "rgb(" + color.join(",") + ")");
      polygon.setAttribute("stroke", "#2c221f");
      polygon.setAttribute("stroke-width", ".24");
      node.append(polygon);
    }
    preview.append(node);
    return preview;
  }

  function renderRegional() {
    if (stage !== 4 || !regionalState) return;
    const node = $("regional-result");
    const frame = R.button("Frame both cities", () => frameRegional());
    frame.className = "secondary-action";
    if (regionalState.metric === "street") {
      renderStreetComparison(node, frame);
      return refreshRegionalGrid();
    }
    const { regions, reasons, sharedDate, sameScale, threshold, bins } = regionalState;
    const totals = regions.map(city => city.snapshot?.summary);
    const summary = R.element("div", null, "regional-summary");
    for (const [i, city] of regions.entries()) {
      const n = totals[i], panel = R.element("div", null, "regional-stat");
      panel.style.setProperty("--series-color", i ? "#82c9d0" : "#f6ab79");
      const button = R.button(city.name + " ↗", () => frameBounds(city.bbox, 13, view === "bars" ? 40 : 14, 0));
      button.className = "secondary-action";
      button.setAttribute("aria-label", "Zoom to " + city.adminName);
      panel.append(button, R.element("strong", Number.isFinite(n?.mean) ? R.format(n.mean) + "°C" : "—"),
        R.element("small", city.adminName + " · " + (city.snapshot ? city.snapshot.datetime.slice(0, 16).replace("T", " ") + " UTC" +
          (city.snapshot.inCore ? "" : " · outside event core") : "No LST snapshot")),
        R.element("small", n ? (n.match * 100).toFixed(1) + "% of estimated residents matched" +
          (n.above == null ? "" : " · " + (n.above * 100).toFixed(1) + "% at ≥" + threshold + "°C LST") : "No matched residents"));
      if (n?.matched) panel.append(comparisonPreview(city, city.bbox));
      summary.append(panel);
    }
    const first = totals[0], second = totals[1];
    const headline = sameScale ? "Comparable overpasses · " + sharedDate : "No like-for-like comparison";
    const notice = R.element("div", null, "comparison-note");
    notice.append(R.element("strong", headline), R.element("p", sameScale ?
      regions[0].name + " minus " + regions[1].name + ": " + R.format(first.mean - second.mean) +
      "°C in mean residential LST and " + R.format(100 * (first.above - second.above), 1) + " percentage points at ≥" + threshold + "°C." :
      reasons.join(" ") + " The cards report each available snapshot separately."));
    node.replaceChildren(notice, summary);
    if (sameScale) node.append(R.seriesLegend(regions.map(city => city.name)), R.bars(
      "Share of matched residents by LST band (°C)",
      A.bins(bins).map((label, i) => [label, first.histogram[i], second.histogram[i]])));
    node.append(R.element("p", "The map shows surface temperature. The chart weights it by the estimated residential population. The 45°C band is a map comparison threshold.", "data-note"), frame);
    refreshRegionalGrid();
  }

  function renderStreetComparison(node, frame) {
    const { street, streetReason, regions } = regionalState;
    if (!street) {
      node.replaceChildren(R.element("p", streetReason, "comparison-note"), frame);
      return;
    }
    const time = street.timeUtc.slice(0, 16).replace("T", " ") + " UTC";
    const totals = R.element("div", null, "regional-summary");
    for (const [i, city] of street.cities.entries()) {
      const region = regions[i], panel = R.element("div", null, "regional-stat");
      panel.style.setProperty("--series-color", i ? "#82c9d0" : "#f6ab79");
      const focus = R.button(city.name + " pilot ↗", () => frameBounds(region.pilot.bounds, 15.1, view === "bars" ? 44 : 23, 0));
      focus.className = "secondary-action";
      panel.append(focus, R.element("strong", city.meanUtci.toFixed(2) + "°C"),
        R.element("small", city.cellCount + " cells · " + R.distance(city.pathLengthM) + " represented walking routes"),
        R.element("small", (city.strongHeat.pathLengthShare * 100).toFixed(1) + "% of walking length in cells ≥32°C UTCI"),
        comparisonPreview(city, region.pilot.bounds, city));
      totals.append(panel);
    }
    const notice = R.element("div", null, "comparison-note");
    notice.append(R.element("strong", "Same-time street pilots · " + time),
      R.element("p", street.cities[0].name + " minus " + street.cities[1].name + ": " +
        (street.cities[0].meanUtci - street.cities[1].meanUtci).toFixed(2) + "°C walking-length-weighted UTCI."));
    const bands = [...new Set(street.cities.flatMap(city => city.distribution.map(b => b.from)))].sort((a, b) => a - b);
    node.replaceChildren(notice, totals, R.seriesLegend(street.cities.map(city => city.name)),
      R.bars("Share of represented walking length by UTCI (°C)", bands.map(n => [n + "–" + (n + 1),
        ...street.cities.map(city => city.distribution.find(b => b.from === n)?.share ?? 0)])),
      R.element("p", "Both results represent only the outlined samples of walking routes at that modelled time. Use each city button to inspect its 100 m grid.", "data-note"), frame);
  }

  const compareEvents = {
    "E1_2019-07": "July 2019 European heatwave", "E2_2020-08": "August 2020 European heatwave",
    "G1_2021-06": "June 2021 Pacific Northwest heat dome", "E3_2022-07": "July 2022 European heatwave",
    "E4_2025-06": "June–July 2025 European heatwave", "E5_2026-06": "June 2026 European heatwave",
  };

  async function refreshRegionalGrid() {
    const state = regionalState;
    if (!state || stage !== 4) { updateVisibility(); return; }
    const key = layerKey();
    if (!key) { updateVisibility(); return; }
    const frame = [state.event.id, ...state.regions.map(city => city.id), key, view].join("/");
    if (regionalFrame === frame && gridKey === key) { updateVisibility(); return; }
    const id = ++gridRequest;
    gridKey = key;
    resolution = "";
    if (key === "regional-utci") {
      drawnGrid = L.collection(state.street.cities.flatMap(city => city.features.features));
      map.getSource("metric-grid").setData(drawnGrid);
      map.setPaintProperty("metric-fill", "fill-color", L.color(key));
      map.setPaintProperty("metric-extrusion", "fill-extrusion-color", L.color(key));
      barsGrid = undefined;
      updateBars();
    } else if (view === "bars") {
      try {
        const parts = await Promise.all(state.regions.map(async city => {
          const meta = city.snapshot?.layer;
          if (!meta || !city.snapshot.summary.matched) return [];
          const buffer = await A.readAdmin(meta.numeric, "grid");
          return A.rasterColumns(buffer, meta, city.clip).map(feature => ({
            ...feature, properties: { ...feature.properties, city: city.name },
          }));
        }));
        if (id !== gridRequest || stage !== 4 || state !== regionalState) return;
        drawnGrid = L.collection(parts.flat());
        map.setPaintProperty("metric-extrusion", "fill-extrusion-color", L.color("regional"));
        barsGrid = undefined;
        updateBars();
      } catch {
        if (id === gridRequest) legendStatus("The 3D preview could not load. The Landsat map is still available.");
      }
    }
    if (id === gridRequest) { regionalFrame = frame; updateVisibility(); }
  }

  async function loadRegional(options = {}, animate = true) {
    if (!adminCatalog) return;
    const id = ++regionalRequest;
    const node = $("regional-result"), eventSelect = $("regional-event"), measure = $("regional-metric"), first = $("regional-first"), second = $("regional-second");
    const metric = (options.metric ?? measure.value) === "street" ? "street" : "surface";
    measure.value = metric;
    regionalState = undefined;
    regionalFrame = undefined;
    regionalLoading = true;
    updateControls();
    clearGrid();
    node.textContent = metric === "street" ? "Checking for matched walking-network model times…" : "Loading residential surface-heat snapshots…";
    try {
      const fallback = metric === "street" ? "E3_2022-07" : "E2_2020-08";
      const requested = options.event ?? (eventSelect.value || fallback);
      const requestedEvent = Object.hasOwn(compareEvents, requested) ? requested : fallback;
      const event = Object.hasOwn(compareEvents, requestedEvent) ? { id: requestedEvent, label: compareEvents[requestedEvent] } : null;
      if (!event) throw new Error("This event is not in the archive.");
      const available = Object.entries(adminCatalog.cities).flatMap(([id, city]) => city.events[event.id] && !city.events[event.id].pointOnly ?
        [{ id, ...city, snapshot: city.events[event.id].snapshot, pilot: adminCatalog.streetModels?.[id]?.[event.id] }] : []);
      const a = available.find(region => region.id === (options.firstRegion ?? (first.value || "Paris"))) ?? available[0];
      const b = available.find(region => region.id === (options.secondRegion ?? (second.value || "Amsterdam")) && region !== a) ??
        available.find(region => region !== a);
      if (!a || !b) throw new Error("Two cities are required.");
      const shapes = await Promise.all([a, b].map(region => A.readAdmin(region.boundary)));
      if (stage !== 4 || id !== regionalRequest) return;
      const [x, y] = [a, b].map(city => city.snapshot);
      const sharedDate = x && y && x.datetime.slice(0, 10) === y.datetime.slice(0, 10) ? x.datetime.slice(0, 10) : null;
      const { minimumMatch, maxSolarMinutes, threshold, bins } = adminCatalog.comparison;
      const reasons = [];
      if (!x || !y) reasons.push("At least one city has no archived Landsat scene.");
      else {
        if (!sharedDate) reasons.push("The Landsat scenes were acquired on different dates.");
        if (!x.inCore || !y.inCore) reasons.push("At least one overpass falls outside the heatwave’s core dates.");
        const gap = Math.abs((Date.parse(x.datetime) - Date.parse(y.datetime)) / 60000 + 4 * (a.center[0] - b.center[0]));
        if (sharedDate && gap > maxSolarMinutes) reasons.push("The local solar overpass times are more than " + maxSolarMinutes + " minutes apart.");
        if (Math.min(x.summary.match, y.summary.match) < minimumMatch) reasons.push("At least one scene matches less than " + minimumMatch * 100 + "% of the city’s estimated residents.");
      }
      if ((options.date && sharedDate !== options.date) || (options.day && Number(sharedDate?.slice(-2)) !== options.day)) {
        reasons.push("The archive has no comparable overpasses for the requested day.");
      }
      if (options.time && [x, y].some(snapshot => !snapshot || !snapshot.datetime.slice(11).startsWith(options.time))) {
        reasons.push("The archive has no pair of overpasses at the requested UTC time.");
      }
      eventSelect.replaceChildren(...Object.entries(compareEvents).map(([id, label]) => new Option(label, id)));
      eventSelect.value = event.id;
      for (const [control, value, other] of [[first, a.id, b.id], [second, b.id, a.id]]) {
        control.replaceChildren(...available.map(region => {
          const option = new Option(region.name, region.id);
          option.disabled = region.id === other;
          return option;
        }));
        control.value = value;
      }
      regionalState = { event, regions: [a, b].map((city, i) => ({ ...city, clip: A.boundaryIndex(shapes[i], city.bbox) })),
        sharedDate, sameScale: reasons.length === 0, reasons, threshold, bins, metric, requestDate: options.date, requestTime: options.time };
      setCaseUrl();
      updateCaseHeader();
      map.getSource("regional-areas").setData(L.collection([a, b].flatMap((region, i) => {
        const [w, , e, n] = metric === "street" && region.pilot ? region.pilot.bounds : region.bbox;
        const properties = { name: region.name, accent: i ? "#82c9d0" : "#f6ab79" };
        if (metric === "surface" && region.snapshot?.summary.matched) {
          const layer = region.snapshot.layer;
          map.getSource("compare-image-" + (i ? "b" : "a")).updateImage({ url: adminPath(layer.image), coordinates: layer.coordinates });
        }
        return [
          { ...shapes[i], properties },
          ...(metric === "street" && region.pilot ? [{ type: "Feature", geometry: region.pilot.geometry, properties }] : []),
          { type: "Feature", properties, geometry: { type: "Point", coordinates: [(w + e) / 2, n] } },
        ];
      })));
      if (metric === "street") {
        const result = await receive("/api/analysis", { kind: "street-comparison", regions: [a.id, b.id], event: event.id, date: options.date, time: options.time },
          message => { if (id === regionalRequest && stage === 4) node.textContent = message; });
        if (id !== regionalRequest || stage !== 4) return;
        if (result.ok) regionalState.street = result.event;
        else regionalState.streetReason = result.reply;
        renderRegional();
        frameRegional(animate);
        return result.reply;
      }
      renderRegional();
      frameRegional(animate);
      return regionalState.sameScale ?
        sharedDate + " UTC · " + a.name + " " + x.summary.mean.toFixed(2) + "°C and " + b.name + " " + y.summary.mean.toFixed(2) +
        "°C population-weighted Landsat LST. See the map and resident distribution in the comparison panel." :
        "These snapshots cannot be directly compared. " + reasons.join(" ") + " The available dated snapshots are on the map.";
    } catch {
      if (stage === 4 && id === regionalRequest) node.textContent = "The comparison could not load. Reopen this chapter to retry.";
    } finally {
      if (id === regionalRequest) { regionalLoading = false; updateControls(); }
    }
  }

  function chooseLayer(key, requestedDay) {
    if (key === "era5") {
      openChapter(-1);
      if (requestedDay) setDay(requestedDay);
      return;
    }
    if (key === "utci") { openChapter(2); return; }
    if (!L.londonLayers.includes(key)) return;
    cityLayer = key;
    if (stage !== 0) openChapter(0);
    else {
      popup?.remove();
      hover?.remove();
      stopPlayback();
      clearGrid();
      renderChapter();
      refreshGrid();
    }
    if (key === "wow" && requestedDay) setDay(requestedDay);
  }

  function rectangle(a, b) {
    return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])];
  }

  function drawOutline(bounds) {
    const source = map.getSource("analysis-area");
    if (!bounds) return source.setData(L.empty);
    const [w, s, e, n] = bounds;
    source.setData({ type: "Feature", properties: {}, geometry: {
      type: "Polygon", coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]],
    } });
  }

  function outline() {
    drawOutline(area()?.bounds ?? (stage === 3 && area()?.chosen && !usingArchive() ? pilot : undefined));
  }

  function areaLabel() {
    const selection = area();
    if (!selection) return;
    const place = stage === 1 ? results.get(1)?.event?.place : undefined;
    const archived = usingArchive() && (stage === 1 ? archiveState.event.snapshot : archiveState.street);
    const time = archived?.datetime ?? archived?.timeUtc;
    $("area-name").textContent = place && !selection.bounds ? place : selection.bounds ? "Drawn area" : usingArchive() ?
      stage === 1 ? archiveState.admin.adminName : archiveState.street?.label ?? "Street model unavailable" : !selection.chosen ? "Select the analysis area" :
      stage === 3 ? "Central London paired pilot" : stage === 1 ? "Greater London" : "London UTCI study area";
    $("area-hint").textContent = drawing ? (corner ? "Click the opposite corner." : "Click one corner on the map.") :
      usingArchive() ? time ? time.slice(0, 16).replace("T", " ") + " UTC" : stage === 1 ? "No valid residential Landsat snapshot" : "No model for this event" :
      stage === 1 ? "Landsat 9 · 18 July 2022 · 10:52 UTC" : "18 July 2022 · 10:52 UTC";
    $("draw-area").textContent = drawing ? "Cancel drawing" : "Draw area";
    $("draw-area").setAttribute("aria-pressed", String(drawing));
    $("full-area").textContent = usingArchive() ? stage === 1 ? "Use administrative area" : "Use model coverage" :
      stage === 3 ? "Use paired pilot" : stage === 1 ? "Use Greater London" : "Use study area";
    $("full-area").setAttribute("aria-pressed", String(selection.chosen && !selection.bounds));
  }

  function setDrawing(on) {
    drawing = on;
    corner = undefined;
    popup?.remove();
    hover?.remove();
    if (on) {
      map.doubleClickZoom.disable();
      if (compactLayout.matches) {
        selectPanel("analysis");
        $("app").dataset.drawing = "true";
      }
      drawOutline(undefined);
    } else {
      map.doubleClickZoom.enable();
      delete $("app").dataset.drawing;
      outline();
    }
    map.getCanvas().style.cursor = on ? "crosshair" : "";
    areaLabel();
    updateControls();
    if (!on) refreshGrid();
  }

  function setArea(selection, center = false) {
    if (!area()) return;
    areas.set(stage, selection);
    results.delete(stage);
    reportAnalysis();
    clearGrid();
    setStep("area");
    renderResult();
    setDrawing(false);
    if (usingArchive()) updateArchiveControls();
    if (stage === 3 && center && !usingArchive()) move(street);
    if (center && usingArchive()) frameBounds(stage >= 2 && archiveState.street ? archiveState.street.bounds : archiveState.admin.bbox,
      stage >= 2 && archiveState.street ? 15.5 : 13);
  }

  function selectArea(bounds, center = false) {
    setArea({ chosen: true, bounds }, center);
  }

  function clearAnalysis() {
    if (busy || !area() || !results.has(stage)) return;
    setArea({ chosen: false });
    $("draw-area").focus({ preventScroll: true });
    $("area-analysis").scrollIntoView({ block: "start", behavior: R.reducedMotion() ? "instant" : "smooth" });
  }

  function selectCorner(e) {
    if (!drawing) return;
    e.preventDefault();
    const point = e.lngLat.toArray();
    if (!corner) {
      corner = point;
      areaLabel();
      return;
    }
    const bounds = rectangle(corner, point);
    if (bounds[2] - bounds[0] >= .0001 && bounds[3] - bounds[1] >= .0001) selectArea(bounds);
    else {
      $("area-hint").textContent = "Choose a point farther from the first corner.";
      if (compactLayout.matches) showPopup(e.lngLat, "Choose a point farther from the first corner.");
    }
  }

  function setStep(step) {
    for (const name of ["area", "run", "result"]) {
      if (name === step) $("step-" + name).setAttribute("aria-current", "step");
      else $("step-" + name).removeAttribute("aria-current");
    }
  }

  function updateControls() {
    for (const id of ["draw-area", "full-area", "run-analysis", "clear-analysis", "shade-percent", "station", "station-period",
      "comparison-station", "analyse-station", "compare-stations", "layer-select", "prompt", "enter", "globe",
      "population-group", "population-reference", "rank-boroughs", "archive-layer", "archive-model", "archive-date",
      "archive-station", "archive-station-other", "archive-period", "archive-weather", "archive-analyse-station",
      "archive-compare-stations", "archive-groups", "archive-play", "view-mode", "intro-compare"]) $(id).disabled = busy || !ready || caseLoading;
    $("case-city").disabled = busy || !ready || caseLoading || !caseCatalog || stage === 4;
    $("case-event").disabled = busy || !ready || caseLoading || !caseCatalog;
    for (const id of ["regional-event", "regional-metric", "regional-first", "regional-second"]) $(id).disabled = busy || !ready || regionalLoading || !adminCatalog;
    $("view-mode").querySelector('[value="comparison"]').disabled = !adminCatalog;
    $("run-analysis").disabled ||= drawing || (!area()?.chosen && !(usingArchive() && stage >= 2));
    $("clear-analysis").disabled ||= drawing;
    if (usingArchive() && stage >= 2 && !archiveState.street) {
      $("draw-area").disabled = $("full-area").disabled = $("shade-percent").disabled = true;
    }
    if (usingArchive() && stage === 0) {
      $("archive-analyse-station").disabled ||= !archiveState.station;
      $("archive-compare-stations").disabled ||= !archiveState.station || !archiveState.comparison;
    }
    $("intro-compare").disabled ||= !adminCatalog;
    for (const node of $("city-cases").children) node.disabled = busy || caseLoading;
    $("rank-boroughs").disabled ||= drawing;
    $("analyse-station").disabled ||= !activeStation;
    $("compare-stations").disabled ||= !activeStation || !comparison;
    $("prompt").disabled ||= drawing;
    $("show-atlas-panel").disabled = drawing;
    $("prompt-form").querySelector("button").disabled = $("prompt").disabled;
    $("day").disabled = $("play-days").disabled = busy || !(stage < 0 || layerKey() === "wow");
    for (const node of $("chapter-nav").children) node.disabled = busy || caseLoading;
    for (const node of $("suggestions").children) node.disabled = busy || drawing || caseLoading;
  }

  function appendTurn(role, message) {
    const item = R.element("div", null, "chat-turn");
    item.dataset.role = role;
    const body = R.element("p", message ?? "•••", message == null ? "chat-thinking" : undefined);
    if (message == null) body.setAttribute("aria-label", "Atlas is preparing a reply");
    const bubble = R.element("div", null, "chat-bubble");
    bubble.append(body);
    item.append(R.element("b", role === "user" ? "You" : "Atlas"), bubble);
    $("conversation").append(item);
    if ($("conversation").childElementCount > 30) $("conversation").firstElementChild.remove();
    $("chat-empty").hidden = $("suggestions").hidden = true;
    scrollChat();
    return { body, bubble };
  }

  function scrollChat() {
    $("guide-scroll").scrollTop = $("guide-scroll").scrollHeight;
  }

  function writeReply(turn, message) {
    turn.body.classList.remove("chat-thinking");
    turn.body.removeAttribute("aria-label");
    return R.typeText(turn.body, message, scrollChat);
  }

  function selectPanel(panel) {
    $("app").dataset.panel = panel;
    $("show-analysis-panel").setAttribute("aria-pressed", String(panel === "analysis"));
    $("show-atlas-panel").setAttribute("aria-pressed", String(panel === "atlas"));
    syncLegendClearance();
    if (panel === "atlas") scrollChat();
    if (stage < 0 && ready && compactLayout.matches && !drawing) {
      map.jumpTo({ padding: cameraPadding() });
      updateGlobeRotation();
    }
  }

  function reportAnalysis(message = "") {
    const notice = $("analysis-notice");
    notice.textContent = message;
    notice.hidden = !message;
    if (message && notice.offsetParent) notice.scrollIntoView({ block: "nearest" });
  }

  function addToolCall(turn, kind, request) {
    const label = ({ station: request.comparison ? "station comparison" : "station analysis",
      population: request.rank ? "district LST ranking" : "population comparison",
      exposure: "heat exposure analysis", shade: "shade scenario", groups: "resident group comparison", weather: "event weather analysis" })[kind];
    const stationName = id => stations.find(station => station.id === id)?.name;
    const subject = request.archiveCase ? archiveState.city.name + " · " + archiveState.record.label :
      kind === "station" ? [stationName(request.station), stationName(request.comparison)].filter(Boolean).join(" + ") :
      kind === "shade" ? request.shadePercent + "% sunlit route length" :
        kind === "population" ? populationGroups[request.group] : request.bounds ? "Drawn area" : "London study area";
    const tool = R.element("div", null, "chat-tool");
    tool.dataset.state = "running";
    tool.append(R.element("i"), R.element("span", "Running " + label + (subject ? " · " + subject : "")));
    tool.firstElementChild.setAttribute("aria-hidden", "true");
    turn.bubble.prepend(tool);
    turn.tool = tool;
    turn.toolLabel = label + (subject ? " · " + subject : "");
    turn.stage = stage;
    scrollChat();
  }

  function finishToolCall(turn, success) {
    if (!turn?.tool) return;
    turn.tool.dataset.state = success ? "complete" : "error";
    turn.tool.lastElementChild.textContent = (success ? "Completed " : "Could not complete ") + turn.toolLabel;
    if (success) {
      const link = R.button("View analysis ↗", () => {
        if (busy || results.get(turn.stage)?.run !== turn.run) return;
        if (stage !== turn.stage) openChapter(turn.stage);
        selectPanel("analysis");
        if (!$("analysis-result").hidden) $("analysis-result").scrollIntoView({ block: "start" });
      });
      link.className = "chat-jump";
      link.dataset.stage = String(turn.stage);
      link.dataset.run = String(turn.run);
      turn.bubble.append(link);
    }
  }

  function suggestions() {
    let texts = chapter()[5];
    if (layerKey() === "wow" && activeStation) texts = ["What does this station’s weather show?", "Compare with another station"];
    if (usingArchive() && stage === 0 && layerKey() === "case-noaa" && archiveState.station) {
      texts = ["What does this station’s weather show?", ...(archiveState.data.stations.length > 1 ? ["Compare with another station"] : [])];
    }
    $("suggestions").replaceChildren(...texts.slice(0, 2).map(text => R.button(text, () => submit(text))));
    updateControls();
  }

  function renderResult(animate = false) {
    const result = results.get(stage);
    const show = Boolean(result) && (stage !== 0 || layerKey() === "wow" || usingArchive());
    const node = $("analysis-result");
    node.hidden = !show;
    $("analysis-footer").hidden = !show || !area();
    $("station-observations").hidden = stage === 0 && show;
    for (const link of $("conversation").querySelectorAll('.chat-jump[data-stage="' + stage + '"]')) {
      if (Number(link.dataset.run) === result?.run) continue;
      link.disabled = true;
      link.textContent = "Result no longer on map";
    }
    node.replaceChildren();
    showHotspots(stage === 2 && show && ["utci", "case-utci"].includes(layerKey()) ? result.analysis : undefined);
    if (!show) return;
    const blocks = result.event?.kind?.startsWith("archive-") ? A.result(result) : R.render(result, {
      variant: variants[stage],
      hotspot: spot => {
        popup?.remove();
        hover?.remove();
        move({ center: spot.coordinates, zoom: 15.4, pitch: 50, bearing: -19 });
      },
      layer: key => {
        if (busy) return;
        variants[stage] = key;
        if (usingArchive()) { archiveState.contextLayer[stage] = false; updateArchiveControls(); }
        clearGrid();
        refreshGrid();
      },
    });
    if (animate && !R.reducedMotion()) return revealResult(node, blocks);
    node.append(...blocks);
  }

  async function revealResult(panel, [title, reply, ...blocks]) {
    const message = reply.textContent;
    reply.textContent = "";
    panel.append(title, reply);
    if (panel.offsetParent) title.scrollIntoView({ block: "nearest" });
    await R.typeText(reply, message, undefined, { interval: 19, maximum: 4900 });
    await wait(180);
    for (const block of blocks) {
      block.classList.add("result-arrive");
      panel.append(block);
      const chart = block.matches(".station-plots,.bar-chart,.line-chart");
      if (panel.offsetParent && chart) block.scrollIntoView({ block: "nearest", behavior: "smooth" });
      await wait(chart ? 1120 : 220);
    }
  }

  function renderChapter() {
    const [, , title, copy, method] = chapter(), key = layerKey();
    $("intro").hidden = stage >= 0;
    $("global-map-controls").hidden = stage >= 0;
    $(stage < 0 ? "global-map-controls" : "chapter-map-controls").append($("map-controls"));
    $("analysis-panel").hidden = stage < 0;
    $("guide").hidden = false;
    $("panel-switch").hidden = stage < 0;
    $("chapter-nav").hidden = stage < 0 || stage === 4;
    updateCaseHeader();
    $("case-event-controls").hidden = stage < 0 || stage === 4;
    $("archive-workspace").hidden = !usingArchive();
    $("weather-reference").hidden = stage !== 0 || usingArchive();
    $("station-analysis").hidden = key !== "wow";
    $("area-analysis").hidden = !area();
    $("population-controls").hidden = stage !== 1 || usingArchive();
    $("archive-groups").hidden = stage !== 1 || !usingArchive();
    $("shade-controls").hidden = stage !== 3 || usingArchive() && !archiveState.street;
    $("regional-comparison").hidden = stage !== 4;
    $("chapter-index").textContent = stage < 0 ? "GLOBAL CONTEXT" : stage === 4 ? "GLOBAL CITY COMPARISON" : "0" + (stage + 1) + " / 04";
    $("chapter-title").textContent = title;
    $("chapter-copy").textContent = copy;
    $("method-copy").textContent = method;
    if (stage < 0) $("global-method-copy").textContent = method;
    $("prompt").placeholder = stage === 2 ? "Ask Atlas about your selection…" : "Ask Atlas about the heatwave…";
    $("layer-select").value = cityLayer;
    $("run-label").textContent = ({ 1: usingArchive() ? "Run population exposure" : "Compare resident groups",
      2: "Run heat exposure analysis", 3: "Run shade scenario" })[stage] ?? "";
    if (usingArchive() && stage >= 2 && !archiveState.street) $("run-label").textContent = "Check model inputs";
    $("actions").replaceChildren();
    if (stage === 3 && !usingArchive()) $("actions").append(R.element("p", "159 paired cells · 6.01°C median sun–building shade difference"));
    if (stage === 0 && !usingArchive()) showWeatherReference();
    if (usingArchive()) updateArchiveControls();
    if (usingArchive() && stage >= 2 && !archiveState.street && archiveState.otherStreet) {
      const [event] = Object.keys(adminCatalog.streetModels[caseRegion]);
      const record = archiveState.city.cases.find(item => item.id === event);
      $("actions").append(R.button("Open " + record.label + " street model ↗", () => {
        if (!busy) chooseCase(caseRegion, event, stage);
      }));
    }
    if (key === "wow") { loadStations(); renderObservations(); }
    for (const [index, button] of [...$("chapter-nav").children].entries()) button.setAttribute("aria-current", String(stage === index));
    areaLabel();
    setStep(results.has(stage) ? "result" : "area");
    suggestions();
    renderResult();
    updateVisibility();
    updateGlobeRotation();
    syncLegendClearance();
  }

  function openChapter(index, animate = true, regionalOptions, forceFrame = false) {
    if (!ready || index < -1 || index >= chapters.length) return;
    const previous = stage;
    if (previous === 4 && index !== 4) {
      regionalRequest++;
      regionalLoading = false;
    }
    if (drawing) setDrawing(false);
    popup?.remove();
    hover?.remove();
    stopPlayback();
    stopArchivePlayback();
    stage = index;
    if (stage >= 0) cancelGlobalFrame();
    $("app").classList.toggle("global-mode", index < 0);
    clearGrid();
    setCaseUrl();
    $("method").open = false;
    reportAnalysis();
    renderChapter();
    $("analysis-scroll").scrollTop = 0;
    outline();
    if (index === 4) {
      if (previous !== index && !regionalState) move(europe, false);
      return loadRegional(regionalOptions, animate);
    }
    if (usingArchive()) {
      if (forceFrame || previous !== index) {
        const street = stage >= 2 && archiveState.street;
        frameBounds(street ? (area()?.bounds ?? archiveState.street.bounds) : archiveState.admin.bbox,
          street ? 15.5 : 13, view === "bars" ? 38 : street ? 38 : 14, 0, animate);
      }
      return refreshGrid();
    }
    if (!animate || previous !== index || forceFrame) {
      const camera = index < 0 ? { ...globe, zoom: phoneLayout.matches ? .16 : globe.zoom } : index < 2 ? london : street;
      const savedArea = results.get(2)?.analysis;
      const districtExtent = results.get(1)?.event?.districtExtent;
      if (area()?.bounds && results.has(index)) frameBounds(area().bounds, 15.6);
      else if (index === 1 && districtExtent) frameBounds(districtExtent, 13.4);
      else if (index === 2 && savedArea?.scope === "london") frameBounds(savedArea.bounds);
      else move({ ...camera, pitch: view === "bars" ? index < 0 ? 24 : 51 : camera.pitch }, animate);
    }
    refreshGrid();
  }

  function progress(message) {
    const panel = $("analysis-progress");
    panel.querySelector("p").textContent = message;
    panel.hidden = false;
    if (panel.offsetParent) panel.scrollIntoView({ block: "nearest" });
  }

  async function receive(endpoint, body, onProgress) {
    const response = await fetch(endpoint, {
      method: "POST", headers: { "Content-Type": "application/json", Accept: "application/x-ndjson" },
      body: JSON.stringify(body), signal: AbortSignal.timeout(20000),
    });
    if (response.headers.get("content-type")?.includes("application/json")) return response.json();
    if (!response.ok || !response.body || !response.headers.get("content-type")?.includes("application/x-ndjson")) {
      throw new Error("Analysis service unavailable");
    }
    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = "", outcome;
    function handle(line) {
      if (!line.trim()) return;
      const event = JSON.parse(line);
      if (event.type === "progress") onProgress(event.message);
      if (event.type === "result") outcome = event;
    }
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      const lines = (buffer + value).split("\n");
      buffer = lines.pop();
      lines.forEach(handle);
    }
    handle(buffer);
    if (!outcome) throw new Error("Analysis service did not return a result");
    return outcome;
  }

  function revealComparison(focus = false) {
    $("station-compare").hidden = false;
    if (focus) $("comparison-station").scrollIntoView({ block: "nearest" });
  }

  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  function syncPopulationOptions(primary = "population-group") {
    const other = primary === "population-group" ? "population-reference" : "population-group";
    if ($(primary).value === $(other).value) $(other).value = $(primary).value === "all" ? "older" : "all";
  }

  async function performArchive(kind, options = {}, chatTurn) {
    const index = { weather: 0, station: 0, population: 1, groups: 1, exposure: 2, shade: 3 }[kind];
    if (!archiveState || index === undefined) return;
    const explain = message => chatTurn ? writeReply(chatTurn, message) : reportAnalysis(message);
    const drawn = options.scope === "full" ? undefined : options.bounds ?? area()?.bounds ?? areas.get(index)?.bounds;
    if (stage !== index) openChapter(index);
    const weatherAction = index === 0;
    if (weatherAction && options.date && options.date !== archiveState.date && !setArchiveDate(options.date)) {
      return explain("Choose a UTC date available in the selected historical case.");
    }
    if (kind === "station" && options.stationPeriod && options.stationPeriod !== archiveState.stationPeriod) {
      archiveState.stationPeriod = options.stationPeriod;
      if (results.get(0)?.event?.kind === "archive-station") results.delete(0);
      renderResult();
      updateArchiveControls();
    }
    const request = {
      kind, archiveCase: { region: caseRegion, event: caseEvent }, date: weatherAction ? archiveState.date : options.date, model: archiveState.model,
      station: archiveState.station, comparison: options.compare ? archiveState.comparison : undefined,
      stationPeriod: archiveState.stationPeriod, compare: options.compare,
      bounds: ["population", "exposure", "shade"].includes(kind) ? drawn : undefined,
      shadePercent: options.shadePercent ?? Number($("shade-percent").value), time: options.time,
    };
    if (chatTurn) addToolCall(chatTurn, kind, request);
    if (kind === "station") {
      const points = [request.station, request.comparison].map(id => archiveState.data.stations.find(item => item.id === id)?.coordinates).filter(Boolean);
      if (points.length === 2 && (points[0][0] !== points[1][0] && points[0][1] !== points[1][1])) {
        frameBounds(rectangle(...points), 13, 25, 0);
      } else if (points.length) move({ center: points[0], zoom: 12, pitch: 25, bearing: 0 });
    }
    let phases = Promise.resolve(), active = true;
    let outcome;
    try {
      outcome = await receive("/api/analysis", request, message => {
        phases = phases.then(async () => {
          if (!active) return;
          setStep("run");
          progress(message);
          if (!R.reducedMotion()) await wait(600);
        });
      });
      if (outcome.ok) await phases;
    } finally { active = false; }
    $("analysis-progress").hidden = true;
    if (!outcome.ok) {
      setStep(results.has(stage) ? "result" : "area");
      finishToolCall(chatTurn, false);
      return explain(outcome.reply);
    }
    outcome.run = ++analysisRun;
    if (request.bounds) areas.set(stage, { chosen: true, bounds: request.bounds });
    else if (!weatherAction) areas.set(stage, { chosen: true });
    results.set(stage, outcome);
    if (chatTurn) chatTurn.run = outcome.run;
    setStep("result");
    if (kind === "station") chooseArchiveLayer("noaa");
    else if (request.bounds) frameBounds(request.bounds, 15.5, index >= 2 ? 42 : 22, 0);
    else if (index >= 2 && archiveState.street) frameBounds(archiveState.street.bounds, 15.5, 42, 0);
    if (!weatherAction) {
      if (kind === "population") archiveState.selected[1] = "lst_c";
      if (kind === "shade") {
        variants[3] = "scenario";
        $("shade-percent").value = String(request.shadePercent);
        $("shade-value").value = request.shadePercent + "%";
      }
      archiveState.contextLayer[stage] = false;
      areaLabel();
      outline();
      clearGrid();
      updateArchiveControls();
      refreshGrid();
    }
    await Promise.all([renderResult(true), chatTurn && writeReply(chatTurn, outcome.reply + (kind === "station" && !options.compare &&
      archiveState.data.stations.length > 1 ? " I can compare the same period with a second station." : ""))]);
    finishToolCall(chatTurn, true);
  }

  async function perform(kind, options = {}, chatTurn) {
    if (usingArchive()) return performArchive(kind, options, chatTurn);
    const index = { station: 0, population: 1, exposure: 2, shade: 3 }[kind];
    if (index === undefined) return;
    const explain = message => chatTurn ? writeReply(chatTurn, message) : reportAnalysis(message);
    const drawn = options.scope === "selected" ? area()?.bounds : undefined;
    if ((archiveState || caseRegion !== "London") && !await chooseCase("London", detailedEvent, index)) {
      return explain("The detailed London case could not load.");
    }
    if (kind === "station" && layerKey() !== "wow") chooseLayer("wow");
    if (index !== stage) {
      openChapter(index);
      if (drawn && area()) selectArea(drawn);
    }
    if (options.scope === "london" && area() && (!area().chosen || area().bounds)) selectArea(undefined);
    if (options.scope === "selected" && area() && !area().bounds && (kind === "shade" || kind === "population")) {
      return explain("Draw an area first, or run the analysis for the full available area.");
    }
    if (kind === "shade" && !area().chosen) selectArea(undefined);
    if (area() && !area().chosen) {
      return explain("Draw an area or use the study area first.");
    }
    if (kind === "station" && options.compare && !comparison) {
      revealComparison(true);
      return explain("Choose a second WOW station to compare shared UTC hours.");
    }
    if (kind === "station" && options.day) setDay(options.day);
    if (kind === "shade" && options.shadePercent != null && options.shadePercent >= 0 && options.shadePercent <= 100) {
      $("shade-percent").value = options.shadePercent;
      $("shade-value").value = options.shadePercent + "%";
    }
    const request = { kind, bounds: area()?.bounds, station: activeStation, comparison: options.compare ? comparison : undefined,
      day: stationDay(), shadePercent: options.shadePercent ?? Number($("shade-percent").value) };
    if (kind === "population") {
      if (options.group) $("population-group").value = options.group;
      if (options.reference) $("population-reference").value = options.reference;
      syncPopulationOptions();
      Object.assign(request, { group: $("population-group").value, reference: $("population-reference").value,
        borough: options.borough, rank: options.rank, rankOrder: options.rankOrder, scopeNote: options.scopeNote });
      if (request.borough || request.rank) request.bounds = undefined;
    }
    if (kind === "station") focusStations(request.station, request.comparison);
    if (chatTurn) addToolCall(chatTurn, kind, request);
    results.delete(stage);
    clearGrid();
    renderResult();
    setStep("run");
    const started = performance.now();
    progress("Starting " + ({
      station: options.compare ? "the station comparison" : "the station analysis",
      population: "the residential surface heat comparison", exposure: "the pedestrian heat exposure calculation", shade: "the shade scenario",
    })[kind] + "…");
    let phases = Promise.resolve(), pending = true;
    let result;
    try {
      result = await receive("/api/analysis", request, message => {
        phases = phases.then(async () => {
          if (!pending) return;
          await wait(760);
          if (pending) progress(message);
        });
      });
      if (result.ok) await phases;
    } finally {
      pending = false;
    }
    if (!result.ok) {
      setStep("area");
      if (kind === "station" && options.compare) revealComparison(true);
      finishToolCall(chatTurn, false);
      return explain(result.reply);
    }
    if (!R.reducedMotion()) await wait(Math.max(540, 2760 - (performance.now() - started)));
    progress("Preparing the map and results…");
    if (!R.reducedMotion()) await wait(460);
    result.run = ++analysisRun;
    results.set(stage, result);
    if (chatTurn) chatTurn.run = result.run;
    if (kind === "population") variants[1] = "residents";
    if (kind === "shade") variants[3] = "scenario";
    setStep("result");
    areaLabel();
    if (kind === "station") revealComparison();
    updateVisibility();
    if (request.bounds) frameBounds(request.bounds, 15.6);
    else if (kind === "population" && result.event.districtExtent) frameBounds(result.event.districtExtent, 13.4);
    else if (kind === "population" && !result.event.borough) move(london);
    else if (kind === "exposure" && result.analysis.scope === "london") frameBounds(result.analysis.bounds);
    else if (kind === "shade" && map.getZoom() < 12.3) move(street);
    refreshGrid();
    $("analysis-progress").hidden = true;
    await Promise.all([renderResult(true), chatTurn && writeReply(chatTurn, result.reply + (kind === "station" && !options.compare ?
      " I can compare these hours with another station." : ""))]);
    finishToolCall(chatTurn, true);
    if (chatTurn) scrollChat();
    if (kind === "station") suggestions();
  }

  async function withBusy(task, chatTurn) {
    if (!ready || busy || drawing || caseLoading) return;
    busy = true;
    stopPlayback();
    stopArchivePlayback();
    reportAnalysis();
    updateControls();
    try {
      await task();
    } catch {
      setStep(results.has(stage) ? "result" : "area");
      const message = "The analysis service could not complete this request. Try again.";
      if (chatTurn) {
        finishToolCall(chatTurn, false);
        await writeReply(chatTurn, message);
      } else reportAnalysis(message);
    } finally {
      busy = false;
      $("analysis-progress").hidden = true;
      updateControls();
    }
  }

  function submit(text) {
    if (!ready || busy || drawing || caseLoading) return;
    appendTurn("user", text);
    const chatTurn = appendTurn("atlas");
    return withBusy(async () => {
      const result = await receive("/api/chat", {
        message: text, bounds: area()?.bounds, studyArea: stage === 2 && area()?.chosen === true, chapter: stage + 1,
        layer: layerKey(), station: activeStation, comparison, dispatch: true, shadePercent: Number($("shade-percent").value),
        comparisonMetric: stage === 4 ? regionalState?.metric : undefined,
        ...(usingArchive() ? { archiveCase: { region: caseRegion, event: caseEvent }, date: archiveState.date, model: archiveState.model,
          station: archiveState.station, comparison: archiveState.comparison, stationPeriod: archiveState.stationPeriod } : {}),
      }, message => chatTurn.body.setAttribute("aria-label", message));
      if (result.provider) {
        $("assistant-mode").textContent = result.provider === "gemini" ? "Gemini" : "Built-in routing";
        $("assistant-mode").hidden = false;
      }
      const action = result.action;
      if (action?.type === "run-analysis") return perform(action.kind, action, chatTurn);
      if (action?.type === "run-archive") return performArchive(action.kind, action, chatTurn);
      if (action?.type === "archive-day") {
        if (stage !== 0) openChapter(0);
        return writeReply(chatTurn, setArchiveDate(action.date) ? result.reply : "That UTC day is unavailable in this case’s weather timeline.");
      }
      if (action?.type === "archive-layer") {
        if (action.layer === "case-utci") {
          const modelTime = archiveState?.street?.timeUtc;
          if (modelTime && (action.date && action.date !== modelTime.slice(0, 10) ||
              action.time && !modelTime.slice(11).startsWith(action.time))) {
            return writeReply(chatTurn, "The available UTCI grid is for " + modelTime.slice(0, 16).replace("T", " ") + " UTC.");
          }
          if (stage !== 2) openChapter(2);
          return writeReply(chatTurn, chooseArchiveLayer("case-utci") ? "Showing the calculated UTCI grid." :
            "Draw an area or use model coverage, then run heat exposure analysis to show the UTCI grid.");
        }
        if (["air-max", "noaa"].includes(action.layer) && stage !== 0) openChapter(0);
        if (action.date && action.date !== archiveState?.date && !setArchiveDate(action.date)) {
          return writeReply(chatTurn, "That UTC date is not in the selected case.");
        }
        if (action.layer === "noaa" && action.date) {
          archiveState.stationPeriod = "day";
          if (results.get(0)?.event?.kind === "archive-station") results.delete(0);
          renderResult();
        }
        const opened = chooseArchiveLayer(action.layer);
        const missing = { lst_c: "a Landsat surface-temperature snapshot", noaa: "screened NOAA ISD station observations",
          "air-max": "event-specific gridded 2 m air temperature", ndvi: "a Landsat NDVI layer", ndwi: "a Landsat NDWI layer", mndwi: "a Landsat MNDWI layer" };
        return writeReply(chatTurn, opened ? "Opening " + archiveLayer().label + " for " + archiveState.city.name +
          (archiveLayer().id === "lst_c" ? " · " + archiveState.event.snapshot.datetime.slice(0, 16).replace("T", " ") + " UTC" : "") + "." :
          "The selected case has no " + (missing[action.layer] ?? "data for that layer") + ".");
      }
      if (action?.type === "open-case") {
        const opened = await chooseCase(action.region, action.event);
        return writeReply(chatTurn, opened ? "Opening the " + (adminCatalog?.cities[action.region]?.name ?? "London") + " case." :
          "That city or event could not open. Check the case menu for available events.");
      }
      if (action?.type === "compare-events") {
        const reply = await openChapter(4, true, action);
        return writeReply(chatTurn, reply ?? "The comparison could not load. Reopen Global city comparison to retry.");
      }
      const detailed = (index = 0) => archiveState || caseRegion !== "London" ? chooseCase("London", detailedEvent, index) : true;
      if (action?.type === "navigate") await chooseCase("London", detailedEvent);
      if (action?.type === "globe") chooseLayer("era5", action.day);
      if (action?.type === "show-layer") {
        if (!await detailed(action.layer === "utci" ? 2 : 0)) return writeReply(chatTurn, "The detailed London case could not load.");
        chooseLayer(action.layer, action.day);
      }
      if (action?.type === "view" && !setView(action.view)) {
        return writeReply(chatTurn, "Switch to a gridded layer to use Flat grid or 3D bars.");
      }
      if (action?.type === "day") {
        if (stage >= 0 && layerKey() !== "wow") openChapter(-1);
        setDay(action.day);
      }
      if (action?.type === "choose-comparison") {
        if (!await detailed()) return writeReply(chatTurn, "The detailed London case could not load.");
        if (layerKey() !== "wow") chooseLayer("wow");
        revealComparison(true);
      }
      const reply = action?.layer === "utci" && !results.has(2) ?
        "Select an area and run heat exposure analysis to display its UTCI grid." : result.reply;
      await writeReply(chatTurn, reply ?? "Choose a layer or analysis to continue.");
    }, chatTurn);
  }

  for (const [i, row] of chapters.slice(0, 4).entries()) {
    const node = R.button("", () => { selectPanel("analysis"); openChapter(i); });
    node.append(R.element("b", "0" + (i + 1)), document.createTextNode(row[1]));
    $("chapter-nav").append(node);
  }
  for (const key of L.londonLayers) $("layer-select").add(new Option(L.layers[key].label, key));
  for (const [key, label] of Object.entries(populationGroups)) {
    $("population-group").add(new Option(label, key));
    $("population-reference").add(new Option(label, key));
  }
  $("population-group").value = "deprived";
  $("population-reference").value = "leastDeprived";
  $("population-group").onchange = () => syncPopulationOptions();
  $("population-reference").onchange = () => syncPopulationOptions("population-reference");
  $("rank-boroughs").onclick = () => withBusy(() => perform("population", { scope: "london", rank: true }));
  for (const id of ["regional-event", "regional-first", "regional-second"]) $(id).onchange = () => loadRegional();
  $("regional-metric").onchange = event => {
    const metric = event.target.value;
    const current = $("regional-event").value;
    loadRegional({ metric, event: current });
  };
  $("enter").onclick = () => chooseCase(caseRegion);
  $("intro-compare").onclick = () => openChapter(4);
  $("view-mode").onchange = event => {
    selectPanel("analysis");
    openChapter(event.target.value === "comparison" ? 4 : 0, true, undefined, true);
  };
  $("case-city").onchange = event => { selectPanel("analysis"); chooseCase(event.target.value); };
  $("case-event").onchange = event => chooseCase(caseRegion, event.target.value, stage);
  $("archive-layer").onchange = event => chooseArchiveLayer(event.target.value);
  $("archive-model").onchange = event => {
    if (!usingArchive()) return;
    stopArchivePlayback();
    archiveState.model = event.target.value;
    registerArchiveLayers();
    clearGrid();
    const dates = A.dates(archiveState);
    setArchiveDate(dates.includes(archiveState.date) ? archiveState.date : dates[0], { modelChanged: true });
  };
  $("archive-date").onchange = event => { stopArchivePlayback(); setArchiveDate(event.target.value); };
  $("archive-play").onclick = playArchive;
  $("archive-station").onchange = event => {
    selectArchiveStation(event.target.value);
  };
  $("archive-station-other").onchange = event => {
    archiveState.comparison = event.target.value || undefined;
    if (results.get(0)?.event?.kind === "archive-station" && results.get(0).event.names.length > 1) {
      results.delete(0);
      renderResult();
      setStep("area");
    }
    updateControls();
    refreshGrid();
  };
  $("archive-period").onchange = event => {
    archiveState.stationPeriod = event.target.value;
    if (results.get(0)?.event?.kind === "archive-station") results.delete(0);
    renderResult();
    updateArchiveControls();
    refreshGrid();
  };
  $("archive-weather").onclick = () => withBusy(() => performArchive("weather"));
  $("archive-groups").onclick = () => withBusy(() => performArchive("groups"));
  $("archive-analyse-station").onclick = () => withBusy(() => performArchive("station"));
  $("archive-compare-stations").onclick = () => withBusy(() => performArchive("station", { compare: true }));
  $("show-analysis-panel").onclick = () => selectPanel("analysis");
  $("show-atlas-panel").onclick = () => selectPanel("atlas");
  selectPanel("analysis");
  $("globe").onclick = () => openChapter(-1);
  $("home").onclick = e => { e.preventDefault(); if (!busy && !caseLoading) openChapter(-1); };
  $("layer-select").onchange = e => chooseLayer(e.target.value);
  $("day").oninput = e => { stopPlayback(); setDay(Number(e.target.value)); };
  $("play-days").onclick = playDays;
  $("spin-globe").onclick = () => { globeRotation = !globeRotation; updateGlobeRotation(); };
  $("view-flat").onclick = () => setView("flat");
  $("view-bars").onclick = () => setView("bars");
  $("draw-area").onclick = () => setDrawing(!drawing);
  $("clear-analysis").onclick = clearAnalysis;
  $("full-area").onclick = () => selectArea(undefined, true);
  $("shade-percent").oninput = e => {
    e.target.value = String(Math.round(Number(e.target.value) * 10) / 10);
    $("shade-value").value = e.target.value + "%";
    results.delete(3);
    clearGrid();
    renderResult();
    setStep("area");
    if (usingArchive()) updateArchiveControls();
    refreshGrid();
  };
  $("run-analysis").onclick = () => withBusy(() => perform({ 1: "population", 2: "exposure", 3: "shade" }[stage]));
  $("station").onchange = e => selectStation(e.target.value);
  $("station-period").onchange = () => { results.delete(0); renderResult(); renderObservations(); };
  $("comparison-station").onchange = e => {
    comparison = e.target.value || undefined;
    if (results.get(0)?.event?.peaks?.length === 2) { results.delete(0); renderResult(); }
    updateStationPoints();
    updateControls();
  };
  $("analyse-station").onclick = () => withBusy(() => perform("station"));
  $("compare-stations").onclick = () => withBusy(() => perform("station", { compare: true }));
  const panelSize = new ResizeObserver(syncLegendClearance);
  panelSize.observe($("analysis-panel"));
  panelSize.observe($("guide"));
  panelSize.observe($("chapter-nav"));
  compactLayout.addEventListener("change", () => {
    if (!ready) return;
    if (compactLayout.matches && drawing) $("app").dataset.drawing = "true";
    else delete $("app").dataset.drawing;
    updateVisibility();
    selectPanel($("app").dataset.panel);
  });
  window.addEventListener("resize", syncLegendClearance);
  motionPreference.addEventListener("change", updateGlobeRotation);
  document.addEventListener("visibilitychange", updateGlobeRotation);
  document.addEventListener("keydown", e => { if (e.key === "Escape" && drawing) setDrawing(false); });
  $("prompt-form").onsubmit = e => {
    e.preventDefault();
    const message = $("prompt").value.trim();
    if (!message || busy || drawing) return;
    $("prompt").value = "";
    submit(message);
  };
  map.addControl(new mapboxgl.NavigationControl({ showCompass: true, visualizePitch: true }), "top-right");
  map.addControl(new mapboxgl.AttributionControl({ compact: true }), "bottom-right");
  map.on("error", event => {
    if (!ready && /401|403|access token|style|fetch/i.test(String(event.error?.message))) {
      $("map-status").textContent = "Mapbox could not load the basemap. Check your network connection.";
    }
  });
  map.once("load", addLayers);
  window.__heatline = { map, get stage() { return stage; }, get ready() { return ready; } };
})();
