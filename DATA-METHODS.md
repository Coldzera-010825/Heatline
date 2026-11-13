Heatline has eight administrative study areas. Each boundary file records the
name, provider and applicable licence. Brussels–Uccle uses the Brussels-Capital
Region; Uccle is the reference location for the archived meteorology. Paris
and Lille are the communes, rather than their metropolitan regions. Study
limits describe the demo and are not legal boundaries.

| Layer or analysis | Common method | Coverage |
| --- | --- | --- |
| Event weather | Use each archive's core dates and report UTC days. NOAA ISD station observations are separate from gridded air temperature. London retains its WOW and NOAA view. | Point-only cases in 2018/2026 remain reference evidence. No interpolated city field is inferred for these cases. |
| Land cover | [ESA WorldCover 2021](https://esa-worldcover.org/en/data-access) v200 at 10 m, resampled by class mode onto 500 m and 100 m metric ground grids, then reprojected for display. | All eight; the switch to 100 m uses the same zoom threshold. |
| Residential surface heat | [USGS Landsat Collection 2 L2](https://www.usgs.gov/landsat-missions/landsat-collection-2-surface-temperature) ST_B10, QA_PIXEL exclusion of fill, dilated cloud, cirrus, cloud, cloud shadow and snow; LST in °C = DN × 0.00341802 − 124.15. Weight at [GHS-POP R2023A](https://human-settlement.emergency.copernicus.eu/ghs_pop2023.php) 2020 native 100 m cell centres inside the boundary and any user selection. | 32 archived city snapshots. Show valid population coverage and the actual overpass. London’s detailed Census/IMD analysis uses its original OA method and remains separate. |
| Landsat comparison | Same UTC day inside both event cores, local solar time within 90 minutes, and ≥80% valid population coverage in each study area. Compare means and distributions over the matched residents. | For example, Paris and Amsterdam on 7 August 2020. LST measures surfaces near residential locations; actual personal exposure is not observed. |
| Pedestrian heat | Use terrain, buildings, canopy and hourly temperature, humidity, shortwave and wind to model 5 m mean radiant temperature with [SOLWEIG](https://github.com/UMEP-dev/solweig). Compute UTCI at request time on the stored radiation samples and weight by represented walking length. | Each of the 32 spatial cases has a 100 m walking pilot. London retains its full 2022 archive in the detailed case. |
| Shade scenario | Require at least 20 m each of sun and building shade in a cell. Reassign the specified fraction of sunlit route length to that cell's building-shade UTCI, then divide the revised total by represented length. | Paired cells at the street pilot time. De Bilt has only three eligible cells. This is a scenario estimate, not a geometry rerun or intervention validation. |

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
fixed by city, so the runs do not reconstruct changes in buildings, trees or
paths over time.

Run `prepare-admin-data.py` with the source directory to rebuild the clipped
assets. Run `prepare-street-model.py` with the original TerraHeat London runner
and co-registered local inputs to add a model time. Run
`prepare-admin-data.py --street-index-only` after new pilot runs, then
`node build-worker.mjs`. Use `node test-admin-api.mjs <base-url>` to verify
all eight archive cases, time matching, area selection, and UTCI agreement
with the SOLWEIG reference output.
