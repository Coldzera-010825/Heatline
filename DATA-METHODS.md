The [research methods page](https://heatline-atlas.abrdns.com/methods.html) gives
the provider downloads, study boundaries, equations and links to atlas examples.

Heatline uses the 1114 FUA v3 delivery. Greater London retains its administrative
boundary. Paris, Lille, Brussels, Amsterdam, Utrecht, Seattle and Portland use
functional urban area (FUA) polygons. The European polygons are GISCO Urban
Audit 2021. Seattle and Portland use OECD FUA polygons of unspecified vintage.
De Bilt remains a weather reference for Utrecht. Study boundaries stay fixed
across the archived years. A Greater London to FUA comparison uses different
geographic definitions. Source and feature IDs accompany each outline.

| Layer or analysis | Common method | Coverage |
| --- | --- | --- |
| Event weather | Use each archive's core dates and report UTC days. Weight ERA5-Land by GHS-POP resident counts within the new footprint. Show independent ERA5 coverage where archived and label reference stations outside the footprint. London retains its WOW and NOAA view. | 32 polygon-backed cases. Point-only cases in 2018 and 2026 retain single-point historical context. |
| Land cover and landscape | Display [ESA WorldCover 2021](https://esa-worldcover.org/en/data-access) v200 land classes, GLO-30 surface elevation, population context and dated vegetation and water indices. | The FUA package supplies 500 m display grids. London uses the detailed 100 m land-cover view at street zoom. |
| Residential surface heat | QA-screen [USGS Landsat Collection 2 L2](https://www.usgs.gov/landsat-missions/landsat-collection-2-surface-temperature) ST_B10, average to 100 m in the native FUA analysis CRS, and mosaic the same day. Apply the formula LST °C = DN × 0.00341802 − 124.15. Sample at [GHS-POP R2023A](https://human-settlement.emergency.copernicus.eu/ghs_pop2023.php) 2020 100 m cell centres inside the boundary and any selection. London retains its original GHS-POP pairing to screened native Landsat. | All 32 main snapshots have full-area and drawn-area calculations. The FUA map uses 500 m Landsat display cells. Calculated resident maps display an overview and use 100 m weights for statistics. Some cases have a second valid event-core LST date. Cloud-screened coverage varies. |
| Census groups | For London, assign each Census Output Area the clear-pixel mean of a 5 × 5 Landsat window around its geometric centroid. For the seven FUAs, distribute official small-area census counts over 100 m GHS-POP cells using the same within-unit weights for each group. Count only the inside share for units that cross the boundary. | All eight support 65+ and all residents where the scene has valid matches. London also has activity limitation and IMD. Seattle and Portland have ACS disability and poverty. Regional joins match 87.2%–100% of the GHS-POP weight before Landsat screening. |
| Landsat comparison | Same UTC day inside both event cores, local solar time within 90 minutes, and ≥80% valid population coverage in each study area. Compare means and distributions over the matched residents. | For example, Paris and Amsterdam on 7 August 2020. LST measures surfaces near residential locations; actual personal exposure is not observed. |
| Pedestrian heat | Use terrain, buildings, canopy and hourly temperature, humidity, shortwave and wind to model 5 m mean radiant temperature with [SOLWEIG](https://github.com/UMEP-dev/solweig). At request time, evaluate the [operational UTCI approximation](https://doi.org/10.1007/s00484-011-0454-1) per radiation sample and weight by represented walking length. | Every polygon-backed case has a 100 m pilot. Expanded results cover the documented model footprint. Amsterdam municipality and De Bilt municipality simulations cover subregions of their FUAs. Dense selections show a 500 m overview and 100 m cells when zoomed in. |
| Shade scenario | A cell qualifies when it has at least 20 m each of sun and building shade. Reassign the specified fraction of sunlit route length to its local building-shade UTCI. Report paired-cell coverage and, for expanded runs, the change across all modelled routes in the selection with other routes fixed. | Uses the event timestamp, fixed geometry and simulated radiation of the selected street model. |

Census sources are [ONS Census 2021](https://www.nomisweb.co.uk/sources/census_2021)
with [English IMD 2025](https://www.gov.uk/government/statistics/english-indices-of-deprivation-2025)
for London, [INSEE IRIS 2022](https://www.insee.fr/fr/statistiques/8647014) for Paris and Lille,
[Statbel Census 2021](https://statbel.fgov.be/fr/open-data/census-2021-population-selon-secteur-statistique-du-lieu-de-residence-sexe-et-age-m)
for Brussels, [CBS neighbourhoods 2022](https://www.cbs.nl/nl-nl/cijfers/detail/85318NED)
for Amsterdam and Utrecht, and [U.S. Census ACS 2018–2022](https://www2.census.gov/programs-surveys/acs/summary_file/2022/table-based-SF/data/5YRData/)
tables B01001, B18101 and B17001 for Portland and Seattle. Population weights
are held fixed by city across historical events. CBS age counts are estimates
from rounded percentages. London IMD 2025 is applied retrospectively.

The pilots have a 1.8 km × 1.8 km model domain and a 1.4 km × 1.4 km internal
comparison domain. Data vintages differ: [Environment Agency](https://environment.data.gov.uk/DefraDataDownload/?Mode=survey),
[Dutch AHN4](https://www.ahn.nl/dataroom), [Brussels UrbIS](https://data.gov.be/en/datasets/8c2d921e-6a53-11ed-bfb5-010101010000),
[IGN LiDAR HD](https://www.data.gouv.fr/datasets/nuages-de-points-lidar-hd),
[Lille Métropole 2018](https://www.data.gouv.fr/datasets/mne-modele-numerique-delevation-issu-du-lidar-scot-lille-metropole-et-mel-2018-1),
and [USGS 3DEP](https://www.usgs.gov/tools/lidarexplorer). Current route
extracts and the residual-height canopy proxy can differ from conditions on
the model date. Do not interpret these samples as a whole-city pedestrian
ranking or a comparison of social groups.

Full study-area runs are recorded case by case in
`cityStreetModels` in the published catalog. The two verified full footprints
are Greater London and the Utrecht FUA, both on 18 July 2022 at 10:52 UTC.
Utrecht uses 353 buffered model tiles, 60 weather locations, and about 9,081 km
of represented walking routes. It excludes routes without valid geometry or
terrain, and cells under the minimum route length. The date refers to one
simulated instant. The other events use their recorded municipality or pilot
footprints.

For live street comparisons, the six European areas use the 18 July 2022 UTC
snapshot. The catalog retains other dated pilots for the shade archive. The
Pacific Northwest pilots use 28 June 2021 at 20:00 UTC. The weather
and radiation change by event. The terrain and walking geometry are held
fixed by city. In administrative-area runs, SOLWEIG uses buffered 1.9 km
tiles, with background weather shared within each tile. Coverage means
modelled walking routes inside the boundary. Water, areas without eligible
paths and cells with insufficient terrain support can have no results. For the
paired shade calculation, the citywide change uses the full represented route
length as its denominator. The paired-only change uses paired route length.
See [the changelog](CHANGELOG.md) and `cityStreetModels` in the published
administrative catalog for the exact cases with expanded coverage.

Use `prepare-fua-data.py --help` to rebuild the clipped archive. It accepts
the 1114 web and processed folders and a v14 baseline checkout. The public
source path combines `fetch-fua-landsat.py` and GHS-POP 2020 tiles and checks
reconstructed results against the delivery statistics before use. Use
`prepare-fua-census.py --help` to regenerate the small-area census lookup,
with IGN Contours IRIS, PDOK CBS 2022 neighbourhoods and TIGER2022 tract
geometry alongside the national census tables described above.
Run `prepare-street-model.py` with the original TerraHeat London runner and
co-registered local inputs for a pilot. Refresh pilot metadata with
`prepare-admin-data.py --street-index-only`.

For a new administrative-area run, provide the boundary, co-registered 5 m
DSM and DTM, walkable network and buildings, and hourly UTC air temperature,
relative humidity, 10 m wind in km/h and shortwave radiation. Run
`prepare-city-street.py --help` for the input contract and sample-time options.
Use `--event-list` to reuse each tile's terrain and sky-view preparation across
multiple timestamps, each with its own hourly weather and SOLWEIG radiation.
Use a new output directory whenever inputs or model settings change. Run
`node prepare-street-catalog.mjs <completed-runs-directory>` to publish the
resulting radiation inputs into the data catalog. The hosted Worker calculates
UTCI and aggregates the selected area and shade scenario when requested.
Preparing SOLWEIG radiation for a new place or time runs in Python before
publishing, typically taking minutes for an administrative area.

## Administrative boundary inputs and weights

The 15 November boundary delivery supplies 13 layers across eight cities.
London uses the full ONS 2021 borough polygons and 33 LAD codes, including
the City of London. The existing Census group archive carries the matched
2021 Output Area to borough code. Seven functional urban areas use clipped
polygons for the chosen unit. Paris arrondissements and U.S. Census places
cover subsets of their larger study areas. Keep levels separate. Edge overlaps
are marked in the control and the result reports the in-study area share.

For a given date and weather model, assign GHS-POP 2020 centres in the polygon
to the archived daily air grid. Estimates weight matched valid cells by
estimated residents, and report the denominator and the number of valid coarse
grid cells. Residential Landsat uses the same polygon membership or the London
ONS code join for Census groups. Native inputs determine the coverage in each
area. Report an unavailable result when data does not match the selection.

Use **Administrative areas** in the area controls to analyse one unit or add
several units from the same boundary layer. They share the event, time and
analysis settings. The comparison table shows each unit's own metrics and
coverage. For two areas it also reports A minus B when both estimates use
the same time. Share differences use percentage points.

Pedestrian and shade comparisons assign cells by their 100 m centres and
retain represented length and the eligible 20 m sun and building shade
condition. The same-time shade comparison keeps unpaired length at baseline.
Residential, walking, shade and field-review maps show the available results
for every selected area with a shared legend. Each map is clipped to the
corresponding polygon. The field review also scopes street lines and location
briefings to their selected area.

Rebuild the web dataset with `node prepare-district-data.mjs <delivery-root>`.
The delivery path contains `manifest.json` and the district geometry folders.
Sources are [ONS](https://www.data.gov.uk/dataset/5ca638fa-79d9-4d1f-a9ce-12ac929c8753/local-authority-districts-december-2021-boundaries-uk-bgc),
[GISCO LAU](https://gisco-services.ec.europa.eu/distribution/v2/lau/lau-2021-files.html),
[Ville de Paris](https://opendata.paris.fr/explore/dataset/arrondissements/)
and the [U.S. Census Bureau](https://www.census.gov/geographies/mapping-files/time-series/geo/cartographic-boundary.2021.html).

## Review & Advise

The `review` action on `POST /api/analysis` accepts the existing `archiveCase`
city and event, an optional selection `bounds`, the Act 4 `shadePercent` and a
`focus` for field checks. `point` requests one modelled 100 m cell. The Worker
calculates baseline UTCI, four shade lengths, paired coverage and the scenario
from the case’s existing model inputs. The scenario map carries forward baseline
UTCI where a valid sun and building-shade pair is absent. These cells appear
dimmed on the scenario map and have no value on the reduction map. The 500 m
thermal overview uses the same 100 m walking length weights.

The city catalogue registers group evidence under `reviewCensus`. The Worker
joins each 100 m walking-cell centre to its census area. For group `g` in cell
`i`, the priority score is

```text
P_i,g = 100 × clamp((UTCI_i − 32) / (46 − 32), 0, 1)
            × (sunlit walking length_i / modelled walking length_i)
            × (residents_g in the census area / all residents in that area)
```

The review ranks positive scores, keeping the highest-ranked cell per census
area. Each 500 m priority tile uses its highest matched 100 m score. Group
coverage measures the share of modelled walking length in matched cells.
This is a field screening score. Census counts describe residence, and a
site visit checks who uses the routes and waiting locations.

London uses [ONS TS007A age bands](https://www.ons.gov.uk/peoplepopulationandcommunity/populationandmigration/populationestimates/adhocs/15432ts007acensus2021agebyfiveyearagebands)
and [ONS TS038](https://www.ons.gov.uk/datasets/TS038/editions/2021/versions/1)
by Census 2021 Output Area. Age uses 65+ and 0–14. The TS038 group includes
respondents whose long-term conditions limit daily activities a little or a lot.
Run `prepare-review-census.py --help` to join a city’s WGS84 census polygons and
counts to its existing walking cells. Supply counts from a common census
denominator for each area. The optional London arguments read the TS007A
Nomis ZIP and the existing OA centroid package with TS038 counts. The generated
lookup contains only area IDs and aggregate counts. The Worker computes scores
for the selected event and area at request time.

The old city exports grouped route samples by cell, shade class and mean
radiant temperature. SOLWEIG shadow rasters were written to temporary tile
directories and cleared after sampling. The original terrain, weather and OSM
inputs are sufficient to reproduce the shadow evidence.

For linework, run `prepare-street-review.py --help`. Supply the registered
city, event, exact UTC model time, metric CRS and study polygon together with
the original hourly weather, OSM PBF extracts and aligned 5 m terrain/surface
inputs. Use `--lidar` for the named mosaicking tiles used by London or `--dtm`
and `--dsm` for co-registered mosaics. Point `--out` at
`dist/client/data/admin/street-review/<city>/<event>` and `--rasters` at a
persistent raw-output directory. The local output preserves paired, georeferenced
5 m shade bands, timestamps and per-tile restart records. The web manifest and
its compressed OSM line records provide ordered shade runs, with way IDs and
street names where available. Keep the local raster directory and use a fresh
pair of output directories when the sources or area change.

The `review-streets` action reads the event’s matching line inputs, clips shade
runs to the analysis area and returns actual line geometry and lengths in the
viewport. When those inputs are missing, grid review remains available. London’s
full study area uses the 18 July 2022 10:52:15 UTC model time and the 5 November
2026 OSM snapshot. The street layer represents candidate walking centre-lines at
approximately 5 m sampling, with field checks for position, use and site conditions.

Use `npm run build` and `node verify-local.mjs` to verify the archive, time
matching, area selection, and UTCI agreement with the SOLWEIG reference.

## Research workspace

Open **Research workspace** from the atlas. Each study fixes a WGS 84
boundary and an event time. Use a catalogue boundary or import GeoJSON, and
choose a metric analysis CRS if the default local UTM grid is unsuitable.
London's catalogue boundary defaults to British National Grid. Signed-in
data and results are available for seven days and can be deleted from the
workspace. Access ends at expiry. The service removes expired files during
workspace use or a scheduled cleanup when the host provides one.

**Continue as guest** runs the same file validation and models in a dedicated
browser worker. Files, parameters and results are held in memory for that tab.
Guest imports and results stay out of the private workspace store. Atlas uses
the built-in methods and model summaries in guest mode. Download the inputs
or results you want to keep before reloading or leaving the page.

- **LST and population.** Import north-up single-band GeoTIFFs. LST accepts
  calibrated Celsius or Kelvin at the study time. Population records the
  source year and keeps people-per-pixel counts. The calculation matches
  population cell centres to LST and reports the matched denominator.
- **Walking heat and shade.** The CSV template uses ISO 8601 times with an
  explicit timezone, WGS 84 coordinates, represented metres, Tmrt and air
  temperature in °C, relative humidity in percent and 10 m wind in m/s.
  UTCI is evaluated per sample. The coarse map preview samples dense outputs
  and the export includes all calculation cells. Add `sunlit` and
  `building_shade` classes for paired estimation. The existing 20 m
  per-class threshold, 100 m grid and what-if equation apply.
- **Field priorities.** Join imported `area_id` polygons to a count table
  with `group_id`, `group_label`, `group_count` and `eligible_count`.
  The model joins walking cells to census polygons and uses the score in
  Review & Advise. Resident shares describe residential context.
- **Export.** Download the original or validated file. Result CSV and GeoJSON
  retain numerical values and locations. ZIP includes both CSV tables,
  the full and selected boundaries, and a manifest with input hashes,
  model and application revisions, coordinate system, time and parameters.

The first release accepts up to 12 MiB per file, 100,000 CSV records and
500,000 clipped raster pixels. Large exports may require selecting a smaller
analysis area. The model uses a prepared Tmrt input at the study event time.
From raw terrain and weather the preparation command in the street model
section generates radiation and shade inputs for the existing archive.

For a private local preview, use `HEATLINE_LOCAL_WORKSPACE=1` with
`npm start` on loopback. The preview storage is in memory. Production uses
the `WORKSPACE` private object-store binding and the Sites visitor identity.
