import {
  createRecurrence,
  deleteRecurrence,
  getRecurrence,
  moveOccurrenceToMain,
  moveRecurrenceToMain,
  updateRecurrence,
} from "./api.js";
import { appConfig } from "./core.js";
import { pushHistoryAction } from "./history.js";
import { getOccurrenceKeyFromBlob, toProjectIsoFromDate } from "./utils.js";

function refreshCalendar() {
  window.dispatchEvent(new CustomEvent("elastisched:refresh"));
}

function serializeRange(range) {
  if (!range?.start || !range?.end) return null;
  return {
    start: toProjectIsoFromDate(range.start, appConfig.projectTimeZone),
    end: toProjectIsoFromDate(range.end, appConfig.projectTimeZone),
  };
}

function normalizeOccurrenceKey(value) {
  if (!value) return "";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return String(value);
  return parsed.toISOString();
}

function clonePayload(payload) {
  return payload && typeof payload === "object" ? { ...payload } : {};
}

function toUpdateRecord(recurrenceId, recurrenceType, beforePayload, afterPayload) {
  return {
    type: "update-recurrence",
    data: {
      recurrenceId,
      recurrenceType,
      beforePayload,
      afterPayload,
    },
  };
}

function toDeleteRecord(recurrenceId, recurrenceType, payload) {
  return {
    type: "delete-recurrence",
    data: {
      recurrenceId,
      recurrenceType,
      payload,
      restoredId: null,
    },
  };
}

function toCreateRecord(recurrenceType, payload, createdId = null) {
  return {
    type: "create-recurrence",
    data: {
      recurrenceId: createdId,
      recurrenceType,
      payload,
      createdId,
    },
  };
}

function maybePushRecord(record, options = {}) {
  if (options.skipHistory) return;
  pushHistoryAction(record);
}

function maybeRefresh(options = {}) {
  if (options.skipRefresh) return;
  refreshCalendar();
}

function createTransactionRecord(records) {
  const compact = Array.isArray(records) ? records.filter(Boolean) : [];
  if (compact.length === 1) return compact[0];
  return { type: "transaction", data: { records: compact } };
}

async function deleteRecurrenceInternal(recurrenceId, previous = null) {
  if (!recurrenceId) return null;
  const existing = previous || (await getRecurrence(recurrenceId));
  await deleteRecurrence(recurrenceId);
  return toDeleteRecord(recurrenceId, existing.type, existing.payload);
}

async function deleteOccurrenceInternal(blob, previous = null) {
  if (!blob?.recurrence_id) return null;
  const occurrenceStart = getOccurrenceKeyFromBlob(blob);
  if (!occurrenceStart) return null;
  const existing = previous || (await getRecurrence(blob.recurrence_id));
  const payload = clonePayload(existing.payload);
  const recurrenceType = existing.type || blob.recurrence_type || "single";
  if (recurrenceType === "multiple") {
    const blobs = Array.isArray(payload.blobs) ? payload.blobs : [];
    const targetKey = normalizeOccurrenceKey(occurrenceStart);
    const remaining = blobs.filter((item) => {
      const itemStart = item?.schedulable_timerange?.start;
      if (!itemStart) return true;
      return normalizeOccurrenceKey(itemStart) !== targetKey;
    });
    if (remaining.length === 0) {
      return deleteRecurrenceInternal(blob.recurrence_id, existing);
    }
    const nextPayload = { ...payload, blobs: remaining };
    await updateRecurrence(blob.recurrence_id, recurrenceType, nextPayload);
    return toUpdateRecord(blob.recurrence_id, recurrenceType, payload, nextPayload);
  }
  if (recurrenceType === "single") {
    return deleteRecurrenceInternal(blob.recurrence_id, existing);
  }
  const existingExclusions = Array.isArray(payload.exclusions) ? payload.exclusions : [];
  const nextExclusions = Array.from(new Set([...existingExclusions, occurrenceStart]));
  const nextPayload = { ...payload, exclusions: nextExclusions };
  await updateRecurrence(blob.recurrence_id, recurrenceType, nextPayload);
  return toUpdateRecord(blob.recurrence_id, recurrenceType, payload, nextPayload);
}

function buildSingleOccurrencePayload(blob, defaultScheduledRange, schedulableRange) {
  const payload = blob?.recurrence_payload || {};
  return {
    recurrence_name: payload.recurrence_name || blob?.name || null,
    recurrence_description: payload.recurrence_description || blob?.description || null,
    color: payload.color || null,
    blob: {
      name: blob?.name || payload.recurrence_name || "Untitled",
      description: blob?.description || payload.recurrence_description || null,
      location: blob?.location || payload?.blob?.location || null,
      tz: blob?.tz || appConfig.userTimeZone,
      default_scheduled_timerange: serializeRange(defaultScheduledRange),
      schedulable_timerange: serializeRange(schedulableRange),
      policy: blob?.policy || {},
      dependencies: Array.isArray(blob?.dependencies) ? blob.dependencies : [],
      tags: Array.isArray(blob?.tags) ? blob.tags : [],
    },
  };
}

function buildUpdatedOccurrenceValues(blob, changes = {}) {
  const defaultStart = changes.defaultStart || new Date(blob?.default_scheduled_timerange?.start);
  const defaultEnd = changes.defaultEnd || new Date(blob?.default_scheduled_timerange?.end);
  const schedStart = changes.schedStart || new Date(blob?.schedulable_timerange?.start);
  const schedEnd = changes.schedEnd || new Date(blob?.schedulable_timerange?.end);
  const defaultScheduledRange =
    defaultStart instanceof Date && defaultEnd instanceof Date
      ? { start: defaultStart, end: defaultEnd }
      : null;
  const schedulableRange =
    schedStart instanceof Date && schedEnd instanceof Date
      ? { start: schedStart, end: schedEnd }
      : null;
  const name = Object.prototype.hasOwnProperty.call(changes, "name")
    ? changes.name
    : blob?.name || "";
  const description = Object.prototype.hasOwnProperty.call(changes, "description")
    ? changes.description
    : blob?.description || null;
  const location = Object.prototype.hasOwnProperty.call(changes, "location")
    ? changes.location
    : blob?.location || null;
  const tags = Object.prototype.hasOwnProperty.call(changes, "tags")
    ? (Array.isArray(changes.tags) ? changes.tags : [])
    : (Array.isArray(blob?.tags) ? blob.tags : []);
  const dependencies = Object.prototype.hasOwnProperty.call(changes, "dependencies")
    ? (Array.isArray(changes.dependencies) ? changes.dependencies : [])
    : (Array.isArray(blob?.dependencies) ? blob.dependencies : []);
  const policy = Object.prototype.hasOwnProperty.call(changes, "policy")
    ? (changes.policy || {})
    : (blob?.policy || {});
  return {
    defaultScheduledRange,
    schedulableRange,
    name,
    description,
    location,
    tags,
    dependencies,
    policy,
  };
}

function validateOccurrenceRanges(defaultScheduledRange, schedulableRange) {
  if (!defaultScheduledRange || !schedulableRange) {
    throw new Error("Missing occurrence timing.");
  }
  if (
    Number.isNaN(defaultScheduledRange.start?.getTime?.()) ||
    Number.isNaN(defaultScheduledRange.end?.getTime?.()) ||
    Number.isNaN(schedulableRange.start?.getTime?.()) ||
    Number.isNaN(schedulableRange.end?.getTime?.())
  ) {
    throw new Error("Invalid occurrence timing.");
  }
  if (defaultScheduledRange.end <= defaultScheduledRange.start) {
    throw new Error("Default end must be after default start.");
  }
  if (schedulableRange.end <= schedulableRange.start) {
    throw new Error("Schedulable end must be after schedulable start.");
  }
  if (
    schedulableRange.start > defaultScheduledRange.start ||
    schedulableRange.end < defaultScheduledRange.end
  ) {
    throw new Error("Schedulable range must contain default range.");
  }
}

async function updateOccurrenceTimingWithUndo(
  blob,
  { defaultScheduledRange = null, schedulableRange = null } = {},
  options = {}
) {
  return updateOccurrenceWithUndo(
    blob,
    {
      ...(defaultScheduledRange ? {
        defaultStart: defaultScheduledRange.start,
        defaultEnd: defaultScheduledRange.end,
      } : {}),
      ...(schedulableRange ? {
        schedStart: schedulableRange.start,
        schedEnd: schedulableRange.end,
      } : {}),
    },
    options
  );
}

async function updateOccurrenceWithUndo(blob, changes = {}, options = {}) {
  if (!blob?.recurrence_id) return null;
  if (!changes || !Object.keys(changes).length) return null;
  const previous = await getRecurrence(blob.recurrence_id);
  const payload = clonePayload(previous.payload);
  const recurrenceType = previous.type || blob.recurrence_type || "single";
  const nextValues = buildUpdatedOccurrenceValues(blob, changes);
  validateOccurrenceRanges(nextValues.defaultScheduledRange, nextValues.schedulableRange);

  if (recurrenceType === "single") {
    const nextPayload = {
      ...payload,
      blob: {
        ...(payload.blob || {}),
        name: nextValues.name,
        description: nextValues.description,
        location: nextValues.location,
        default_scheduled_timerange: serializeRange(nextValues.defaultScheduledRange),
        schedulable_timerange: serializeRange(nextValues.schedulableRange),
        policy: nextValues.policy,
        dependencies: nextValues.dependencies,
        tags: nextValues.tags,
      },
    };
    await updateRecurrence(blob.recurrence_id, recurrenceType, nextPayload);
    const record = toUpdateRecord(blob.recurrence_id, recurrenceType, payload, nextPayload);
    maybePushRecord(record, options);
    maybeRefresh(options);
    return record;
  }

  if (recurrenceType === "multiple") {
    const occurrenceKey = normalizeOccurrenceKey(getOccurrenceKeyFromBlob(blob));
    const nextPayload = {
      ...payload,
      blobs: (Array.isArray(payload.blobs) ? payload.blobs : []).map((item) => {
        const itemKey = normalizeOccurrenceKey(item?.schedulable_timerange?.start);
        if (itemKey !== occurrenceKey) {
          return item;
        }
        return {
          ...item,
          name: nextValues.name,
          description: nextValues.description,
          location: nextValues.location,
          default_scheduled_timerange: serializeRange(nextValues.defaultScheduledRange),
          schedulable_timerange: serializeRange(nextValues.schedulableRange),
          policy: nextValues.policy,
          dependencies: nextValues.dependencies,
          tags: nextValues.tags,
        };
      }),
    };
    await updateRecurrence(blob.recurrence_id, recurrenceType, nextPayload);
    const record = toUpdateRecord(blob.recurrence_id, recurrenceType, payload, nextPayload);
    maybePushRecord(record, options);
    maybeRefresh(options);
    return record;
  }

  const deleteRecord = await deleteOccurrenceInternal(blob, previous);
  const exceptionalPayload = buildSingleOccurrencePayload(
    {
      ...blob,
      name: nextValues.name,
      description: nextValues.description,
      location: nextValues.location,
      policy: nextValues.policy,
      dependencies: nextValues.dependencies,
      tags: nextValues.tags,
    },
    nextValues.defaultScheduledRange,
    nextValues.schedulableRange
  );
  const created = await createRecurrence("single", exceptionalPayload);
  const createRecord = toCreateRecord("single", exceptionalPayload, created?.id || null);
  const record = createTransactionRecord([deleteRecord, createRecord]);
  maybePushRecord(record, options);
  maybeRefresh(options);
  return record;
}

async function updateOccurrencesWithUndo(blobs, changes = {}) {
  const unique = [];
  const seen = new Set();
  (Array.isArray(blobs) ? blobs : []).forEach((blob) => {
    if (!blob?.id || seen.has(blob.id)) return;
    seen.add(blob.id);
    unique.push(blob);
  });
  if (!unique.length) return null;
  const records = [];
  for (const blob of unique) {
    const record = await updateOccurrenceWithUndo(blob, changes, {
      skipHistory: true,
      skipRefresh: true,
    });
    if (record) {
      records.push(record);
    }
  }
  const combined = createTransactionRecord(records);
  if (!combined) return null;
  pushHistoryAction(combined);
  refreshCalendar();
  return combined;
}

async function deleteRecurrenceWithUndo(recurrenceId, options = {}) {
  if (!recurrenceId) return null;
  const record = await deleteRecurrenceInternal(recurrenceId);
  maybePushRecord(record, options);
  maybeRefresh(options);
  return record;
}

async function deleteOccurrenceWithUndo(blob, options = {}) {
  if (!blob?.recurrence_id) return null;
  const record = await deleteOccurrenceInternal(blob);
  maybePushRecord(record, options);
  maybeRefresh(options);
  return record;
}

async function deleteOccurrencesWithUndo(blobs) {
  const unique = [];
  const seen = new Set();
  (Array.isArray(blobs) ? blobs : []).forEach((blob) => {
    if (!blob?.id || seen.has(blob.id)) return;
    seen.add(blob.id);
    unique.push(blob);
  });
  if (!unique.length) return null;
  const records = [];
  for (const blob of unique) {
    const record = await deleteOccurrenceInternal(blob);
    if (record) {
      records.push(record);
    }
  }
  const combined = createTransactionRecord(records);
  if (!combined) return null;
  pushHistoryAction(combined);
  refreshCalendar();
  return combined;
}

async function moveRecurrenceToMainWithRefresh(recurrenceId) {
  if (!recurrenceId) return null;
  const result = await moveRecurrenceToMain(recurrenceId);
  refreshCalendar();
  return result;
}

async function moveOccurrenceToMainWithRefresh(blob) {
  if (!blob?.recurrence_id) return null;
  const occurrenceStart = getOccurrenceKeyFromBlob(blob);
  if (!occurrenceStart) return null;
  const result = await moveOccurrenceToMain(blob.recurrence_id, occurrenceStart);
  refreshCalendar();
  return result;
}

export {
  deleteOccurrenceWithUndo,
  deleteOccurrencesWithUndo,
  deleteRecurrenceWithUndo,
  moveRecurrenceToMainWithRefresh,
  moveOccurrenceToMainWithRefresh,
  updateOccurrencesWithUndo,
  updateOccurrenceWithUndo,
  updateOccurrenceTimingWithUndo,
};
