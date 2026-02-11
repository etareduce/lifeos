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
  return (
    target &&
    (target.tagName === "INPUT" ||
      target.tagName === "TEXTAREA" ||
      target.isContentEditable)
  );
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
