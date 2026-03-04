import { getLocalTimeZone } from "./utils.js";

const state = {
  blobs: [],
  view: "day",
  anchorDate: new Date(),
  editingRecurrenceId: null,
  editingRecurrenceType: null,
  editingRecurrencePayload: null,
  editingWeeklyAnchorStart: null,
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
  selectedOccurrenceIds: [],
  previewBlobs: [],
  calendarVisibilityByViewId: {},
  llmDraftRecurrences: null,
  llmDraftNotes: null,
  workspaceMode: "home",
};

const KEYBIND_DEFAULTS = Object.freeze({
  undo: "Mod+Z",
  redo: "Mod+Y",
  closePanels: "Escape",
  createTask: "N",
  createEvent: "C",
  navigatePrev: "ArrowLeft",
  navigateNext: "ArrowRight",
});

function normalizeKeybindToken(token) {
  const raw = String(token || "").trim();
  if (!raw) return "";
  const lower = raw.toLowerCase();
  if (lower === "esc" || lower === "escape") return "Escape";
  if (lower === "left" || lower === "arrowleft") return "ArrowLeft";
  if (lower === "right" || lower === "arrowright") return "ArrowRight";
  if (lower === "up" || lower === "arrowup") return "ArrowUp";
  if (lower === "down" || lower === "arrowdown") return "ArrowDown";
  if (lower === "space" || lower === "spacebar") return "Space";
  if (lower === "return" || lower === "enter") return "Enter";
  if (lower === "tab") return "Tab";
  if (lower === "backspace") return "Backspace";
  if (lower === "delete" || lower === "del") return "Delete";
  if (lower === "pageup") return "PageUp";
  if (lower === "pagedown") return "PageDown";
  if (lower === "home") return "Home";
  if (lower === "end") return "End";
  if (/^f\d{1,2}$/.test(lower)) return lower.toUpperCase();
  if (raw.length === 1) return raw.toUpperCase();
  return "";
}

function normalizeKeybindCombo(value, fallback = "") {
  const raw = String(value || "").trim();
  if (!raw) return fallback;
  const tokens = raw
    .split("+")
    .map((part) => part.trim())
    .filter(Boolean);
  if (!tokens.length) return fallback;
  let hasMod = false;
  let hasCtrl = false;
  let hasMeta = false;
  let hasAlt = false;
  let hasShift = false;
  let key = "";
  for (const token of tokens) {
    const lower = token.toLowerCase();
    if (lower === "mod") {
      hasMod = true;
      continue;
    }
    if (lower === "ctrl" || lower === "control") {
      hasCtrl = true;
      continue;
    }
    if (lower === "meta" || lower === "cmd" || lower === "command") {
      hasMeta = true;
      continue;
    }
    if (lower === "alt" || lower === "option") {
      hasAlt = true;
      continue;
    }
    if (lower === "shift") {
      hasShift = true;
      continue;
    }
    if (key) return fallback;
    key = normalizeKeybindToken(token);
    if (!key) return fallback;
  }
  if (!key) return fallback;
  const parts = [];
  if (hasMod) {
    parts.push("Mod");
  } else {
    if (hasCtrl) parts.push("Ctrl");
    if (hasMeta) parts.push("Meta");
  }
  if (hasAlt) parts.push("Alt");
  if (hasShift) parts.push("Shift");
  parts.push(key);
  return parts.join("+");
}

function normalizeKeybindConfig(rawConfig) {
  const raw = rawConfig && typeof rawConfig === "object" ? rawConfig : {};
  const next = {};
  Object.entries(KEYBIND_DEFAULTS).forEach(([action, fallback]) => {
    next[action] = normalizeKeybindCombo(raw[action], fallback);
  });
  return next;
}

const defaultConfig = {
  scheduleName: window.APP_CONFIG?.scheduleName || "Elastisched",
  subtitle: window.APP_CONFIG?.subtitle || "Schedule at a glance",
  minuteGranularity: Math.max(1, Number(window.APP_CONFIG?.minuteGranularity || 5)),
  tasksDisplayDays: Math.max(1, Number(window.APP_CONFIG?.tasksDisplayDays || 3)),
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
  sidebarWidth: Number(
    window.APP_CONFIG?.sidebarWidth ||
      (window.APP_CONFIG?.sidebarWide ? 360 : 280)
  ),
  sidebarWide: Boolean(window.APP_CONFIG?.sidebarWide || false),
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
  keybinds: normalizeKeybindConfig(window.APP_CONFIG?.keybinds),
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
appConfig.keybinds = normalizeKeybindConfig(appConfig.keybinds);

const DEFAULT_SIDEBAR_WIDTH = 280;
const MIN_SIDEBAR_WIDTH = 240;
const MAX_SIDEBAR_WIDTH = 520;

function clampSidebarWidthValue(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return DEFAULT_SIDEBAR_WIDTH;
  }
  return Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, Math.round(numeric)));
}

if (!Number.isFinite(Number(appConfig.sidebarWidth))) {
  appConfig.sidebarWidth = appConfig.sidebarWide ? 360 : DEFAULT_SIDEBAR_WIDTH;
}
appConfig.sidebarWidth = clampSidebarWidthValue(appConfig.sidebarWidth);

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

function saveWorkspaceMode(mode) {
  try {
    window.localStorage.setItem("elastisched:workspace-mode", mode);
  } catch (error) {
    // Ignore storage errors.
  }
}

function loadWorkspaceMode() {
  try {
    return window.localStorage.getItem("elastisched:workspace-mode");
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
  KEYBIND_DEFAULTS,
  appConfig,
  isTypingInField,
  loadView,
  loadWorkspaceMode,
  minuteGranularity,
  normalizeKeybindCombo,
  normalizeKeybindConfig,
  normalizeKeybindToken,
  applyTheme,
  saveSettings,
  saveView,
  saveWorkspaceMode,
  state,
};
