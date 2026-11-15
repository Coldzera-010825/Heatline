"""Preserve SOLWEIG shade rasters and OSM line order for an event-time street review.

Uses the terrain, weather and walking-network inputs of prepare-city-street.py.
The web archive contains ordered shade intervals along clipped OSM ways. The
georeferenced rasters and the restart records are kept in a separate directory.
"""
import argparse
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta
import importlib.util
import logging
from pathlib import Path

import numpy as np
import osmium
from pyproj import Transformer
import rasterio
from rasterio.features import rasterize
from rasterio.transform import from_origin
import shapely
from shapely.geometry import box, shape
import solweig
from solweig.components.shadows import compute_transmissivity
from solweig.physics.sun_position import sun_position
from solweig.rustalgos import shadowing


spec = importlib.util.spec_from_file_location("city_street", Path(__file__).with_name("prepare-city-street.py"))
city_street = importlib.util.module_from_spec(spec)
spec.loader.exec_module(city_street)
PIXEL, CORE, BUFFER, SIZE = (city_street.PIXEL, city_street.CORE, city_street.BUFFER, city_street.SIZE)
CLASSES = ["sunlit", "building shade", "canopy shade", "partial shade", "unavailable"]


class NamedNetwork(city_street.Network):
    def __init__(self, bounds):
        super().__init__(bounds)
        self.names = {}

    def way(self, way):
        super().way(way)
        if way.id in self.roads:
            self.names[way.id] = way.tags.get("name", "")


def load_network(paths, boundary, to_grid, to_geo):
    limits = city_street.projected_boundary(boundary.buffer(BUFFER + 100), to_geo).bounds
    ways, buildings, snapshots = {}, {}, []
    for path in paths:
        with osmium.io.Reader(str(path)) as src:
            snapshots.append(src.header().get("osmosis_replication_timestamp"))
        current = NamedNetwork(limits)
        current.apply_file(str(path), locations=True, idx="flex_mem")
        for identifier, wkb in current.roads.items():
            if identifier not in ways or len(wkb) > len(ways[identifier][1]):
                ways[identifier] = (current.names[identifier], wkb)
        for identifier, wkb in current.buildings.items():
            if identifier not in buildings or len(wkb) > len(buildings[identifier]):
                buildings[identifier] = wkb
    if not ways or not buildings:
        raise ValueError("The OSM extract must include walkable ways and building footprints")
    ordered = sorted(ways)

    def index(items):
        return shapely.STRtree(shapely.transform(shapely.from_wkb(items), to_grid.transform, interleaved=False))

    print(f"{len(ways):,} walkable ways and {len(buildings):,} buildings", flush=True)
    return index([ways[i][1] for i in ordered]), index(list(buildings.values())), [(i, ways[i][0]) for i in ordered], snapshots


def shadow_grids(dem, dsm, canopy, location, weather):
    # Same sun position and vegetation transmissivity as the SOLWEIG timeseries.
    # Shadow casting needs only the current time, so the radiation warm-up can be skipped.
    time = weather.datetime - timedelta(minutes=weather.timestep_minutes / 2)
    sun = sun_position({"year": time.year, "month": time.month, "day": time.day, "hour": time.hour,
                        "min": time.minute, "sec": time.second, "UTC": location.utc_offset}, location.to_sun_position_dict())
    azimuth = float(np.asarray(sun["azimuth"]).flat[0])
    altitude = 90 - float(np.asarray(sun["zenith"]).flat[0])
    surface = solweig.SurfaceData(dsm=dsm.copy(), dem=dem.copy(), cdsm=canopy.copy(), pixel_size=PIXEL)
    surface.preprocess()
    if altitude <= 0:
        return np.full_like(surface.dsm, np.nan), np.full_like(surface.dsm, np.nan)
    maximum = float(np.nanmax(surface.dsm) - np.nanmin(surface.dsm))
    bare = shadowing.calculate_shadows_wall_ht_25(azimuth, altitude, PIXEL, maximum, surface.dsm, max_shadow_distance_m=BUFFER)
    full = shadowing.calculate_shadows_wall_ht_25(azimuth, altitude, PIXEL, surface.max_height, surface.dsm, surface.cdsm,
                                        surface.tdsm, np.zeros_like(surface.dsm), max_shadow_distance_m=BUFFER)
    psi = compute_transmissivity(weather.datetime.timetuple().tm_yday)
    return np.asarray(full.bldg_sh) * (psi + (1 - psi) * np.asarray(full.veg_sh)), np.asarray(bare.bldg_sh)


def store_rasters(path, x, y, core, crs, stamp, full, bare, supported):
    offset, size = BUFFER // PIXEL, CORE // PIXEL
    window = np.s_[offset:offset + size, offset:offset + size]
    transform = from_origin(x, y + CORE, PIXEL, PIXEL)
    mask = rasterize([(core, 1)], out_shape=(size, size), transform=transform, dtype="uint8").astype(bool)
    mask &= supported[window]
    partial = path.with_suffix(".part")
    with rasterio.open(partial, "w", driver="GTiff", height=size, width=size, count=2, dtype="float32",
                       transform=transform, crs=crs, nodata=np.nan, compress="deflate", tiled=True) as dst:
        for i, (values, name) in enumerate(((full, "Building and canopy transmittance"), (bare, "Building-only transmittance")), 1):
            dst.write(np.where(mask, values[window], np.nan).astype("float32"), i)
            dst.set_band_description(i, name)
        dst.update_tags(time_utc=stamp, model="SOLWEIG " + solweig.__version__)
    partial.replace(path)


def street_records(roads, metadata, core, x, y, to_geo, classification):
    hits = np.sort(roads.query(core, predicate="intersects"))
    parts, owners = shapely.get_parts(shapely.intersection(roads.geometries[hits], core), return_index=True)
    lengths = shapely.length(parts)
    linear = (shapely.get_type_id(parts) == 1) & (lengths >= .1)
    parts, lengths, owners = parts[linear], lengths[linear], hits[owners[linear]]
    names, records, used = {"": 0}, [], 0
    if not len(parts):
        return names, records, used
    counts = np.ceil(lengths / PIXEL).astype(int)
    weights = np.repeat(lengths / counts, counts)
    ends = np.r_[0, np.cumsum(counts)]
    steps = np.arange(len(weights)) - np.repeat(ends[:-1], counts)
    xy = shapely.get_coordinates(shapely.line_interpolate_point(np.repeat(parts, counts), (steps + .5) * weights))
    col = np.floor((xy[:, 0] - (x - BUFFER)) / PIXEL).astype(int)
    row = np.floor((y + CORE + BUFFER - xy[:, 1]) / PIXEL).astype(int)
    codes = classification[row, col]
    codes[(xy[:, 0] >= x + CORE) | (xy[:, 1] >= y + CORE)] = 4
    for part, owner, length, start, end in zip(parts, owners, lengths, ends[:-1], ends[1:]):
        classes = codes[start:end]
        if np.all(classes == 4):
            continue
        used += int(np.count_nonzero(classes != 4))
        identifier, name = metadata[owner]
        if name not in names:
            names[name] = len(names)
        coords = shapely.get_coordinates(part)
        distance = np.r_[0, np.cumsum(np.linalg.norm(np.diff(coords, axis=0), axis=1))]
        lon, lat = to_geo.transform(coords[:, 0], coords[:, 1])
        vertices = np.column_stack((np.rint(distance * 10), np.rint(lon * 1e7), np.rint(lat * 1e7))).astype(np.int64).ravel().tolist()
        switches = np.r_[np.flatnonzero(np.diff(classes) != 0) + 1, len(classes)]
        runs = np.column_stack((np.rint(switches / len(classes) * length * 10), classes[switches - 1])).astype(np.int64).ravel().tolist()
        records.append([identifier, names[name], vertices, runs])
    return names, records, used


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--boundary", type=Path, required=True)
    parser.add_argument("--weather", type=Path, required=True)
    parser.add_argument("--time", required=True, help="Event UTC timestamp ending in Z")
    parser.add_argument("--crs", type=int, required=True)
    parser.add_argument("--city", required=True)
    parser.add_argument("--event", required=True)
    parser.add_argument("--source", required=True)
    parser.add_argument("--osm", action="append", type=Path, required=True)
    parser.add_argument("--lidar", type=Path)
    parser.add_argument("--lidar-step", type=int, default=10000)
    parser.add_argument("--dtm", type=Path)
    parser.add_argument("--dsm", type=Path)
    parser.add_argument("--out", type=Path, required=True, help="Web directory for this city and event")
    parser.add_argument("--rasters", type=Path, required=True, help="Local directory for the georeferenced shade tiles")
    parser.add_argument("--workers", type=int, default=4)
    parser.add_argument("--bounds", type=float, nargs=4, help="Optional lon/lat subset for a test run")
    args = parser.parse_args()
    if not args.time.endswith("Z") or not (args.lidar or args.dtm and args.dsm) or args.workers < 1:
        parser.error("Provide an explicit UTC time, terrain sources and at least one worker")

    logging.getLogger("solweig").setLevel(logging.ERROR)
    shadowing.disable_gpu()
    when = datetime.fromisoformat(args.time[:-1])
    to_grid, to_geo = (Transformer.from_crs(a, b, always_xy=True) for a, b in ((4326, args.crs), (args.crs, 4326)))
    feature = city_street.read(args.boundary)
    geom = shape(feature["geometry"]) if feature["type"] == "Feature" else shapely.union_all([shape(f["geometry"]) for f in feature["features"]])
    boundary = city_street.projected_boundary(geom, to_grid)
    extent = boundary if not args.bounds else boundary.intersection(city_street.projected_boundary(box(*args.bounds), to_grid))
    origins = city_street.origins_for(extent) if not extent.is_empty else []
    if not origins:
        parser.error("The requested area does not intersect the boundary")
    args.out.mkdir(parents=True, exist_ok=True)
    args.rasters.mkdir(parents=True, exist_ok=True)
    identity = args.rasters / "run.json"
    config = {"city": args.city, "event": args.event, "timeUtc": args.time, "crs": args.crs, "bounds": args.bounds,
              "web": str(args.out.resolve()), "osm": [str(x.resolve()) for x in args.osm], "weather": str(args.weather.resolve()),
              "boundary": str(args.boundary.resolve()), "lidar": str(args.lidar), "dsm": str(args.dsm), "dtm": str(args.dtm)}
    if identity.is_file() and city_street.read(identity) != config:
        parser.error("The raster directory already contains a different run")
    city_street.save(identity, config)
    roads, buildings, metadata, snapshots = load_network(args.osm, extent, to_grid, to_geo)
    forcing, _ = city_street.weather_at(args.weather, when, to_grid)

    def process(origin):
        x, y = origin
        key = f"{x}_{y}"
        file, raster = args.out / f"{key}.bin", args.rasters / f"{key}.tif"
        info = args.rasters / f"{key}.json"
        if info.is_file():
            saved = city_street.read(info)
            if (not saved["ways"] or file.is_file()) and (not saved["raster"] or raster.is_file()):
                return saved
        core_box = box(x, y, x + CORE, y + CORE)
        core = core_box.intersection(extent)
        bounds = city_street.projected_boundary(core_box, to_geo).bounds
        report = {"id": key, "file": file.name, "bounds": bounds, "ways": 0, "samples": 0, "raster": False}
        terrain = city_street.tile_surface(args, (x - BUFFER, y - BUFFER, x + CORE + BUFFER, y + CORE + BUFFER), buildings)
        if terrain is None:
            city_street.save(info, report)
            return report
        dem, dsm, canopy, supported, building = terrain
        cx, cy = x + CORE / 2, y + CORE / 2
        lon, lat = to_geo.transform(cx, cy)
        location = solweig.Location(latitude=lat, longitude=lon, utc_offset=0)
        last_weather = forcing(cx, cy)[-1]
        if last_weather.datetime != when:
            raise ValueError(f"Weather does not cover {args.time} for tile {key}")
        full, bare = shadow_grids(dem, dsm, canopy, location, last_weather)
        store_rasters(raster, x, y, core, args.crs, args.time, full, bare, supported)
        classes = city_street.shade_classes(full, bare)
        classes[~supported | building | ~np.isfinite(full) | ~np.isfinite(bare)] = 4
        names, records, samples = street_records(roads, metadata, core, x, y, to_geo, classes)
        if records:
            city_street.save(file, {"names": list(names), "ways": records}, True)
        report.update(ways=len(records), samples=samples, raster=True)
        city_street.save(info, report)
        return report

    completed = []
    print(f"{len(origins)} buffered tiles at {args.time}", flush=True)
    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        for i, result in enumerate(pool.map(process, origins), 1):
            completed.append(result)
            if i % 20 == 0 or i == len(origins):
                print(f"{i}/{len(origins)} tiles", flush=True)
    available = [row for row in completed if row["ways"]]
    if not available:
        raise ValueError("No routes with modelled shade were found")
    manifest = {"version": 1, "city": args.city, "event": args.event, "timeUtc": args.time, "source": args.source,
                "osmSnapshots": sorted(set(filter(None, snapshots))), "engine": "SOLWEIG " + solweig.__version__,
                "terrainM": PIXEL, "routeStepM": PIXEL, "classes": CLASSES, "crs": args.crs,
                "bounds": city_street.projected_boundary(extent, to_geo).bounds, "modelTiles": len(origins),
                "rasterTiles": sum(row["raster"] for row in completed), "routeParts": sum(row["ways"] for row in available),
                "samples": sum(row["samples"] for row in available), "tiles": available}
    city_street.save(args.out / "manifest.json", manifest)
    print({key: manifest[key] for key in ("city", "timeUtc", "modelTiles", "rasterTiles", "routeParts", "samples")}, flush=True)


if __name__ == "__main__":
    main()
