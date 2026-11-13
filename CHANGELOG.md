# Heatline changelog

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
