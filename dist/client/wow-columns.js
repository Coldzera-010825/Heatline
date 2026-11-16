(() => {
  const sourceId = "wow-column-footprints";
  const sides = 12;
  const bearings = Array.from({ length: sides }, (_, i) => 2 * Math.PI * i / sides);
  const temperature = ["number", ["feature-state", "temperature"], ["get", "value"], 20];
  const height = ["+", 160, ["*", 250, ["max", 0, ["-", temperature, 10]]]];

  function footprint(point, radius) {
    const [lon, lat] = point.geometry.coordinates;
    const dy = radius / 111195, dx = dy / Math.cos(lat * Math.PI / 180);
    const ring = bearings.map(angle => [lon + dx * Math.cos(angle), lat + dy * Math.sin(angle)]);
    ring.push(ring[0]);
    return { ...point, geometry: { type: "Polygon", coordinates: [ring] } };
  }

  function install(map, layers) {
    map.addSource(sourceId, { type: "geojson", data: layers.empty, promoteId: "id" });
    map.addLayer({ id: "station-column", type: "fill-extrusion", source: sourceId, layout: { visibility: "none" },
      paint: { "fill-extrusion-color": layers.color("wow", temperature),
        "fill-extrusion-height": ["interpolate", ["linear"], ["zoom"], 8.5, height,
          10.5, ["*", height, .46], 12.5, ["*", height, .145], 14.5, ["*", height, .038], 17, ["*", height, .008]],
        "fill-extrusion-vertical-gradient": true, "fill-extrusion-emissive-strength": .30 } });

    let points = [], geometryKey, frame;
    const rendered = new Map();

    function resize() {
      const zoom = Math.round(map.getZoom() * 4) / 4;
      const key = [zoom, ...points.map(point => point.properties.id)].join("/");
      if (key === geometryKey) return;
      geometryKey = key;
      const radius = Math.max(4, Math.min(620, 425 * 2 ** (9.35 - zoom)));
      map.getSource(sourceId).setData(layers.collection(points.map(point => footprint(point, radius))));
    }

    function paint(id, value) {
      rendered.set(id, value);
      map.setFeatureState({ source: sourceId, id }, { temperature: value });
    }

    function update(stations, animate) {
      cancelAnimationFrame(frame);
      points = stations.filter(point => Number.isFinite(point.properties.value));
      const targets = new Map(points.map(({ properties: { id, value } }) => [id, value]));
      for (const id of rendered.keys()) {
        if (!targets.has(id)) {
          rendered.delete(id);
          map.removeFeatureState({ source: sourceId, id });
        }
      }
      resize();
      const motion = [];
      for (const [id, value] of targets) {
        const previous = rendered.get(id);
        if (animate && previous != null && previous !== value) motion.push({ id, previous, value });
        else if (previous !== value) paint(id, value);
      }
      if (!motion.length) return;
      const start = performance.now();
      let last = start;
      function tick(now) {
        const progress = Math.min(1, (now - start) / 470);
        if (progress === 1 || now - last >= 30) {
          const eased = progress * progress * (3 - 2 * progress);
          for (const { id, previous, value } of motion) paint(id, previous + (value - previous) * eased);
          last = now;
        }
        if (progress < 1) frame = requestAnimationFrame(tick);
      }
      frame = requestAnimationFrame(tick);
    }

    return { resize, update };
  }

  window.HEATLINE_WOW_COLUMNS = { install };
})();
