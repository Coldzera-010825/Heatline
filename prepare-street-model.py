"""Run the London SOLWEIG method for a new 1.8 km pilot and publish 100 m cells.

The input directory contains co-registered 5 m dsm.tif and dtm.tif, extent.json,
buildings.geojson, roads.geojson and an Open-Meteo hourly weather.json (UTC,
temperature_2m, relative_humidity_2m, wind_speed_10m, shortwave_radiation).
The existing London runner supplies the common SOLWEIG and network algorithms.
"""
import argparse
import gzip
import importlib.util
import json
from datetime import datetime, timedelta
from pathlib import Path

import numpy as np
from pyproj import Transformer
import rasterio
from rasterio.features import rasterize
from rasterio.transform import from_origin
from scipy.ndimage import distance_transform_edt
from shapely import make_valid
from shapely.geometry import box, shape, mapping
from shapely.ops import transform


DATA = Path(__file__).parent / "dist/client/data/admin"


def read(path):
    return json.loads(path.read_text(encoding="utf-8-sig"))


def write(path, value, packed=False):
    path.parent.mkdir(parents=True, exist_ok=True)
    data = json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode()
    path.write_bytes(gzip.compress(data, mtime=0) if packed else data + b"\n")


def load_runner(path, args, bounds):
    spec = importlib.util.spec_from_file_location("london_solweig_pilot", path)
    model = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(model)
    model.CRS = args.crs
    model.BOUNDS = bounds
    model.CORE = box(bounds[0] + 200, bounds[1] + 200, bounds[2] - 200, bounds[3] - 200)
    model.PIXEL = 5
    model.SIZE = (round((bounds[3] - bounds[1]) / 5), round((bounds[2] - bounds[0]) / 5))
    model.TRANSFORM = from_origin(bounds[0], bounds[3], 5, 5)
    model.TO_GRID = Transformer.from_crs(4326, args.crs, always_xy=True).transform
    model.TO_WGS = Transformer.from_crs(args.crs, 4326, always_xy=True).transform
    model.EVENT = datetime.fromisoformat(args.time.removesuffix("Z"))
    return model


def rasters(inputs, model, buildings):
    data = []
    for field in ("dsm", "dtm"):
        with rasterio.open(inputs / (field + ".tif")) as src:
            if src.crs != model.CRS or src.transform != model.TRANSFORM or src.shape != model.SIZE:
                raise ValueError(f"{field} is not co-registered on the common 5 m grid")
            data.append(src.read(1, masked=True).filled(np.nan))
    dsm, dtm = data
    # Bare-ground terrain is absent below roofs and many canals in AHN4. Use
    # nearest measured ground for the surface model; exclude routes without a
    # supported height estimate rather than sampling through the missing area.
    missing = ~np.isfinite(dtm)
    distance, (rows, cols) = distance_transform_edt(missing, return_indices=True)
    terrain = np.where(missing, dtm[rows, cols], dtm)
    observed = np.isfinite(dsm)
    if not np.isfinite(terrain).all() or not observed.any():
        raise ValueError("The study area has no usable height model")
    height = np.clip(np.where(observed, dsm - terrain, 0), 0, None)
    building_dsm = terrain + np.where(buildings, height, 0)
    canopy = np.where(~buildings & (height >= 2) & (height <= 30), height, 0)
    return terrain, building_dsm, canopy, ~observed | (distance > 10)


def forcing(inputs, model, bounds):
    values = read(inputs / "weather.json")
    weather = values["hourly"]
    times = {datetime.fromisoformat(time): i for i, time in enumerate(weather["time"])}
    event = model.EVENT
    hour = event.replace(minute=0, second=0)
    fraction = (event - hour).total_seconds() / 3600

    def row(at, index, next_index, fraction, minutes):
        def mean(key):
            return weather[key][index] * (1 - fraction) + weather[key][next_index] * fraction
        return model.solweig.Weather(datetime=at, ta=mean("temperature_2m"), rh=mean("relative_humidity_2m"),
            global_rad=weather["shortwave_radiation"][next_index], ws=mean("wind_speed_10m") / 3.6, timestep_minutes=minutes)

    series = []
    for k in range(4, -1, -1):
        at = hour - timedelta(hours=k)
        series.append(row(at, times[at], times[at], 0, 60))
    if fraction:
        series.append(row(event, times[hour], times[hour + timedelta(hours=1)], fraction, fraction * 60))
    w, s, e, n = bounds
    return series, model.TO_WGS((w + e) / 2, (s + n) / 2)


def prepare(args):
    inputs = args.inputs
    bounds = tuple(read(inputs / "extent.json"))
    model = load_runner(args.london_runner, args, bounds)
    area = box(*bounds)
    boundary = read(DATA / args.city / "boundary.json")
    admin = transform(model.TO_GRID, shape(boundary["geometry"]))
    model.CORE = model.CORE.intersection(admin)
    if model.CORE.is_empty:
        raise ValueError("The pilot does not intersect its administrative boundary")
    buildings, roads = [], []
    for file, target in (("buildings", buildings), ("roads", roads)):
        for f in read(inputs / (file + ".geojson"))["features"]:
            p = f["properties"]
            if not f["geometry"] or p.get("is_underground") or (isinstance(p.get("level"), (int, float)) and p["level"] < 0):
                continue
            if file == "roads" and (p.get("class") not in model.ROADS or p.get("is_tunnel") or p.get("is_bridge") or
                                     p.get("access") in {"no", "private"}):
                continue
            g = make_valid(transform(model.TO_GRID, shape(f["geometry"]))).intersection(area)
            if not g.is_empty:
                target.append(g)
    if not buildings or not roads:
        raise ValueError("No usable building or road geometries")
    building_mask = rasterize([(g, 1) for g in buildings], out_shape=model.SIZE, transform=model.TRANSFORM).astype(bool)
    args.work.mkdir(parents=True, exist_ok=True)
    terrain, dsm, canopy, invalid = rasters(inputs, model, building_mask)
    for field, values in (("terrain", terrain), ("building_dsm", dsm), ("canopy", canopy)):
        model.save_raster(args.work / f"{field}_5m.tif", values)
    weather, (lon, lat) = forcing(inputs, model, bounds)
    print("Event forcing", weather[-1], "road features", len(roads), flush=True)
    full, tmrt, utci = model.run_model(args.work, weather, lon, lat, True)
    buildings_only = model.run_model(args.work, weather, lon, lat, False)
    cells, _ = model.sample_network(roads, building_mask | invalid, full, buildings_only, tmrt, utci)
    publish(args, model, weather[-1], cells)


def publish(args, model, forcing, cells):
    rows, pairs = [], []
    for (x, y), data in sorted(cells.items()):
        array = np.asarray(data)
        length = array[:, 1].sum()
        if length < 20:
            continue
        polygon = box(x, y, x + 100, y + 100).intersection(model.CORE)
        if polygon.geom_type != "Polygon" or polygon.is_empty:
            continue
        anchor = polygon.representative_point()
        lon, lat = (round(v, 7) for v in model.TO_WGS(anchor.x, anchor.y))
        ring = [[round(a, 7), round(b, 7)] for a, b in transform(model.TO_WGS, polygon).exterior.coords]
        mean = float(np.average(array[:, 3], weights=array[:, 1]))
        distribution = {}
        for shade, path, radiant, _ in data:
            weights = distribution.setdefault(round(float(radiant), 2), [0., 0., 0., 0.])
            weights[shade] += float(path)
        samples = [[radiant, *[round(n, 5) for n in weights]] for radiant, weights in sorted(distribution.items())]
        rows.append([lon, lat, round(mean, 2), round(float(length), 1), ring, samples])
        sun, shade = array[array[:, 0] == 0], array[array[:, 0] == 1]
        lengths = [a[:, 1].sum() for a in (sun, shade)]
        if min(lengths) >= 20:
            by_class = [float(np.average(a[:, 3], weights=a[:, 1])) for a in (sun, shade)]
            pairs.append([lon, lat, round(float(length), 1), *(round(float(v), 1) for v in lengths),
                          round(mean, 4), *(round(v, 4) for v in by_class), ring])
    if not rows:
        raise ValueError("Cannot publish: no valid network cells")
    folder = f"{args.city}/{args.event}"
    time = model.EVENT.isoformat() + "Z"
    core_geo = transform(model.TO_WGS, model.CORE)
    write(DATA / folder / "street.bin", {"rows": rows, "pairs": pairs}, True)
    meta = {"label": args.label, "timeUtc": time, "bounds": core_geo.bounds,
            "geometry": mapping(core_geo), "file": folder + "/street.bin", "gridCells": len(rows),
            "pairedCells": len(pairs), "source": args.source,
            "engine": "SOLWEIG " + model.solweig.__version__, "terrainM": 5, "gridM": 100, "scope": "pilot",
            "weather": {"airC": forcing.ta, "humidity": forcing.rh, "wind": forcing.ws, "shortwaveWm2": forcing.global_rad},
            "fixedGeometry": True}
    write(DATA / folder / "street.json", meta)
    print(json.dumps({k: v for k, v in meta.items() if k != "geometry"}), flush=True)


def existing_london(args):
    root = args.london_runner.parent
    model = load_runner(args.london_runner, args, (529600, 180400, 531400, 182200))
    buildings, roads, _ = model.osm_geometries(root / "inputs")
    mask = rasterize([(g, 1) for g in buildings], out_shape=model.SIZE, transform=model.TRANSFORM).astype(bool)
    results = root / "results"

    def load(folder, field):
        with rasterio.open(results / folder / field / f"{field}_{model.EVENT:%Y%m%d_%H%M}.tif") as src:
            return src.read(1, masked=True).filled(np.nan)

    if args.inputs is None:
        inputs = read(results / "summary.json")["forcing"]
        weather = model.solweig.Weather(datetime=model.EVENT, ta=inputs["air_c"], rh=inputs["relative_humidity_pct"],
            ws=inputs["wind_10m_ms"], global_rad=inputs["global_shortwave_wm2"])
        full, bare = load("full", "shadow"), load("buildings_only", "shadow")
        tmrt, utci = load("full", "tmrt"), load("full", "utci")
    else:
        from shutil import copyfile
        args.work.mkdir(parents=True, exist_ok=True)
        for name in ("terrain_5m.tif", "building_dsm_5m.tif", "canopy_5m.tif"):
            if not (args.work / name).exists():
                copyfile(results / name, args.work / name)
        series, (lon, lat) = forcing(args.inputs, model, model.BOUNDS)
        full, tmrt, utci = model.run_model(args.work, series, lon, lat, True)
        bare = model.run_model(args.work, series, lon, lat, False)
        weather = series[-1]
    cells, _ = model.sample_network(roads, mask, full, bare, tmrt, utci)
    publish(args, model, weather, cells)


if __name__ == "__main__":
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--city", required=True)
    p.add_argument("--event", required=True)
    p.add_argument("--label", required=True)
    p.add_argument("--crs", required=True)
    p.add_argument("--time", required=True)
    p.add_argument("--source", required=True)
    p.add_argument("--inputs", type=Path)
    p.add_argument("--work", type=Path)
    p.add_argument("--london-runner", type=Path, required=True)
    p.add_argument("--existing-london", action="store_true")
    args = p.parse_args()
    if not args.existing_london and (args.inputs is None or args.work is None):
        p.error("--inputs and --work are required when running a new case")
    (existing_london if args.existing_london else prepare)(args)
