import { getLocalTimeZone } from "./utils.js";

const state = {
  blobs: [],
  view: "day",
  anchorDate: new Date(),
  editingRecurrenceId: null,
  editingRecurrenceType: null,
  editingRecurrencePayload: null,
  editingOccurrenceStart: null,
  loadedRange: null,
  selectionMode: false,
  selectionStep: null,
  pendingDefaultRange: null,
  pendingSchedulableRange: null,
  selectionPointer: null,
  selectionScrollHandler: null,
  activeBlockClickHandler: null,
  infoCardLocked: false,
  lockedBlobId: null,
  infoCardHovering: false,
  infoCardAnchorHovering: false,
  infoCardHideTimeout: null,
  currentBlobType: "task",
  scheduleDirty: true,
  scheduleLastRun: null,
  scheduleRunning: false,
  currentOccurrenceId: null,
  previewBlobs: [],
  llmDraftRecurrences: null,
  llmDraftNotes: null,
};

const defaultConfig = {
  scheduleName: window.APP_CONFIG?.scheduleName || "Elastisched",
  subtitle: window.APP_CONFIG?.subtitle || "Schedule at a glance",
  minuteGranularity: Math.max(1, Number(window.APP_CONFIG?.minuteGranularity || 5)),
  finishEarlyBufferMinutes: Math.max(
    1,
    Number(window.APP_CONFIG?.finishEarlyBufferMinutes || 15)
  ),
  includeActiveOccurrences:
    typeof window.APP_CONFIG?.includeActiveOccurrences === "boolean"
      ? window.APP_CONFIG.includeActiveOccurrences
      : true,
  projectTimeZone: window.APP_CONFIG?.projectTimeZone || "UTC",
  lookaheadSeconds: Math.max(
    1,
    Number(window.APP_CONFIG?.lookaheadSeconds || 14 * 24 * 60 * 60)
  ),
  userTimeZone: window.APP_CONFIG?.userTimeZone || null,
  theme: window.APP_CONFIG?.theme || "sand",
  sidebarCollapsed: Boolean(window.APP_CONFIG?.sidebarCollapsed || false),
  engineInitialTemp: Math.max(0.0001, Number(window.APP_CONFIG?.engineInitialTemp || 10.0)),
  engineFinalTemp: Math.max(0.000001, Number(window.APP_CONFIG?.engineFinalTemp || 0.0001)),
  engineNumIters: Math.max(1, Number(window.APP_CONFIG?.engineNumIters || 1000000)),
  engineAdvancedEnabled: Boolean(window.APP_CONFIG?.engineAdvancedEnabled || false),
  engineIllegalScheduleWeight: Math.max(
    0,
    Number(window.APP_CONFIG?.engineIllegalScheduleWeight || 1.0)
  ),
  engineOverlapCostWeight: Math.max(
    0,
    Number(window.APP_CONFIG?.engineOverlapCostWeight || 1.0)
  ),
  engineSplitCostWeight: Math.max(
    0,
    Number(window.APP_CONFIG?.engineSplitCostWeight || 1.0)
  ),
  engineConsistencyCostWeight: Math.max(
    0,
    Number(window.APP_CONFIG?.engineConsistencyCostWeight || 1.0)
  ),
  engineGranularityCostWeight: Math.max(
    0,
    Number(window.APP_CONFIG?.engineGranularityCostWeight || 1.0)
  ),
};

const storedConfig = (() => {
  try {
    const raw = window.localStorage.getItem("elastisched:settings");
    return raw ? JSON.parse(raw) : null;
  } catch (error) {
    return null;
  }
})();

const appConfig = {
  ...defaultConfig,
  ...(storedConfig || {}),
};

if (!appConfig.userTimeZone) {
  appConfig.userTimeZone = getLocalTimeZone();
}
try {
  Intl.DateTimeFormat("en-US", { timeZone: appConfig.userTimeZone });
} catch (error) {
  appConfig.userTimeZone = getLocalTimeZone();
}

const minuteGranularity = Math.max(1, Number(appConfig.minuteGranularity || 5));
const API_BASE = window.location.origin;

function applyTheme(theme) {
  const nextTheme = theme || "sand";
  document.body.dataset.theme = nextTheme;
}


function saveView(view) {
  try {
    window.localStorage.setItem("elastisched:view", view);
  } catch (error) {
    // Ignore storage errors.
  }
}

function loadView() {
  try {
    return window.localStorage.getItem("elastisched:view");
  } catch (error) {
    return null;
  }
}

function saveSettings(config) {
  try {
    window.localStorage.setItem("elastisched:settings", JSON.stringify(config));
  } catch (error) {
    // Ignore storage errors.
  }
}

function isTypingInField(target) {
  if (!(target instanceof Element)) return false;
  const isEditableControl =
    target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable;
  if (!isEditableControl) return false;
  if (target instanceof HTMLInputElement) {
    const blockedTypes = new Set([
      "button",
      "submit",
      "reset",
      "checkbox",
      "radio",
      "range",
      "color",
      "file",
      "hidden",
    ]);
    if (blockedTypes.has((target.type || "").toLowerCase())) {
      return false;
    }
  }
  if (target instanceof HTMLElement) {
    const style = window.getComputedStyle(target);
    const hiddenByStyle =
      style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse";
    if (hiddenByStyle || target.getClientRects().length === 0) {
      return false;
    }
  }
  return true;
}

export {
  API_BASE,
  appConfig,
  isTypingInField,
  loadView,
  minuteGranularity,
  applyTheme,
  saveSettings,
  saveView,
  state,
};
