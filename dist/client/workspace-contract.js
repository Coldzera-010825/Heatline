export const studyLifeDays = 7;
export const fileLimitMiB = 12;
export const maxRasterPixels = 500000;
export const maxTableRows = 100000;
export const shadeClasses = ["sunlit", "building_shade", "canopy_shade", "partial_shade"];

export const roles = {
  boundary: { label: "Study boundary", format: "GeoJSON", accept: ".geojson,.json", hint: "Polygon or MultiPolygon · WGS 84 longitude and latitude." },
  lst: { label: "Land surface temperature", format: "GeoTIFF", accept: ".tif,.tiff", hint: "One band of calibrated temperature. Record the observation time and unit." },
  population: { label: "Resident counts", format: "GeoTIFF", accept: ".tif,.tiff", hint: "One band of people per pixel, with a census or estimate year. An additional grid can represent a second group." },
  samples: { label: "Walking heat samples", format: "CSV", accept: ".csv", hint: "One row per sample with event-hour weather, mean radiant temperature and represented walking length." },
  routes: { label: "Walking routes", format: "GeoJSON", accept: ".geojson,.json", hint: "WGS 84 lines with an optional segment_id for linking to sample records." },
  censusAreas: { label: "Census areas", format: "GeoJSON", accept: ".geojson,.json", hint: "WGS 84 polygons with a unique area_id in each feature." },
  censusGroups: { label: "Census groups", format: "CSV", accept: ".csv", hint: "Residents in each group and their eligible population, joined by area_id." },
  referenceRaster: { label: "Reference raster", format: "GeoTIFF", accept: ".tif,.tiff", hint: "A georeferenced single-band result or context layer, with a declared unit." },
  referenceVector: { label: "Reference features", format: "GeoJSON", accept: ".geojson,.json", hint: "WGS 84 points, lines or polygons. Supply a numeric property to colour by value." },
};

export const sampleFields = ["sample_id", "lon", "lat", "time_utc", "length_m", "tmrt_c", "air_c", "rh_pct", "wind_10m_ms", "shade_class", "segment_id"];
export const groupFields = ["area_id", "group_id", "group_label", "group_count", "eligible_count"];
export const models = {
  resident: { label: "Residential heat exposure", short: "Residential heat", help: "Weight land surface temperature by resident counts in the study area.", inputs: ["lst", "population"] },
  walking: { label: "Pedestrian heat exposure", short: "Pedestrian UTCI", help: "Calculate UTCI from weather and radiation, weighted by walking length on a 100 m grid.", inputs: ["samples"] },
  shade: { label: "Shade scenario", short: "Shade scenario", help: "Apply the observed or modelled local building-shade contrast to a share of sunlit walking length.", inputs: ["samples"] },
  priority: { label: "Field priority", short: "Field priority", help: "Rank sunlit walking cells using the selected resident group and modelled heat.", inputs: ["samples", "censusAreas", "censusGroups"] },
};
