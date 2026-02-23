import {
  createRecurrence,
  deleteRecurrence,
  getRecurrence,
  moveOccurrenceToMain,
  moveRecurrenceToMain,
  updateRecurrence,
} from "./api.js";
import { pushHistoryAction } from "./history.js";

function refreshCalendar() {
  window.dispatchEvent(new CustomEvent("elastisched:refresh"));
}

async function deleteRecurrenceWithUndo(recurrenceId) {
  if (!recurrenceId) return;
  const previous = await getRecurrence(recurrenceId);
  await deleteRecurrence(recurrenceId);
  pushHistoryAction({
    type: "delete-recurrence",
    data: {
      recurrenceId,
      recurrenceType: previous.type,
      payload: previous.payload,
      restoredId: null,
    },
  });
  refreshCalendar();
}

async function deleteOccurrenceWithUndo(blob) {
  if (!blob?.recurrence_id) return;
  const occurrenceStart = blob.schedulable_timerange?.start;
  if (!occurrenceStart) return;
  const previous = await getRecurrence(blob.recurrence_id);
  const payload = previous.payload || {};
  const recurrenceType = previous.type || blob.recurrence_type || "single";
  const normalizeKey = (value) => {
    if (!value) return "";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    return date.toISOString();
  };
  if (recurrenceType === "multiple") {
    const blobs = Array.isArray(payload.blobs) ? payload.blobs : [];
    const targetKey = normalizeKey(occurrenceStart);
    const remaining = blobs.filter((item) => {
      const itemStart = item?.schedulable_timerange?.start;
      if (!itemStart) return true;
      const itemKey = normalizeKey(itemStart);
      return itemKey !== targetKey;
    });
    if (remaining.length === 0) {
      await deleteRecurrenceWithUndo(blob.recurrence_id);
      return;
    }
    const nextPayload = { ...payload, blobs: remaining };
    await updateRecurrence(blob.recurrence_id, recurrenceType, nextPayload);
    pushHistoryAction({
      type: "update-recurrence",
      data: {
        recurrenceId: blob.recurrence_id,
        recurrenceType,
        beforePayload: payload,
        afterPayload: nextPayload,
      },
    });
    refreshCalendar();
    return;
  }
  const existing = Array.isArray(payload.exclusions) ? payload.exclusions : [];
  const nextExclusions = Array.from(new Set([...existing, occurrenceStart]));
  const nextPayload = { ...payload, exclusions: nextExclusions };
  await updateRecurrence(blob.recurrence_id, recurrenceType, nextPayload);
  pushHistoryAction({
    type: "update-recurrence",
    data: {
      recurrenceId: blob.recurrence_id,
      recurrenceType,
      beforePayload: payload,
      afterPayload: nextPayload,
    },
  });
  refreshCalendar();
}

async function moveRecurrenceToMainWithRefresh(recurrenceId) {
  if (!recurrenceId) return null;
  const result = await moveRecurrenceToMain(recurrenceId);
  refreshCalendar();
  return result;
}

async function moveOccurrenceToMainWithRefresh(blob) {
  if (!blob?.recurrence_id) return null;
  const occurrenceStart = blob.schedulable_timerange?.start;
  if (!occurrenceStart) return null;
  const result = await moveOccurrenceToMain(blob.recurrence_id, occurrenceStart);
  refreshCalendar();
  return result;
}

export {
  deleteOccurrenceWithUndo,
  deleteRecurrenceWithUndo,
  moveRecurrenceToMainWithRefresh,
  moveOccurrenceToMainWithRefresh,
};
