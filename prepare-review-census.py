"""Join the existing walking-cell centres to aggregate census geographies."""
import argparse
import csv
import gzip
import importlib.util
import io
import json
from pathlib import Path
import re
from zipfile import ZipFile

import numpy as np
from shapely import STRtree, make_valid, points
from shapely.geometry import shape

spec = importlib.util.spec_from_file_location("census_data", Path(__file__).with_name("prepare-census-data.py"))
census_data = importlib.util.module_from_spec(spec)
spec.loader.exec_module(census_data)
DATA, load, save = census_data.DATA, census_data.load, census_data.save

GROUPS = ("older", "children", "limited")
COORDINATE_SCALE = 10_000_000


def london_counts(centroids, age_archive):
    records = {f["properties"]["OA21CD"]: f["properties"] for f in load(centroids)["features"]}
    with ZipFile(age_archive) as archive, io.TextIOWrapper(archive.open("census2021-ts007a-oa.csv"), encoding="utf-8-sig") as stream:
        table = csv.DictReader(stream)
        child_bands = [h for h in table.fieldnames if re.search(r"Aged (4|5|10)\b", h)]
        older_bands = [h for h in table.fieldnames if re.search(r"Aged (65|70|75|80|85)\b", h)]
        if len(child_bands) != 3 or len(older_bands) != 5:
            raise ValueError("The age table must contain the standard 0–14 and 65+ bands")
        result = {}
        for row in table:
            code = row["geography code"]
            census = records.get(code)
            if census is None:
                continue
            all_residents = int(row["Age: Total"])
            if all_residents != census["pop_all"]:
                raise ValueError(f"Population totals for {code} do not match the London census inputs")
            result[code] = {
                "all": all_residents,
                "older": sum(int(row[h]) for h in older_bands),
                "children": sum(int(row[h]) for h in child_bands),
                "limited": census["pop_disabled"],
            }
    if result.keys() != records.keys():
        raise ValueError("The age table is missing London Output Areas")
    return result


def csv_counts(path):
    with path.open(encoding="utf-8-sig", newline="") as stream:
        return {row["id"]: {k: float(row[k]) if row.get(k) else None for k in ("all", *GROUPS)}
                for row in csv.DictReader(stream)}


def read_model(path):
    return json.loads(gzip.decompress((DATA / path).read_bytes()))


def walking_cells(catalog, city):
    models = {**catalog.get("streetModels", {}).get(city, {}), **catalog.get("cityStreetModels", {}).get(city, {})}
    tiles = {shard["file"] for model in models.values() for shard in model.get("shards", [])}
    centres = set()
    for path in sorted(tiles):
        for tile in read_model(path):
            centres.update(tuple(row[:2]) for row in tile["rows"])
    for model in models.values():
        if "file" in model and "shards" not in model:
            centres.update(tuple(row[:2]) for row in read_model(model["file"])["rows"])
    return np.unique(np.rint(np.asarray(sorted(centres)) * COORDINATE_SCALE).astype("<i4"), axis=0)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--city", required=True)
    parser.add_argument("--boundaries", type=Path, required=True, help="Census polygons in GeoJSON / EPSG:4326")
    parser.add_argument("--id-field", default="id")
    parser.add_argument("--counts", type=Path, required=True, help="CSV with id, all and any of older, children, limited")
    parser.add_argument("--london-age", type=Path, help="TS007A Nomis ZIP. With this option, --counts is the London OA centroid package.")
    parser.add_argument("--source", required=True)
    parser.add_argument("--year", type=int, required=True)
    parser.add_argument("--unit", required=True)
    args = parser.parse_args()
    catalog = load(DATA / "catalog.json")
    if args.city not in catalog["cities"]:
        parser.error("Use a registered city")
    counts = london_counts(args.counts, args.london_age) if args.london_age else csv_counts(args.counts)
    boundaries = {f["properties"][args.id_field]: f["geometry"] for f in load(args.boundaries)["features"]}
    units = sorted(code for code, row in counts.items() if code in boundaries and row["all"] is not None and row["all"] > 0)
    groups = [key for key in GROUPS if any(counts[code].get(key) is not None for code in units)]
    if not groups:
        parser.error("No census group and boundary match")
    populations = [[code, counts[code]["all"], *(counts[code].get(key) for key in groups)] for code in units]
    if any(value is not None and not 0 <= value <= row[1] for row in populations for value in row[2:]):
        parser.error("Group counts must be between zero and the area total")
    centres = walking_cells(catalog, args.city)
    if not len(centres):
        parser.error("The city needs an existing walking-grid model")
    tree = STRtree([make_valid(shape(boundaries[code])) for code in units])
    cell_indices, census_indices = tree.query(points(centres / COORDINATE_SCALE), predicate="covered_by")
    # On a shared boundary, consistently take the lowest census area code.
    order = np.lexsort((census_indices, cell_indices))
    chosen_cells, first = np.unique(cell_indices[order], return_index=True)
    if not len(chosen_cells):
        parser.error("No walking cell centres intersect the census geography")
    packed = np.column_stack((centres[chosen_cells], census_indices[order[first]])).astype("<i4")

    prefix = f"street-review/{args.city}/census"
    save(DATA / f"{prefix}-areas.bin", populations)
    (DATA / f"{prefix}.bin").write_bytes(gzip.compress(packed.tobytes(), mtime=0))
    catalog["cities"][args.city]["reviewCensus"] = {
        "file": prefix, "groups": groups, "source": args.source, "year": args.year, "unit": args.unit,
    }
    save(DATA / "catalog.json", catalog)
    print(f"{args.city}: {len(chosen_cells):,}/{len(centres):,} walking-cell centres matched, {len(units):,} census areas")


if __name__ == "__main__":
    main()
