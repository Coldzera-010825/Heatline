const strongHeatThreshold = 32;
const maxReturnedCellIds = 5000;
const riskUnavailable = {
  status: "unavailable",
  message: "A heat risk assessment requires an agreed risk model and compatible population and vulnerability data.",
};
const method = "Select the 100 m cells by their published sample locations, then weight cell UTCI by the represented walking-network length.";

function validBounds(bounds) {
  if (!Array.isArray(bounds) || bounds.length !== 4 || !bounds.every(Number.isFinite)) return false;
  const [west, south, east, north] = bounds;
  return west >= -180 && east <= 180 && south >= -90 && north <= 90 && west < east && south < north;
}

function intersects([west, south, east, north], [otherWest, otherSouth, otherEast, otherNorth]) {
  return west <= otherEast && east >= otherWest && south <= otherNorth && north >= otherSouth;
}

function* tileRows(shards) {
  for (const shard of shards) {
    for (const [lon, lat, utci, , , length] of shard) yield [lon, lat, utci, length];
  }
}

function* packedRows(buffer) {
  if (buffer.byteLength % 12 !== 0) throw new Error("Invalid London UTCI analysis index");
  const view = new DataView(buffer);
  for (let offset = 0; offset < view.byteLength; offset += 12) {
    yield [view.getInt32(offset, true) / 1e6, view.getInt32(offset + 4, true) / 1e6,
      view.getInt16(offset + 8, true) / 100, view.getUint16(offset + 10, true) / 10];
  }
}

function summarize(rows, [west, south, east, north]) {
  let cellCount = 0;
  let pathLength = 0;
  let weightedSum = 0;
  let minUtci = Infinity;
  let maxUtci = -Infinity;
  let strongCellCount = 0;
  let strongPathLength = 0;
  const stress = [
    { min: 46, label: "Extreme", length: 0 },
    { min: 38, label: "Very strong", length: 0 },
    { min: 32, label: "Strong", length: 0 },
    { min: 26, label: "Moderate", length: 0 },
    { min: -Infinity, label: "Below 26°C", length: 0 },
  ];
  const cellIds = [];
  const hotspots = [];
  const degrees = new Map();

  for (const [lon, lat, utci, length] of rows) {
    if (lon < west || lon > east || lat < south || lat > north ||
        !Number.isFinite(utci) || !Number.isFinite(length) || length <= 0) continue;

    cellCount += 1;
    pathLength += length;
    weightedSum += utci * length;
    const degree = Math.floor(utci);
    degrees.set(degree, (degrees.get(degree) ?? 0) + length);
    stress.find(band => utci >= band.min).length += length;
    minUtci = Math.min(minUtci, utci);
    maxUtci = Math.max(maxUtci, utci);
    if (cellCount <= maxReturnedCellIds) cellIds.push(lon + "," + lat);
    if (utci >= strongHeatThreshold) {
      strongCellCount += 1;
      strongPathLength += length;
    }
    if (hotspots.length < 5 || utci > hotspots[hotspots.length - 1].utci) {
      hotspots.push({ cellId: lon + "," + lat, coordinates: [lon, lat], utci });
      hotspots.sort((a, b) => b.utci - a.utci);
      if (hotspots.length > 5) hotspots.pop();
    }
  }

  if (cellCount === 0) return null;
  return {
    cellCount,
    cellIds: cellCount <= maxReturnedCellIds ? cellIds : [],
    pathLengthM: Math.round(pathLength),
    meanUtci: Number((weightedSum / pathLength).toFixed(2)),
    minUtci,
    maxUtci,
    stress: stress.reverse().map(({ label, length }) => ({ label, share: length / pathLength })),
    distribution: Array.from({ length: Math.floor(maxUtci) - Math.floor(minUtci) + 1 }, (_, index) => {
      const from = Math.floor(minUtci) + index;
      return { from, share: (degrees.get(from) ?? 0) / pathLength };
    }),
    strongHeat: {
      thresholdUtci: strongHeatThreshold,
      cellCount: strongCellCount,
      pathLengthM: Math.round(strongPathLength),
      pathLengthShare: strongPathLength / pathLength,
    },
    hotspots,
  };
}

async function analyzeArea({ bounds, metric = "exposure" }, progress, readData) {
  if (metric === "risk") return { ok: false, status: "unsupported", reply: riskUnavailable.message, heatRisk: riskUnavailable };
  if (metric !== "exposure") return { ok: false, status: "unsupported", reply: "Choose pedestrian heat exposure or heat risk." };
  if (bounds != null && !validBounds(bounds)) {
    return { ok: false, status: "clarify", reply: "Draw a rectangular area with valid map coordinates." };
  }

  progress("Matching the area to London’s archived UTCI grid…");
  const manifest = await readData("manifest.json");
  const shards = bounds ? manifest.shards.filter(shard => intersects(shard.bounds, bounds)) : manifest.shards;
  const selection = bounds ?? shards.reduce(
    ([west, south, east, north], { bounds: [w, s, e, n] }) =>
      [Math.min(west, w), Math.min(south, s), Math.max(east, e), Math.max(north, n)],
    [Infinity, Infinity, -Infinity, -Infinity]
  );
  const rows = shards.length > 20
    ? packedRows(await readData("analysis-index.bin", "packed-index"))
    : tileRows(await Promise.all(shards.map(shard => readData(shard.file))));
  progress("Calculating pedestrian heat exposure…");
  const summary = summarize(rows, selection);
  if (!summary) {
    return { ok: false, status: "empty", reply: "This selection contains no walking-network cells in the London UTCI dataset. Move or enlarge the area within the available coverage." };
  }

  const analysis = {
    ...summary,
    bounds: selection,
    scope: bounds ? "selected" : "london",
    timeUtc: manifest.time,
    source: "TerraHeat London pedestrian UTCI archive · SOLWEIG + UTCI",
    method,
  };
  const areaLabel = bounds ? "In the selected area" : "Across the available London grid";
  const pathLength = summary.pathLengthM < 1000
    ? summary.pathLengthM + " m"
    : (summary.pathLengthM / 1000).toFixed(1) + " km";
  const strongHeatShare = (summary.strongHeat.pathLengthShare * 100).toFixed(1);
  return {
    ok: true,
    status: "complete",
    reply: `${areaLabel}, the route-length-weighted UTCI was ${summary.meanUtci.toFixed(2)}°C. The analysis covers ${summary.cellCount.toLocaleString("en-GB")} grid cells and ${pathLength} of represented walking network. ${strongHeatShare}% of that length was in cells with a mean UTCI of ${strongHeatThreshold}°C or higher.`,
    analysis,
    heatRisk: riskUnavailable,
  };
}

export { analyzeArea, method, summarize, validBounds };

