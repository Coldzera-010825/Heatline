"""Build reusable SOLWEIG radiation inputs for a city and event.

Run with Python 3.12 and solweig==0.1.0b96, rasterio, scipy, pyproj,
shapely and osmium. All 5 m terrain tiles must use the chosen metric CRS.
The published files contain radiation and route lengths, not final UTCI.
"""
import argparse
from concurrent.futures import ThreadPoolExecutor
import csv
from datetime import datetime, timedelta
import gzip
import json
import math
import os
from pathlib import Path
import tempfile

import numpy as np
import osmium
from pyproj import Transformer
import rasterio
from rasterio.features import rasterize
from rasterio.transform import from_origin
from rasterio.windows import from_bounds
from scipy.interpolate import LinearNDInterpolator, NearestNDInterpolator
from scipy.ndimage import distance_transform_edt
import shapely
from shapely.geometry import box, mapping, shape
import solweig

PIXEL, GRID, CORE, BUFFER = 5, 100, 1900, 400
SIZE = (CORE + 2 * BUFFER) // PIXEL
FIELDS = ("temperature_2m", "relative_humidity_2m", "wind_speed_10m", "shortwave_radiation")
ROADS = {"primary", "secondary", "tertiary", "residential", "living_street", "pedestrian",
         "footway", "path", "unclassified", "service", "steps", "track"}


def read(path):
    return json.loads(path.read_text(encoding="utf-8-sig"))


def save(path, value, packed=False):
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = json.dumps(value, separators=(",", ":"), allow_nan=False, ensure_ascii=False).encode()
    temp = path.with_name(path.name + ".part")
    temp.write_bytes(gzip.compress(payload, compresslevel=5, mtime=0) if packed else payload + b"\n")
    temp.replace(path)


class Network(osmium.SimpleHandler):
    def __init__(self, bbox):
        super().__init__()
        self.factory = osmium.geom.WKBFactory()
        self.bbox = bbox
        self.roads, self.buildings = [], []

    def way(self, way):
        t = way.tags
        if (t.get("highway") not in ROADS or t.get("foot") in {"no", "private"} or
                (t.get("access") in {"no", "private"} and t.get("foot") not in {"yes", "designated"}) or
                any(t.get(key, "no") != "no" for key in ("tunnel", "indoor", "covered", "bridge", "area"))):
            return
        try:
            w, s, e, n = self.bbox
            if any(w <= p.lon <= e and s <= p.lat <= n for p in way.nodes):
                self.roads.append(self.factory.create_linestring(way))
        except (RuntimeError, osmium.InvalidLocationError):
            pass

    def area(self, area):
        if area.tags.get("building", "no") == "no":
            return
        try:
            w, s, e, n = self.bbox
            if any(w <= p.lon <= e and s <= p.lat <= n for ring in area.outer_rings() for p in ring):
                self.buildings.append(self.factory.create_multipolygon(area))
        except (RuntimeError, osmium.InvalidLocationError):
            pass


def network(args, city, to_grid, to_geo):
    cache = args.work / "osm-geometry.json.gz"
    if args.osm_cache:
        cache = args.osm_cache
    elif not cache.exists():
        bounds = shapely.transform(city.buffer(BUFFER + 100), to_geo.transform, interleaved=False).bounds
        handler = Network(bounds)
        handler.apply_file(str(args.osm), locations=True, idx="flex_mem")
        save(cache, [handler.roads, handler.buildings], True)
    with gzip.open(cache, "rt", encoding="utf8") as src:
        roads, buildings = json.load(src)
    print(f"Network: {len(roads)} walkable ways, {len(buildings)} building geometries", flush=True)
    if not roads or not buildings:
        raise ValueError("Missing walkable ways or buildings")
    def tree(items):
        return shapely.STRtree(shapely.transform(shapely.from_wkb(items), to_grid.transform, interleaved=False))
    return tree(roads), tree(buildings)


def weather_at(path, when, to_grid):
    hour = when.replace(minute=0, second=0, microsecond=0)
    start = hour - timedelta(hours=4)
    fraction = (when - hour).total_seconds() / 3600
    hours = [start + timedelta(hours=i) for i in range(5 + bool(fraction))]
    records = {}
    if path.suffix.lower() == ".csv":
        with path.open(encoding="utf-8-sig", newline="") as src:
            for row in csv.DictReader(src):
                at = datetime.fromisoformat(row["time"].removesuffix("Z")).replace(tzinfo=None)
                if at not in hours:
                    continue
                try:
                    values = [float(row[k]) for k in FIELDS]
                except (TypeError, ValueError):
                    continue
                if all(math.isfinite(x) for x in values):
                    records.setdefault((float(row["longitude"]), float(row["latitude"])), {})[at] = values
    else:
        obj = read(path)
        for d in obj if isinstance(obj, list) else [obj]:
            by_time = {}
            for i, text in enumerate(d["hourly"]["time"]):
                at = datetime.fromisoformat(text.removesuffix("Z")).replace(tzinfo=None)
                values = [d["hourly"][k][i] for k in FIELDS]
                if at in hours and all(x is not None and math.isfinite(x) for x in values):
                    by_time[at] = values
            records[(d["longitude"], d["latitude"])] = by_time
    points = [pt for pt, d in records.items() if all(t in d for t in hours)]
    if not points:
        raise ValueError("Missing UTC weather variables for the event hour and four-hour warm-up")
    values = np.asarray([[records[p][t] for t in hours] for p in points])
    xy = np.asarray(to_grid.transform(*np.asarray(points).T)).T
    nearest = NearestNDInterpolator(xy, values)
    linear = LinearNDInterpolator(xy, values) if len(points) >= 3 and np.linalg.matrix_rank(xy - xy[0]) >= 2 else None
    print(f"Weather: {len(points)} complete forcing locations", flush=True)

    def at(x, y):
        rows = linear(x, y) if linear is not None else nearest(x, y)
        if not np.isfinite(rows).all():
            rows = nearest(x, y)
        sequence = [solweig.Weather(datetime=t, ta=ta, rh=rh, ws=wind / 3.6, global_rad=rad)
                    for t, (ta, rh, wind, rad) in zip(hours[:5], rows)]
        if fraction:
            ta, rh, wind, _ = rows[4] * (1 - fraction) + rows[5] * fraction
            sequence.append(solweig.Weather(datetime=when, ta=ta, rh=rh, ws=wind / 3.6,
                                           global_rad=rows[5, 3], timestep_minutes=fraction * 60))
        return sequence
    return at, len(points)


def tile_raster(args, field, limits):
    w, s, e, n = limits
    if args.lidar:
        output = np.full((SIZE, SIZE), np.nan, dtype="float32")
        step = args.lidar_step
        for x in range(w // step * step, e, step):
            for y in range(s // step * step, n, step):
                file = args.lidar / f"{field}_{x}_{y}.tif"
                if not file.is_file():
                    continue
                left, bottom, right, top = max(w, x), max(s, y), min(e, x + step), min(n, y + step)
                with rasterio.open(file) as src:
                    values = src.read(1, window=from_bounds(left, bottom, right, top, src.transform), masked=True)
                output[(n - top)//PIXEL:(n - bottom)//PIXEL, (left - w)//PIXEL:(right - w)//PIXEL] = values.filled(np.nan)
        return output
    with rasterio.open(getattr(args, field)) as src:
        if src.crs.to_epsg() != args.crs or src.res != (PIXEL, PIXEL):
            raise ValueError(f"{field} must use the model CRS and a 5 m pixel")
        window = from_bounds(*limits, src.transform)
        if max(abs(window.col_off - round(window.col_off)), abs(window.row_off - round(window.row_off))) > 1e-5:
            raise ValueError(f"{field} must align to the 5 m model grid")
        return src.read(1, window=window.round_offsets().round_lengths(), boundless=True,
                        fill_value=np.nan, masked=True, out_dtype="float32").filled(np.nan)


def routes_in_core(roads, core, x, y):
    hits = roads.query(core, predicate="intersects")
    parts = shapely.get_parts(shapely.intersection(roads.geometries[hits], core))
    length = shapely.length(parts)
    keep = (shapely.get_type_id(parts) == 1) & (length > 0)
    parts, length = parts[keep], length[keep]
    if not len(parts):
        return np.empty((0, 2)), np.empty(0)
    counts = np.ceil(length / PIXEL).astype(int)
    weights = np.repeat(length / counts, counts)
    index = np.arange(len(weights)) - np.repeat(np.cumsum(counts) - counts, counts)
    xy = shapely.get_coordinates(shapely.line_interpolate_point(np.repeat(parts, counts), (index + .5) * weights))
    keep = (xy[:, 0] >= x) & (xy[:, 0] < x + CORE) & (xy[:, 1] >= y) & (xy[:, 1] < y + CORE)
    return xy[keep], weights[keep]


def run_tile(args, x, y, boundary, roads, buildings, at, to_geo):
    core = box(x, y, x + CORE, y + CORE).intersection(boundary)
    xy, weights = routes_in_core(roads, core, x, y)
    if not len(weights):
        return None, 0, 0
    left, bottom, right, top = x - BUFFER, y - BUFFER, x + CORE + BUFFER, y + CORE + BUFFER
    limits = left, bottom, right, top
    r, c = np.floor((top - xy[:, 1]) / PIXEL).astype(int), np.floor((xy[:, 0] - left) / PIXEL).astype(int)
    dem, dsm = [tile_raster(args, field, limits) for field in ("dtm", "dsm")]
    supported = np.isfinite(dem) & np.isfinite(dsm)
    usable_terrain = np.isfinite(dem)
    if not supported.any():
        return None, len(weights), len(weights)
    around = box(*limits)
    geoms = buildings.geometries[buildings.query(around, predicate="intersects")]
    geoms = geoms[~shapely.is_empty(geoms)]
    building = rasterize(((g, 1) for g in geoms), out_shape=(SIZE, SIZE), transform=from_origin(left, top, PIXEL, PIXEL),
                         dtype="uint8").astype(bool) if len(geoms) else np.zeros((SIZE, SIZE), dtype=bool)
    if not usable_terrain.all():
        distance, (iy, ix) = distance_transform_edt(~usable_terrain, return_indices=True)
        dem = dem[iy, ix]
        supported = np.isfinite(dsm) & (distance <= 10)
    missing = int((~supported[r, c]).sum())
    good = supported[r, c] & ~building[r, c]
    if not good.any():
        return None, len(weights), missing
    xy, weights, r, c = xy[good], weights[good], r[good], c[good]
    height = np.maximum(np.where(np.isfinite(dsm), dsm - dem, 0), 0)
    dsm = dem + np.where(building, height, 0)
    canopy = np.where(~building & (height >= 2) & (height <= 30), height, 0)
    cx, cy = x + CORE / 2, y + CORE / 2
    lon, lat = to_geo.transform(cx, cy)
    forcing = at(cx, cy)
    args.work.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="heatline-tile-", dir=args.work) as tmp:
        dst = Path(tmp)
        for name, canopy_grid, fields in (("full", canopy, ("tmrt", "shadow", "utci")), ("bare", None, ("shadow",))):
            surface = solweig.SurfaceData.prepare(dsm=dsm, dem=dem, cdsm=canopy_grid, cdsm_relative=True, pixel_size=PIXEL)
            solweig.calculate(surface, weather=forcing, location=solweig.Location(latitude=lat, longitude=lon, utc_offset=0),
                              output_dir=dst / name, outputs=list(fields), use_anisotropic_sky=False, max_shadow_distance_m=BUFFER)
        def take(name, field):
            with rasterio.open(dst / name / field / f"{field}_{args.when:%Y%m%d_%H%M}.tif") as src:
                return src.read(1, masked=True).filled(np.nan)[r, c]
        radiant, shadow, bare, reference = take("full", "tmrt"), take("full", "shadow"), take("bare", "shadow"), take("full", "utci")
    valid = np.isfinite(radiant) & np.isfinite(shadow) & np.isfinite(bare) & np.isfinite(reference)
    xy, weights, radiant, shadow, bare, reference = [v[valid] for v in (xy, weights, radiant, shadow, bare, reference)]
    if not len(weights):
        return None, len(good), missing
    shade = np.select([shadow >= .8, bare < .5, shadow < .5], [0, 1, 2], default=3)
    # Stable group order keeps each cell independent of catalogue or viewport ordering.
    e, n = np.floor(xy / GRID).astype(int).T
    order = np.lexsort((n, e))
    ends = np.r_[0, np.flatnonzero((np.diff(e[order]) != 0) | (np.diff(n[order]) != 0)) + 1, len(order)]
    rows, paired, sampled = [], 0, 0
    for i, j in zip(ends[:-1], ends[1:]):
        mask = order[i:j]
        weight = weights[mask]
        total = float(weight.sum())
        if total < 20:
            continue
        east, north = e[mask[0]] * GRID, n[mask[0]] * GRID
        poly = box(east, north, east + GRID, north + GRID)
        if not boundary.covers(poly):
            poly = poly.intersection(boundary)
            if poly.geom_type == "MultiPolygon":
                poly = max(poly.geoms, key=lambda part: part.area)
            if poly.geom_type != "Polygon" or poly.is_empty:
                continue
        pos = poly.representative_point()
        center = [round(z, 7) for z in to_geo.transform(pos.x, pos.y)]
        ring = [[round(a, 7), round(b, 7)] for a, b in (to_geo.transform(u, v) for u, v in poly.exterior.coords)]
        bins = {}
        for t, l, k in zip(radiant[mask], weight, shade[mask]):
            bins.setdefault(round(float(t), 2), [0., 0., 0., 0.])[k] += l
        band = [[t, *[round(l, 5) for l in ls]] for t, ls in sorted(bins.items())]
        by_class = np.bincount(shade[mask], weights=weight, minlength=4)
        paired += int(min(by_class[:2]) >= 20)
        rows.append([*center, round(float(np.average(reference[mask], weights=weight)), 2), round(total, 1), ring, band])
        sampled += total
    if not rows:
        return None, len(good), missing
    weather = forcing[-1]
    return {
        "weather": {"airC": weather.ta, "humidity": weather.rh, "wind": weather.ws, "shortwaveWm2": weather.global_rad},
        "rows": rows, "paired": paired, "routeM": round(sampled, 1),
    }, len(good), missing


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--boundary", type=Path, required=True)
    p.add_argument("--weather", type=Path, required=True)
    p.add_argument("--time", required=True, help="Model time in UTC (ISO 8601 Z)")
    p.add_argument("--crs", type=int, required=True)
    p.add_argument("--city", required=True)
    p.add_argument("--event", required=True)
    p.add_argument("--source", required=True)
    p.add_argument("--osm", type=Path)
    p.add_argument("--osm-cache", type=Path)
    p.add_argument("--dtm", type=Path)
    p.add_argument("--dsm", type=Path)
    p.add_argument("--lidar", type=Path, help="DSM/DTM tiles named e.g. dsm_500000_170000.tif")
    p.add_argument("--lidar-step", type=int, default=10000)
    p.add_argument("--work", type=Path, required=True)
    p.add_argument("--out", type=Path, required=True)
    p.add_argument("--workers", type=int, default=3)
    p.add_argument("--bounds", nargs=4, type=float, metavar=("WEST", "SOUTH", "EAST", "NORTH"),
                   help="Only model the buffered tiles intersecting this lon/lat area")
    args = p.parse_args()
    if not args.time.endswith("Z"):
        p.error("Use an explicit UTC time ending in Z")
    if not (args.osm or args.osm_cache) or not (args.lidar or (args.dtm and args.dsm)):
        p.error("Provide OSM inputs and co-registered terrain/surface rasters")
    args.when = datetime.fromisoformat(args.time[:-1])
    to_grid, to_geo = (Transformer.from_crs(a, b, always_xy=True) for a, b in ((4326, args.crs), (args.crs, 4326)))
    feature = read(args.boundary)
    geom = shape(feature["geometry"]) if feature["type"] == "Feature" else shapely.union_all([shape(f["geometry"]) for f in feature["features"]])
    boundary = shapely.transform(shapely.make_valid(geom), to_grid.transform, interleaved=False)
    args.work.mkdir(parents=True, exist_ok=True)
    args.out.mkdir(parents=True, exist_ok=True)
    roads, buildings = network(args, boundary, to_grid, to_geo)
    forcing, n_locations = weather_at(args.weather, args.when, to_grid)
    extent = boundary if not args.bounds else boundary.intersection(shapely.transform(box(*args.bounds), to_grid.transform, interleaved=False))
    if extent.is_empty:
        p.error("The requested area does not intersect the administrative boundary")
    w, s, e, n = extent.bounds
    origins = [(x, y) for y in range(int(s)//CORE*CORE, math.ceil(n/CORE)*CORE, CORE)
               for x in range(int(w)//CORE*CORE, math.ceil(e/CORE)*CORE, CORE) if extent.intersects(box(x, y, x+CORE, y+CORE))]
    print(f"{len(origins)} buffered tiles", flush=True)

    def work(origin):
        x, y = origin
        key = f"{x}_{y}"
        file, info = (args.out / f"{key}.{ext}" for ext in ("bin", "json"))
        if info.exists() and (file.exists() or not read(info)["cells"]):
            return read(info)
        packed, count, missing = run_tile(args, x, y, boundary, roads, buildings, forcing, to_geo)
        shape_wgs = shapely.transform(box(x, y, x + CORE, y + CORE), to_geo.transform, interleaved=False)
        meta = {"file": file.name, "bounds": shape_wgs.bounds, "samples": count, "missing": missing, "cells": len(packed["rows"]) if packed else 0,
                "pairs": packed["paired"] if packed else 0, "routeM": packed["routeM"] if packed else 0}
        if packed:
            save(file, packed, True)
        save(info, meta)
        return meta

    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        tiles = []
        for i, item in enumerate(pool.map(work, origins), 1):
            tiles.append(item)
            if i % 10 == 0 or i == len(origins):
                print(f"{i}/{len(origins)} tiles, {sum(t['cells'] for t in tiles)} walking cells", flush=True)
    manifest = {"city": args.city, "event": args.event, "scope": "selected" if args.bounds else "city",
                "timeUtc": args.time, "source": args.source, "engine": "SOLWEIG " + solweig.__version__,
                "terrainM": PIXEL, "gridM": GRID, "weatherLocations": n_locations,
                "bounds": (shapely.transform(extent, to_geo.transform, interleaved=False).bounds if args.bounds else geom.bounds),
                "geometry": mapping(shapely.simplify(geom, .00003, preserve_topology=True)),
                "cells": sum(t["cells"] for t in tiles), "pairedCells": sum(t["pairs"] for t in tiles),
                "samples": sum(t["samples"] for t in tiles), "missing": sum(t["missing"] for t in tiles),
                "tiles": [t for t in tiles if t["cells"]]}
    if not manifest["cells"]:
        raise ValueError("No valid walking cells")
    save(args.out / "manifest.json", manifest)
    print(json.dumps({k: manifest[k] for k in ("scope", "timeUtc", "cells", "pairedCells", "missing", "samples")}), flush=True)


if __name__ == "__main__":
    main()
