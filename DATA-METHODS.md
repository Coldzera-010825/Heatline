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

For street comparisons, the six European areas use a common morning UTC
snapshot on 25 July 2019, 7 August 2020, 18 July 2022, 1 July 2025, or
26 June 2026. The Pacific Northwest uses 28 June 2021 at 20:00 UTC. The weather
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
Use a new output directory whenever inputs or model settings change. Run
`node prepare-street-catalog.mjs <completed-runs-directory>` to publish the
resulting radiation inputs into the data catalog. The hosted Worker calculates
UTCI and aggregates the selected area and shade scenario when requested.
Preparing SOLWEIG radiation for a new place or time runs in Python before
publishing, typically taking minutes for an administrative area.

Use `npm run build` and `node verify-local.mjs` to verify the archive, time
matching, area selection, and UTCI agreement with the SOLWEIG reference.
