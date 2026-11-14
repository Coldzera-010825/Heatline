"""Attach national small-area census counts to the FUA 100 m residential cells."""
import argparse
from collections import defaultdict
import csv
import gzip
from io import TextIOWrapper
import json
from pathlib import Path
from zipfile import ZipFile

import numpy as np
import rasterio
from pyproj import Transformer
from rasterio.features import geometry_mask
from rasterio.windows import from_bounds
import shapefile
from shapely import STRtree, covers, make_valid, points, transform
from shapely.geometry import box, shape


DATA = Path(__file__).parent / "dist/client/data/admin"
GROUPS = {"all": "All residents", "older": "Residents aged 65+"}
ACS_GROUPS = {**GROUPS, "limited": "Civilian noninstitutionalized residents with a disability",
              "poverty": "Residents below the U.S. poverty threshold"}
META = {
    "fr": (2022, "INSEE IRIS census age estimates", "https://www.insee.fr/fr/statistiques/8647014", "IRIS",
           "INSEE 2022 census counts joined by IRIS code to the available IGN Contours IRIS geometry."),
    "be": (2021, "Statbel Census 2021 S01", "https://statbel.fgov.be/en/open-data", "Statistical sector",
           "Census counts by age joined to the 1 January 2021 Statbel statistical sectors."),
    "nl": (2022, "CBS Wijken en Buurten 2022", "https://www.cbs.nl/nl-nl/cijfers/detail/85318NED", "CBS neighbourhood",
           "Population aged 65+ is estimated from the rounded share and population reported for each neighbourhood."),
    "us": (2022, "U.S. Census ACS 2018–2022 five-year estimates", "https://www.census.gov/programs-surveys/acs/data.html",
           "Census tract", "2022 TIGER/Line tracts with ACS B01001, B18101 and B17001 estimates. Disability and poverty use separate population universes."),
}


def read(path):
    return json.loads(path.read_bytes())


def from_zip(path, separator):
    with ZipFile(path) as archive:
        name = next(file for file in archive.namelist() if file.lower().endswith((".txt", ".csv")))
        with archive.open(name) as data:
            yield from csv.DictReader(TextIOWrapper(data, encoding="utf-8-sig"), delimiter=separator)


def shapes(path, bbox, crs):
    converter = Transformer.from_crs(4326, crs, always_xy=True)
    bounds = converter.transform_bounds(*bbox)
    with ZipFile(path) as archive:
        name = next(file for file in archive.namelist() if file.endswith(".shp"))
        with archive.open(name) as geo, archive.open(name[:-3] + "dbf") as db, archive.open(name[:-3] + "shx") as index:
            reader = shapefile.Reader(shp=geo, dbf=db, shx=index, encoding="utf-8")
            for row in reader.iterShapeRecords(bbox=bounds):
                yield row.record.as_dict(), shape(row.shape.__geo_interface__), crs


def french(stage, inputs, region):
    features = read(stage / f"fr-{region}.geojson")["features"]
    ids = {f["properties"]["code_iris"] for f in features}
    data = {r["IRIS"]: r for r in from_zip(inputs / "fr-age.zip", ";") if r["IRIS"] in ids}
    for feature in features:
        p = feature["properties"]
        row = data.get(p["code_iris"])
        if row:
            yield shape(feature["geometry"]), 4326, [float(row["P22_POP"]), float(row["P22_POP65P"])], p["code_insee"], p["nom_commune"]


def belgian(inputs, bbox):
    units = list(shapes(inputs / "be-bound.zip", bbox, 31370))
    ids = {p["CS01012021"] for p, _, _ in units}
    counts = defaultdict(lambda: [0, 0])
    for row in from_zip(inputs / "be-age.zip", "|"):
        key = row["CD_SECTOR"]
        if key in ids:
            pop = int(row["MS_POP"])
            counts[key][0] += pop
            if int(row["CD_AGE"].split("-", 1)[0].rstrip("+")) >= 65:
                counts[key][1] += pop
    for p, geo, crs in units:
        if p["CS01012021"] in counts:
            yield geo, crs, counts[p["CS01012021"]], p["CNIS5_2021"], p["T_MUN_FR"]


def dutch(stage, region):
    for feature in read(stage / f"cbs-{region}.geojson")["features"]:
        p = feature["properties"]
        count, older = p["aantalInwoners"], p["percentagePersonen65JaarEnOuder"]
        if count is not None and count > 0 and older is not None and 0 <= older <= 100:
            yield shape(feature["geometry"]), 4326, [count, count * older / 100], p["gemeentecode"], p["gemeentenaam"]


def acs(inputs, file, table, columns, ids):
    with (inputs / file).open(encoding="utf-8") as source:
        header = next(source).strip().split("|")
        cols = [header.index(f"{table}_E{i:03}") for i in columns]
        data = {}
        for line in source:
            if line.startswith("1400000US") and line.split("|", 1)[0][9:] in ids:
                r = line.rstrip("\n").split("|")
                values = [int(r[i]) if r[i] and int(r[i]) >= 0 else None for i in cols]
                if None not in values:
                    data[r[0][9:]] = values
        return data


def american(stage, inputs, bbox):
    units = [row for state in ("41", "53") for row in shapes(stage / f"tract-{state}.zip", bbox, 4269)]
    ids = {p["GEOID"] for p, _, _ in units}
    age = acs(inputs, "us-age.dat", "B01001", [1, *range(20, 26), *range(44, 50)], ids)
    disability = acs(inputs, "us-limited.dat", "B18101", [1, 4, 7, 10, 13, 16, 19, 23, 26, 29, 32, 35, 38], ids)
    poverty = acs(inputs, "us-poverty.dat", "B17001", [1, 2], ids)
    for p, geo, crs in units:
        key = p["GEOID"]
        if key in age:
            d, l = disability.get(key), poverty.get(key)
            yield geo, crs, [age[key][0], sum(age[key][1:]), sum(d[1:]) if d else np.nan,
                             l[1] if l else np.nan, d[0] if d else np.nan, l[0] if l else np.nan], None, None


def project(geo, source):
    # GHS-POP grids use Mollweide, with metric 100 m source cells.
    converter = Transformer.from_crs(source, "ESRI:54009", always_xy=True)
    return transform(geo, converter.transform, interleaved=False)


def tile_population(geo, sources):
    result = 0.
    for source in sources:
        window = from_bounds(*geo.bounds, source.transform).round_offsets().round_lengths()
        try:
            window = window.intersection(rasterio.windows.Window(0, 0, source.width, source.height))
        except rasterio.errors.WindowError:
            continue
        values = source.read(1, window=window, masked=True).filled(0)
        inside = geometry_mask([geo], values.shape, source.window_transform(window), invert=True)
        result += float(values[inside & np.isfinite(values) & (values > 0)].sum(dtype="float64"))
    return result


def build(region, city, kind, units, sources):
    wgs = shape(read(DATA / city["boundary"])["geometry"])
    outline = project(wgs, 4326)
    group_labels = ACS_GROUPS if kind == "us" else GROUPS
    keys = list(group_labels) + (["limitedUniverse", "povertyUniverse"] if kind == "us" else [])
    features, values, codes, districts = [], [], [], {}
    converters = {}
    for geo, crs, counts, code, name in units:
        if not geo.is_valid:
            geo = make_valid(geo)
        if crs not in converters:
            converters[crs] = Transformer.from_crs(crs, "ESRI:54009", always_xy=True)
        geom = transform(geo, converters[crs].transform, interleaved=False)
        if not outline.intersects(geom) or counts[0] <= 0:
            continue
        if geom.intersection(outline).area < 1:
            continue
        features.append(geom)
        values.append(counts)
        codes.append(code)
        if code:
            districts[code] = name
    coords = gzip.decompress((DATA / city["populationPacked"]).read_bytes())
    size = len(coords) // 12
    lon, lat = np.frombuffer(coords, dtype="<i4", count=2 * size).reshape(2, -1) / 1e7
    pop = np.frombuffer(coords, dtype="<f4", count=size, offset=8 * size).astype("float64")
    xy = Transformer.from_crs(4326, "ESRI:54009", always_xy=True).transform(lon, lat)
    tree = STRtree(features)
    idx, area = tree.query(points(*xy), predicate="within")
    if np.any(np.bincount(idx, minlength=size) > 1):
        # Some source features overlap at invalid or redrawn borders. Assign each center once.
        order = np.lexsort((area, idx))
        keep = np.r_[True, np.diff(idx[order]) != 0]
        idx, area = idx[order][keep], area[order][keep]
    represented = np.bincount(area, weights=pop[idx], minlength=len(features))
    denominator = represented.copy()
    crossing = ~covers(outline, features)
    for i in np.flatnonzero(crossing & (represented > 0)):
        denominator[i] = max(represented[i], tile_population(features[i], sources))
    units_data = np.asarray(values, dtype="<f4")
    units_data = np.column_stack([units_data, denominator.astype("<f4")])
    mask = np.full(size, 65535, dtype="<u2")
    if len(features) >= 65535:
        raise ValueError(region + " exceeds the census lookup capacity")
    mask[idx] = area
    coverage = pop[idx].sum() / pop.sum()
    if coverage < .85:
        raise ValueError(f"{region} joins only {coverage:.1%} of GHS-POP to census areas")
    year, provider, url, unit, note = META[kind]
    file = f"fua/{region}/census-index.bin"
    (DATA / file).write_bytes(gzip.compress(mask.tobytes() + units_data.astype("<f4").tobytes(), compresslevel=6, mtime=0))
    city["metroCensus"] = {"file": file, "keys": keys, "groups": group_labels,
                           "year": year, "source": provider, "sourceUrl": url, "unit": unit,
                           "districts": districts, "codes": codes if districts else [], "coverage": round(float(coverage), 6),
                           "method": note + " Allocate each source unit's population over 100 m GHS-POP residential cells. " +
                           "For units crossing the study boundary, include only the estimated portion inside. " +
                           f"{coverage:.1%} of GHS-POP resident weight is joined to a populated census unit."}
    print(region, len(features), "units", len(idx), "GHS cells", f"{coverage:.2%} GHS match", flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--geometry", type=Path, required=True)
    parser.add_argument("--counts", type=Path, required=True)
    parser.add_argument("--ghs", type=Path, required=True)
    parser.add_argument("--area", action="append", help="Rebuild only this city. May be repeated.")
    args = parser.parse_args()
    path = DATA / "catalog.json"
    catalog = read(path)
    skipped = []
    for region, city in catalog["cities"].items():
        if region == "London" or args.area and region not in args.area:
            continue
        if region in {"Paris", "Lille"}:
            kind, units = "fr", french(args.geometry, args.counts, region)
        elif region == "Brussels_Uccle":
            kind, units = "be", belgian(args.counts, city["bbox"])
        elif region in {"Amsterdam", "Utrecht"}:
            kind, units = "nl", dutch(args.geometry, region)
        else:
            kind, units = "us", american(args.geometry, args.counts, city["bbox"])
        tiles = [rasterio.open(tile) for tile in args.ghs.glob("GHS_POP_E2020_*_100_V1_0_*.tif")]
        try:
            build(region, city, kind, units, tiles)
        except (ValueError, FileNotFoundError) as error:
            print(f"{region} missing metropolitan census: {error}", flush=True)
            skipped.append(region)
        finally:
            for tile in tiles:
                tile.close()
    path.write_text(json.dumps(catalog, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf8")
    if skipped:
        raise SystemExit(f"Metropolitan census incomplete for {', '.join(skipped)}. Municipality coverage is retained where available.")


if __name__ == "__main__":
    main()
