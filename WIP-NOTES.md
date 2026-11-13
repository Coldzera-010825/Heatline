# City analysis work in progress

This branch is a checkpoint of the local work paused for team collaboration.
Start from `main` for the tested demo. No updates from this branch have been deployed.

- The partial map changes move London July 2022 towards a single case, reuse the prepared 100 m Landsat display, and remove contextual layers from the street and shade chapters. The result rendering and controls are incomplete.
- `prepare-city-street.py` reads terrain, walking geometry, and event-hour weather to prepare city-scale SOLWEIG radiation inputs. The staged input downloads and partial runs are not included. The new path is not wired to the hosted API yet.
- Population map results and additional city Census groups still need to be connected. The existing demo data and Worker remain available on `main`.
