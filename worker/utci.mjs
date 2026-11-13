// Operational UTCI approximation (Bröde et al., 2012, doi:10.1007/s00484-011-0454-1).
// Numerical terms transcribed from the SOLWEIG implementation. The term table
// carries its source and licence in THIRD_PARTY.md.
import terms from "./utci-coefficients.mjs";

export function utciAtWeather({ airC, humidity, wind }) {
  if (![airC, humidity, wind].every(Number.isFinite) || humidity < 0 || humidity > 100 || wind < 0) {
    throw new Error("Invalid event-hour UTCI weather");
  }
  const k = airC + 273.15;
  const logPressure = 2.7150305 * Math.log(k) - 2836.5744 / k ** 2 - 6028.076559 / k + 19.54263612
    - .02737830188 * k + .000016261698 * k ** 2 + 7.0229056e-10 * k ** 3 - 1.8680009e-13 * k ** 4;
  const vaporKpa = Math.exp(logPressure) * humidity / 100000;
  const coefficients = [airC, 0, 0, 0, 0, 0, 0];
  for (const [coefficient, a, w, d, p] of terms) {
    coefficients[d] += coefficient * airC ** a * wind ** w * vaporKpa ** p;
  }
  return meanRadiant => {
    const difference = meanRadiant - airC;
    let value = coefficients[6];
    for (let degree = 5; degree >= 0; degree--) value = value * difference + coefficients[degree];
    return value;
  };
}

// Grouped 5 m model samples: Tmrt followed by represented lengths in sun,
// building shade, canopy shade and partial shade. Compute per sample band
// before aggregating; UTCI at the mean Tmrt is a different calculation.
export function evaluateStreetGrid(grid, weather, includes = () => true) {
  const utci = utciAtWeather(weather), rows = [], pairs = [];
  for (const [lon, lat, , , ring, samples] of grid.rows) {
    if (!includes(lon, lat)) continue;
    const length = [0, 0, 0, 0], heat = [0, 0, 0, 0];
    for (const [tmrt, sun, building, canopy, partial] of samples) {
      const temp = utci(tmrt);
      length[0] += sun;
      length[1] += building;
      length[2] += canopy;
      length[3] += partial;
      heat[0] += temp * sun;
      heat[1] += temp * building;
      heat[2] += temp * canopy;
      heat[3] += temp * partial;
    }
    const total = length.reduce((a, b) => a + b, 0);
    const baseline = heat.reduce((a, b) => a + b, 0) / total;
    rows.push([lon, lat, Number(baseline.toFixed(2)), total, ring]);
    if (length[0] + .0005 >= 20 && length[1] + .0005 >= 20) {
      pairs.push([lon, lat, total, length[0], length[1], baseline, heat[0] / length[0], heat[1] / length[1], ring]);
    }
  }
  return { rows, pairs };
}
