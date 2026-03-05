import { minuteGranularity } from "./core.js";

const timeZonePartsFormatterCache = new Map();
const timeRangeFormatterCache = new Map();
const locationTimeZoneRules = [
  {
    timeZone: "America/New_York",
    patterns: [
      /\bamerica\/new_york\b/i,
      /\beastern(?:\s+time)?\b/i,
      /\b(?:et|est|edt)\b/i,
      /\bnew\s+york\b/i,
      /\bnyc\b/i,
      /\bboston\b/i,
      /\bmiami\b/i,
      /\bwashington(?:,\s*d\.?c\.?)?\b/i,
      /\btoronto\b/i,
    ],
  },
  {
    timeZone: "America/Chicago",
    patterns: [
      /\bamerica\/chicago\b/i,
      /\bcentral(?:\s+time)?\b/i,
      /\b(?:ct|cst|cdt)\b/i,
      /\bchicago\b/i,
      /\bdallas\b/i,
      /\bhouston\b/i,
      /\baustin\b/i,
      /\bminneapolis\b/i,
    ],
  },
  {
    timeZone: "America/Denver",
    patterns: [
      /\bamerica\/denver\b/i,
      /\bmountain(?:\s+time)?\b/i,
      /\b(?:mt|mst|mdt)\b/i,
      /\bdenver\b/i,
      /\bsalt\s+lake\s+city\b/i,
    ],
  },
  {
    timeZone: "America/Phoenix",
    patterns: [
      /\bamerica\/phoenix\b/i,
      /\barizona\b/i,
      /\bphoenix\b/i,
    ],
  },
  {
    timeZone: "America/Los_Angeles",
    patterns: [
      /\bamerica\/los_angeles\b/i,
      /\bpacific(?:\s+time)?\b/i,
      /\b(?:pt|pst|pdt)\b/i,
      /\blos\s+angeles\b/i,
      /\bsan\s+francisco\b/i,
      /\bseattle\b/i,
      /\bvancouver\b/i,
    ],
  },
  {
    timeZone: "America/Anchorage",
    patterns: [
      /\bamerica\/anchorage\b/i,
      /\balaska\b/i,
      /\b(?:akst|akdt)\b/i,
      /\banchorage\b/i,
    ],
  },
  {
    timeZone: "Pacific/Honolulu",
    patterns: [
      /\bpacific\/honolulu\b/i,
      /\bhawaii\b/i,
      /\bhonolulu\b/i,
      /\bhst\b/i,
    ],
  },
  {
    timeZone: "Europe/London",
    patterns: [
      /\beurope\/london\b/i,
      /\blondon\b/i,
      /\buk\b/i,
      /\bengland\b/i,
      /\b(?:gmt|bst)\b/i,
    ],
  },
  {
    timeZone: "Europe/Paris",
    patterns: [
      /\beurope\/paris\b/i,
      /\bparis\b/i,
      /\bfrance\b/i,
      /\b(?:cet|cest)\b/i,
    ],
  },
  {
    timeZone: "Asia/Tokyo",
    patterns: [
      /\basia\/tokyo\b/i,
      /\btokyo\b/i,
      /\bjapan\b/i,
      /\bjst\b/i,
    ],
  },
  {
    timeZone: "Asia/Kolkata",
    patterns: [
      /\basia\/kolkata\b/i,
      /\bindia\b/i,
      /\bkolkata\b/i,
      /\bmumbai\b/i,
      /\bist\b/i,
    ],
  },
  {
    timeZone: "Australia/Sydney",
    patterns: [
      /\baustralia\/sydney\b/i,
      /\bsydney\b/i,
      /\baustralia\b/i,
      /\b(?:aest|aedt)\b/i,
    ],
  },
];

function isValidTimeZone(value) {
  if (!value) return false;
  try {
    Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch (error) {
    return false;
  }
}

function extractIanaTimeZone(text) {
  const candidates = String(text || "").match(/[A-Za-z_]+\/[A-Za-z0-9_+\-]+(?:\/[A-Za-z0-9_+\-]+)?/g) || [];
  for (const candidate of candidates) {
    if (isValidTimeZone(candidate)) {
      return candidate;
    }
  }
  return null;
}

function extractUtcOffsetTimeZone(text) {
  const match = String(text || "").match(/\b(?:utc|gmt)\s*([+-])\s*(\d{1,2})(?::?(\d{2}))?\b/i);
  if (!match) return null;
  const sign = match[1];
  const hours = Number(match[2]);
  const minutes = Number(match[3] || 0);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return null;
  if (hours < 0 || hours > 14 || minutes < 0 || minutes >= 60) return null;
  if (minutes !== 0) return null;
  if (hours === 0) return "UTC";
  const etcSign = sign === "+" ? "-" : "+";
  const candidate = `Etc/GMT${etcSign}${hours}`;
  return isValidTimeZone(candidate) ? candidate : null;
}

function inferTimeZoneFromLocation(location, fallback = "UTC") {
  const fallbackTimeZone = isValidTimeZone(fallback) ? fallback : "UTC";
  const raw = String(location || "").trim();
  if (!raw) return fallbackTimeZone;

  const directIana = extractIanaTimeZone(raw);
  if (directIana) return directIana;

  const utcOffsetZone = extractUtcOffsetTimeZone(raw);
  if (utcOffsetZone) return utcOffsetZone;

  for (const rule of locationTimeZoneRules) {
    if (rule.patterns.some((pattern) => pattern.test(raw))) {
      return rule.timeZone;
    }
  }
  return fallbackTimeZone;
}

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

function normalizeOccurrenceKey(value) {
  const date = value ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

function getOccurrenceKeyFromBlob(blob) {
  if (!blob) return null;
  if (typeof blob.occurrence_key === "string" && blob.occurrence_key.trim()) {
    return normalizeOccurrenceKey(blob.occurrence_key);
  }
  const recurrenceId = typeof blob.recurrence_id === "string" ? blob.recurrence_id.trim() : "";
  const blobId = typeof blob.id === "string" ? blob.id : "";
  if (recurrenceId && blobId.startsWith(`${recurrenceId}:`)) {
    return normalizeOccurrenceKey(blobId.slice(recurrenceId.length + 1));
  }
  return normalizeOccurrenceKey(blob.schedulable_timerange?.start);
}

function getOccurrenceOverride(blob) {
  if (!blob) return null;
  const key = getOccurrenceKeyFromBlob(blob);
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

function getBlobCalendarContext(blob) {
  const payload = blob?.recurrence_payload;
  const recurrencePayload = payload && typeof payload === "object" ? payload : {};
  const calendarView =
    recurrencePayload.calendar_view && typeof recurrencePayload.calendar_view === "object"
      ? recurrencePayload.calendar_view
      : null;
  const integrationSource =
    recurrencePayload.integration_source &&
    typeof recurrencePayload.integration_source === "object"
      ? recurrencePayload.integration_source
      : null;
  const calendarViewId = String(calendarView?.id || "").trim();
  const isMain =
    Boolean(calendarView?.is_main) ||
    calendarViewId === "main" ||
    (!calendarView && !integrationSource);
  return {
    calendarView,
    integrationSource,
    calendarViewId,
    isMain,
  };
}

function isBlobEditableInMainUi(blob) {
  return getBlobCalendarContext(blob).isMain;
}

function overlaps(rangeStart, rangeEnd, eventStart, eventEnd) {
  return eventStart < rangeEnd && eventEnd > rangeStart;
}

function compareTimedBlocks(left, right) {
  return left.startMin - right.startMin || right.endMin - left.endMin;
}

function blockOverlaps(left, right) {
  return overlaps(left.startMin, left.endMin, right.startMin, right.endMin);
}

function clampNumber(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function estimateNameReadableWidth(block) {
  const title = String(block?.title || "").trim();
  const length = Math.min(42, title.length || 8);
  return clampNumber(0.54 + length * 0.005, 0.56, 0.78);
}

function estimateTimeReadableWidth(block) {
  const label = String(block?.time || "").trim();
  const length = Math.min(20, label.length || 11);
  return clampNumber(0.4 + length * 0.004, 0.44, 0.6);
}

function findReusableColumn(columns, block) {
  for (let index = 0; index < columns.length; index += 1) {
    const column = columns[index];
    const lastBlock = column[column.length - 1];
    if (!lastBlock || lastBlock.endMin <= block.startMin) {
      return index;
    }
  }
  return columns.length;
}

function getLocalColumnSignature(block, events) {
  const localColumns = new Set([block.column]);
  events.forEach((other) => {
    if (other === block) return;
    if (!blockOverlaps(block, other)) return;
    localColumns.add(other.column);
  });
  const ordered = Array.from(localColumns).sort((a, b) => a - b);
  const localIndex = ordered.indexOf(block.column);
  return {
    localIndex: localIndex < 0 ? 0 : localIndex,
    localTotal: Math.max(1, ordered.length),
  };
}

function toBlockHorizontalStyles({
  localIndex,
  localTotal,
  nameReadableWidth,
  timeReadableWidth,
}) {
  const insetPx = 8;
  const safeTotal = Math.max(1, localTotal);
  const safeIndex = clampNumber(localIndex, 0, safeTotal - 1);
  const minNameWidth = clampNumber(nameReadableWidth, 0.42, 0.9);
  const preferredTimeWidth = clampNumber(timeReadableWidth, minNameWidth, 0.9);
  let step = 0;
  if (safeTotal > 1) {
    const maxStepForReadable = (1 - preferredTimeWidth) / (safeTotal - 1);
    const visualStepCap = 0.1;
    step = Math.max(0, Math.min(visualStepCap, maxStepForReadable));
    if (safeIndex > 0) {
      const maxStepForNameAtIndex = (1 - minNameWidth) / safeIndex;
      step = Math.min(step, maxStepForNameAtIndex);
    }
  }
  const leftFraction = safeIndex * step;
  const widthFraction = Math.max(minNameWidth, 1 - leftFraction);
  return {
    leftCss: `calc(${insetPx}px + (100% - ${insetPx * 2}px) * ${leftFraction.toFixed(6)})`,
    widthCss: `calc((100% - ${insetPx * 2}px) * ${widthFraction.toFixed(6)})`,
  };
}

function toColumnLaneStyles(column, totalColumns) {
  const insetPx = 8;
  const safeColumns = Math.max(1, totalColumns);
  const leftFraction = clampNumber(column / safeColumns, 0, 1);
  const widthFraction = 1 / safeColumns;
  return {
    activeLeftCss: `calc(${insetPx}px + (100% - ${insetPx * 2}px) * ${leftFraction.toFixed(6)})`,
    activeWidthCss: `calc((100% - ${insetPx * 2}px) * ${widthFraction.toFixed(6)})`,
  };
}

function layoutBlocks(blocks) {
  const sorted = [...blocks].sort(compareTimedBlocks);
  const active = [];
  const clusters = [];
  let currentCluster = null;

  sorted.forEach((block) => {
    for (let i = active.length - 1; i >= 0; i -= 1) {
      if (active[i].endMin <= block.startMin) {
        active.splice(i, 1);
      }
    }

    if (active.length === 0) {
      currentCluster = { events: [] };
      clusters.push(currentCluster);
    }

    active.push(block);
    currentCluster.events.push(block);
  });

  clusters.forEach((cluster) => {
    // Pack each connected overlap cluster into the fewest columns, then size
    // each event from local (actual) overlap pressure instead of cluster-wide
    // pressure. Readability priority: title first, then time.
    const events = [...cluster.events].sort(compareTimedBlocks);
    const columns = [];

    events.forEach((block) => {
      const columnIndex = findReusableColumn(columns, block);
      if (!columns[columnIndex]) {
        columns[columnIndex] = [];
      }
      block.column = columnIndex;
      columns[columnIndex].push(block);
    });

    events.forEach((block) => {
      const { localIndex, localTotal } = getLocalColumnSignature(block, events);
      const { leftCss, widthCss } = toBlockHorizontalStyles({
        localIndex,
        localTotal,
        nameReadableWidth: estimateNameReadableWidth(block),
        timeReadableWidth: estimateTimeReadableWidth(block),
      });
      const { activeLeftCss, activeWidthCss } = toColumnLaneStyles(
        block.column,
        columns.length
      );
      block.columns = localTotal;
      block.columnSpan = 1;
      block.leftCss = leftCss;
      block.widthCss = widthCss;
      block.activeLeftCss = activeLeftCss;
      block.activeWidthCss = activeWidthCss;
    });
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
  getBlobCalendarContext,
  getOccurrenceKeyFromBlob,
  getOccurrenceOverride,
  isBlobEditableInMainUi,
  getLocalTimeZone,
  getTimeZoneParts,
  normalizeOccurrenceKey,
  formatDateTimeLocalInTimeZone,
  formatIsoInTimeZone,
  toProjectIsoFromLocalInput,
  toProjectIsoFromDate,
  toLocalInputValueInTimeZone,
  toZonedDate,
  inferTimeZoneFromLocation,
  formatTimeRangeInTimeZone,
  layoutBlocks,
  overlaps,
  shiftAnchorDate,
  startOfDay,
  toDate,
  toIso,
  toLocalInputFromDate,
  toLocalInputValue,
  zonedTimeToUtcFromParts,
};
