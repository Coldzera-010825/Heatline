# Release Heatline

The collaboration repository is [Coldzera-010825/Heatline](https://github.com/Coldzera-010825/Heatline). The production site is [heatline-atlas.abrdns.com](https://heatline-atlas.abrdns.com) on ChatGPT Sites.

## GitHub to production

1. Open a pull request to `main`. The [Heatline checks workflow](https://github.com/Coldzera-010825/Heatline/actions/workflows/check.yml) builds the Worker and checks the analysis API against the committed archive.
2. After merging, wait for the checks for the new `main` commit. The run stores an artifact named `heatline-<full commit SHA>` containing the built public files and Worker.
3. Give that commit SHA or workflow run URL to a Heatline Sites owner or editor to release it. The publisher imports the exact tested GitHub source into the existing Sites checkout, preserves its Mapbox configuration and separately managed WOW data, rebuilds, and publishes to the existing domain. Verify the URL and the analysis API after publication.

GitHub Actions builds and tests automatically. Publishing to the current Sites project is a separate authorised step. A successful GitHub check does not, by itself, change the website.

## Publishing checklist

- Start from the latest **published Sites source**, in a clean release checkout. Keep any unrelated local work on its own branch or checkout.
- In a GitHub checkout containing the successful commit, run `node prepare-sites-release.mjs <commit SHA> <Sites release checkout>`. It imports the exact committed source, preserves the deployment identity, Mapbox configuration and separate WOW data, and writes the source SHA to `dist/client/build-info.json`. Runtime credentials stay in Sites.
- Build and test the assembled release before saving and deploying it through Sites. Confirm `/build-info.json` on the production domain has the expected GitHub SHA.
- Roll back through Sites version history if a release fails after publication. The custom domain stays with the existing Sites project.
