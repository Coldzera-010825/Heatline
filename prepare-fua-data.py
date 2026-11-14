"""Import the eight Heatline FUA v3 areas and rebuild their published case data.

Use --processed for the complete package's 100 m rasters. The optional
--scenes and --ghs inputs reproduce missing rasters from their public sources.
Without native rasters, only the supplied full-area population statistic is
available for the affected snapshot. Display grid values never enter the model.
"""
import argparse
from concurrent.futures import ThreadPoolExecutor
import gzip
import importlib.util
import json
from pathlib import Path

import numpy as np
import rasterio
from pyproj import Transformer
from rasterio.features import geometry_mask
from rasterio.transform import from_origin, rowcol, xy
from rasterio.warp import reproject, Resampling
from shapely.geometry import mapping, shape


spec = importlib.util.spec_from_file_location("admin_data", Path(__file__).with_name("prepare-admin-data.py"))
admin = importlib.util.module_from_spec(spec)
spec.loader.exec_module(admin)
read = admin.read
cases_dir = admin.DATA / "cases"
labels = {
    "lst_c": ("Landsat surface temperature", "°C", [25, 55], admin.THERMAL),
    "lst_core_c": ("Landsat LST · event core", "°C", [25, 55], admin.THERMAL),
    "ndvi": ("Landsat NDVI", "", [-.5, .85], ["#54396d", "#e1c9a6", "#37916d"]),
    "ndwi": ("Landsat NDWI", "", [-.65, .6], ["#a6754a", "#dacfbd", "#528ebf"]),
    "mndwi": ("Landsat MNDWI", "", [-.65, .6], ["#a6754a", "#dacfbd", "#528ebf"]),
    "elevation": ("Surface elevation", " m", [-20, 800], ["#443765", "#e0d8ae", "#258475"]),
    "landcover": ("Land cover", "", [0, 100], None),
    "population_count_100m": ("Resident population · display grid", " people", [0, 500], ["#443765", "#e0d8ae", "#258475"]),
}
static_source = {
    "elevation": "Copernicus GLO-30 DSM",
    "landcover": "ESA WorldCover 2021 v200 · dominant class · CC BY 4.0",
    "population_count_100m": "GHS-POP 2020 · mean count per 100 m source cell",
}


def save_case(relative, value):
    path = cases_dir / relative
    path.parent.mkdir(parents=True, exist_ok=True)
    raw = json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode()
    path.write_bytes(gzip.compress(raw, mtime=0) if path.suffix == ".bin" else raw + b"\n")


def save_binary(relative, data):
    path = admin.OUT / relative
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(gzip.compress(data, compresslevel=6, mtime=0))
    return relative


def footprint(feature):
    return shape(feature["geometry"])


def source_boundary(web, item):
    boundary = read(web / item["boundary"])
    if boundary["type"] == "FeatureCollection":
        if len(boundary["features"]) != 1:
            raise ValueError(f"{item['id']} must contain one boundary feature")
        return boundary["features"][0]
    return boundary


def geometry_grid(web, key, feature, crs):
    geo = footprint(feature)
    mask = admin.project(geo, 4326, 3857)
    projected = admin.project(geo, 4326, crs)
    positions = read(web / key / "geometry_positions.json")
    rows, cols = (np.asarray([r[i] for r in positions], dtype="int32") for i in (0, 1))
    # Verify the published cell indices against the projected polygons.
    manifest = read(web / key / "geometry_manifest.json")
    tiles = manifest["tiles"]
    seen = set()
    west = north = None
    for file in dict.fromkeys([tiles[0], tiles[-1]]):
        for cell in read(web / file)["features"]:
            parts = cell["properties"]["cell_id"].split("_")
            r, c = map(int, parts)
            geom = admin.project(footprint(cell), 4326, crs)
            if abs(geom.area - 250_000) > .1:
                continue
            w, _, _, n = (round(v) for v in geom.bounds)
            observed = (w - c * 500, n + r * 500)
            seen.add(observed)
            west, north = observed
            break
    if len(seen) != 1 or not (west <= projected.bounds[0] < west + 500 and north - 500 < projected.bounds[3] <= north):
        raise ValueError(f"{key} has an inconsistent 500 m display grid")
    dims = int(rows.max()) + 1, int(cols.max()) + 1
    keys = [r[2] for r in positions]
    if len(keys) != manifest["feature_count"] or len(set(keys)) != len(keys):
        raise ValueError(f"{key} contains invalid display cell IDs")
    return geo, mask, dims, from_origin(west, north, 500, 500), rows, cols, keys


def vector_layer(web, info, index, key, rel, context="", crs=None, center=None):
    label, unit, limits, colors = labels[key]
    _, mask, dims, transform, rows, cols, keys = index
    src = read(web / info["vector_values"])["values"]
    values = np.full(dims, np.nan, dtype="float32")
    values[rows, cols] = np.asarray([src.get(identifier) for identifier in keys], dtype="float32")
    if np.count_nonzero(np.isfinite(values)) != info["display_nonnull_cells"]:
        raise ValueError(f"{rel} display counts do not match the data package")
    rendered, bounds = admin.display_grid(values, transform, crs, mask, center, 500)
    classes = admin.COVER if key == "landcover" else None
    source = static_source.get(key, f"USGS Landsat Collection 2 L2 · {context}")
    return {"id": key, **admin.asset(rel, rendered, bounds, mask, label, source + " · 500 m display",
                                    limits, unit, colors, 500, classes), "native": info["native"]}


def package_weather(web, info, name):
    if not info or (info.get("status") not in ("ready", None)) or "geometry" not in info:
        return None
    features = read(web / info["geometry"])["features"]
    cells = [{"geometry": feature["geometry"], "population": feature["properties"]["population_2020"]} for feature in features]
    indices = {f["properties"]["cell_id"]: i for i, f in enumerate(features)}
    days, sums = {}, {}
    for row in read(web / info["cell_values"]):
        i = indices.get(row["cell_id"])
        if row["valid_hours"] != 24:
            continue
        day = row["date"]
        values = [row["tmax_c"], row["tmin_c"], row["tmean_c"]]
        if i is not None:
            days.setdefault(day, [None] * len(cells))[i] = values
        if all(v is not None for v in values):
            w = row["population_2020"]
            tally = sums.setdefault(day, [0, 0, 0])
            tally[0] += w
            tally[1] += w * values[1]
            tally[2] += w * values[2]
    daily = []
    for row in read(web / info["daily"]):
        day = row["date"]
        weight, lo, mean = sums.get(day, [0, 0, 0])
        daily.append({"date": day, "values": [row["population_weighted_tmax_c"], lo / weight if weight else None, mean / weight if weight else None],
                      "population": row["boundary_population_2020"], "matched": row["matched_population_2020"],
                      "match": row["population_match_rate"], "validCells": row["valid_cells"], "totalCells": row["total_cells"]})
    return {"model": name, "source": info["source"], "resolution": "0.1°" if name == "land" else "0.25°",
            "scope": info["scope"], "cells": cells, "days": days, "daily": daily}


def package_stations(web, event, existing, geo):
    from shapely.geometry import Point
    paths = event.get("stations")
    if isinstance(paths, str):
        paths = {"inside": paths, "reference": event.get("stations_reference")}
    labels_by_id = {s["id"]: s["name"].removesuffix(" (reference)") for s in existing}
    result = {}
    for path in (paths or {}).get("inside"), (paths or {}).get("reference"):
        if not path:
            continue
        payload = read(web / path)
        labels_by_id.update({s["id"]: s["name"] for s in payload.get("metadata", {}).get("stations", [])})
        for row in payload["observations"]:
            if not row["screen_pass"] or row["air_temperature_c"] is None:
                continue
            longitude, latitude = row["longitude"], row["latitude"]
            if longitude is None or latitude is None or (not longitude and not latitude):
                continue
            key = row["station_id"]
            if key not in result:
                reference = not geo.covers(Point(longitude, latitude))
                name = labels_by_id.get(key, "NOAA " + key)
                result[key] = {"id": key, "name": name + (" (reference)" if reference else ""), "reference": reference,
                               "coordinates": [longitude, latitude],
                               "url": f"https://www.ncei.noaa.gov/data/global-hourly/access/{event['peak_date'][:4]}/{key}.csv",
                               "rows": {}}
            t = row["time_utc"].removesuffix("Z") + "Z"
            if len(t) == 20:
                t = t[:-1] + ".000Z"
            result[key]["rows"].setdefault(t, [t, row["air_temperature_c"], row["original_temperature_qc"]])
    ordered = sorted(result.values(), key=lambda item: (item["reference"], item["name"]))
    return [{**item, "rows": sorted(item["rows"].values())} for item in ordered]


def population_points(args, item, geo):
    city = item["id"]
    file = args.processed and args.processed / city / "static" / "population_count_100m.clipped.tif"
    if file and file.is_file():
        with rasterio.open(file) as src:
            values = src.read(1, masked=True).filled(0)
            polygon = admin.project(geo, 4326, src.crs)
            mask = geometry_mask([polygon], values.shape, src.transform, invert=True)
            r, c = np.where(mask & np.isfinite(values) & (values > 0))
            lon, lat = Transformer.from_crs(src.crs, 4326, always_xy=True).transform(*xy(src.transform, r, c))
            points = np.column_stack([lon, lat, values[r, c]])
    elif args.ghs:
        # All tiles needed by this delivery were checked against the global GHSL tile index.
        by_city = {
            "Paris": ["R4_C19"], "Lille": ["R4_C19"], "Brussels_Uccle": ["R4_C19"],
            "Amsterdam": ["R3_C19"], "Utrecht": ["R3_C19"], "Seattle": ["R4_C9"], "Portland": ["R4_C9"],
        }
        points = admin.population(args.ghs, city, geo, by_city)
    else:
        return None
    actual, expected = points[:, 2].sum(), item["population_2020"]
    if not np.isclose(actual, expected, rtol=.00005):
        raise ValueError(f"{city} GHS population {actual:.2f} differs from the package {expected:.2f}")
    return points


def sample(values, affine, crs, points):
    x, y = Transformer.from_crs(4326, crs, always_xy=True).transform(points[:, 0], points[:, 1])
    rr, cc = rowcol(affine, x, y)
    valid = (rr >= 0) & (rr < values.shape[0]) & (cc >= 0) & (cc < values.shape[1])
    temperatures = np.full(len(points), np.nan, dtype="float32")
    temperatures[valid] = values[rr[valid], cc[valid]]
    return temperatures


def mosaic(scenes, scene_ids, geo, crs):
    folders = [scenes / scene for scene in scene_ids] if scenes else []
    if not folders or not all((folder / "scene.json").is_file() for folder in folders):
        return None
    meta = [read(folder / "scene.json") for folder in folders]
    projected = admin.project(geo, 4326, crs)
    dims, _, affine = admin.grid(projected.bounds, 100)
    cover = geometry_mask([projected], dims, affine, invert=True)
    result = np.full(dims, np.nan, dtype="float32")
    for i in sorted(range(len(folders)), key=lambda i: meta[i]["cloud_cover"] if meta[i]["cloud_cover"] is not None else 100):
        with rasterio.open(folders[i] / "st.tif") as st, rasterio.open(folders[i] / "qa.tif") as qa:
            if st.shape != qa.shape or st.transform != qa.transform or st.crs != qa.crs:
                raise ValueError(f"Landsat ST and QA grids differ for {meta[i]['id']}")
            raw = st.read(1)
            valid = (raw > 0) & ((qa.read(1) & 63) == 0)
            temperature = np.where(valid, raw * .00341802 - 124.15, np.nan).astype("float32")
            aligned = np.full(dims, np.nan, dtype="float32")
            reproject(temperature, aligned, src_crs=st.crs, src_transform=st.transform, src_nodata=np.nan,
                      dst_crs=crs, dst_transform=affine, dst_nodata=np.nan, resampling=Resampling.average)
            np.copyto(result, aligned, where=cover & ~np.isfinite(result) & np.isfinite(aligned))
    return result, affine, crs


def native_lst(args, info, scene_ids, geo, crs):
    if args.processed and info.get("native_processed_file"):
        path = args.processed / Path(info["native_processed_file"]).relative_to("processed")
        if path.is_file():
            with rasterio.open(path) as src:
                if src.res != (100, 100):
                    raise ValueError(f"Unexpected analysis resolution for {path.name}")
                return src.read(1, masked=True).filled(np.nan), src.transform, src.crs, "FUA v3 GeoTIFF"
    rebuilt = mosaic(args.scenes, scene_ids, geo, crs)
    return (*rebuilt, "Rebuilt from selected USGS scenes") if rebuilt else None


def pack_snapshot(args, meta, info, scene_ids, geo, crs, points, rel):
    stats = meta["statistics"]
    expected = {"mean": stats["population_weighted_lst_c"], "matched": round(stats["matched_population_2020"]),
                "population": round(stats["boundary_population_2020"]), "match": stats["population_match_rate"],
                "above": None, "histogram": []}
    native = native_lst(args, info, scene_ids, geo, crs) if points is not None and expected["matched"] else None
    if native is None:
        return {"summary": expected, "nativeStatus": "supplied-summary"}, None
    values, affine, source_crs, provenance = native
    temperatures = sample(values, affine, source_crs, points)
    valid = np.isfinite(temperatures)
    packed = np.full(len(points), -32768, dtype="<i2")
    packed[valid] = np.rint(temperatures[valid] * 100)
    summary = admin.metrics(points, np.where(valid, packed.astype("float32") / 100, np.nan))
    # Compare against the independently supplied result before making a rebuild active.
    error = abs((summary["mean"] or 0) - (expected["mean"] or 0))
    difference = abs(summary["match"] - expected["match"])
    if error > .12 or difference > .003:
        print(f"{rel}: native validation differs by {error:.3f} °C and {difference:.4%} coverage", flush=True)
        if provenance == "FUA v3 GeoTIFF":
            raise ValueError(f"{rel}: complete package analysis could not be reproduced")
        return {"summary": expected, "nativeStatus": "supplied-summary"}, None
    return {"summary": summary, "surfacePacked": save_binary(rel + ".bin", packed.tobytes()),
            "nativeStatus": provenance}, native


def clipped_census(city, old, snapshot, native, geo, rel, previous_admin):
    from shapely import intersects_xy
    if not old.get("census", {}).get("file") or native is None:
        return
    old_event = rel.removesuffix("/core").rsplit("/", 1)[1]
    if old_event not in old["events"]:
        return
    points = np.asarray(read(previous_admin / old["population"]))
    census = read(previous_admin / old["census"]["file"])
    included = intersects_xy(geo, points[:, 0], points[:, 1])
    temps = sample(*native[:3], points)
    temps[~included] = np.nan
    census = [row for row in census if included[row[0]]]
    people = sum(row[1] for row in census)
    matched = sum(row[1] for row in census if np.isfinite(temps[row[0]]))
    if not people or not matched:
        return
    city["census"] = {**old["census"], "area": old["adminName"], "population": old["population"]}
    city["census"]["method"] = f"Local census coverage only · {old['adminName']} within {city['name']} study boundary. " + old["census"]["method"]
    file = admin.save(f"{rel}/census.bin", census, True)
    surface = admin.save(f"{rel}/census-surface.bin", [round(float(t), 2) if np.isfinite(t) else None for t in temps], True)
    snapshot["census"] = {"file": file, "surface": surface, "coverage": matched / people}


def build_area(item, in_events, old_city, old_case, args):
    web, key = args.web, item["id"]
    old_id = "DeBilt" if key == "Utrecht" else key
    name = "Utrecht" if key == "Utrecht" else "Brussels" if key == "Brussels_Uccle" else old_city["name"]
    prefix = f"fua/{key}"
    feature = source_boundary(web, item)
    geo = footprint(feature)
    source = feature["properties"]
    boundary = admin.save(prefix + "/boundary.json", feature)
    center = [5.1214, 52.0907] if key == "Utrecht" else old_city["center"]
    if key == "London":
        city = {**old_city, "boundary": boundary, "events": dict(old_city["events"]), "scope": "administrative_polygon"}
    else:
        crs = read(web / in_events[0]["url"])["layers"]["lst_c"]["native"]["crs"]
        index = geometry_grid(web, key, feature, crs)
        vector = lambda k, info, rel, context="": vector_layer(web, info, index, k, rel, context, crs, center)
        cover = vector("landcover", item["static"]["landcover"], prefix + "/landcover-500")
        base = {k: vector(k, info, f"{prefix}/{k}") for k, info in item["static"].items() if k != "landcover"}
        points = population_points(args, item, geo)
        population = None
        if points is not None:
            coordinates = np.rint(points[:, :2].T * 1e7).astype("<i4")
            weights = points[:, 2].astype("<f4")
            population = save_binary(prefix + "/population.bin", coordinates.tobytes() + weights.tobytes())
        city = {"name": name, "adminName": item["name"], "center": center, "bbox": list(geo.bounds), "boundary": boundary,
                "scope": item["scope"], "areaKm2": item["area_km2"],
                "provenance": {"source": source["source"], "url": source.get("source_url"), "code": source.get("URAU_CODE", source.get("fuacode"))},
                "populationCount": round(item["population_2020"]), "populationPacked": population,
                "cover": {"500": cover, "100": cover}, "layers": base, "events": {}}
    archive = {"id": key, "name": name, "bbox": city["bbox"], "population": city["populationCount"], "cases": []}
    old_records = {r["id"]: r for r in old_case["cases"]}
    old_cases = args.previous_data / "cases"
    for entry in in_events:
        event = read(web / entry["url"])
        identifier = event["event"]
        old_record = old_records.get(identifier)
        old_data = read(old_cases / old_record["file"]) if old_record else {"stations": [], "point": None}
        path = prefix + "/" + identifier
        model = package_weather(web, event["weather"], "land")
        alternative = package_weather(web, event["era5_alternative"], "era5")
        if key == "London":
            saved = city["events"][identifier]
            layers = [{"id": layer["id"]} for layer in old_data["layers"]]
            sat = old_data["satellite"]
        else:
            sat = event["landsat"]
            scenes = sat.get("scenes", [])
            times = [scene["datetime"] for scene in scenes]
            date = sat.get("date")
            main_time = min(times) if times else None
            core = sat.get("core_period_layer") or {}
            layers = []
            for k, info in event["layers"].items():
                display_date = core.get("date") if k == "lst_core_c" else date
                if k == "lst_core_c" and (display_date == date or info["display_nonnull_cells"] == 0):
                    continue
                layers.append(vector(k, info, f"{path}/{k}", display_date or "no valid overpass"))
            saved = {"layers": {layer["id"]: layer for layer in layers if layer["id"] != "lst_c"}}
            if main_time and sat.get("statistics"):
                scene_ids = [scene["id"] for scene in scenes]
                packed, native = pack_snapshot(args, sat, event["layers"]["lst_c"], scene_ids, geo, crs, points, f"{path}/surface")
                main = {"layer": next(layer for layer in layers if layer["id"] == "lst_c"), "datetime": main_time,
                        "timeEnd": max(times), "times": times, "scene": ", ".join(scene_ids), "inCore": sat["selection"]["in_core"],
                        "method": sat["statistics"].get("method"), **packed}
                saved["snapshot"] = main
                clipped_census(city, old_city, main, native, geo, path, args.previous_data / "admin")
                print(f"{key}/{identifier}: {main['nativeStatus']}, {main['summary']['match']:.1%} matched", flush=True)
            if "lst_core_c" in saved["layers"] and core.get("statistics", {}).get("matched_population_2020", 0) > 0:
                packed, native = pack_snapshot(args, core, event["layers"]["lst_core_c"], core["scene_ids"], geo, crs, points, f"{path}/core-surface")
                core_times = []
                if args.scenes:
                    core_times = [read(args.scenes / scene / "scene.json")["time"] for scene in core["scene_ids"]
                                  if (args.scenes / scene / "scene.json").is_file()]
                snapshot = {"layer": saved["layers"]["lst_core_c"], "datetime": min(core_times) if core_times else core["date"],
                            "timeEnd": max(core_times) if core_times else None, "times": core_times, "scene": ", ".join(core["scene_ids"]),
                            "inCore": True, **packed}
                saved["coreSnapshot"] = snapshot
                clipped_census(city, old_city, snapshot, native, geo, path + "/core", args.previous_data / "admin")
        saved.update(core=[event["core_start"], event["core_end"]], window=[event["start"], event["end"]],
                     peak=event["peak_date"], pointOnly=False,
                     weather={k: {x: v for x, v in w.items() if x not in ("cells", "days")} for k, w in (("land", model), ("era5", alternative)) if w})
        city["events"][identifier] = saved
        bundle = {"region": key, "event": identifier, "cityName": name, "bbox": city["bbox"], "start": event["start"],
                  "end": event["end"], "peak": event["peak_date"], "core": saved["core"], "scope": city["scope"],
                  "layers": layers if key == "London" else [], "satellite": sat, "population": city["populationCount"],
                  "snapshotTimes": {k: entry.get("times") or [entry["datetime"]]
                                    for k, entry in (("lst_c", saved.get("snapshot")), ("lst_core_c", saved.get("coreSnapshot"))) if entry},
                  "stations": package_stations(web, event, old_data["stations"], geo), "point": old_data["point"],
                  "weather": model, "alternative": alternative}
        save_case(path + "/case.bin", bundle)
        archive["cases"].append({"id": identifier, "file": path + "/case.bin", "label": old_record["label"], "peak": bundle["peak"], "pointOnly": False})
    for identifier, record in old_records.items():
        if not record["pointOnly"]:
            continue
        data = read(old_cases / record["file"])
        data.update(region=key, cityName=name, bbox=city["bbox"])
        path = f"{prefix}/{identifier}/case.bin"
        save_case(path, data)
        archive["cases"].append({**record, "file": path})
        city["events"][identifier] = old_city["events"][identifier]
    archive["cases"].sort(key=lambda case: case["peak"], reverse=True)
    return key, old_id, city, archive, geo


def bind_model(model, key, city, geometry):
    if key == "London":
        return model
    outline = shape(model["geometry"])
    clipped = admin.polygonal(outline.intersection(geometry))
    if clipped.is_empty:
        return None
    if model["scope"] == "city":
        label = "De Bilt municipality within Utrecht FUA" if key == "Utrecht" else "Amsterdam municipality within Amsterdam FUA"
        model = {**model, "scope": "subregion", "label": label}
    else:
        model = {**model, "label": model["label"] + " · " + city["name"] + " FUA"}
    model["boundaryClipped"] = not geometry.covers(outline)
    model.update(city=key, geometry=mapping(clipped), bounds=list(clipped.bounds))
    return model


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--web", required=True, type=Path)
    parser.add_argument("--processed", type=Path)
    parser.add_argument("--scenes", type=Path)
    parser.add_argument("--ghs", type=Path)
    parser.add_argument("--baseline", required=True, type=Path, help="Directory containing the previous admin.json and cases.json catalogues")
    parser.add_argument("--previous-data", type=Path, default=admin.DATA, help="v14 dist/client/data directory")
    args = parser.parse_args()
    supplied = read(args.web / "catalog.json")
    published = read(args.baseline / "admin.json")
    original = read(args.baseline / "cases.json")
    originals = {c["id"]: c for c in original["cities"]}
    if len(supplied["cities"]) != 8 or len(supplied["events"]) != 32:
        raise ValueError("Expected eight areas and 32 cases from the 1114 FUA v3 data package")
    tasks = []
    for item in supplied["cities"]:
        key = item["id"]
        old_id = "DeBilt" if key == "Utrecht" else key
        tasks.append((item, [e for e in supplied["events"] if e["city"] == key], published["cities"][old_id], originals[old_id], args))
    with ThreadPoolExecutor(3) as executor:
        built = list(executor.map(lambda t: build_area(*t), tasks))
    output = {**published, "cities": {key: city for key, _, city, _, _ in built}, "boundaryVersion": "Heatline FUA v3 · 1114"}
    for name in ("streetModels", "cityStreetModels"):
        output[name] = {}
        for key, old_id, city, _, geo in built:
            models = {event: bind_model(model, key, city, geo) for event, model in published[name].get(old_id, {}).items()}
            output[name][key] = {event: model for event, model in models.items() if model}
    admin.save("catalog.json", output)
    save_binary("catalog.bin", (admin.OUT / "catalog.json").read_bytes())
    save_case("catalog.json", {**original, "cities": [archive for _, _, _, archive, _ in built], "boundaryVersion": output["boundaryVersion"]})
    print("Published boundaries, weather and model index for eight areas and 32 boundary-backed events.", flush=True)


if __name__ == "__main__":
    main()
