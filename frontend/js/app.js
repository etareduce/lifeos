import { appConfig, applyTheme, isTypingInField, loadView, state } from "./core.js";
import { dom } from "./dom.js";
import {
  ensureOccurrences,
  fetchScheduleStatus,
  getRecurrence,
  runSchedule,
  updateRecurrence,
} from "./api.js";
import { pushHistoryAction, redoHistoryAction, undoHistoryAction } from "./history.js";
import { alertDialog, bindDialogEvents, confirmDialog } from "./popups.js";
import {
  bindFormHandlers,
  openCreateForm,
  openEditForm,
  resetFormMode,
  toggleForm,
  toggleSettings,
  toggleHelp,
} from "./forms.js";
import {
  clearInfoCardLock,
  setActive,
  updateNowIndicators,
} from "./render.js";
import {
  formatTimeRangeInTimeZone,
  getEffectiveOccurrenceRange,
  getViewRange,
  shiftAnchorDate,
  toProjectIsoFromDate,
} from "./utils.js";

dom.brandTitle.textContent = appConfig.scheduleName || dom.brandTitle.textContent;
dom.brandSubtitle.textContent = appConfig.subtitle || dom.brandSubtitle.textContent;
applyTheme(appConfig.theme);
if (dom.timeZoneLabel) {
  dom.timeZoneLabel.textContent = appConfig.userTimeZone || "Local";
}

bindFormHandlers(refreshView);

async function refreshView(nextView = state.view) {
  const view = nextView || state.view;
  setActive(view, { deferRender: true });
  const range = getViewRange(view, state.anchorDate);
  await ensureOccurrences(range.start, range.end);
  setActive(view);
  await refreshScheduleStatus();
  renderNowPanel();
  updateNowIndicators();
}

function setScheduleStatusState(mode, message) {
  if (!dom.scheduleStatus || !dom.scheduleStatusText) return;
  dom.scheduleStatus.classList.remove("clean", "dirty", "running", "error");
  if (mode) {
    dom.scheduleStatus.classList.add(mode);
  }
  dom.scheduleStatusText.textContent = message;
}

async function refreshScheduleStatus() {
  if (!dom.scheduleStatus || !dom.scheduleStatusText) return;
  try {
    const status = await fetchScheduleStatus();
    state.scheduleDirty = Boolean(status.dirty);
    state.scheduleLastRun = status.last_run || null;
    const label = state.scheduleDirty ? "Schedule out of date" : "Schedule up to date";
    setScheduleStatusState(state.scheduleDirty ? "dirty" : "clean", label);
    if (state.scheduleLastRun) {
      const lastRun = new Date(state.scheduleLastRun);
      if (!Number.isNaN(lastRun.getTime())) {
        dom.scheduleStatus.title = `Last run: ${lastRun.toLocaleString()}`;
      }
    }
  } catch (error) {
    setScheduleStatusState("error", "Schedule status unavailable");
  }
}

async function handleRunSchedule() {
  if (state.scheduleRunning) return;
  state.scheduleRunning = true;
  if (dom.runScheduleBtn) {
    dom.runScheduleBtn.disabled = true;
  }
  setScheduleStatusState("running", "Scheduling...");
  try {
    await runSchedule(appConfig.minuteGranularity, appConfig.lookaheadSeconds);
    await refreshView(state.view);
  } catch (error) {
    setScheduleStatusState("error", error?.message || "Scheduler failed");
  } finally {
    state.scheduleRunning = false;
    if (dom.runScheduleBtn) {
      dom.runScheduleBtn.disabled = false;
    }
  }
}

function getOccurrenceRange(blob) {
  const effective = getEffectiveOccurrenceRange(blob);
  if (!effective) return null;
  return { start: effective.start, end: effective.effectiveEnd };
}

function getCurrentOccurrences() {
  const now = new Date();
  return state.blobs
    .map((blob) => {
      const range = getOccurrenceRange(blob);
      if (!range) return null;
      if (now < range.start || now >= range.end) return null;
      return { blob, range };
    })
    .filter(Boolean)
    .sort((a, b) => a.range.start - b.range.start);
}

function ensureSelectedOccurrence(current) {
  if (!current.length) {
    state.currentOccurrenceId = null;
    return;
  }
  const exists = current.some((item) => item.blob.id === state.currentOccurrenceId);
  if (!exists) {
    state.currentOccurrenceId = current[0].blob.id;
  }
}

function renderNowPanel() {
  if (!dom.nowPanel || !dom.nowTime || !dom.nowDate || !dom.nowEvents) return;
  const now = new Date();
  const timeFormatter = new Intl.DateTimeFormat(undefined, {
    timeZone: appConfig.userTimeZone,
    hour: "2-digit",
    minute: "2-digit",
  });
  const dateFormatter = new Intl.DateTimeFormat(undefined, {
    timeZone: appConfig.userTimeZone,
    weekday: "short",
    month: "short",
    day: "numeric",
  });
  dom.nowTime.textContent = timeFormatter.format(now);
  dom.nowDate.textContent = dateFormatter.format(now);

  const current = getCurrentOccurrences();
  ensureSelectedOccurrence(current);
  const activeId = state.currentOccurrenceId;

  if (!current.length) {
    dom.nowEvents.innerHTML = `<div class="now-empty">No active events.</div>`;
    if (dom.finishNowBtn) dom.finishNowBtn.disabled = true;
    if (dom.addTimeBtn) dom.addTimeBtn.disabled = true;
    const addMenu = dom.addTimeBtn?.closest(".add-time-menu");
    if (addMenu) addMenu.classList.add("disabled");
    return;
  }

  const eventHtml = current
    .map(({ blob }) => {
      const timeZone = blob?.tz || appConfig.userTimeZone;
      const effectiveRange = getEffectiveOccurrenceRange(blob);
      if (!effectiveRange) return "";
      const timeLabel = formatTimeRangeInTimeZone(
        effectiveRange.start,
        effectiveRange.effectiveEnd,
        timeZone
      );
      return `
        <button class="now-event ${blob.id === activeId ? "active" : ""}" data-occurrence-id="${blob.id}" type="button">
          <span class="now-event-title">${blob.name || "Untitled"}</span>
          <span class="now-event-time">${timeLabel}</span>
        </button>
      `;
    })
    .join("");
  dom.nowEvents.innerHTML = eventHtml;
  if (dom.finishNowBtn) dom.finishNowBtn.disabled = false;
  if (dom.addTimeBtn) dom.addTimeBtn.disabled = false;
  const addMenu = dom.addTimeBtn?.closest(".add-time-menu");
  if (addMenu) addMenu.classList.remove("disabled");
}

function getSelectedOccurrence() {
  if (!state.currentOccurrenceId) return null;
  return state.blobs.find((blob) => blob.id === state.currentOccurrenceId) || null;
}

async function extendOccurrenceByMinutes(minutes) {
  const blob = getSelectedOccurrence();
  if (!blob) return;
  if (!Number.isFinite(minutes) || minutes <= 0) return;
  const effective = getEffectiveOccurrenceRange(blob);
  if (!effective) return;
  const schedEnd = new Date(blob.schedulable_timerange?.end);
  if (Number.isNaN(schedEnd.getTime())) return;
  const occurrenceKey = blob.schedulable_timerange?.start;
  if (!occurrenceKey) return;
  let previous = null;
  try {
    previous = await getRecurrence(blob.recurrence_id);
  } catch (error) {
    await alertDialog(error?.message || "Unable to load recurrence.");
    return;
  }
  const payload = previous.payload || {};
  const overrides =
    payload.occurrence_overrides && typeof payload.occurrence_overrides === "object"
      ? { ...payload.occurrence_overrides }
      : {};
  const currentOverride = overrides[occurrenceKey] || {};
  let currentAdded = Number(currentOverride?.added_minutes || 0);
  if (!Number.isFinite(currentAdded)) currentAdded = 0;
  const nextAdded = currentAdded + minutes;
  const nextEnd = new Date(effective.end.getTime() + nextAdded * 60000);
  let schedulableEndOverride = null;
  if (nextEnd > schedEnd) {
    const confirmed = await confirmDialog(
      "This extends beyond the schedulable window. Continue anyway?",
      { confirmText: "Extend", cancelText: "Cancel" }
    );
    if (!confirmed) return;
    schedulableEndOverride = nextEnd;
  }
  const nextOverride = {
    ...(currentOverride || {}),
    added_minutes: nextAdded,
  };
  if (schedulableEndOverride) {
    nextOverride.schedulable_timerange = {
      start: blob.schedulable_timerange?.start,
      end: toProjectIsoFromDate(schedulableEndOverride, appConfig.projectTimeZone),
    };
  }
  if (nextOverride.finished_at) {
    delete nextOverride.finished_at;
  }
  overrides[occurrenceKey] = nextOverride;
  const nextPayload = { ...payload, occurrence_overrides: overrides };

  try {
    await updateRecurrence(
      blob.recurrence_id,
      blob.recurrence_type || previous.type || "single",
      nextPayload
    );
    pushHistoryAction({
      type: "update-recurrence",
      data: {
        recurrenceId: blob.recurrence_id,
        recurrenceType: blob.recurrence_type || previous.type || "single",
        beforePayload: payload,
        afterPayload: nextPayload,
      },
    });
    state.loadedRange = null;
    await refreshView(state.view);
  } catch (error) {
    await alertDialog(error?.message || "Failed to update occurrence.");
  }
}

async function handleFinishNow() {
  const blob = getSelectedOccurrence();
  if (!blob) return;
  const effective = getEffectiveOccurrenceRange(blob);
  if (!effective) return;
  const bufferMinutes = Math.max(1, Number(appConfig.finishEarlyBufferMinutes || 15));
  const threshold = new Date(
    effective.effectiveEnd.getTime() - bufferMinutes * 60000
  );
  const now = new Date();
  const occurrenceKey = blob.schedulable_timerange?.start;
  if (!occurrenceKey) return;
  let previous = null;
  try {
    previous = await getRecurrence(blob.recurrence_id);
  } catch (error) {
    await alertDialog(error?.message || "Unable to load recurrence.");
    return;
  }
  const payload = previous.payload || {};
  const overrides =
    payload.occurrence_overrides && typeof payload.occurrence_overrides === "object"
      ? { ...payload.occurrence_overrides }
      : {};
  const currentOverride = overrides[occurrenceKey] || {};
  overrides[occurrenceKey] = {
    ...(currentOverride || {}),
    finished_at: toProjectIsoFromDate(now, appConfig.projectTimeZone),
  };
  const nextPayload = { ...payload, occurrence_overrides: overrides };
  try {
    await updateRecurrence(
      blob.recurrence_id,
      blob.recurrence_type || previous.type || "single",
      nextPayload
    );
    pushHistoryAction({
      type: "update-recurrence",
      data: {
        recurrenceId: blob.recurrence_id,
        recurrenceType: blob.recurrence_type || previous.type || "single",
        beforePayload: payload,
        afterPayload: nextPayload,
      },
    });
    state.loadedRange = null;
    await refreshView(state.view);
    if (now < threshold) {
      await handleRunSchedule();
    }
  } catch (error) {
    await alertDialog(error?.message || "Failed to finish occurrence.");
  }
}

dom.tabs.forEach((tab) => {
  tab.addEventListener("click", () => refreshView(tab.dataset.view));
});

if (dom.runScheduleBtn) {
  dom.runScheduleBtn.addEventListener("click", handleRunSchedule);
}

if (dom.nowEvents) {
  dom.nowEvents.addEventListener("click", (event) => {
    const target = event.target.closest("[data-occurrence-id]");
    if (!target) return;
    const occurrenceId = target.getAttribute("data-occurrence-id");
    if (!occurrenceId) return;
    state.currentOccurrenceId = occurrenceId;
    renderNowPanel();
  });
}

if (dom.finishNowBtn) {
  dom.finishNowBtn.addEventListener("click", () => {
    handleFinishNow();
  });
}

if (dom.addTimePopover) {
  dom.addTimePopover.addEventListener("click", (event) => {
    const button = event.target.closest("[data-add-minutes]");
    if (!button) return;
    const minutes = Number(button.getAttribute("data-add-minutes"));
    if (!Number.isFinite(minutes)) return;
    extendOccurrenceByMinutes(minutes);
  });
}

if (dom.addTimeForm) {
  dom.addTimeForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const formData = new FormData(dom.addTimeForm);
    const minutes = Number(formData.get("addMinutes") || 0);
    if (!Number.isFinite(minutes) || minutes <= 0) return;
    extendOccurrenceByMinutes(minutes);
    dom.addTimeForm.reset();
  });
}

document.addEventListener("click", (event) => {
  const target = event.target.closest(".week-day-label button, .month-day, .year-month");
  if (!target) return;
  const dateIso = target.getAttribute("data-date");
  if (!dateIso) return;
  state.anchorDate = new Date(dateIso);
  if (target.classList.contains("year-month")) {
    refreshView("month");
    return;
  }
  refreshView("day");
});

document.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-copy-blob-id]");
  if (!button) return;
  event.preventDefault();
  const blobId = button.getAttribute("data-copy-blob-id");
  if (!blobId) return;
  const originalLabel = button.textContent;
  button.textContent = "Copying...";
  try {
    await navigator.clipboard.writeText(blobId);
    button.textContent = "Copied";
  } catch (error) {
    button.textContent = "Copy failed";
  }
  window.setTimeout(() => {
    button.textContent = originalLabel;
  }, 1200);
});

document.addEventListener(
  "click",
  (event) => {
    if (!event.shiftKey) return;
    const target = event.target.closest("[data-blob-id]");
    if (!target) return;
    if (event.target.closest(".star-toggle")) return;
    if (dom.formPanel.classList.contains("active")) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const blobId = target.getAttribute("data-blob-id");
    const blob = state.blobs.find((item) => item.id === blobId);
    if (blob) {
      openEditForm(blob);
    }
  },
  true
);

document.addEventListener("click", (event) => {
  if (!dom.formPanel.classList.contains("active")) return;
  if (!state.editingRecurrenceId) return;
  if (dom.formPanel.contains(event.target)) return;
  toggleForm(false);
  resetFormMode();
});

window.addEventListener("keydown", (event) => {
  if (isTypingInField(event.target)) return;
  const hasMod = event.ctrlKey || event.metaKey;
  if (hasMod && event.key.toLowerCase() === "z") {
    event.preventDefault();
    if (event.shiftKey) {
      redoHistoryAction();
    } else {
      undoHistoryAction();
    }
    return;
  }
  if (hasMod && event.key.toLowerCase() === "y") {
    event.preventDefault();
    redoHistoryAction();
    return;
  }
  const isArrowLeft =
    event.key === "ArrowLeft" ||
    event.key === "Left" ||
    event.code === "ArrowLeft" ||
    event.keyCode === 37;
  const isArrowRight =
    event.key === "ArrowRight" ||
    event.key === "Right" ||
    event.code === "ArrowRight" ||
    event.keyCode === 39;
  if (event.key === "Escape") {
    clearInfoCardLock();
    if (dom.settingsModal.classList.contains("active")) {
      toggleSettings(false);
      dom.settingsStatus.textContent = "";
    }
    if (dom.helpModal?.classList.contains("active")) {
      toggleHelp(false);
    }
    if (dom.formPanel.classList.contains("active")) {
      toggleForm(false);
      resetFormMode();
    }
    return;
  }
  if (!hasMod && event.key.toLowerCase() === "n") {
    event.preventDefault();
    openCreateForm("task");
  }
  if (!hasMod && event.key.toLowerCase() === "c") {
    event.preventDefault();
    openCreateForm("event");
  }
  if (isArrowLeft || isArrowRight) {
    const direction = isArrowLeft ? -1 : 1;
    const view = state.view;
    const next = shiftAnchorDate(view, state.anchorDate, direction);
    if (!next) {
      return;
    }
    state.anchorDate = next;
    event.preventDefault();
    refreshView(view);
  }
});

resetFormMode();
bindDialogEvents();
window.elastischedRefresh = () => {
  state.loadedRange = null;
  refreshView(state.view);
};
window.addEventListener("elastisched:refresh", () => {
  window.elastischedRefresh?.();
});
const savedView = loadView();
refreshView(savedView || "day");
window.setInterval(() => {
  renderNowPanel();
  updateNowIndicators();
}, 30000);
