The operational UTCI approximation is from Bröde et al. (2012),
[DOI 10.1007/s00484-011-0454-1](https://doi.org/10.1007/s00484-011-0454-1).
The coefficient table in `worker/utci-coefficients.mjs` and its JavaScript
evaluation adapt the [SOLWEIG Rust implementation](https://github.com/UMEP-dev/solweig/blob/main/rust/src/utci.rs).
The adaptations are available under [GPL version 3](licenses/solweig-GPL-3.0.txt).
For the browser polygon-intersection library, see [polygon-clipping and
bundled notices](dist/client/vendor/polygon-clipping.LICENSE.md).

Prepared data retain their source terms; this repository does not grant a
new license for them. See [Data and methods](DATA-METHODS.md), the boundary
metadata, and the map attribution. London population aggregates use ONS
Census 2021 and English Indices of Deprivation 2025. Contains public sector
information licensed under the Open Government Licence v3.0. The optional
WOW station export is not included in this public repository; see the
[WOW licence page](https://wow.metoffice.gov.uk/support/licence).
