import { fromArrayBuffer, writeArrayBuffer } from "geotiff";
import { maxRasterPixels } from "../dist/client/workspace-contract.js";
import { bbox, collection, contains, crsName, feature, overlapGeometry, project, ring, wgs } from "./workspace-geography.mjs";

const nodata = -9999;
const rounded = (n, digits = 3) => Number(n.toFixed(digits));

export const pixels = buffer => new Float32Array(buffer);
export const centre = (grid, column, row) => [
  grid.origin[0] + (column + .5) * grid.dx, grid.origin[1] - (row + .5) * grid.dy,
];

export function readCell(values, grid, x, y) {
  const col = Math.floor((x - grid.origin[0]) / grid.dx);
  const row = Math.floor((grid.origin[1] - y) / grid.dy);
  return col >= 0 && row >= 0 && col < grid.width && row < grid.height ? values[row * grid.width + col] : NaN;
}

export function blockGeometry(grid, col, row, width, height, projectToMap) {
  const left = grid.origin[0] + col * grid.dx, top = grid.origin[1] - row * grid.dy;
  return { type: "Polygon", coordinates: [ring([left, top - height * grid.dy, left + width * grid.dx, top])
    .map(p => projectToMap(...p))] };
}

export function rasterPreview(values, grid, limit, sum = false) {
  const stride = Math.max(1, Math.ceil(Math.sqrt(values.length / 1200)));
  const mapPoint = project(grid.crs, wgs), features = [];
  for (let row = 0; row < grid.height; row += stride) {
    const height = Math.min(grid.height - row, stride);
    for (let col = 0; col < grid.width; col += stride) {
      const width = Math.min(grid.width - col, stride);
      let total = 0, count = 0;
      for (let j = row; j < row + height; j++) for (let i = col; i < col + width; i++) {
        const n = values[j * grid.width + i];
        if (Number.isFinite(n)) { total += n; count++; }
      }
      if (!count) continue;
      const geometry = overlapGeometry(blockGeometry(grid, col, row, width, height, mapPoint), limit);
      if (geometry) features.push(feature(geometry, { value: rounded(sum ? total : total / count), valid_pixels: count }));
    }
  }
  return collection(features);
}

export async function normalizeRaster(bytes, role, meta, limit) {
  const input = await fromArrayBuffer(bytes);
  const image = await input.getImage();
  if (image.getSamplesPerPixel() !== 1) throw new Error("Export a single-band GeoTIFF for this layer.");
  const keys = image.getGeoKeys() ?? {};
  const projected = keys.ProjectedCSTypeGeoKey, geographic = keys.GeographicTypeGeoKey;
  const embedded = projected && projected < 32767 ? projected : projected === 54009 ? "ESRI:54009" :
    !projected && geographic && geographic < 32767 ? geographic : "";
  const mollweide = /mollweide/i.test([keys.PCSCitationGeoKey, keys.GTCitationGeoKey].join(" "));
  const crs = crsName(embedded || (mollweide ? "ESRI:54009" : meta.crs));
  if (meta.crs && crsName(meta.crs) !== crs) throw new Error("The coordinate system conflicts with the GeoTIFF tags.");
  const [px, py] = image.getResolution();
  let [left, top] = image.getOrigin();
  const dir = image.getFileDirectory();
  const transform = dir.getValue("ModelTransformation");
  if (![px, py, left, top].every(Number.isFinite) || px <= 0 || py >= 0 ||
    (transform && (transform[1] !== 0 || transform[4] !== 0))) {
    throw new Error("Use a north-up GeoTIFF with an explicit cell size and origin.");
  }
  if (keys.GTRasterTypeGeoKey === 2) { left -= px / 2; top -= py / 2; }
  const dx = px, dy = -py, maxX = image.getWidth(), maxY = image.getHeight();
  const [west, south, east, north] = bbox(limit, project(wgs, crs));
  const col = Math.max(0, Math.floor((west - left) / dx)), row = Math.max(0, Math.floor((top - north) / dy));
  const stopX = Math.min(maxX, Math.ceil((east - left) / dx)), stopY = Math.min(maxY, Math.ceil((top - south) / dy));
  const width = stopX - col, height = stopY - row;
  if (width <= 0 || height <= 0) throw new Error("The raster does not overlap the study boundary.");
  if (width * height > maxRasterPixels || image.getTileWidth() * image.getTileHeight() > 2 * maxRasterPixels ||
    (Math.ceil(width / image.getTileWidth()) + 1) * (Math.ceil(height / image.getTileHeight()) + 1) *
      image.getTileWidth() * image.getTileHeight() > 12 * maxRasterPixels) {
    throw new Error("Crop the raster to this study or export it in smaller tiles. The clipped raster limit is 500,000 pixels.");
  }
  const band = await image.readRasters({ window: [col, row, stopX, stopY], interleave: true });
  const grid = { origin: [left + col * dx, top - row * dy], crs, width, height, dx, dy };
  const out = new Float32Array(width * height), inside = contains(limit), mapPoint = project(crs, wgs);
  const missing = image.getGDALNoData(), offset = role === "lst" && meta.units === "K" ? 273.15 : 0;
  let valid = 0, covered = 0, low = Infinity, high = -Infinity;
  for (let i = 0; i < out.length; i++) {
    out[i] = NaN;
    if (!inside(...mapPoint(...centre(grid, i % width, Math.floor(i / width))))) continue;
    covered++;
    if (!Number.isFinite(band[i]) || band[i] === missing) continue;
    const n = band[i] - offset;
    if (role === "population" && n < 0) throw new Error("Population pixels must contain non-negative counts. Declare missing cells as NoData.");
    if (role === "lst" && (n < -110 || n > 140)) throw new Error("Land surface values are outside the supported temperature range. Apply the sensor scale and offset before importing.");
    out[i] = n;
    valid++;
    low = Math.min(low, n);
    high = Math.max(high, n);
  }
  if (!valid) throw new Error("There are no valid pixels in the study boundary.");
  return { grid, data: out, preview: rasterPreview(out, grid, limit, role === "population"),
    details: { valid, covered, minimum: rounded(low), maximum: rounded(high), resolution: [dx, dy], crs } };
}

export function exportRaster(grid, values) {
  const clean = values.map(n => Number.isFinite(n) ? n : nodata);
  const code = Number(grid.crs.split(":")[1]);
  const projection = grid.crs === wgs ? { GeographicTypeGeoKey: 4326, GTModelTypeGeoKey: 2 } :
    { ProjectedCSTypeGeoKey: code, PCSCitationGeoKey: grid.crs, GTModelTypeGeoKey: 1 };
  return writeArrayBuffer(clean, {
    width: grid.width, height: grid.height, GDAL_NODATA: String(nodata), BitsPerSample: [32], SampleFormat: [3],
    ...projection, GTRasterTypeGeoKey: 1, ModelPixelScale: [grid.dx, grid.dy, 0],
    ModelTiepoint: [0, 0, 0, grid.origin[0], grid.origin[1], 0],
  });
}
