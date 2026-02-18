import { minuteGranularity } from "./core.js";

const timeZonePartsFormatterCache = new Map();
const timeRangeFormatterCache = new Map();

function getTimeZonePartsFormatter(timeZone) {
  const key = timeZone || "UTC";
  if (timeZonePartsFormatterCache.has(key)) {
    return timeZonePartsFormatterCache.get(key);
  }
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: key,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  timeZonePartsFormatterCache.set(key, formatter);
  return formatter;
}

function getTimeRangeFormatter(timeZone) {
  const key = timeZone || "UTC";
  if (timeRangeFormatterCache.has(key)) {
    return timeRangeFormatterCache.get(key);
  }
  const formatter = new Intl.DateTimeFormat(undefined, {
    timeZone: key,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  timeRangeFormatterCache.set(key, formatter);
  return formatter;
}

function toDate(value) {
  return value ? new Date(value) : null;
}

function getOccurrenceOverride(blob) {
  if (!blob) return null;
  const key = blob.schedulable_timerange?.start;
  if (!key) return null;
  const overrides = blob.recurrence_payload?.occurrence_overrides;
  if (!overrides || typeof overrides !== "object") return null;
  const override = overrides[key];
  return override && typeof override === "object" ? override : null;
}

function getEffectiveOccurrenceRange(blob) {
  if (!blob) return null;
  const baseRange = blob.realized_timerange || blob.default_scheduled_timerange;
  if (!baseRange?.start || !baseRange?.end) return null;
  const start = toDate(baseRange.start);
  const end = toDate(baseRange.end);
  if (!start || !end) return null;
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return null;
  const override = getOccurrenceOverride(blob);
  let addedMinutes = Number(override?.added_minutes || 0);
  if (!Number.isFinite(addedMinutes)) addedMinutes = 0;
  let finishedAt = override?.finished_at ? toDate(override.finished_at) : null;
  if (finishedAt && Number.isNaN(finishedAt.getTime())) finishedAt = null;
  const effectiveEnd = finishedAt
    ? finishedAt
    : new Date(end.getTime() + addedMinutes * 60000);
  return { start, end, effectiveEnd, addedMinutes, finishedAt };
}

function getLocalTimeZone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

function getTimeZoneParts(date, timeZone) {
  const formatter = getTimeZonePartsFormatter(timeZone);
  const parts = formatter.formatToParts(date);
  const map = {};
  parts.forEach((part) => {
    if (part.type !== "literal") {
      map[part.type] = part.value;
    }
  });
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour: Number(map.hour),
    minute: Number(map.minute),
    second: Number(map.second),
  };
}

function toZonedDate(date, timeZone) {
  if (!date) return null;
  const parts = getTimeZoneParts(date, timeZone);
  return new Date(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second
  );
}

function getTimeZoneOffsetMinutes(date, timeZone) {
  const parts = getTimeZoneParts(date, timeZone);
  const asUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second
  );
  return (asUtc - date.getTime()) / 60000;
}

function zonedTimeToUtcFromParts(parts, timeZone) {
  const utcGuess = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second || 0
  );
  const offsetMinutes = getTimeZoneOffsetMinutes(new Date(utcGuess), timeZone);
  return new Date(utcGuess - offsetMinutes * 60000);
}

function formatDateTimeLocalInTimeZone(date, timeZone) {
  const parts = getTimeZoneParts(date, timeZone);
  const year = String(parts.year).padStart(4, "0");
  const month = String(parts.month).padStart(2, "0");
  const day = String(parts.day).padStart(2, "0");
  const hour = String(parts.hour).padStart(2, "0");
  const minute = String(parts.minute).padStart(2, "0");
  return `${year}-${month}-${day}T${hour}:${minute}`;
}

function formatIsoInTimeZone(date, timeZone) {
  const parts = getTimeZoneParts(date, timeZone);
  const offsetMinutes = getTimeZoneOffsetMinutes(date, timeZone);
  const sign = offsetMinutes <= 0 ? "+" : "-";
  const abs = Math.abs(offsetMinutes);
  const offsetHours = String(Math.floor(abs / 60)).padStart(2, "0");
  const offsetMins = String(Math.floor(abs % 60)).padStart(2, "0");
  const year = String(parts.year).padStart(4, "0");
  const month = String(parts.month).padStart(2, "0");
  const day = String(parts.day).padStart(2, "0");
  const hour = String(parts.hour).padStart(2, "0");
  const minute = String(parts.minute).padStart(2, "0");
  const second = String(parts.second).padStart(2, "0");
  return `${year}-${month}-${day}T${hour}:${minute}:${second}${sign}${offsetHours}:${offsetMins}`;
}

function toProjectIsoFromLocalInput(value, userTimeZone, projectTimeZone) {
  if (!value) return "";
  const [datePart, timePart] = value.split("T");
  if (!datePart || !timePart) return "";
  const [year, month, day] = datePart.split("-").map((part) => Number(part));
  const [hour, minute] = timePart.split(":").map((part) => Number(part));
  if (
    [year, month, day, hour, minute].some((item) => Number.isNaN(item))
  ) {
    return "";
  }
  const utcDate = zonedTimeToUtcFromParts(
    { year, month, day, hour, minute, second: 0 },
    userTimeZone
  );
  if (projectTimeZone === "UTC") {
    return utcDate.toISOString().replace(".000Z", "Z");
  }
  return formatIsoInTimeZone(utcDate, projectTimeZone);
}

function toProjectIsoFromDate(date, projectTimeZone) {
  if (!date || Number.isNaN(date.getTime())) return "";
  if (projectTimeZone === "UTC") {
    return date.toISOString().replace(".000Z", "Z");
  }
  return formatIsoInTimeZone(date, projectTimeZone);
}

function formatOffset(minutes) {
  const sign = minutes <= 0 ? "+" : "-";
  const abs = Math.abs(minutes);
  const hours = `${Math.floor(abs / 60)}`.padStart(2, "0");
  const mins = `${abs % 60}`.padStart(2, "0");
  return `${sign}${hours}:${mins}`;
}

function toIso(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  const hours = `${date.getHours()}`.padStart(2, "0");
  const minutes = `${date.getMinutes()}`.padStart(2, "0");
  const seconds = `${date.getSeconds()}`.padStart(2, "0");
  const offset = formatOffset(date.getTimezoneOffset());
  return `${year}-${month}-${day}T${hours}:${minutes}:${seconds}${offset}`;
}

function toLocalInputValue(isoString) {
  const date = toDate(isoString);
  if (!date) return "";
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  const hours = `${date.getHours()}`.padStart(2, "0");
  const minutes = `${date.getMinutes()}`.padStart(2, "0");
  return `${year}-${month}-${day}T${hours}:${minutes}`;
}

function toLocalInputValueInTimeZone(isoString, timeZone) {
  const date = toDate(isoString);
  if (!date) return "";
  return formatDateTimeLocalInTimeZone(date, timeZone);
}

function toLocalInputFromDate(date) {
  if (!date) return "";
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  const hours = `${date.getHours()}`.padStart(2, "0");
  const minutes = `${date.getMinutes()}`.padStart(2, "0");
  return `${year}-${month}-${day}T${hours}:${minutes}`;
}

function clampToGranularity(minutes) {
  return Math.round(minutes / minuteGranularity) * minuteGranularity;
}

function pad(num) {
  return num.toString().padStart(2, "0");
}

function formatTimeRange(start, end) {
  const startDate = toDate(start);
  const endDate = toDate(end);
  if (!startDate || !endDate) {
    return "";
  }
  const startLabel = `${pad(startDate.getHours())}:${pad(startDate.getMinutes())}`;
  const endLabel = `${pad(endDate.getHours())}:${pad(endDate.getMinutes())}`;
  return `${startLabel} - ${endLabel}`;
}

function formatTimeRangeInTimeZone(start, end, timeZone) {
  const startDate = toDate(start);
  const endDate = toDate(end);
  if (!startDate || !endDate) {
    return "";
  }
  const formatter = getTimeRangeFormatter(timeZone);
  return `${formatter.format(startDate)} - ${formatter.format(endDate)}`;
}

function startOfDay(date) {
  const copy = new Date(date);
  copy.setHours(0, 0, 0, 0);
  return copy;
}

function addDays(date, count) {
  const copy = new Date(date);
  copy.setDate(copy.getDate() + count);
  return copy;
}

function shiftAnchorDate(view, anchorDate, direction) {
  if (!anchorDate || !Number.isFinite(direction)) return null;
  if (view === "day") {
    return addDays(anchorDate, direction);
  }
  if (view === "week") {
    return addDays(anchorDate, direction * 7);
  }
  if (view === "month") {
    const next = new Date(anchorDate);
    next.setMonth(next.getMonth() + direction);
    return next;
  }
  if (view === "year") {
    const next = new Date(anchorDate);
    next.setFullYear(next.getFullYear() + direction);
    return next;
  }
  return null;
}

function getWeekStart(date) {
  const dayOfWeek = date.getDay();
  return addDays(startOfDay(date), -dayOfWeek);
}

function getViewRange(view, anchorDate) {
  if (view === "day") {
    const start = startOfDay(anchorDate);
    return { start, end: addDays(start, 1) };
  }
  if (view === "week") {
    const dayOfWeek = anchorDate.getDay();
    const start = addDays(startOfDay(anchorDate), -dayOfWeek);
    return { start, end: addDays(start, 7) };
  }
  if (view === "month") {
    const start = new Date(anchorDate.getFullYear(), anchorDate.getMonth(), 1);
    const end = new Date(anchorDate.getFullYear(), anchorDate.getMonth() + 1, 1);
    return { start, end };
  }
  const start = new Date(anchorDate.getFullYear(), 0, 1);
  const end = new Date(anchorDate.getFullYear() + 1, 0, 1);
  return { start, end };
}

function getTagType(tags) {
  if (tags?.includes("deep")) return "deep";
  if (tags?.includes("admin")) return "admin";
  return "focus";
}

function overlaps(rangeStart, rangeEnd, eventStart, eventEnd) {
  return eventStart < rangeEnd && eventEnd > rangeStart;
}

function layoutBlocks(blocks) {
  const sorted = [...blocks].sort((a, b) => a.startMin - b.startMin || a.endMin - b.endMin);
  const active = [];
  let cluster = null;
  let clusterId = 0;

  sorted.forEach((block) => {
    for (let i = active.length - 1; i >= 0; i -= 1) {
      if (active[i].endMin <= block.startMin) {
        active.splice(i, 1);
      }
    }

    if (active.length === 0) {
      clusterId += 1;
      cluster = { id: clusterId, maxColumns: 0, events: [] };
    }

    const used = new Set(active.map((item) => item.column));
    let column = 0;
    while (used.has(column)) {
      column += 1;
    }

    block.column = column;
    block.cluster = cluster;
    cluster.events.push(block);
    active.push(block);

    const activeColumns = new Set(active.map((item) => item.column));
    cluster.maxColumns = Math.max(cluster.maxColumns, activeColumns.size);
  });

  blocks.forEach((block) => {
    block.columns = block.cluster?.maxColumns || 1;
  });

  const maxStack = 4;
  blocks.forEach((block) => {
    const stackCount = Math.min(block.columns, maxStack);
    block.stackCount = stackCount;
    block.stackIndex = Math.min(block.column || 0, stackCount - 1);
    block.stackStep = Math.max(6, 18 - stackCount * 2);
  });
}

export {
  addDays,
  clampToGranularity,
  formatTimeRange,
  getTagType,
  getViewRange,
  getWeekStart,
  getEffectiveOccurrenceRange,
  getOccurrenceOverride,
  getLocalTimeZone,
  getTimeZoneParts,
  formatDateTimeLocalInTimeZone,
  formatIsoInTimeZone,
  toProjectIsoFromLocalInput,
  toProjectIsoFromDate,
  toLocalInputValueInTimeZone,
  toZonedDate,
  formatTimeRangeInTimeZone,
  layoutBlocks,
  overlaps,
  shiftAnchorDate,
  startOfDay,
  toDate,
  toIso,
  toLocalInputFromDate,
  toLocalInputValue,
};
