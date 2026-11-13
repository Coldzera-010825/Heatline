Heatline has eight administrative study areas. Each boundary file records the
name, provider and applicable licence. Brussels–Uccle uses the Brussels-Capital
Region; Uccle is the reference location for the archived meteorology. Paris
and Lille are the communes, rather than their metropolitan regions. Study
limits describe the demo and are not legal boundaries.

| Layer or analysis | Common method | Coverage |
| --- | --- | --- |
| Event weather | Use each archive's core dates and report UTC days. NOAA ISD station observations are separate from gridded air temperature. London retains its WOW and NOAA view. | Point-only cases in 2018/2026 remain reference evidence. No interpolated city field is inferred for these cases. |
| Land cover | [ESA WorldCover 2021](https://esa-worldcover.org/en/data-access) v200 at 10 m, resampled by class mode onto 500 m and 100 m metric ground grids, then reprojected for display. | All eight; the switch to 100 m uses the same zoom threshold. |
| Residential surface heat | [USGS Landsat Collection 2 L2](https://www.usgs.gov/landsat-missions/landsat-collection-2-surface-temperature) ST_B10. QA_PIXEL excludes fill, dilated cloud, cirrus, cloud, cloud shadow and snow. LST in °C = DN × 0.00341802 − 124.15. Weight at [GHS-POP R2023A](https://human-settlement.emergency.copernicus.eu/ghs_pop2023.php) 2020 native 100 m cell centres inside the boundary and any user selection. | 32 archived city snapshots. The event layer uses a 100 m display grid, including London July 2022. Population analysis reports valid coverage and the actual overpass, with a 500 m map of the matched results. |
| Census groups | Compare the population-weighted LST distributions and matched coverage of available groups. For London, assign each Census Output Area the clear-pixel mean of a 5 × 5 Landsat window centred on the OA centroid. Elsewhere, distribute small-area population counts across GHS-POP 100 m cells within each statistical unit, using the same spatial weights for each group. | All eight cities support 65+ and all residents where the scene has valid matches. London also provides activity limitation and IMD. Seattle and Portland also provide disability and poverty using their ACS survey denominators. District ranking is available for London, Paris, Brussels, Amsterdam and De Bilt. |
| Landsat comparison | Same UTC day inside both event cores, local solar time within 90 minutes, and ≥80% valid population coverage in each study area. Compare means and distributions over the matched residents. | For example, Paris and Amsterdam on 7 August 2020. LST measures surfaces near residential locations; actual personal exposure is not observed. |
| Pedestrian heat | Use terrain, buildings, canopy and hourly temperature, humidity, shortwave and wind to model 5 m mean radiant temperature with [SOLWEIG](https://github.com/UMEP-dev/solweig). At request time, evaluate the [operational UTCI approximation](https://doi.org/10.1007/s00484-011-0454-1) per radiation sample and weight by represented walking length. | All 32 spatial cases have 100 m pilots. Where administrative-area runs are available, the same API uses their expanded walking grid. Dense selections show a 500 m overview and 100 m cells when zoomed in. |
| Shade scenario | A cell qualifies when it has at least 20 m each of sun and building shade. Reassign the specified fraction of sunlit route length to its local building-shade UTCI. Show paired-cell coverage and, for administrative-area runs, the change across all modelled routes with other routes fixed. | Uses the event timestamp in the street model. Coloured cells show the eligible pairs. The estimates use existing simulated radiation and fixed geometry. |

Census sources are [ONS Census 2021](https://www.nomisweb.co.uk/sources/census_2021)
with [English IMD 2025](https://www.gov.uk/government/statistics/english-indices-of-deprivation-2025)
for London, [INSEE IRIS 2022](https://www.insee.fr/fr/statistiques/8647014) for Paris and Lille,
[Statbel Census 2021](https://statbel.fgov.be/fr/open-data/census-2021-population-selon-secteur-statistique-du-lieu-de-residence-sexe-et-age-m)
for Brussels, [CBS neighbourhoods 2022](https://www.cbs.nl/nl-nl/cijfers/detail/85318NED)
for Amsterdam and De Bilt, and [U.S. Census ACS 2018–2022](https://www2.census.gov/programs-surveys/acs/summary_file/2022/table-based-SF/data/5YRData/)
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

Run `prepare-admin-data.py` with the source directory to rebuild the clipped
assets. Use `prepare-census-data.py --help` for the required census, geometry,
population and Landsat inputs. Run `prepare-street-model.py` with the original
TerraHeat London runner and co-registered local inputs to add a pilot model
time. Refresh pilot metadata with `prepare-admin-data.py --street-index-only`.

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
