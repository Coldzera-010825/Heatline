# Heatline changelog

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
