"""Stage PDOK AHN 5 m surfaces and UTC event-hour forcing for a Dutch FUA."""
import argparse
from concurrent.futures import ThreadPoolExecutor
from math import ceil, floor
from pathlib import Path
import json

import numpy as np
import rasterio
import requests
from pyproj import Transformer
from rasterio.transform import from_origin
from rasterio.windows import from_bounds
from shapely import transform
from shapely.geometry import box, shape


CRS = "EPSG:28992"
AHN = "https://service.pdok.nl/rws/ahn/wcs/v1_0"
WEATHER = "https://archive-api.open-meteo.com/v1/archive"
FIELDS = ("temperature_2m", "relative_humidity_2m", "wind_speed_10m", "shortwave_radiation")


def download(url, params, path):
    if path.is_file():
        return
    with requests.get(url, params=params, stream=True, timeout=(12, 110)) as response:
        response.raise_for_status()
        pending = path.with_suffix(".part")
        with pending.open("wb") as stream:
            for chunk in response.iter_content(1024 * 1024):
                stream.write(chunk)
        pending.replace(path)


def get_tile(directory, field, bounds):
    w, s, e, n = bounds
    path = directory / f"{field}-{w}-{s}.tif"
    params = dict(service="WCS", version="1.0.0", request="GetCoverage", coverage=field + "_05m", crs=CRS,
                  response_crs=CRS, bbox=",".join(map(str, bounds)), width=(e-w)//5, height=(n-s)//5, format="image/tiff")
    download(AHN, params, path)
    with rasterio.open(path) as src:
        if src.crs.to_epsg() != 28992 or src.res != (5, 5) or tuple(src.bounds) != bounds:
            raise ValueError(f"Unexpected reference grid in {path.name}")
    print("AHN", path.name, path.stat().st_size, flush=True)
    return field, path


def weather(directory, day, bounds):
    w, s, e, n = bounds
    coords = [(i / 10, j / 10) for j in range(floor(s * 10), ceil(n * 10) + 1)
              for i in range(floor(w * 10), ceil(e * 10) + 1)]
    target = directory / (day + ".weather.json")
    payload = []
    for start in range(0, len(coords), 24):
        path = directory / f"{day}.forcing-{start}.json"
        a = coords[start:start + 24]
        params = dict(longitude=",".join(str(x) for x, _ in a), latitude=",".join(str(y) for _, y in a),
                      start_date=day, end_date=day, hourly=",".join(FIELDS), models="era5_seamless",
                      timezone="GMT", wind_speed_unit="kmh")
        download(WEATHER, params, path)
        values = json.loads(path.read_bytes())
        payload.extend(values if isinstance(values, list) else [values])
    target.write_text(json.dumps(payload), encoding="utf8")
    print("Forcing", day, len(payload), "grid locations", flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--boundary", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--date", required=True)
    parser.add_argument("--workers", type=int, default=6)
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    obj = json.loads(args.boundary.read_bytes())
    geo = shape(obj["geometry"])
    convert = Transformer.from_crs(4326, CRS, always_xy=True)
    local = transform(geo, convert.transform, interleaved=False).buffer(1100)
    w, s, e, n = local.bounds
    step = 10000
    w, s, e, n = floor(w / step) * step, floor(s / step) * step, ceil(e / step) * step, ceil(n / step) * step
    tiles = [(x, y, x + step, y + step) for y in range(s, n, step) for x in range(w, e, step)
             if local.intersects(box(x, y, x+step, y+step))]
    dims = ((n - s) // 5, (e - w) // 5)
    affine = from_origin(w, n, 5, 5)
    with ThreadPoolExecutor(args.workers) as executor:
        forcing = executor.submit(weather, args.output, args.date, geo.bounds)
        jobs = [executor.submit(get_tile, args.output, field, boundary) for boundary in tiles for field in ("dsm", "dtm")]
        parts = [job.result() for job in jobs]
        forcing.result()
    for field in ("dsm", "dtm"):
        out = args.output / (field + ".tif")
        pending = out.with_suffix(".mosaic")
        with rasterio.open(pending, "w", driver="GTiff", width=dims[1], height=dims[0], count=1, crs=CRS,
                           transform=affine, dtype="float32", nodata=np.nan, compress="deflate", tiled=True, sparse_ok=True) as sink:
            for kind, tile in parts:
                if kind == field:
                    with rasterio.open(tile) as source:
                        values = source.read(1, masked=True).filled(np.nan)
                        values[~np.isfinite(values) | (abs(values) > 10000)] = np.nan
                        sink.write(values, 1, window=from_bounds(*source.bounds, affine).round_offsets().round_lengths())
        pending.replace(out)


if __name__ == "__main__":
    main()
