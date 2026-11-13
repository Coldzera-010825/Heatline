"""Prepare event LST samples for official small-area population counts.

Pass the staged census GeoJSON directory, the prepared Landsat source directory
and the existing London OA population bundle. Geometry and population counts
must be from compatible statistical geography. All output is aggregate.
"""
import argparse
import gzip
import json
from pathlib import Path

import numpy as np
from pyproj import Transformer
import rasterio
from rasterio.features import geometry_mask
from rasterio.transform import rowcol
from shapely import STRtree, covers, get_coordinates, make_valid, points, transform
from shapely.geometry import shape

DATA = Path(__file__).parent / "dist/client/data/admin"


def load(path):
    return json.loads(path.read_bytes())


def save(path, data):
    payload = json.dumps(data, separators=(",", ":"), ensure_ascii=False, allow_nan=False).encode()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(gzip.compress(payload, mtime=0) if path.suffix == ".bin" else payload + b"\n")


def change_crs(geometry, source, target):
    converter = Transformer.from_crs(source, target, always_xy=True)
    return transform(geometry, converter.transform, interleaved=False)


def landsat(path):
    with rasterio.open(path / "st.tif") as st, rasterio.open(path / "qa.tif") as qa:
        if st.shape != qa.shape or st.transform != qa.transform or st.crs != qa.crs:
            raise ValueError("Mismatched Landsat temperature and quality grids")
        values = st.read(1)
        values = np.where((values > 0) & ((qa.read(1) & 63) == 0), values * .00341802 - 124.15, np.nan)
        return values, st.transform, st.crs


def sample(values, affine, xy, radius=0):
    rr, cc = [np.asarray(v) for v in rowcol(affine, xy[:, 0], xy[:, 1])]
    sums, counts = np.zeros(len(xy)), np.zeros(len(xy))
    for dy in range(-radius, radius + 1):
        for dx in range(-radius, radius + 1):
            r, c = rr + dy, cc + dx
            inside = (r >= 0) & (c >= 0) & (r < values.shape[0]) & (c < values.shape[1])
            indices = np.flatnonzero(inside)
            data = values[r[indices], c[indices]]
            valid = np.isfinite(data)
            sums[indices[valid]] += data[valid]
            counts[indices[valid]] += 1
    return np.divide(sums, counts, out=np.full(len(xy), np.nan), where=counts > 0)


def london(catalog, args):
    rows = json.loads(gzip.decompress(args.london.read_bytes()))
    lon_lat = np.asarray([row[:2] for row in rows])
    city = catalog["cities"]["London"]
    city["census"] = {
        "year": 2021, "unit": "Output Areas", "source": "ONS Census 2021 TS007A and TS038; English IMD 2025",
        "sourceUrl": "https://www.nomisweb.co.uk/sources/census_2021",
        "groups": {"all": "All usual residents", "older": "Residents aged 65+",
                   "limited": "Residents with limited day-to-day activities",
                   "deprived": "Residents in IMD deciles 1–2", "leastDeprived": "Residents in IMD deciles 9–10"},
        "rank": True,
        "method": "Fixed 2021 Census population and retrospective IMD 2025. Each Output Area is assigned its 5 × 5 clear Landsat mean around the geometric centroid.",
    }
    for event, case in city["events"].items():
        snapshot = case.get("snapshot")
        if not snapshot:
            continue
        if event == "E3_2022-07":
            snapshot["census"] = {"coverage": sum(row[3] for row in rows if row[2] is not None) / sum(row[3] for row in rows)}
            continue
        values, affine, crs = landsat(args.satellite / ("London__" + event))
        xy = change_crs(points(lon_lat), 4326, crs)
        temperatures = sample(values, affine, get_coordinates(xy), 2)
        joined = [[row[0], row[1], round(float(t), 3) if np.isfinite(t) else None, *row[3:]]
                  for row, t in zip(rows, temperatures)]
        coverage = sum(row[3] for row in joined if row[2] is not None) / sum(row[3] for row in rows)
        file = f"London/{event}/census.bin"
        save(DATA / file, joined)
        snapshot["census"] = {"file": file, "coverage": round(coverage, 6)}
        print("London", event, round(100 * coverage, 1), flush=True)


def dutch(city, file):
    data = load(file)
    districts_file = file.with_name(file.stem + "-districts.geojson")
    district_names = {}
    if districts_file.is_file():
        district_names = {f["properties"]["wijkcode"]: f["properties"]["wijknaam"] for f in load(districts_file)["features"]}
    code = "GM0363" if city == "Amsterdam" else "GM0310"
    features = []
    for f in data["features"]:
        p = f["properties"]
        count, older = p["aantalInwoners"], p["percentagePersonen65JaarEnOuder"]
        if p["gemeentecode"] != code or count is None or older is None or count <= 0 or not 0 <= older <= 100:
            continue
        properties = {"id": p["buurtcode"], "all": count, "older": round(count * older / 100, 3),
                      "districtId": p["wijkcode"], "districtName": district_names.get(p["wijkcode"])}
        features.append({**f, "properties": properties})
    return {
        "features": features,
        "metadata": {
            "year": 2022, "unit": "CBS neighbourhoods", "source": "CBS Wijken en Buurten 2022 via PDOK",
            "sourceUrl": "https://www.cbs.nl/nl-nl/cijfers/detail/85318NED",
            "note": "65+ counts are estimated from CBS rounded neighbourhood percentages and population totals.",
        },
    }


def city_population(region, city, data, args, tiles):
    source = data["metadata"]
    metric = "ESRI:54009"
    boundary = make_valid(shape(load(DATA / city["boundary"])["geometry"]))
    polygons = np.asarray([make_valid(shape(f["geometry"])) for f in data["features"]])
    geometries = change_crs(polygons, 4326, metric)
    properties = [f["properties"] for f in data["features"]]
    city_outline = change_crs(boundary, 4326, metric)
    overlaps = STRtree(geometries)
    inside_points = json.loads(gzip.decompress((DATA / city["population"]).read_bytes()))
    locations = np.asarray(inside_points)
    inside = change_crs(points(locations[:, :2]), 4326, metric)
    point_index, area_index = overlaps.query(inside, predicate="within")
    if not len(point_index):
        raise ValueError(f"No GHS-POP cells matched the census geography for {region}")

    # Determine the fraction of each boundary-crossing statistical unit's
    # residential distribution inside the city using the same GHS-POP raster.
    represented = np.bincount(area_index, weights=locations[point_index, 2], minlength=len(polygons))
    denominator = represented.copy()
    crossing = ~covers(city_outline, geometries)
    for i in np.flatnonzero(crossing & (represented > 0)):
        total = 0.
        geom = geometries[i]
        for tile in tiles:
            with rasterio.open(tile) as ds:
                window = rasterio.windows.from_bounds(*geom.bounds, ds.transform).round_offsets().round_lengths()
                full = rasterio.windows.Window(0, 0, ds.width, ds.height)
                try:
                    window = window.intersection(full)
                except rasterio.errors.WindowError:
                    continue
                if window.width < 1 or window.height < 1:
                    continue
                a = ds.read(1, window=window, masked=True).filled(0)
                mask = geometry_mask([geom], a.shape, ds.window_transform(window), invert=True)
                total += float(np.sum(a[mask & np.isfinite(a) & (a > 0)]))
        denominator[i] = max(represented[i], total)

    groups = {"all": "All residents", "older": "Residents aged 65+"}
    for key, label in (("limited", "Civilian noninstitutionalized residents with a disability"),
                       ("poverty", "Residents below the U.S. poverty threshold")):
        if any(p.get(key) is not None for p in properties):
            groups[key] = label
    city["census"] = {
        "year": source["year"], "unit": source["unit"], "source": source["source"], "sourceUrl": source["sourceUrl"],
        "groups": groups, "method": ("Distribute small-area counts over native 100 m GHS-POP 2020 residential cells by population weight, "
                                     "using only their in-boundary portion. This assumes the same within-unit distribution for each group. " +
                                     source.get("note", "")),
    }
    # Add separate group weights where boundaries cut statistical units. Keep
    # each small-area total consistent with its allocated residential weights.
    keys = [*groups, *(key + "Universe" for key in ("limited", "poverty") if key in groups)]
    weights = np.zeros((len(locations), len(keys)), dtype=np.float64)
    known = np.zeros_like(weights, dtype=bool)
    ratios = locations[point_index, 2] / denominator[area_index]
    for j, key in enumerate(keys):
        counts = np.asarray([p.get(key, np.nan) for p in properties], dtype=float)[area_index]
        keep = np.isfinite(counts)
        np.add.at(weights[:, j], point_index[keep], counts[keep] * ratios[keep])
        known[point_index[keep], j] = True
    active = np.flatnonzero((weights[:, 0] > 0) & known[:, 0])
    district_by_id = {p["districtId"]: p.get("districtName") or p["districtId"] for p in properties if p.get("districtId")}
    rankings = len(district_by_id) > 1
    districts = np.full(len(locations), "", dtype=object)
    if rankings:
        districts[point_index] = [properties[i].get("districtId", "") for i in area_index]
        city["census"]["districts"] = district_by_id
        keys.append("district")
    joined = [[int(i), *[round(float(v), 6) if m else None for v, m in zip(weights[i], known[i])],
               *([districts[i] or None] if rankings else [])] for i in active]
    city["census"]["file"] = f"{region}/census.bin"
    city["census"]["keys"] = keys
    city["census"]["unallocated"] = round(sum(p["all"] for i, p in enumerate(properties) if not crossing[i] and represented[i] == 0))
    save(DATA / city["census"]["file"], joined)
    for case in city["events"].values():
        snap = case.get("snapshot")
        if not snap:
            continue
        temperatures = json.loads(gzip.decompress((DATA / snap["surface"]).read_bytes()))
        coverage = sum(weights[i, 0] for i in active if temperatures[i] is not None) / weights[active, 0].sum()
        snap["census"] = {"coverage": round(float(coverage), 6)}
    print(region, len(data["features"]), "units,", len(active), "residential cells,", round(float(weights[active, 0].sum())), "allocated residents", flush=True)


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--census", type=Path, required=True)
    p.add_argument("--satellite", type=Path, required=True)
    p.add_argument("--ghs", type=Path, required=True)
    p.add_argument("--london", type=Path, required=True)
    args = p.parse_args()
    catalog = load(DATA / "catalog.json")
    index = load(args.ghs / "tiles-by-city.json")
    london(catalog, args)
    for region, city in catalog["cities"].items():
        if region == "London":
            continue
        file = args.census / f"{region}.geojson"
        if region in {"Amsterdam", "DeBilt"}:
            data = dutch(region, args.census.parent / f"cbs-{region.lower()}.geojson")
        else:
            data = load(file)
        rasters = [args.ghs / f"GHS_POP_E2020_GLOBE_R2023A_54009_100_V1_0_{tile}.tif" for tile in index[region]]
        city_population(region, city, data, args, rasters)
    save(DATA / "catalog.json", catalog)


if __name__ == "__main__":
    main()
