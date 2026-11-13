// The map's observation and model controls use UTC throughout.
const months = "january february march april may june july august september october november december".split(" ");
const monthPattern = months.map(month => month.length > 3 ? month.slice(0, 3) + "(?:" + month.slice(3) + ")?" : month).join("|");
const dayFirst = new RegExp("\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(" + monthPattern + ")(?:\\.?[ ,]+((?:19|20)\\d{2}))?\\b");
const monthFirst = new RegExp("\\b(" + monthPattern + ")\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:[ ,]+((?:19|20)\\d{2}))?\\b");

export function requestTime(query, defaultYear) {
  let year, month, day;
  const iso = query.match(/\b((?:19|20)\d{2})-(\d{2})-(\d{2})(?=\b|t)/);
  const chinese = query.match(/(?:((?:19|20)\d{2})\s*年\s*)?(\d{1,2})\s*月\s*(\d{1,2})\s*(?:日|号)/);
  const first = query.match(dayFirst);
  const second = query.match(monthFirst);
  if (iso || chinese) {
    [, year, month, day] = iso ?? chinese;
  } else if (first || second) {
    const name = first?.[2] ?? second[1];
    month = months.findIndex(m => m.startsWith(name)) + 1;
    day = first?.[1] ?? second[2];
    year = (first ?? second)[3];
  }
  const explicitYear = year ?? query.match(/\b(?:19|20)\d{2}\b/)?.[0];
  const clock = query.match(/(?:\b|t)(\d{1,2}):(\d{2})(?::(\d{2}))?(?=\b|z)/);
  let time;
  if (clock) {
    const suffix = query.slice(clock.index + clock[0].length);
    const meridiem = suffix.match(/^\s*(am|pm)\b/)?.[1];
    const offset = suffix.match(/^\s*(?:(?:utc|gmt)\s*)?[+-](\d{1,2})(?::?(\d{2}))?\b/);
    const localZone = /\b(?:bst|cest|cet|pst|pdt|edt|est|local time)\b|当地时间/.test(query) ||
      (offset && (Number(offset[1]) !== 0 || Number(offset[2] ?? 0) !== 0));
    const hour = Number(clock[1]);
    if ((meridiem ? hour < 1 || hour > 12 : hour > 23) || Number(clock[2]) > 59 || Number(clock[3]) > 59 || localZone) {
      return { invalid: true };
    }
    const utcHour = meridiem ? hour % 12 + (meridiem === "pm" ? 12 : 0) : hour;
    time = String(utcHour).padStart(2, "0") + ":" + clock[2] + (clock[3] ? ":" + clock[3] : "");
  }
  if (day === undefined) return { explicitYear, time };
  const resolvedYear = explicitYear ?? defaultYear;
  const dayNumber = Number(day), monthNumber = Number(month);
  const date = resolvedYear + "-" + String(monthNumber).padStart(2, "0") + "-" + String(dayNumber).padStart(2, "0");
  const parsed = new Date(date + "T00:00:00Z");
  if (!resolvedYear || !Number.isFinite(+parsed) || parsed.toISOString().slice(0, 10) !== date) return { invalid: true };
  return { date, day: dayNumber, month: monthNumber, explicitYear, time };
}

export function matchesSnapshot(timestamp, date, time) {
  return (!date || date === timestamp.slice(0, 10)) &&
    (!time || (typeof time === "string" && /^\d{2}:\d{2}(?::\d{2})?$/.test(time) && timestamp.slice(11).startsWith(time)));
}

export function viewIntent(query) {
  const bars = /\b(?:3d(?: bars)?|extrusions?)\b|三维|立体/.test(query);
  const flat = /\b(?:2d|flat(?: grid)?)\b|平面/.test(query);
  if (bars === flat) return;
  return bars ? "bars" : "flat";
}
