function insideRing(ring, x, y) {
  let inside = false;
  for (let i = 1; i < ring.length; i++) {
    const [ax, ay] = ring[i - 1], [bx, by] = ring[i];
    if ((ay > y) !== (by > y) && x < (bx - ax) * (y - ay) / (by - ay) + ax) inside = !inside;
  }
  return inside;
}

export function modelFootprint(model) {
  if (!model.boundaryClipped) return () => true;
  const geometry = model.geometry;
  const polygons = geometry.type === "MultiPolygon" ? geometry.coordinates : [geometry.coordinates];
  // Reject rings by latitude range before testing detailed boundary edges.
  const indexed = polygons.map(rings => rings.map(ring => {
    let south = Infinity, north = -Infinity;
    for (const [, lat] of ring) {
      south = Math.min(south, lat);
      north = Math.max(north, lat);
    }
    return { ring, south, north };
  }));
  const within = ({ ring, south, north }, x, y) => y >= south && y <= north && insideRing(ring, x, y);
  return (x, y) => indexed.some(([outer, ...holes]) => within(outer, x, y) && !holes.some(hole => within(hole, x, y)));
}
