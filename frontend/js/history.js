import { alertDialog } from "./popups.js";
import { createRecurrence, deleteRecurrence, updateRecurrence } from "./api.js";

const STORAGE_KEY = "elastisched:history";
const undoStack = [];
const redoStack = [];

function persistHistory() {
  try {
    const payload = JSON.stringify({ undo: undoStack, redo: redoStack });
    window.sessionStorage.setItem(STORAGE_KEY, payload);
  } catch (error) {
    // Ignore storage errors.
  }
}

function loadHistory() {
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const data = JSON.parse(raw);
    undoStack.length = 0;
    redoStack.length = 0;
    if (Array.isArray(data.undo)) {
      undoStack.push(...data.undo);
    }
    if (Array.isArray(data.redo)) {
      redoStack.push(...data.redo);
    }
  } catch (error) {
    // Ignore storage errors.
  }
}

function refreshCalendar() {
  if (typeof window.elastischedRefresh === "function") {
    window.elastischedRefresh();
    return;
  }
  window.dispatchEvent(new CustomEvent("elastisched:refresh"));
}

function shouldRefresh(options = {}) {
  return options.refresh !== false;
}

async function runUndo(record, options = {}) {
  if (!record) return;
  if (record.type === "transaction") {
    const records = Array.isArray(record.data?.records) ? record.data.records : [];
    for (let index = records.length - 1; index >= 0; index -= 1) {
      await runUndo(records[index], { refresh: false });
    }
    if (shouldRefresh(options)) {
      refreshCalendar();
    }
    return;
  }
  if (record.type === "update-recurrence") {
    const { recurrenceId, recurrenceType, beforePayload } = record.data || {};
    if (!recurrenceId || !beforePayload) return;
    await updateRecurrence(recurrenceId, recurrenceType || "single", beforePayload);
    if (shouldRefresh(options)) {
      refreshCalendar();
    }
    return;
  }
  if (record.type === "create-recurrence") {
    const { recurrenceId, createdId } = record.data || {};
    const targetId = createdId || recurrenceId;
    if (!targetId) return;
    await deleteRecurrence(targetId);
    if (shouldRefresh(options)) {
      refreshCalendar();
    }
    return;
  }
  if (record.type === "delete-recurrence") {
    const { recurrenceType, payload } = record.data || {};
    if (!payload) return;
    const created = await createRecurrence(recurrenceType || "single", payload);
    record.data.restoredId = created?.id || null;
    persistHistory();
    if (shouldRefresh(options)) {
      refreshCalendar();
    }
  }
}

async function runRedo(record, options = {}) {
  if (!record) return;
  if (record.type === "transaction") {
    const records = Array.isArray(record.data?.records) ? record.data.records : [];
    for (const item of records) {
      await runRedo(item, { refresh: false });
    }
    if (shouldRefresh(options)) {
      refreshCalendar();
    }
    return;
  }
  if (record.type === "update-recurrence") {
    const { recurrenceId, recurrenceType, afterPayload } = record.data || {};
    if (!recurrenceId || !afterPayload) return;
    await updateRecurrence(recurrenceId, recurrenceType || "single", afterPayload);
    if (shouldRefresh(options)) {
      refreshCalendar();
    }
    return;
  }
  if (record.type === "create-recurrence") {
    const { recurrenceType, payload } = record.data || {};
    if (!payload) return;
    const created = await createRecurrence(recurrenceType || "single", payload);
    record.data.createdId = created?.id || null;
    persistHistory();
    if (shouldRefresh(options)) {
      refreshCalendar();
    }
    return;
  }
  if (record.type === "delete-recurrence") {
    const { recurrenceId, restoredId } = record.data || {};
    const targetId = restoredId || recurrenceId;
    if (!targetId) return;
    await deleteRecurrence(targetId);
    if (shouldRefresh(options)) {
      refreshCalendar();
    }
  }
}

function pushHistoryAction(record) {
  if (!record || !record.type) return;
  undoStack.push(record);
  redoStack.length = 0;
  persistHistory();
}

async function undoHistoryAction() {
  const record = undoStack.pop();
  if (!record) return false;
  try {
    await runUndo(record);
  } catch (error) {
    await alertDialog(error?.message || "Undo failed.");
    undoStack.push(record);
    return false;
  }
  redoStack.push(record);
  persistHistory();
  return true;
}

async function redoHistoryAction() {
  const record = redoStack.pop();
  if (!record) return false;
  try {
    await runRedo(record);
  } catch (error) {
    await alertDialog(error?.message || "Redo failed.");
    redoStack.push(record);
    return false;
  }
  undoStack.push(record);
  persistHistory();
  return true;
}

loadHistory();

export { pushHistoryAction, redoHistoryAction, undoHistoryAction };
