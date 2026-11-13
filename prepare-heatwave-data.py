"""Package historical source observations and simulation inputs for the atlas.

Run with the AEF Python environment. The staging directory contains the
July ERA5-Land OPeNDAP extract, ESA WorldCover crops, the LOAC boundaries
and the Nomis Census TS007A archive. Existing AEF and TerraHeat inputs
are read in place.
"""

import argparse
import ast
from collections import defaultdict
import csv
from datetime import datetime
import gzip
import io
import json
from pathlib import Path
import re
import sys
import zipfile


parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("staging", type=Path)
parser.add_argument("--aef", type=Path, required=True)
parser.add_argument("--terraheat", type=Path, required=True)
args = parser.parse_args()
sys.path.insert(0, str(args.aef / "tools/python_packages"))

import numpy as np
from pyproj import Transformer
import rasterio
from rasterio.features import geometry_mask, rasterize
from rasterio.transform import from_origin, rowcol
from rasterio.warp import reproject, Resampling
from shapely import make_valid, union_all
from shapely.geometry import box, LineString, Polygon, shape
from shapely.ops import unary_union
import xml.etree.ElementTree as ET


data = Path(__file__).resolve().parent / "dist/client/data"
output = data / "heatwave"
traditional = args.aef / "Data/03_Traditional_Geographical_Variables"
lst_path = args.aef / "experiments/greater-london-heat/inputs/landsat9_lst_100m.tif"
boundary = union_all([shape(f["geometry"]) for f in json.loads(
    (data / "greater-london-boundary.geojson").read_text(encoding="utf-8")
)["features"]])


def write(name, content):
    path = output / name
    path.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(content, ensure_ascii=False, separators=(",", ":"), allow_nan=False) + "\n"
    if name in ("london-grid.json", "stations.json"):
        path.write_text(text, encoding="utf-8")
    else:
        path.with_suffix(".bin").write_bytes(gzip.compress(text.encode("utf-8"), mtime=0))


def globe():
    source = (args.staging / "era5-globe-2deg.txt").read_text(encoding="ascii")
    coordinates = {}
    for axis in ("time", "lat", "lon"):
        values = re.search(rf"maxtemp\.{axis}\[\d+\]\s*\n([^\n]+)", source)[1]
        coordinates[axis] = [float(value) for value in values.split(",")]
    assert coordinates["time"] == list(range(12, 19))
    days = [[] for _ in coordinates["time"]]
    for line in source.splitlines():
        match = re.match(r"^\[(\d+)\]\[(\d+)\], (.+)", line)
        if not match:
            continue
        day, row = map(int, match.group(1, 2))
        lat = coordinates["lat"][row]
        if abs(lat) > 84:
            continue
        values = [float(value) for value in match[3].split(",")]
        for lon, kelvin in zip(coordinates["lon"], values, strict=True):
            if kelvin > 0:
                days[day].append([int((lon + 180) % 360 - 180), int(lat), round(kelvin - 273.15, 1)])
    assert all(len(rows) > 3500 for rows in days)
    for day, rows in enumerate(days, 13):
        write(f"globe-{day}.json", rows)
    print("ERA5-Land", [len(rows) for rows in days])


def london_layers():
    inputs = [
        [lst_path],
        [traditional / "07_NDVI_Landsat8/London/2022/07/Monthly_Composites/Landsat8_NDVI_median_2022-07_London_30m.tif"],
        [traditional / "04_NDWI_Landsat8/London/2022/07/Scenes/LC09_L2SP_201024_20220718_02_T1_London_NDWI_30m.tif"],
        [traditional / "01_Elevation/London/Static/NASADEM_London_30m.tif"],
        sorted(args.staging.glob("land-cover-N51*.tif")),
    ]
    assert len(inputs[-1]) == 2
    west, south, east, north = [-0.54, 51.27, 0.36, 51.72]
    levels = []
    for detail, multiplier in (("overview", 5), ("detail", 1)):
        dx, dy = .0015 * multiplier, .0009 * multiplier
        columns, rows = round((east - west) / dx), round((north - south) / dy)
        transform = from_origin(west, north, dx, dy)
        mask = geometry_mask([boundary], (rows, columns), transform, invert=True)
        arrays = []
        for index, paths in enumerate(inputs):
            field = np.full((rows, columns), np.nan, np.float32)
            for path in paths:
                with rasterio.open(path) as source:
                    tile = np.full_like(field, np.nan)
                    reproject(
                        rasterio.band(source, 1), tile, dst_transform=transform,
                        dst_crs="EPSG:4326", src_nodata=source.nodata,
                        dst_nodata=np.nan, resampling=Resampling.mode if index == 4 else Resampling.average,
                    )
                    valid = np.isfinite(tile)
                    if index == 4:
                        valid &= tile > 0
                    field[valid] = tile[valid]
            arrays.append(field)
        tiles = defaultdict(list)
        for row, col in np.argwhere(mask):
            values = [field[row, col] for field in arrays]
            if not np.isfinite(values).any():
                continue
            rounded = [
                round(float(value), decimals) if np.isfinite(value) else None
                for value, decimals in zip(values, (1, 3, 3, 1, 0), strict=True)
            ]
            tile = (int(col // 80), int(row // 100)) if detail == "detail" else (0, 0)
            tiles[tile].append([int(col), int(row), *rounded])
        files = []
        for (col, row), values in sorted(tiles.items()):
            file = f"london-{detail}-{col}-{row}.json"
            write(file, values)
            files.append({
                "file": file,
                "bounds": [
                    round(west + min(r[0] for r in values) * dx, 6),
                    round(north - (max(r[1] for r in values) + 1) * dy, 6),
                    round(west + (max(r[0] for r in values) + 1) * dx, 6),
                    round(north - min(r[1] for r in values) * dy, 6),
                ],
            })
        levels.append({"dx": dx, "dy": dy, "meters": 100 * multiplier, "tiles": files})
        print("London layers", detail, len(tiles), sum(map(len, tiles.values())),
              [int(np.count_nonzero(np.isfinite(f) & mask)) for f in arrays])
    write("london-grid.json", {"west": west, "north": north, "levels": levels})


def wow():
    source = args.terraheat / "dist/data/london-research"
    catalog = []
    features = json.loads((source / "wow-stations.geojson").read_text(encoding="utf-8"))["features"]
    for feature in features:
        site_id = feature["properties"]["id"]
        series = json.loads((source / "wow-series" / f"{site_id}.json").read_text(encoding="utf-8"))
        rows = [r for r in series["rows"] if "2022-07-13" <= r[0] < "2022-07-20"]
        if not any(r[1] is not None for r in rows):
            continue
        name = feature["properties"]["name"].strip()
        if re.search(r"^\d|,\s*(?:[A-Z]{1,2}\d|UK\b)", name):
            name = f"WOW station {len(catalog) + 1:02}"
        station = {"id": site_id, "name": name, "coordinates": feature["geometry"]["coordinates"]}
        catalog.append(station)
        write(f"wow/{site_id}.json", {**station, "fields": series["fields"], "rows": rows})
    assert len(catalog) >= 25
    write("stations.json", catalog)
    print("WOW stations", len(catalog))


def population():
    with zipfile.ZipFile(args.staging / "census2021-ts007a.zip") as source:
        with source.open("census2021-ts007a-oa.csv") as archive:
            table = csv.DictReader(io.TextIOWrapper(archive, encoding="utf-8-sig"))
            older_columns = [h for h in table.fieldnames if re.search(r"Aged (65|70|75|80|85)\b", h)]
            assert len(older_columns) == 5, older_columns
            counts = {
                row["geography code"]: [int(row["Age: Total"]), sum(int(row[h]) for h in older_columns)]
                for row in table
            }
    area_features = json.loads((args.staging / "london-oa-boundaries.geojson").read_text(encoding="utf-8"))["features"]
    codes = [f["properties"]["OA21CD"] for f in area_features]
    assert len(set(codes)) == len(codes) == 26369
    points = []
    with rasterio.open(lst_path) as lst:
        to_pixel = Transformer.from_crs("EPSG:4326", lst.crs, always_xy=True)
        for feature in area_features:
            geometry = make_valid(shape(feature["geometry"]))
            center = geometry.centroid
            if not geometry.covers(center):
                center = geometry.representative_point()
            points.append((center.x, center.y))
        east, north = to_pixel.transform(*zip(*points))
        values = lst.sample(zip(east, north), masked=True)
        records = []
        for code, (lon, lat), value in zip(codes, points, values, strict=True):
            t = float(value[0]) if not np.ma.is_masked(value[0]) else np.nan
            records.append([round(lon, 6), round(lat, 6), round(t, 2) if np.isfinite(t) else None, *counts[code]])
    assert all(r[-1] <= r[-2] for r in records)
    write("population.json", records)
    print("Census output areas", len(records), "with Landsat", sum(r[2] is not None for r in records))


def shade_pairs():
    pilot = args.aef / "experiments/london-heat-pilot"
    # Reuse the pilot sampler on the original rasters, without importing the simulator or plotting dependencies.
    dependencies = {
        "BOUNDS", "CORE", "PIXEL", "SIZE", "TRANSFORM", "CRS", "TO_GRID", "TO_WGS",
        "EVENT", "ROADS", "osm_geometries", "sample_network",
    }
    parsed = ast.parse((pilot / "run_pilot.py").read_text(encoding="utf-8"))
    required = [
        node for node in parsed.body
        if (isinstance(node, ast.Assign) and isinstance(node.targets[0], ast.Name)
            and node.targets[0].id in dependencies)
        or (isinstance(node, ast.FunctionDef) and node.name in dependencies)
    ]
    model = dict(globals())
    exec(compile(ast.Module(body=required, type_ignores=[]), str(pilot / "run_pilot.py"), "exec"), model)
    buildings, routes, _ = model["osm_geometries"](pilot / "inputs")
    building_mask = rasterize(
        [(geometry, 1) for geometry in buildings if not geometry.is_empty],
        out_shape=model["SIZE"], transform=model["TRANSFORM"], dtype="uint8",
    ).astype(bool)

    def raster(name, field):
        with rasterio.open(pilot / f"results/{name}/{field}/{field}_20220718_1052.tif") as source:
            return source.read(1, masked=True).filled(np.nan)

    samples, _ = model["sample_network"](
        routes, building_mask, raster("full", "shadow"), raster("buildings_only", "shadow"),
        raster("full", "tmrt"), raster("full", "utci"),
    )
    to_wgs = model["TO_WGS"]
    records = []
    for (east, north), values in sorted(samples.items()):
        rows = np.array(values)
        sun, shade = rows[rows[:, 0] == 0], rows[rows[:, 0] == 1]
        sun_m, shade_m = sun[:, 1].sum(), shade[:, 1].sum()
        if sun_m < 20 or shade_m < 20:
            continue
        lon, lat = to_wgs(east + 50, north + 50)
        polygon = [to_wgs(x, y) for x, y in box(east, north, east + 100, north + 100).exterior.coords]
        means = [np.average(r[:, 3], weights=r[:, 1]) for r in (rows, sun, shade)]
        record = [lon, lat, rows[:, 1].sum(), sun_m, shade_m, *means]
        records.append([*[round(float(v), 6) for v in record],
                        [[round(x, 7), round(y, 7)] for x, y in polygon]])
    assert len(records) == 159, len(records)
    median = float(np.median([r[6] - r[7] for r in records]))
    assert round(median, 2) == 6.01, median
    write("shade-pairs.json", records)
    print("Shade pairs", len(records), "median sun minus building shade", round(median, 2))


for prepare in (globe, london_layers, wow, population, shade_pairs):
    prepare()
