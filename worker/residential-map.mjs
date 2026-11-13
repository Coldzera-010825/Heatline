// Group points into roughly 500 m cells in a local metric grid. Keep a
// longitude/latitude rectangle for display and clip it in the map.
export function residentialTiles(points, latitude) {
  const dy = 500 / 111195, dx = dy / Math.cos(latitude * Math.PI / 180);
  const tiles = new Map();
  for (const [lon, lat, temperature, weights, denominators] of points) {
    if (!Number.isFinite(temperature) || !weights.all) continue;
    const col = Math.floor(lon / dx), row = Math.floor(lat / dy);
    const key = col + ":" + row;
    const tile = tiles.get(key) ?? { col, row, population: 0, heat: 0, groups: {}, totals: {} };
    tile.population += weights.all;
    tile.heat += temperature * weights.all;
    for (const [group, value] of Object.entries(weights)) {
      if (group === "all" || !Number.isFinite(value)) continue;
      tile.groups[group] = (tile.groups[group] ?? 0) + value;
      tile.totals[group] = (tile.totals[group] ?? 0) + (denominators?.[group] ?? weights.all);
    }
    tiles.set(key, tile);
  }
  return [...tiles.values()].map(tile => [
    tile.col * dx, tile.row * dy, dx, dy, Number((tile.heat / tile.population).toFixed(2)), Number(tile.population.toFixed(2)),
    Object.fromEntries(Object.entries(tile.groups).flatMap(([key, value]) =>
      tile.totals[key] > 0 ? [[key, Number((100 * value / tile.totals[key]).toFixed(1))]] : [])),
  ]);
}

export function* matchedPoints(points, temperatures, bounds, census, keys = []) {
  function* rows() {
    if (census) yield* census;
    else for (let i = 0; i < points.length; i++) yield [i, points[i][2]];
  }
  for (const [index, count, ...values] of rows()) {
    const [lon, lat] = points[index];
    if (bounds && (lon < bounds[0] || lon > bounds[2] || lat < bounds[1] || lat > bounds[3])) continue;
    const weights = { all: count };
    const denominators = {};
    let district;
    for (const [i, key] of keys.slice(1).entries()) {
      if (key.endsWith("Universe")) denominators[key.slice(0, -8)] = values[i];
      else if (key === "district") district = values[i];
      else weights[key] = values[i];
    }
    yield [lon, lat, temperatures[index], weights, denominators, district];
  }
}
