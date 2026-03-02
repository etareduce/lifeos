import {
  appConfig,
  applyTheme,
  isTypingInField,
  loadView,
  loadWorkspaceMode,
  normalizeKeybindCombo,
  normalizeKeybindConfig,
  normalizeKeybindToken,
  saveWorkspaceMode,
  state,
} from "./core.js";
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
} from "./forms.js";
import { bindIntegrationHandlers } from "./integrations.js";
import {
  clearInfoCardLock,
  setActive,
  updateNowIndicators,
} from "./render.js";
import {
  addDays,
  formatTimeRangeInTimeZone,
  getEffectiveOccurrenceRange,
  getViewRange,
  shiftAnchorDate,
  startOfDay,
  toProjectIsoFromDate,
} from "./utils.js";

dom.brandTitle.textContent = appConfig.scheduleName || dom.brandTitle.textContent;
dom.brandSubtitle.textContent = appConfig.subtitle || dom.brandSubtitle.textContent;
applyTheme(appConfig.theme);
if (dom.timeZoneLabel) {
  dom.timeZoneLabel.textContent = appConfig.userTimeZone || "Local";
}

bindFormHandlers(refreshView);
bindIntegrationHandlers(refreshView);

const WORKSPACE_MODE = {
  HOME: "home",
  TASKS: "tasks",
  SEARCH: "search",
};
const WORKSPACE_LOOKAHEAD_DAYS = 90;
const TASKS_OVERDUE_LOOKBACK_DAYS = 30;
const ZOOM_SCROLL_THRESHOLD = 1.05;
const BASE_DEVICE_PIXEL_RATIO =
  Number.isFinite(window.devicePixelRatio) && window.devicePixelRatio > 0
    ? window.devicePixelRatio
    : 1;
const BASE_VISUAL_VIEWPORT_SCALE =
  window.visualViewport && Number.isFinite(window.visualViewport.scale)
    ? window.visualViewport.scale || 1
    : 1;
let pendingRetroactiveCompletionId = null;
let taskCompletionLastFocusedElement = null;

function getCurrentZoomFactor() {
  const viewportScale =
    window.visualViewport && Number.isFinite(window.visualViewport.scale)
      ? window.visualViewport.scale || 1
      : 1;
  const normalizedViewportScale =
    BASE_VISUAL_VIEWPORT_SCALE > 0
      ? viewportScale / BASE_VISUAL_VIEWPORT_SCALE
      : viewportScale;
  const devicePixelRatio =
    Number.isFinite(window.devicePixelRatio) && window.devicePixelRatio > 0
      ? window.devicePixelRatio
      : 1;
  const normalizedDevicePixelRatio =
    BASE_DEVICE_PIXEL_RATIO > 0
      ? devicePixelRatio / BASE_DEVICE_PIXEL_RATIO
      : devicePixelRatio;
  return Math.max(normalizedViewportScale, normalizedDevicePixelRatio);
}

function syncZoomScrollMode() {
  const zoomFactor = getCurrentZoomFactor();
  const zoomed = zoomFactor > ZOOM_SCROLL_THRESHOLD;
  document.documentElement.dataset.zoomed = zoomed ? "true" : "false";
}

function setTaskCompletionStatus(message = "", error = false) {
  if (!dom.taskCompletionStatus) return;
  dom.taskCompletionStatus.textContent = message;
  dom.taskCompletionStatus.classList.toggle("error", Boolean(error));
}

function toggleTaskCompletionModal(show) {
  if (!dom.taskCompletionModal || !dom.taskCompletionPanel) return;
  const active = Boolean(show);
  if (active) {
    taskCompletionLastFocusedElement = document.activeElement;
  }
  dom.taskCompletionModal.classList.toggle("active", active);
  dom.taskCompletionPanel.classList.toggle("active", active);
  dom.taskCompletionModal.setAttribute("aria-hidden", (!active).toString());
  document.body.classList.toggle("modal-open", active);
  if (!active) {
    dom.taskCompletionModal.setAttribute("inert", "");
    pendingRetroactiveCompletionId = null;
    if (dom.taskCompletionForm) {
      dom.taskCompletionForm.reset();
    }
    setTaskCompletionStatus("");
    if (
      taskCompletionLastFocusedElement &&
      typeof taskCompletionLastFocusedElement.focus === "function"
    ) {
      taskCompletionLastFocusedElement.focus();
    }
    taskCompletionLastFocusedElement = null;
    return;
  }
  dom.taskCompletionModal.removeAttribute("inert");
  dom.taskCompletionMinutesInput?.focus();
}

function openRetroactiveCompletionModal(blob) {
  if (!blob) return;
  pendingRetroactiveCompletionId = blob.id;
  const effective = getEffectiveOccurrenceRange(blob);
  const defaultMinutes = effective
    ? Math.max(1, Math.round((effective.end.getTime() - effective.start.getTime()) / 60000))
    : 30;
  if (dom.taskCompletionSummary) {
    dom.taskCompletionSummary.textContent = `Estimate how long "${blob.name || "this task"}" took to complete.`;
  }
  if (dom.taskCompletionMinutesInput) {
    dom.taskCompletionMinutesInput.value = String(defaultMinutes);
  }
  setTaskCompletionStatus("");
  toggleTaskCompletionModal(true);
}

syncZoomScrollMode();
window.addEventListener("resize", syncZoomScrollMode, { passive: true });
if (window.visualViewport) {
  window.visualViewport.addEventListener("resize", syncZoomScrollMode, {
    passive: true,
  });
}

function getWorkspaceDataRange() {
  const now = new Date();
  const start = addDays(now, -TASKS_OVERDUE_LOOKBACK_DAYS);
  const end = addDays(now, WORKSPACE_LOOKAHEAD_DAYS);
  return { start, end };
}

function setWorkspaceMode(mode) {
  const nextMode = Object.values(WORKSPACE_MODE).includes(mode) ? mode : WORKSPACE_MODE.HOME;
  state.workspaceMode = nextMode;
  document.documentElement.dataset.workspaceMode = nextMode;
  saveWorkspaceMode(nextMode);
  if (dom.homeBtn) dom.homeBtn.classList.toggle("active", nextMode === WORKSPACE_MODE.HOME);
  if (dom.tasksBtn) dom.tasksBtn.classList.toggle("active", nextMode === WORKSPACE_MODE.TASKS);
  if (dom.searchBtn) dom.searchBtn.classList.toggle("active", nextMode === WORKSPACE_MODE.SEARCH);
  if (dom.homeSection) {
    const active = nextMode === WORKSPACE_MODE.HOME;
    dom.homeSection.classList.toggle("active", active);
    dom.homeSection.setAttribute("aria-hidden", (!active).toString());
  }
  if (dom.tasksSection) {
    const active = nextMode === WORKSPACE_MODE.TASKS;
    dom.tasksSection.classList.toggle("active", active);
    dom.tasksSection.setAttribute("aria-hidden", (!active).toString());
  }
  if (dom.searchSection) {
    const active = nextMode === WORKSPACE_MODE.SEARCH;
    dom.searchSection.classList.toggle("active", active);
    dom.searchSection.setAttribute("aria-hidden", (!active).toString());
  }
}

function dayKeyInZone(date, timeZone) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function getUpcomingOccurrences() {
  const now = new Date();
  return state.blobs
    .map((blob) => {
      const range = getOccurrenceRange(blob);
      if (!range || range.end <= now) return null;
      return { blob, range };
    })
    .filter(Boolean)
    .sort((a, b) => a.range.start - b.range.start);
}

function getRecurrenceSummary(blob) {
  const payload = blob?.recurrence_payload || {};
  const recurrenceId = blob?.recurrence_id || blob?.id || "unknown";
  const name =
    payload.recurrence_name ||
    blob?.recurrence_name ||
    blob?.name ||
    "Untitled recurrence";
  const description =
    payload.recurrence_description ||
    blob?.recurrence_description ||
    blob?.description ||
    "";
  return { recurrenceId, name, description };
}

function getUpcomingRecurrenceGroups() {
  const groups = new Map();
  getUpcomingOccurrences().forEach((item) => {
    const { recurrenceId, name, description } = getRecurrenceSummary(item.blob);
    if (!groups.has(recurrenceId)) {
      groups.set(recurrenceId, {
        recurrenceId,
        name,
        description,
        occurrences: [],
      });
    }
    groups.get(recurrenceId).occurrences.push(item);
  });
  return Array.from(groups.values())
    .map((group) => ({
      ...group,
      occurrences: group.occurrences.sort((a, b) => a.range.start - b.range.start),
    }))
    .sort((a, b) => {
      const aStart = a.occurrences[0]?.range?.start?.getTime?.() || Number.POSITIVE_INFINITY;
      const bStart = b.occurrences[0]?.range?.start?.getTime?.() || Number.POSITIVE_INFINITY;
      return aStart - bStart;
    });
}

function isTaskOccurrence(blob) {
  const showOnTasksPage = blob?.policy?.show_on_tasks_page;
  if (typeof showOnTasksPage === "boolean" && !showOnTasksPage) {
    return false;
  }
  const defaultRange = blob?.default_scheduled_timerange || null;
  const schedulableRange = blob?.schedulable_timerange || null;
  if (
    !defaultRange?.start ||
    !defaultRange?.end ||
    !schedulableRange?.start ||
    !schedulableRange?.end
  ) {
    return false;
  }
  const defaultStart = new Date(defaultRange.start);
  const defaultEnd = new Date(defaultRange.end);
  const schedStart = new Date(schedulableRange.start);
  const schedEnd = new Date(schedulableRange.end);
  if (
    Number.isNaN(defaultStart.getTime()) ||
    Number.isNaN(defaultEnd.getTime()) ||
    Number.isNaN(schedStart.getTime()) ||
    Number.isNaN(schedEnd.getTime())
  ) {
    return false;
  }
  return (
    defaultStart.getTime() !== schedStart.getTime() ||
    defaultEnd.getTime() !== schedEnd.getTime()
  );
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function renderTasksPanel() {
  if (!dom.tasksList) return;
  const userZone = appConfig.userTimeZone;
  const now = new Date();
  const windowEnd = addDays(now, Math.max(1, Number(appConfig.tasksDisplayDays || 3)));
  const taskItems = state.blobs
    .filter((blob) => isTaskOccurrence(blob))
    .map((blob) => {
      const effective = getEffectiveOccurrenceRange(blob);
      if (!effective?.start || !effective?.effectiveEnd) return null;
      return {
        blob,
        range: {
          start: effective.start,
          end: effective.effectiveEnd,
        },
        finishedAt: effective.finishedAt || null,
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.range.start - b.range.start);
  const overdueItems = taskItems.filter(
    (item) => !item.finishedAt && item.range.end < now
  );
  const windowItems = taskItems.filter(
    (item) => !item.finishedAt && item.range.end >= now && item.range.start < windowEnd
  );
  const inProgressCount = windowItems.filter(
    (item) => item.range.start <= now && now < item.range.end
  ).length;
  if (dom.tasksUpcomingCount) dom.tasksUpcomingCount.textContent = `${windowItems.length}`;
  if (dom.tasksTodayCount) dom.tasksTodayCount.textContent = `${inProgressCount}`;
  if (dom.tasksWeekCount) dom.tasksWeekCount.textContent = `${overdueItems.length}`;

  const dateFormatter = new Intl.DateTimeFormat(undefined, {
    timeZone: userZone,
    weekday: "short",
    month: "short",
    day: "numeric",
  });
  const renderTaskCards = (items, options = {}) => {
    const emptyMessage = options.emptyMessage || "No tasks.";
    if (!items.length) {
      return `<div class="tasks-empty">${escapeHtml(emptyMessage)}</div>`;
    }
    return items
      .slice(0, 80)
      .map((item) => {
        const { blob, range } = item;
        const timeZone = blob?.tz || userZone;
        const title = escapeHtml(blob.name || "Untitled");
        const description = escapeHtml(blob.description || "");
        const dayLabel = dateFormatter.format(range.start);
        const timeLabel = formatTimeRangeInTimeZone(range.start, range.end, timeZone);
        const isInProgress = range.start <= now && now < range.end;
        const completeAction = options.allowRetroactiveCompletion
          ? `
            <button type="button" class="ghost small" data-complete-task="retroactive" data-occurrence-id="${blob.id}">
              Mark complete
            </button>
          `
          : isInProgress
            ? `
              <button type="button" class="ghost small" data-complete-task="now" data-occurrence-id="${blob.id}">
                Finish now
              </button>
            `
            : "";
        const statusBadge = options.allowRetroactiveCompletion
          ? '<span class="task-card-status overdue">Overdue</span>'
          : isInProgress
            ? '<span class="task-card-status active">In progress</span>'
            : "";
        return `
          <article class="task-card">
            <div class="task-card-main">
              <div class="task-card-head">
                <div class="task-card-title">${title}</div>
                ${statusBadge}
              </div>
              ${description ? `<div class="task-card-copy">${description}</div>` : ""}
            </div>
            <div class="task-card-meta">
              <div class="task-card-day">${escapeHtml(dayLabel)}</div>
              <div class="task-card-time">${escapeHtml(timeLabel)}</div>
              ${completeAction}
            </div>
          </article>
        `;
      })
      .join("");
  };
  const windowLabel = Math.max(1, Number(appConfig.tasksDisplayDays || 3));
  dom.tasksList.innerHTML = `
    <section class="tasks-column">
      <div class="tasks-column-header">
        <h3 class="tasks-column-title">Next ${windowLabel} day${windowLabel === 1 ? "" : "s"}</h3>
        <div class="tasks-column-copy">Current and upcoming tasks in the active window.</div>
      </div>
      <div class="tasks-column-list">
        ${renderTaskCards(windowItems, {
          allowRetroactiveCompletion: false,
          emptyMessage: "No tasks in this window.",
        })}
      </div>
    </section>
    <section class="tasks-column">
      <div class="tasks-column-header">
        <h3 class="tasks-column-title">Overdue</h3>
        <div class="tasks-column-copy">Unfinished tasks from the past.</div>
      </div>
      <div class="tasks-column-list">
        ${renderTaskCards(overdueItems, {
          allowRetroactiveCompletion: true,
          emptyMessage: "No overdue tasks.",
        })}
      </div>
    </section>
  `;
}

function renderSearchPanel() {
  if (!dom.eventSearchResults) return;
  const recurrenceGroups = getUpcomingRecurrenceGroups();
  const query = (dom.eventSearchInput?.value || "").trim().toLowerCase();
  const matches = query
    ? recurrenceGroups.filter((group) => {
        return `${group.name} ${group.description} ${group.recurrenceId}`
          .toLowerCase()
          .includes(query);
      })
    : recurrenceGroups;

  if (!matches.length) {
    dom.eventSearchResults.innerHTML = query
      ? `<div class="search-empty">No recurrences match "${escapeHtml(query)}".</div>`
      : `<div class="search-empty">Type to search upcoming recurrences.</div>`;
    return;
  }

  const dateFormatter = new Intl.DateTimeFormat(undefined, {
    timeZone: appConfig.userTimeZone,
    weekday: "short",
    month: "short",
    day: "numeric",
  });
  const markup = matches
    .slice(0, 100)
    .map((group) => {
      const next = group.occurrences[0] || null;
      if (!next) return "";
      const title = escapeHtml(group.name || "Untitled recurrence");
      const description = escapeHtml(group.description || "");
      const dayLabel = dateFormatter.format(next.range.start);
      const timeLabel = formatTimeRangeInTimeZone(
        next.range.start,
        next.range.end,
        next.blob?.tz || appConfig.userTimeZone
      );
      const countLabel = `${group.occurrences.length} upcoming`;
      return `
        <article class="search-card">
          <div class="search-card-head">
            <div class="search-card-title">${title}</div>
            <div class="search-card-time">${escapeHtml(dayLabel)} · ${escapeHtml(timeLabel)}</div>
          </div>
          <div class="search-card-copy">${escapeHtml(countLabel)} occurrence(s)</div>
          ${description ? `<div class="search-card-copy">${description}</div>` : ""}
        </article>
      `;
    })
    .join("");
  dom.eventSearchResults.innerHTML = markup;
}

function renderWorkspacePanels() {
  renderTasksPanel();
  renderSearchPanel();
}

async function switchWorkspaceMode(mode) {
  setWorkspaceMode(mode);
  if (mode === WORKSPACE_MODE.HOME) {
    await refreshView(state.view);
    return;
  }
  const range = getWorkspaceDataRange();
  await ensureOccurrences(range.start, range.end);
  renderWorkspacePanels();
  if (mode === WORKSPACE_MODE.SEARCH && dom.eventSearchInput) {
    dom.eventSearchInput.focus();
  }
}

async function refreshView(nextView = state.view, options = {}) {
  const view = nextView || state.view;
  if (options?.forceReload) {
    state.loadedRange = null;
  }
  setActive(view, { deferRender: true });
  const range =
    state.workspaceMode === WORKSPACE_MODE.HOME
      ? getViewRange(view, state.anchorDate)
      : getWorkspaceDataRange();
  let rangeStart = range.start;
  let rangeEnd = range.end;
  if (state.workspaceMode === WORKSPACE_MODE.HOME) {
    const todayStart = startOfDay(new Date());
    const todayEnd = addDays(todayStart, 1);
    if (todayStart < rangeStart) rangeStart = todayStart;
    if (todayEnd > rangeEnd) rangeEnd = todayEnd;
  }
  await ensureOccurrences(rangeStart, rangeEnd);
  setActive(view);
  refreshScheduleStatus();
  renderNowPanel();
  renderWorkspacePanels();
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
  await completeTaskOccurrence(blob, { finishedAt: new Date(), rerunIfEarly: true });
}

async function completeTaskOccurrence(blob, options = {}) {
  if (!blob) return false;
  const effective = getEffectiveOccurrenceRange(blob);
  if (!effective) return false;
  const now = new Date();
  const finishedAt =
    options.finishedAt instanceof Date && !Number.isNaN(options.finishedAt.getTime())
      ? options.finishedAt
      : now;
  const occurrenceKey = blob.schedulable_timerange?.start;
  if (!occurrenceKey) return false;
  const bufferMinutes = Math.max(1, Number(appConfig.finishEarlyBufferMinutes || 15));
  const threshold = new Date(
    effective.effectiveEnd.getTime() - bufferMinutes * 60000
  );
  let previous = null;
  try {
    previous = await getRecurrence(blob.recurrence_id);
  } catch (error) {
    await alertDialog(error?.message || "Unable to load recurrence.");
    return false;
  }
  const payload = previous.payload || {};
  const overrides =
    payload.occurrence_overrides && typeof payload.occurrence_overrides === "object"
      ? { ...payload.occurrence_overrides }
      : {};
  const currentOverride = overrides[occurrenceKey] || {};
  overrides[occurrenceKey] = {
    ...(currentOverride || {}),
    finished_at: toProjectIsoFromDate(finishedAt, appConfig.projectTimeZone),
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
    if (options.rerunIfEarly && finishedAt < threshold) {
      await handleRunSchedule();
    }
    return true;
  } catch (error) {
    await alertDialog(error?.message || "Failed to finish occurrence.");
    return false;
  }
}

async function handleTaskCompletionAction(button) {
  if (!(button instanceof HTMLButtonElement)) return;
  const occurrenceId = button.getAttribute("data-occurrence-id");
  if (!occurrenceId) return;
  const blob = state.blobs.find((item) => item.id === occurrenceId);
  if (!blob) {
    await alertDialog("Task occurrence not found.");
    return;
  }
  const mode = button.getAttribute("data-complete-task");
  if (mode === "retroactive") {
    openRetroactiveCompletionModal(blob);
    return;
  }
  await completeTaskOccurrence(blob, { finishedAt: new Date(), rerunIfEarly: true });
}

async function handleRetroactiveCompletionSubmit(event) {
  event.preventDefault();
  const occurrenceId = pendingRetroactiveCompletionId;
  if (!occurrenceId) {
    toggleTaskCompletionModal(false);
    return;
  }
  const blob = state.blobs.find((item) => item.id === occurrenceId);
  if (!blob) {
    setTaskCompletionStatus("Task occurrence not found.", true);
    return;
  }
  const effective = getEffectiveOccurrenceRange(blob);
  if (!effective) {
    setTaskCompletionStatus("Unable to read task timing.", true);
    return;
  }
  const estimatedMinutes = Math.max(
    0,
    Math.round(Number(dom.taskCompletionMinutesInput?.value || 0))
  );
  if (!Number.isFinite(estimatedMinutes) || estimatedMinutes <= 0) {
    setTaskCompletionStatus("Enter a positive number of minutes.", true);
    dom.taskCompletionMinutesInput?.focus();
    return;
  }
  const retroactiveFinish = new Date(
    Math.min(Date.now(), effective.start.getTime() + estimatedMinutes * 60000)
  );
  if (dom.taskCompletionSubmitBtn) {
    dom.taskCompletionSubmitBtn.disabled = true;
  }
  setTaskCompletionStatus("Saving...");
  try {
    const completed = await completeTaskOccurrence(blob, {
      finishedAt: retroactiveFinish,
      rerunIfEarly: false,
    });
    if (completed) {
      toggleTaskCompletionModal(false);
    } else {
      setTaskCompletionStatus("Unable to mark task complete.", true);
    }
  } catch (error) {
    setTaskCompletionStatus(error?.message || "Unable to mark task complete.", true);
  } finally {
    if (dom.taskCompletionSubmitBtn) {
      dom.taskCompletionSubmitBtn.disabled = false;
    }
  }
}

dom.tabs.forEach((tab) => {
  tab.addEventListener("click", () => refreshView(tab.dataset.view));
});

if (dom.homeBtn) {
  dom.homeBtn.addEventListener("click", () => {
    switchWorkspaceMode(WORKSPACE_MODE.HOME);
  });
}

if (dom.tasksBtn) {
  dom.tasksBtn.addEventListener("click", () => {
    switchWorkspaceMode(WORKSPACE_MODE.TASKS);
  });
}

if (dom.searchBtn) {
  dom.searchBtn.addEventListener("click", () => {
    switchWorkspaceMode(WORKSPACE_MODE.SEARCH);
  });
}

if (dom.eventSearchInput) {
  dom.eventSearchInput.addEventListener("input", () => {
    renderSearchPanel();
  });
}

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

if (dom.tasksList) {
  dom.tasksList.addEventListener("click", (event) => {
    const button = event.target.closest("[data-complete-task]");
    if (!(button instanceof HTMLButtonElement)) return;
    handleTaskCompletionAction(button);
  });
}

dom.taskCompletionForm?.addEventListener("submit", handleRetroactiveCompletionSubmit);
dom.taskCompletionCancelBtn?.addEventListener("click", () => toggleTaskCompletionModal(false));
dom.taskCompletionCloseBtn?.addEventListener("click", () => toggleTaskCompletionModal(false));
dom.taskCompletionBackdrop?.addEventListener("click", () => toggleTaskCompletionModal(false));
window.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  if (!dom.taskCompletionModal?.classList.contains("active")) return;
  toggleTaskCompletionModal(false);
});

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
  event.stopPropagation();
  const blobId = button.getAttribute("data-copy-blob-id");
  if (!blobId) return;
  const defaultAriaLabel = button.dataset.defaultAriaLabel || button.getAttribute("aria-label") || "Copy blob id";
  button.dataset.defaultAriaLabel = defaultAriaLabel;
  const existingTimer = Number(button.dataset.copyStatusTimer || 0);
  if (existingTimer) {
    window.clearTimeout(existingTimer);
  }
  button.classList.remove("copy-ok", "copy-fail");
  button.removeAttribute("data-copy-status");
  try {
    await navigator.clipboard.writeText(blobId);
    button.classList.add("copy-ok");
    button.dataset.copyStatus = "Copied";
    button.setAttribute("aria-label", "Blob id copied");
  } catch (error) {
    button.classList.add("copy-fail");
    button.dataset.copyStatus = "Copy failed";
    button.setAttribute("aria-label", "Copy blob id failed");
  }
  const timerId = window.setTimeout(() => {
    button.classList.remove("copy-ok", "copy-fail");
    button.removeAttribute("data-copy-status");
    button.setAttribute("aria-label", defaultAriaLabel);
    delete button.dataset.copyStatusTimer;
  }, 1100);
  button.dataset.copyStatusTimer = String(timerId);
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

function getActiveKeybinds() {
  const normalized = normalizeKeybindConfig(appConfig.keybinds);
  appConfig.keybinds = normalized;
  return normalized;
}

function parseKeybind(combo) {
  const normalized = normalizeKeybindCombo(combo, "");
  if (!normalized) return null;
  const parsed = {
    mod: false,
    ctrl: false,
    meta: false,
    alt: false,
    shift: false,
    key: "",
  };
  normalized.split("+").forEach((token) => {
    if (token === "Mod") {
      parsed.mod = true;
      return;
    }
    if (token === "Ctrl") {
      parsed.ctrl = true;
      return;
    }
    if (token === "Meta") {
      parsed.meta = true;
      return;
    }
    if (token === "Alt") {
      parsed.alt = true;
      return;
    }
    if (token === "Shift") {
      parsed.shift = true;
      return;
    }
    parsed.key = token;
  });
  return parsed.key ? parsed : null;
}

function normalizeEventKey(event) {
  const raw = String(event.key || "").trim().toLowerCase();
  if (
    raw === "control" ||
    raw === "ctrl" ||
    raw === "meta" ||
    raw === "alt" ||
    raw === "shift" ||
    raw === "cmd" ||
    raw === "command"
  ) {
    return "";
  }
  return normalizeKeybindToken(event.key);
}

function matchesKeybind(event, combo) {
  const parsed = parseKeybind(combo);
  if (!parsed) return false;
  if (parsed.mod) {
    if (!(event.ctrlKey || event.metaKey)) return false;
  } else {
    if (Boolean(event.ctrlKey) !== parsed.ctrl) return false;
    if (Boolean(event.metaKey) !== parsed.meta) return false;
  }
  if (Boolean(event.altKey) !== parsed.alt) return false;
  if (Boolean(event.shiftKey) !== parsed.shift) return false;
  return normalizeEventKey(event) === parsed.key;
}

window.addEventListener("keydown", (event) => {
  if (isTypingInField(event.target)) return;
  const keybinds = getActiveKeybinds();
  const redoMatch = matchesKeybind(event, keybinds.redo);
  const undoMatch = matchesKeybind(event, keybinds.undo);
  const closePanelsMatch = matchesKeybind(event, keybinds.closePanels);
  const createTaskMatch = matchesKeybind(event, keybinds.createTask);
  const createEventMatch = matchesKeybind(event, keybinds.createEvent);
  const navigatePrevMatch = matchesKeybind(event, keybinds.navigatePrev);
  const navigateNextMatch = matchesKeybind(event, keybinds.navigateNext);

  if (undoMatch) {
    event.preventDefault();
    undoHistoryAction();
    return;
  }
  if (redoMatch) {
    event.preventDefault();
    redoHistoryAction();
    return;
  }
  if (closePanelsMatch) {
    clearInfoCardLock();
    let closedSidebarModal = false;
    if (dom.settingsModal.classList.contains("active")) {
      toggleSettings(false);
      dom.settingsStatus.textContent = "";
      closedSidebarModal = true;
    }
    if (closedSidebarModal) {
      document.querySelectorAll(".sidebar-icon-link.active").forEach((link) => {
        link.classList.remove("active");
      });
    }
    if (dom.formPanel.classList.contains("active")) {
      toggleForm(false);
      resetFormMode();
    }
    return;
  }
  if (createTaskMatch) {
    event.preventDefault();
    openCreateForm("task");
    return;
  }
  if (createEventMatch) {
    event.preventDefault();
    openCreateForm("event");
    return;
  }
  if (navigatePrevMatch || navigateNextMatch) {
    if (state.workspaceMode !== WORKSPACE_MODE.HOME) {
      return;
    }
    const direction = navigatePrevMatch ? -1 : 1;
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
const savedWorkspaceMode = loadWorkspaceMode();
const initialWorkspaceMode = Object.values(WORKSPACE_MODE).includes(savedWorkspaceMode)
  ? savedWorkspaceMode
  : WORKSPACE_MODE.HOME;
if (initialWorkspaceMode === WORKSPACE_MODE.HOME) {
  setWorkspaceMode(WORKSPACE_MODE.HOME);
  refreshView(savedView || "day");
} else {
  switchWorkspaceMode(initialWorkspaceMode);
}
window.setInterval(() => {
  renderNowPanel();
  updateNowIndicators();
}, 30000);
