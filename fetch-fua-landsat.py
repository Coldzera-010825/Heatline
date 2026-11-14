"""Cache the same selected Landsat scene crops used in the FUA catalog."""
import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
import json
from pathlib import Path
from threading import Lock
import time
from urllib.parse import urlsplit

import requests
import rasterio
from rasterio.windows import Window, from_bounds
from rasterio.warp import transform_bounds


API = "https://planetarycomputer.microsoft.com/api"
tokens = {}
token_lock = Lock()


def read_json(path):
    return json.loads(path.read_text(encoding="utf-8-sig"))


def scene_jobs(web):
    catalog = read_json(web / "catalog.json")
    cities = {item["id"]: item for item in catalog["cities"]}
    jobs = {}
    for item in catalog["events"]:
        if item["city"] == "London":
            continue
        event = read_json(web / item["url"])
        landsat = event.get("landsat", {})
        core = landsat.get("core_period_layer") or {}
        ids = {scene["id"] for scene in landsat.get("scenes", [])}
        if core.get("status") == "available" and core.get("matched_population_2020", 0) > 0:
            ids.update(core.get("scene_ids", []))
        a = cities[item["city"]]["bounds"]
        for scene in ids:
            b = jobs.get(scene, a)
            jobs[scene] = [min(a[0], b[0]), min(a[1], b[1]), max(a[2], b[2]), max(a[3], b[3])]
    return jobs


def get_json(url):
    for delay in (1, 3, 8, 15):
        response = requests.get(url, timeout=(8, 22))
        if response.status_code not in (429, 500, 502, 503, 504):
            response.raise_for_status()
            return response.json()
        time.sleep(delay)
    response.raise_for_status()


def signed_url(href):
    parsed = urlsplit(href)
    account = parsed.hostname.split(".")[0]
    container = parsed.path.split("/")[1]
    key = (account, container)
    with token_lock:
        if key not in tokens:
            tokens[key] = get_json(f"{API}/sas/v1/token/{account}/{container}")["token"].lstrip("?")
    return href + "?" + tokens[key]


def acquire(scene, box, output):
    folder = output / scene
    folder.mkdir(parents=True, exist_ok=True)
    if all((folder / name).exists() for name in ("st.tif", "qa.tif", "scene.json")):
        return "cached"
    item = get_json(f"{API}/stac/v1/collections/landsat-c2-l2/items/{scene}")
    with rasterio.Env(GDAL_DISABLE_READDIR_ON_OPEN="EMPTY_DIR", GDAL_HTTP_TIMEOUT="18",
                      GDAL_HTTP_MAX_RETRY="1", GDAL_HTTP_MULTIRANGE="YES"):
        for key, name in (("lwir11", "st"), ("qa_pixel", "qa")):
            if (folder / f"{name}.tif").exists():
                continue
            url = signed_url(item["assets"][key]["href"])
            with rasterio.open(url) as source:
                w, s, e, n = transform_bounds("EPSG:4326", source.crs, *box)
                window = from_bounds(w - 150, s - 150, e + 150, n + 150, source.transform)
                window = window.round_offsets().round_lengths().intersection(Window(0, 0, source.width, source.height))
                values = source.read(1, window=window)
                profile = dict(driver="GTiff", width=values.shape[1], height=values.shape[0], count=1,
                               dtype=values.dtype, crs=source.crs, transform=source.window_transform(window),
                               compress="deflate", tiled=True)
                temp = folder / f"{name}.part.tif"
                with rasterio.open(temp, "w", **profile) as out:
                    out.write(values, 1)
                temp.replace(folder / f"{name}.tif")
    info = {"id": scene, "cloud_cover": item["properties"].get("eo:cloud_cover"), "time": item["properties"]["datetime"]}
    (folder / "scene.json").write_text(json.dumps(info), encoding="utf-8")
    return "ready"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--web", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--workers", type=int, default=8)
    args = parser.parse_args()
    jobs = scene_jobs(args.web)
    print(f"Selected scenes: {len(jobs)}", flush=True)
    failed = 0
    with ThreadPoolExecutor(args.workers) as pool:
        futures = {pool.submit(acquire, scene, box, args.output): scene for scene, box in jobs.items()}
        for future in as_completed(futures):
            scene = futures[future]
            try:
                print(scene, future.result(), flush=True)
            except Exception as error:
                # A signed URL can appear in driver errors. Print only the error class.
                status = error.response.status_code if isinstance(error, requests.HTTPError) else ""
                print(scene, type(error).__name__, status, flush=True)
                failed += 1
    if failed:
        raise SystemExit(f"{failed} scene crops unavailable")


if __name__ == "__main__":
    main()
