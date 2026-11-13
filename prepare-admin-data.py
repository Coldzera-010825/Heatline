"""Build Heatline's boundary-clipped assets from verified local source crops.

Run after prepare-case-data.mjs:
  python prepare-admin-data.py --sources PATH
Inputs are the original administrative GeoJSONs, WorldCover 2021 GeoTIFFs,
GHS-POP R2023A 100 m tiles, and Landsat ST_B10 / QA_PIXEL pairs. The source
crops and the output index are intentionally separate from the archive previews.
"""
from argparse import ArgumentParser
from concurrent.futures import ThreadPoolExecutor
from math import ceil, cos, floor, radians
from pathlib import Path
import gzip
import json

import numpy as np
from PIL import Image
from pyproj import Transformer
import rasterio
from rasterio.features import geometry_mask
from rasterio.merge import merge
from rasterio.transform import from_bounds, from_origin
from rasterio.warp import reproject, Resampling
from rasterio.windows import from_bounds as bounds_window
from shapely import make_valid
from shapely.geometry import box, mapping, shape
from shapely.ops import transform, unary_union


DATA = Path(__file__).parent / "dist/client/data"
OUT = DATA / "admin"
ADMIN_NAMES = {"London": "Greater London", "Paris": "City of Paris",
               "Brussels_Uccle": "Brussels-Capital Region", "Amsterdam": "Amsterdam municipality",
               "Lille": "Commune of Lille", "DeBilt": "De Bilt municipality",
               "Portland": "City of Portland", "Seattle": "City of Seattle"}
PIN = {"London": [-0.1276, 51.5072], "Paris": [2.3522, 48.8566],
       "Brussels_Uccle": [4.3517, 50.8503], "Amsterdam": [4.9041, 52.3676],
       "Lille": [3.0573, 50.6293], "DeBilt": [5.1797, 52.1065],
       "Portland": [-122.6765, 45.5231], "Seattle": [-122.3321, 47.6062]}
COVER = [[10, "Tree cover", "#006400"], [20, "Shrubland", "#ffbb22"],
         [30, "Grassland", "#ffff4c"], [40, "Cropland", "#f096ff"], [50, "Built-up", "#fa0000"],
         [60, "Bare / sparse", "#b4b4b4"], [70, "Snow and ice", "#f0f0f0"],
         [80, "Permanent water", "#0064c8"], [90, "Herbaceous wetland", "#0096a0"],
         [95, "Mangroves", "#00cf75"], [100, "Moss and lichen", "#fae6a0"]]
THERMAL = ["#45337d", "#943c81", "#d35675", "#f2a66c", "#fff4ad"]
THRESHOLD = 45
BINS = [25, 30, 35, 40, 45, 50, 55]


def read(path):
    return json.loads((gzip.decompress(path.read_bytes()) if path.suffix == ".bin" else path.read_bytes()).decode("utf-8-sig"))


def save(relative, value, compress=False):
    path = OUT / relative
    path.parent.mkdir(parents=True, exist_ok=True)
    raw = json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode()
    path.write_bytes(gzip.compress(raw, mtime=0) if compress else raw + b"\n")
    return relative


def project(geometry, src, dst):
    return transform(Transformer.from_crs(src, dst, always_xy=True).transform, geometry)


def polygonal(geometry):
    if geometry.geom_type in ("Polygon", "MultiPolygon"):
        return geometry
    return unary_union([part for part in geometry.geoms if part.geom_type in ("Polygon", "MultiPolygon")])


def grid(bounds, step):
    w, s, e, n = bounds
    w, s = floor(w / step) * step, floor(s / step) * step
    e, n = ceil(e / step) * step, ceil(n / step) * step
    return (ceil((n - s) / step), ceil((e - w) / step)), (w, s, e, n), from_origin(w, n, step, step)


def rgba(values, colors, low, high, classes):
    valid = np.isfinite(values)
    result = np.zeros((*values.shape, 4), dtype="uint8")
    result[..., 3] = np.where(valid, 255, 0)
    palette = lambda color: [int(color[i:i + 2], 16) for i in (1, 3, 5)]
    if classes:
        for number, _, color in classes:
            result[values == number, :3] = palette(color)
    else:
        for channel, intensities in enumerate(np.array([palette(color) for color in colors]).T):
            result[..., channel] = np.interp(np.nan_to_num(values, nan=low), np.linspace(low, high, len(colors)), intensities)
    return result


def asset(stem, values, bounds, city_mask, label, source, limits, unit, colors, metres, classes=None):
    height, width = values.shape
    image = stem + ".png"
    numeric = stem + ".grid.bin"
    out = OUT / image
    out.parent.mkdir(parents=True, exist_ok=True)
    base = Image.fromarray(rgba(values, colors, *limits, classes))
    # Retain the numerical display grid; mask the rendered outline at finer resolution.
    factor = max(1, min(6, 1500 // max(height, width)))
    image_size = (width * factor, height * factor)
    base = base.resize(image_size, Image.Resampling.NEAREST)
    # Rasterise the real outline, including holes, separately from the data grid.
    mask = geometry_mask([city_mask], (image_size[1], image_size[0]),
                         from_bounds(*bounds, *image_size), invert=True)
    alpha = np.asarray(base.getchannel("A"))
    base.putalpha(Image.fromarray(np.where(mask, alpha, 0).astype("uint8")))
    base.save(out, optimize=True)
    offset = 0 if classes else floor(float(np.nanmin(values))) if np.isfinite(values).any() else limits[0]
    step = 1 if classes else .01
    valid = np.isfinite(values)
    packed = np.full(values.shape, 65535, dtype="<u2")
    packed[valid] = np.clip(np.rint((values[valid] - offset) / step), 0, 65534)
    (OUT / numeric).write_bytes(gzip.compress(packed.tobytes(), mtime=0))
    w, s, e, n = bounds
    to_wgs = Transformer.from_crs(3857, 4326, always_xy=True)
    return {"label": label, "image": image, "numeric": numeric, "bounds": bounds, "width": width,
            "height": height, "coordinates": [to_wgs.transform(x, y) for x, y in [(w, n), (e, n), (e, s), (w, s)]],
            "range": limits, "offset": offset, "step": step, "source": source, "unit": unit,
            "colors": colors, "classes": classes, "resolution": metres, "admin": True}


def display_grid(values, local_transform, crs, mask, lon_lat, metres):
    # Reproject the common metric grid for Mapbox's image source; never interpolate categories.
    step = metres / cos(radians(lon_lat[1]))
    dims, bounds, dest = grid(mask.bounds, step)
    result = np.full(dims, np.nan, dtype="float32")
    reproject(values, result, src_transform=local_transform, src_crs=crs, src_nodata=np.nan,
              dst_transform=dest, dst_crs=3857, dst_nodata=np.nan, resampling=Resampling.nearest)
    return result, bounds


def cover_layers(root, city, geometry, mask, crs):
    projected = project(geometry, 4326, crs)
    paths = sorted((root / "worldcover" / city).glob("*.tif"))
    if not paths:
        raise FileNotFoundError(f"No WorldCover data for {city}")
    mosaic = None
    if len(paths) > 1:
        values, transform_ = merge(paths, nodata=0)
        mosaic = (values[0], transform_)
    result = {}
    for metres in (100, 500):
        dims, _, affine = grid(projected.bounds, metres)
        classes = np.zeros(dims, "uint8")
        if mosaic is not None:
            reproject(mosaic[0], classes, src_transform=mosaic[1], src_crs=4326, src_nodata=0,
                      dst_transform=affine, dst_crs=crs, dst_nodata=0, resampling=Resampling.mode)
        else:
            with rasterio.open(paths[0]) as src:
                reproject(rasterio.band(src, 1), classes, src_nodata=0, dst_transform=affine,
                          dst_crs=crs, dst_nodata=0, resampling=Resampling.mode)
        rendered, bounds = display_grid(np.where(classes, classes, np.nan).astype("float32"), affine, crs, mask, PIN[city], metres)
        result[str(metres)] = {"id": "landcover", **asset(f"{city}/landcover-{metres}", rendered, bounds, mask,
            "Land cover", f"ESA WorldCover 2021 v200 · {metres} m ground grid · dominant class · CC BY 4.0",
            [0, 100], "", None, metres, COVER)}
    return result


def population(root, city, geometry, tiles):
    target = "ESRI:54009"
    polygon = project(geometry, 4326, target)
    inside = []
    to_wgs = Transformer.from_crs(target, 4326, always_xy=True)
    for tile in tiles[city]:
        with rasterio.open(root / f"GHS_POP_E2020_GLOBE_R2023A_54009_100_V1_0_{tile}.tif") as src:
            window = bounds_window(*polygon.bounds, src.transform).round_offsets().round_lengths()
            window = window.intersection(rasterio.windows.Window(0, 0, src.width, src.height))
            data = src.read(1, window=window, masked=True).filled(0)
            affine = src.window_transform(window)
            mask = geometry_mask([polygon], data.shape, affine, invert=True)
            rr, cc = np.where(mask & np.isfinite(data) & (data > 0))
            x, y = rasterio.transform.xy(affine, rr, cc)
            lon, lat = to_wgs.transform(x, y)
            weights = data[rr, cc]
            inside.extend(zip(np.round(lon, 7).tolist(), np.round(lat, 7).tolist(), np.round(weights.astype("float64"), 4).tolist()))
    return np.array(inside, dtype="float64")


def metrics(points, temps):
    weights = points[:, 2]
    valid = np.isfinite(temps)
    total, matched = float(weights.sum()), float(weights[valid].sum())
    if not matched:
        return {"population": round(total), "matched": 0, "match": 0, "mean": None, "above": None, "histogram": []}
    t, w = temps[valid], weights[valid]
    return {"population": round(total), "matched": round(matched), "match": round(matched / total, 6),
            "mean": round(float(np.average(t, weights=w)), 3), "above": round(float(w[t >= THRESHOLD].sum() / matched), 6),
            "histogram": (np.histogram(t, bins=[-np.inf, *BINS, np.inf], weights=w)[0] / matched).round(6).tolist()}


def surface(root, city, case, data, points, mask, geometry, crs):
    sat = data["satellite"]
    folder = root / "landsat" / (city + "__" + case["id"])
    with rasterio.open(folder / "st.tif") as st, rasterio.open(folder / "qa.tif") as qa:
        if st.shape != qa.shape or st.transform != qa.transform or st.crs != qa.crs:
            raise ValueError(f"ST and QA grids differ for {folder.name}")
        raw = st.read(1)
        t = np.where((raw > 0) & ((qa.read(1) & 63) == 0), raw * .00341802 - 124.15, np.nan).astype("float32")
        lon, lat = points[:, 0], points[:, 1]
        x, y = Transformer.from_crs(4326, st.crs, always_xy=True).transform(lon, lat)
        rr, cc = rasterio.transform.rowcol(st.transform, x, y)
        inside = (rr >= 0) & (rr < st.height) & (cc >= 0) & (cc < st.width)
        sampled = np.full(len(points), np.nan)
        sampled[inside] = np.round(t[rr[inside], cc[inside]].astype("float64"), 2)
        # Keep only the administrative footprint before aggregating radiometric pixels.
        clipped = geometry_mask([project(geometry, 4326, st.crs)], st.shape, st.transform, invert=True)
        t[~clipped] = np.nan
        dims, _, affine = grid(project(geometry, 4326, crs).bounds, 100)
        local = np.full(dims, np.nan, dtype="float32")
        reproject(t, local, src_crs=st.crs, src_transform=st.transform, src_nodata=np.nan, dst_crs=crs,
                  dst_transform=affine, dst_nodata=np.nan, resampling=Resampling.average)
    stem = city + "/" + case["id"]
    rendered, bounds = display_grid(local, affine, crs, mask, PIN[city], 100)
    layer = {"id": "lst_c", **asset(stem + "/lst", rendered, bounds, mask, "Landsat surface temperature",
             f"USGS Landsat Collection 2 L2 · {sat['datetime'][:16].replace('T', ' ')} UTC · 100 m display grid",
             [25, 55], "°C", THERMAL, 100)}
    summary = metrics(points, sampled)
    return {"layer": layer, "datetime": sat["datetime"], "scene": sat["scene"],
            "inCore": data["core"][0] <= sat["datetime"][:10] <= data["core"][1],
            "surface": save(stem + "/surface.bin", [v if np.isfinite(v) else None for v in sampled], True),
            "summary": summary}


def clipped_preview(meta, mask, stem):
    bounds = meta["bounds"]
    affine = from_bounds(*bounds, meta["width"], meta["height"])
    inside = geometry_mask([mask], (meta["height"], meta["width"]), affine, invert=True)
    packed = np.frombuffer(gzip.decompress((DATA / "cases" / meta["numeric"]).read_bytes()), dtype="<u2").copy()
    packed[~inside.ravel()] = 65535
    out = OUT / stem
    out.parent.mkdir(parents=True, exist_ok=True)
    out.with_suffix(".grid.bin").write_bytes(gzip.compress(packed.tobytes(), mtime=0))
    with Image.open(DATA / "cases" / meta["image"]) as image:
        image = image.convert("RGBA")
    alpha = np.asarray(image.getchannel("A"))
    footprint = geometry_mask([mask], (image.height, image.width), from_bounds(*bounds, image.width, image.height), invert=True)
    image.putalpha(Image.fromarray(np.where(footprint, alpha, 0).astype("uint8")))
    image.save(out.with_suffix(".png"), optimize=True)
    return {**meta, "image": stem + ".png", "numeric": stem + ".grid.bin", "admin": True,
            "match": None, "source": meta["source"] + " · clipped to administrative boundary"}


def weather_summary(model, points):
    """Summarise regional weather on the same admin population denominator."""
    lon, lat, pop = points.T
    weights = np.zeros(len(model["cells"]))
    unassigned = np.ones(len(lon), dtype=bool)
    for i, cell in enumerate(model["cells"]):
        if cell["bounds"] is None:
            continue
        w, s, e, n = cell["bounds"]
        match = unassigned & (lon >= w) & (lon < e) & (lat >= s) & (lat < n)
        weights[i] = pop[match].sum()
        unassigned[match] = False
    rows = []
    total = float(pop.sum())
    for date, records in sorted(model["days"].items()):
        data = np.asarray([row or [None] * 3 for row in records], dtype=float)
        valid = np.isfinite(data).all(axis=1) & (weights > 0)
        matched = float(weights[valid].sum())
        rows.append({"date": date, "values": np.average(data[valid], axis=0, weights=weights[valid]).round(3).tolist()
                     if matched else [None] * 3, "match": matched / total, "matched": round(matched),
                     "population": round(total), "validCells": int(valid.sum()), "totalCells": int((weights > 0).sum())})
    return {"source": model["source"], "resolution": model["resolution"], "daily": rows}


def build_city(source, tile_index, city):
    key = city["id"]
    if key == "London":
        feature = read(DATA / "greater-london-boundary.geojson")["features"][0]
        provenance = {"source": "Greater London boundary used by the London SOLWEIG archive",
                      "url": "https://data.london.gov.uk/dataset/statistical-gis-boundary-files-london"}
    else:
        feature = read(source / f"{key}.geojson")
        provenance = feature["properties"]
    geo = polygonal(make_valid(shape(feature["geometry"]))).simplify(.000025, preserve_topology=True)
    mask = project(geo, 4326, 3857)
    boundary = save(key + "/boundary.json", {"type": "Feature", "geometry": mapping(geo),
                    "properties": {"name": ADMIN_NAMES[key], "city": key, **{k: provenance[k] for k in ("source", "url", "license") if k in provenance}}})
    crs = 27700 if key == "London" else 32600 + floor((PIN[key][0] + 180) / 6) + 1
    points = population(source, key, geo, tile_index)
    popfile = save(key + "/population.bin", points.tolist(), True)
    cover = cover_layers(source, key, geo, mask, crs)
    base = {meta["id"]: clipped_preview(meta, mask, f"{key}/static/{meta['id']}") for meta in city["layers"] if meta["id"] != "landcover"}
    events = {}
    for case in city["cases"]:
        data = read(DATA / "cases" / case["file"])
        event = {"core": data.get("core"), "window": [data["start"], data["end"]], "peak": data["peak"], "pointOnly": case["pointOnly"]}
        events[case["id"]] = event
        if case["pointOnly"]:
            continue
        event["weather"] = {key: weather_summary(data[prop], points) for key, prop in (("land", "weather"), ("era5", "alternative"))
                            if data[prop]}
        event["layers"] = {meta["id"]: clipped_preview(meta, mask, f"{key}/{case['id']}/{meta['id']}")
                           for meta in data["layers"] if meta["id"] != "lst_c"}
        try:
            event["snapshot"] = surface(source, key, case, data, points, mask, geo, crs)
        except FileNotFoundError:
            event["snapshot"] = None
            print(f"Missing source ST or QA crop: {key}/{case['id']}", flush=True)
    return key, {"name": city["name"], "adminName": ADMIN_NAMES[key], "center": PIN[key],
                 "bbox": list(geo.bounds), "boundary": boundary, "provenance": provenance, "population": popfile,
                 "populationCount": round(float(points[:, 2].sum())), "cover": cover, "layers": base, "events": events}


def main():
    parser = ArgumentParser(description=__doc__)
    parser.add_argument("--sources", type=Path)
    parser.add_argument("--street-index-only", action="store_true")
    args = parser.parse_args()
    if args.street_index_only:
        cities = read(OUT / "catalog.json")["cities"]
    else:
        if not args.sources:
            parser.error("--sources is required unless refreshing the street index")
        catalog = read(DATA / "cases/catalog.json")
        tile_index = read(args.sources / "tiles-by-city.json")
        with ThreadPoolExecutor(3) as workers:
            cities = dict(workers.map(lambda city: build_city(args.sources, tile_index, city), catalog["cities"]))
    models = {}
    for path in sorted(OUT.glob("*/*/street.json")):
        city, event, _ = path.relative_to(OUT).parts
        metadata = read(path)
        if "weather" not in metadata:
            continue
        core = cities[city]["events"][event]["core"]
        if not core or not core[0] <= metadata["timeUtc"][:10] <= core[1]:
            raise ValueError(f"Street pilot falls outside the event core: {city}/{event}")
        models.setdefault(city, {})[event] = metadata
    save("catalog.json", {"cities": cities, "streetModels": models, "comparison": {"minimumMatch": .80, "maxSolarMinutes": 90,
         "threshold": THRESHOLD, "bins": BINS}, "sources": {
         "population": "https://human-settlement.emergency.copernicus.eu/ghs_pop2023.php",
         "landcover": "https://esa-worldcover.org/en/data-access",
         "lst": "https://www.usgs.gov/landsat-missions/landsat-surface-temperature"}})
    print("Street models:", {city: list(events) for city, events in models.items()}, flush=True)
    for key, city in cities.items() if not args.street_index_only else []:
        print(key, city["populationCount"], [(k, e["snapshot"]["summary"]["match"], e["snapshot"]["datetime"][:10])
              for k, e in city["events"].items() if e.get("snapshot")], flush=True)


if __name__ == "__main__":
    main()
