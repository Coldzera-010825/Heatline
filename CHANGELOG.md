# Heatline changelog

## v26 — Multi-area comparison maps

- Move Administrative areas into the area selection card. Analyse one area or add and remove several areas from the same boundary layer.
- Draw the results for every covered selection in the residential heat, pedestrian UTCI, shade scenario and field review chapters. Use a shared scale and clip each result to its own boundary.
- Report coverage per area. Keep available results visible when another selected area lacks matching inputs.
- Keep street inspection and field briefings tied to the selected location's administrative area. Update Data & Methods and the Atlas knowledge base.

## v25 — Administrative area analysis

- Add 13 administrative boundary layers for eight cities, including London boroughs, Paris arrondissements, European municipalities and U.S. Census layers.
- Select one area or compare two at the same time and settings in each city chapter. Show matched residents, modelled routes and shade coverage with the relevant metrics.
- Document boundary definitions, clipping, date matching and source links in Data & Methods and refresh the Atlas knowledge base.

## v24 — Atlas methods knowledge

- Rebuild the Atlas knowledge base from the latest Data & Methods page, repository methods and case catalogue.
- Answer questions about research workspace inputs and exports, field priority and street shade from the published methods.

## v23 — Private research workspace

- Import a study boundary and validated GeoJSON, GeoTIFF or CSV inputs. Preview and clip layers to the study area.
- Calculate resident-weighted LST, walking UTCI, paired shade scenarios and group field priorities from the selected uploaded files.
- Export original and normalized layers, CSV results, GeoJSON and a reproducibility package with model, coverage, inputs and selection.

## v22 — Shade coverage and census-informed field priorities

- Show the full modelled walking area on the Act 5 scenario map. Dimmed cells carry forward baseline UTCI. The reduction map identifies cells that lack a valid pair.
- Rank field visits in Greater London using 2021 Census resident shares for ages 65+, ages 0–14 and residents with limited daily activities. Show the scores and population counts in the review, map and briefing.
- Check the census match before offering group priorities. The same walking heat and shade review works for cities whose small-area census input is pending.

## v21 — Field review of modelled heat and shade

- Add Review & Advise to the single-city workflow, with Act 4 scope and shade assumptions, 100 m grid evidence, Atlas field checks and an exportable briefing.
- Recompute UTCI, coverage and the shade comparison in a shared Worker analysis for supported city cases.
- Preserve London’s 5 m shadow rasters and ordered OSM street shade for 18 July 2022. The website loads the street geometry for the active map view.

## v18 — Research data and methods page

- Add a dedicated page with official sources, downloadable study boundaries, model coverage, formulas, and literature and atlas references.
- Link each map chapter’s **Data and method** panel and the related result notes to the corresponding method.
- Count all matched residents at or above 45 °C in the non-London census summaries.

## v17 — Focus walking heat exposure on 2022

- Lock **At street level** to the 2022 heatwave case. All eight city boundaries remain selectable on this chapter. Seattle and Portland show which 2022 inputs are needed before analysis can run.
- Apply the same year scope to the analysis API, Atlas and the walking-heat comparison. Archived weather, residential LST and paired shade retain their own dated cases.
- July 2022 coverage is Greater London and the full Utrecht functional urban area, Amsterdam municipality within its functional urban area, and central Paris, Lille and Brussels pilots.

## v16 — Full Utrecht FUA pedestrian heat for July 2022

- Publish a SOLWEIG run for the official Utrecht FUA footprint on 18 July 2022 at 10:52 UTC. The model has 46,814 walking cells, 1,163 eligible sun/shade pairs and about 9,081 km of represented routes.
- Keep July 2022 Greater London and the previously scoped models. The four other Utrecht heatwave timestamps retain De Bilt municipality coverage until their independent full-area runs pass verification.
- Allow multiple historical weather timestamps to share terrain and sky-view preparation. Check the published boundary, event time and tile data before registering an expanded run.

## v15 — Functional urban areas and 100 m population analysis

- Import the eight Heatline FUA v3 outlines. Keep Greater London and use metropolitan polygons for the other seven areas. Utrecht replaces the De Bilt study-area entry.
- Update the 32 dated spatial cases with the new boundary-clipped Landsat, vegetation, water, land-cover, elevation and population layers, plus FUA-weighted ERA5-Land and available station observations.
- Recompute residential surface heat and census-group comparisons for full areas or drawn selections using 100 m population weights. Display the supplied 500 m overview in the seven FUAs. Select a comparable event-core Landsat date when one exists.
- Bind live UTCI and shade calculations to the documented walking-network footprint. Full studies, municipality subsets and pilots show their own extent. Full-FUA claims require full-footprint radiation inputs.

## v14 — Faster delivery of citywide maps

- Send a smaller 500 m overview for dense street heat and shade results. Load 100 m cells as users zoom into the selection. All measurements continue to use the 100 m calculation grid.
- Compress the city catalog and map response and allow more time for slower connections. London, Amsterdam and De Bilt keep their v13 model coverage.

## v13 — City walking heat and residential exposure

- Use one London July 2022 case with the 100 m Landsat display grid. Existing links to the detailed case still open that event.
- Open the street and shade chapters on the base map. A button or Atlas request calculates the result for the selected area. Dense maps show a 500 m overview with 100 m detail on zoom.
- Add administrative-area street and shade analysis to the cases listed below. The shade panel shows the estimated change for eligible pairs and for all modelled walking routes in the selection, with other routes fixed. It reports the share of modelled walking length represented by pairs.
- Add result maps for population exposure and official census group comparisons across eight cities with valid Landsat matches. All eight support 65+ versus all residents. London also supports activity limitation and IMD. Seattle and Portland also support ACS disability and poverty. Compare districts where the local census geography provides district identifiers.
- Keep the UTCI approximation, route weighting and shade calculation in the hosted analysis API. Prepare the SOLWEIG radiation inputs offline for each new place and time.

### Administrative-area model coverage

| Study area | Heatwave events with administrative-area walking inputs |
| --- | --- |
| Greater London | July 2022 |
| Amsterdam | July 2019, August 2020, July 2022, June–July 2025, June 2026 |
| De Bilt | July 2019, August 2020, July 2022, June–July 2025, June 2026 |

Other modelled cases use their outlined pilots. Analysis requires valid inputs
for the selected place and time. The release uses historical snapshots.

### Verification

- Regression checks cover eight administrative boundaries, 32 pilot models,
  official census group analysis and result grids, and time and area matching.
- Administrative-area tests compare UTCI with the SOLWEIG reference, test
  100 m viewport details, and check zero and positive shade scenarios outside
  the original pilots.
