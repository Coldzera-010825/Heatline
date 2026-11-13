# Heatline

Heatline is an interactive climate atlas. Explore historical heatwaves from the globe to city and street level, compare residential surface heat, and estimate changes to walking heat under a shade scenario.

[Live atlas](https://heatline-atlas.abrdns.com) · [Releases](https://github.com/Coldzera-010825/Heatline/releases) · [Data and methods](DATA-METHODS.md) · [Third-party notices](THIRD_PARTY.md)

## Run locally

Use Node.js 22 or later. No npm packages are needed for the local preview.

1. Copy `dist/client/mapbox-token.example.js` to `dist/client/mapbox-token.js`. Set your own [public Mapbox token](https://docs.mapbox.com/accounts/guides/tokens/) with access to the styles used by the map. The local file is ignored by Git.
2. Run `npm run build` and then `npm start`. Open [localhost:8788](http://127.0.0.1:8788). Both the frontend and the existing Worker endpoints run in this preview.
3. With the preview running, run `npm test` in another terminal to check the archived cases and analysis API.

The demo archive includes prepared map and model assets, rather than the raw LiDAR or downloaded source archives. The optional WOW station export is distributed separately: to enable it locally, supply the project's authorised `dist/client/data/heatwave/stations.json` and corresponding series under `dist/client/data/heatwave/wow/`. Other layers and analysis can run without that export. Data retain their original terms. See [Data and methods](DATA-METHODS.md) and the attribution in the map.

## Work on the project

- `dist/client/` contains the Mapbox interface, story chapters, charts, and prepared data.
- `worker/` contains the analysis and Atlas endpoints, including the UTCI formula.
- `prepare-*.py` and `prepare-*.mjs` prepare inputs. Their required local datasets are described in [Data and methods](DATA-METHODS.md) and in each script.

Use `main` for the working demo and a separate branch for each change. GitHub Actions builds and tests pull requests and stores a build for each successful `main` commit. The [release instructions](DEPLOYMENT.md) explain how to publish that commit to the existing production site.

Check the data provenance and scope before adding new city results.
