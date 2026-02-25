import {
  API_BASE,
  KEYBIND_DEFAULTS,
  appConfig,
  applyTheme,
  normalizeKeybindCombo,
  normalizeKeybindConfig,
  normalizeKeybindToken,
  saveSettings,
  state,
} from "./core.js";
import { dom } from "./dom.js";
import {
  addDays,
  formatDateTimeLocalInTimeZone,
  getViewRange,
  getWeekStart,
  isBlobEditableInMainUi,
  overlaps,
  shiftAnchorDate,
  toLocalInputValueInTimeZone,
  toProjectIsoFromDate,
  toProjectIsoFromLocalInput,
} from "./utils.js";
import { setActive, startInteractiveCreate } from "./render.js";
import {
  createLLMRecurrenceDraft,
  createRecurrence,
  createRecurrencesBulk,
  updateRecurrence,
} from "./api.js";
import { alertDialog, confirmDialog } from "./popups.js";
import { bindDateTimePickers, syncDateTimeDisplays } from "./datetime_picker.js";
import { deleteOccurrenceWithUndo, deleteRecurrenceWithUndo } from "./actions.js";

let refreshView = null;
const recurrenceFieldGroups = document.querySelectorAll(".recurrence-fields");
const weeklyRecurrenceFields = document.querySelector('.recurrence-fields[data-recurrence="weekly"]');
const WEEK_DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const editOnlyElements = document.querySelectorAll(".edit-only");
const settingsTabs = document.querySelectorAll(".settings-tab");
const settingsSections = document.querySelectorAll(".settings-section");
const utilityLinks = document.querySelectorAll(".sidebar-icon-link");
const nonWeeklyField = document.querySelector(".non-weekly-field");
const primaryDependencyField = document.querySelector(
  ".dependency-field:not(.slot-dependency-field)"
);
const primaryTagField = document.getElementById("recurrenceTagField");
let dependencyIds = [];
let tagNames = [];
const slotTagStore = new WeakMap();
const slotDependencyStore = new WeakMap();
let isDraggingForm = false;
let dragOffset = { x: 0, y: 0 };
let formPosition = null;
let isDraggingLlm = false;
let llmDragOffset = { x: 0, y: 0 };
let llmPosition = null;
let settingsHydrating = false;
let settingsDirty = false;
let sidebarResizeSession = null;

const DEFAULT_SIDEBAR_WIDTH = 280;
const MIN_SIDEBAR_WIDTH = 240;
const MAX_SIDEBAR_WIDTH = 520;
const KEYBIND_FIELD_BY_ACTION = Object.freeze({
  undo: "keybindUndo",
  redo: "keybindRedo",
  closePanels: "keybindClosePanels",
  createTask: "keybindCreateTask",
  createEvent: "keybindCreateEvent",
  navigatePrev: "keybindNavigatePrev",
  navigateNext: "keybindNavigateNext",
});
const KEYBIND_ACTION_BY_FIELD = Object.freeze(
  Object.fromEntries(
    Object.entries(KEYBIND_FIELD_BY_ACTION).map(([action, field]) => [field, action])
  )
);
const KEYBIND_FIELD_NAMES = new Set(Object.values(KEYBIND_FIELD_BY_ACTION));

const weeklyFieldPlacement = {
  dependency: {
    el: primaryDependencyField,
    parent: null,
    nextSibling: null,
  },
  tag: {
    el: primaryTagField,
    parent: null,
    nextSibling: null,
  },
};

function storeWeeklyFieldPlacement(entry) {
  if (!entry?.el || entry.parent) return;
  entry.parent = entry.el.parentNode;
  entry.nextSibling = entry.el.nextSibling;
}

function moveWeeklyField(entry, target) {
  if (!entry?.el || !target) return;
  target.appendChild(entry.el);
}

function restoreWeeklyField(entry) {
  if (!entry?.el || !entry.parent) return;
  if (entry.nextSibling && entry.nextSibling.parentNode === entry.parent) {
    entry.parent.insertBefore(entry.el, entry.nextSibling);
  } else {
    entry.parent.appendChild(entry.el);
  }
}

function setRefreshHandler(handler) {
  refreshView = handler;
}

function clampSidebarWidth(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return DEFAULT_SIDEBAR_WIDTH;
  }
  return Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, Math.round(numeric)));
}

function applySidebarState() {
  if (!dom.page) return;
  appConfig.sidebarWidth = clampSidebarWidth(appConfig.sidebarWidth);
  dom.page.style.setProperty("--sidebar-width", `${appConfig.sidebarWidth}px`);
  dom.page.classList.toggle("sidebar-collapsed", Boolean(appConfig.sidebarCollapsed));
}

function toggleSidebarCollapsed(force) {
  const next =
    typeof force === "boolean" ? force : !Boolean(appConfig.sidebarCollapsed);
  appConfig.sidebarCollapsed = next;
  applySidebarState();
  saveSettings(appConfig);
}

function beginSidebarResize(event) {
  if (!(event instanceof PointerEvent)) return;
  if (!dom.page || !dom.sidebar || !dom.sidebarResizer) return;
  if (window.matchMedia("(max-width: 720px)").matches) return;
  if (appConfig.sidebarCollapsed) return;
  event.preventDefault();
  const sidebarWidth = dom.sidebar.getBoundingClientRect().width;
  sidebarResizeSession = {
    pointerId: event.pointerId,
    originX: event.clientX,
    originWidth: clampSidebarWidth(sidebarWidth),
  };
  dom.page.classList.add("sidebar-resizing");
  dom.sidebarResizer.classList.add("active");
  try {
    dom.sidebarResizer.setPointerCapture(event.pointerId);
  } catch (error) {
    // Ignore pointer capture failures.
  }
}

function updateSidebarResize(event) {
  if (!(event instanceof PointerEvent)) return;
  if (!sidebarResizeSession) return;
  const delta = event.clientX - sidebarResizeSession.originX;
  const nextWidth = clampSidebarWidth(sidebarResizeSession.originWidth + delta);
  appConfig.sidebarWidth = nextWidth;
  applySidebarState();
}

function endSidebarResize(event) {
  if (!(event instanceof PointerEvent)) return;
  if (!sidebarResizeSession) return;
  if (event.pointerId !== sidebarResizeSession.pointerId) return;
  sidebarResizeSession = null;
  if (dom.page) {
    dom.page.classList.remove("sidebar-resizing");
  }
  if (dom.sidebarResizer) {
    dom.sidebarResizer.classList.remove("active");
  }
  saveSettings(appConfig);
}

function bindSidebarResize() {
  if (!dom.sidebarResizer) return;
  dom.sidebarResizer.addEventListener("pointerdown", beginSidebarResize);
  window.addEventListener("pointermove", updateSidebarResize);
  window.addEventListener("pointerup", endSidebarResize);
  window.addEventListener("pointercancel", endSidebarResize);
}

function toggleForm(show) {
  const isActive = typeof show === "boolean" ? show : !dom.formPanel.classList.contains("active");
  dom.formPanel.classList.toggle("active", isActive);
  dom.formPanel.classList.toggle("floating", isActive);
  if (isActive && formPosition) {
    dom.formPanel.style.left = `${formPosition.x}px`;
    dom.formPanel.style.top = `${formPosition.y}px`;
    dom.formPanel.style.right = "auto";
  }
}

function toggleSettings(show) {
  const isActive = typeof show === "boolean" ? show : !dom.settingsModal.classList.contains("active");
  dom.settingsModal.classList.toggle("active", isActive);
  dom.settingsPanel.classList.toggle("active", isActive);
  dom.settingsModal.setAttribute("aria-hidden", (!isActive).toString());
  if (isActive) {
    setActiveSettingsTab(settingsTabs[0]?.dataset?.settingsTab || "general");
  }
}

function setSettingsDirty(nextDirty) {
  settingsDirty = Boolean(nextDirty);
  if (dom.settingsSaveBtn) {
    dom.settingsSaveBtn.disabled = !settingsDirty;
  }
  if (dom.settingsDirtyIndicator) {
    dom.settingsDirtyIndicator.textContent = "";
  }
}

function updateAdvancedEngineVisibility(enabled) {
  if (!dom.advancedEngineCard) return;
  dom.advancedEngineCard.classList.toggle("is-hidden", !enabled);
}

function toggleLlm(show) {
  if (!dom.llmPanel) return;
  const isActive = typeof show === "boolean" ? show : !dom.llmPanel.classList.contains("active");
  dom.llmPanel.classList.toggle("active", isActive);
  dom.llmPanel.classList.toggle("floating", isActive);
  dom.llmPanel.setAttribute("aria-hidden", (!isActive).toString());
  if (isActive && llmPosition) {
    dom.llmPanel.style.left = `${llmPosition.x}px`;
    dom.llmPanel.style.top = `${llmPosition.y}px`;
    dom.llmPanel.style.right = "auto";
  }
  if (!isActive && dom.llmStatus) {
    dom.llmStatus.textContent = "";
  }
}

function setLlmPreviewControls(hasPreview) {
  const hasDraft = Boolean(state.llmDraftRecurrences?.length);
  if (dom.llmConfirmBtn) dom.llmConfirmBtn.disabled = !hasDraft;
  if (dom.llmDiscardBtn) dom.llmDiscardBtn.disabled = !hasDraft && !hasPreview;
}

async function clearLlmPreview() {
  state.previewBlobs = [];
  state.llmDraftRecurrences = null;
  state.llmDraftNotes = null;
  setLlmPreviewControls(false);
  if (refreshView) {
    await refreshView(state.view);
  }
}

function setUtilitySidebarActive(targetId) {
  utilityLinks.forEach((link) => {
    link.classList.toggle("active", Boolean(targetId) && link.id === targetId);
  });
}

function setActiveSettingsTab(tabName) {
  if (!tabName) return;
  settingsTabs.forEach((tab) => {
    const isActive = tab.dataset.settingsTab === tabName;
    tab.classList.toggle("active", isActive);
    tab.setAttribute("aria-selected", isActive.toString());
  });
  settingsSections.forEach((section) => {
    section.classList.toggle("active", section.dataset.settingsSection === tabName);
  });
}

function getSettingsKeybindValues(formData) {
  return normalizeKeybindConfig({
    undo: formData.get(KEYBIND_FIELD_BY_ACTION.undo),
    redo: formData.get(KEYBIND_FIELD_BY_ACTION.redo),
    closePanels: formData.get(KEYBIND_FIELD_BY_ACTION.closePanels),
    createTask: formData.get(KEYBIND_FIELD_BY_ACTION.createTask),
    createEvent: formData.get(KEYBIND_FIELD_BY_ACTION.createEvent),
    navigatePrev: formData.get(KEYBIND_FIELD_BY_ACTION.navigatePrev),
    navigateNext: formData.get(KEYBIND_FIELD_BY_ACTION.navigateNext),
  });
}

function hydrateSettingsKeybindFields() {
  const normalized = normalizeKeybindConfig(appConfig.keybinds);
  appConfig.keybinds = normalized;
  Object.entries(KEYBIND_FIELD_BY_ACTION).forEach(([action, fieldName]) => {
    const field = dom.settingsForm?.[fieldName];
    if (!(field instanceof HTMLInputElement)) return;
    field.value = normalized[action] || KEYBIND_DEFAULTS[action];
  });
}

function buildKeybindFromKeyboardEvent(event) {
  const key = normalizeKeybindToken(event.key);
  if (!key) return "";
  if (key === "Shift") return "";
  const lowerRaw = String(event.key || "").trim().toLowerCase();
  if (
    lowerRaw === "control" ||
    lowerRaw === "ctrl" ||
    lowerRaw === "meta" ||
    lowerRaw === "alt" ||
    lowerRaw === "cmd" ||
    lowerRaw === "command"
  ) {
    return "";
  }
  const parts = [];
  if (event.ctrlKey || event.metaKey) parts.push("Mod");
  if (event.altKey) parts.push("Alt");
  if (event.shiftKey && key !== "Shift") parts.push("Shift");
  parts.push(key);
  return normalizeKeybindCombo(parts.join("+"), "");
}

function populateTimeZones() {
  const select = dom.settingsForm?.userTimeZone;
  if (!select || select.dataset.populated === "true") return;
  let zones = [];
  if (typeof Intl !== "undefined" && typeof Intl.supportedValuesOf === "function") {
    zones = Intl.supportedValuesOf("timeZone");
  }
  if (!zones.length) {
    zones = [
      "UTC",
      "America/Los_Angeles",
      "America/Denver",
      "America/Chicago",
      "America/New_York",
      "Europe/London",
      "Europe/Berlin",
      "Europe/Paris",
      "Asia/Tokyo",
      "Asia/Singapore",
      "Australia/Sydney",
    ];
  }
  select.innerHTML = zones.map((zone) => `<option value="${zone}">${zone}</option>`).join("");
  select.dataset.populated = "true";
}

function hydrateSettingsForm() {
  settingsHydrating = true;
  dom.settingsForm.scheduleName.value = appConfig.scheduleName || "";
  dom.settingsForm.subtitle.value = appConfig.subtitle || "";
  dom.settingsForm.minuteGranularity.value = appConfig.minuteGranularity || 5;
  dom.settingsForm.finishEarlyBufferMinutes.value =
    appConfig.finishEarlyBufferMinutes || 15;
  dom.settingsForm.includeActiveOccurrences.checked =
    appConfig.includeActiveOccurrences !== false;
  dom.settingsForm.theme.value = appConfig.theme || "sand";
  const lookaheadMinutes = Math.max(
    1,
    Math.round((appConfig.lookaheadSeconds || 14 * 24 * 60 * 60) / 60)
  );
  dom.settingsForm.lookaheadMinutes.value = lookaheadMinutes;
  dom.settingsForm.userTimeZone.value = appConfig.userTimeZone || "";
  if (dom.settingsForm.engineInitialTemp) {
    dom.settingsForm.engineInitialTemp.value = appConfig.engineInitialTemp ?? 10.0;
  }
  if (dom.settingsForm.engineFinalTemp) {
    dom.settingsForm.engineFinalTemp.value = appConfig.engineFinalTemp ?? 0.0001;
  }
  if (dom.settingsForm.engineNumIters) {
    dom.settingsForm.engineNumIters.value = appConfig.engineNumIters ?? 1000000;
  }
  if (dom.settingsForm.engineAdvancedEnabled) {
    dom.settingsForm.engineAdvancedEnabled.checked = Boolean(appConfig.engineAdvancedEnabled);
    updateAdvancedEngineVisibility(Boolean(appConfig.engineAdvancedEnabled));
  }
  if (dom.settingsForm.engineIllegalScheduleWeight) {
    dom.settingsForm.engineIllegalScheduleWeight.value =
      appConfig.engineIllegalScheduleWeight ?? 1.0;
  }
  if (dom.settingsForm.engineOverlapCostWeight) {
    dom.settingsForm.engineOverlapCostWeight.value = appConfig.engineOverlapCostWeight ?? 1.0;
  }
  if (dom.settingsForm.engineSplitCostWeight) {
    dom.settingsForm.engineSplitCostWeight.value = appConfig.engineSplitCostWeight ?? 1.0;
  }
  if (dom.settingsForm.engineConsistencyCostWeight) {
    dom.settingsForm.engineConsistencyCostWeight.value =
      appConfig.engineConsistencyCostWeight ?? 1.0;
  }
  if (dom.settingsForm.engineGranularityCostWeight) {
    dom.settingsForm.engineGranularityCostWeight.value =
      appConfig.engineGranularityCostWeight ?? 1.0;
  }
  hydrateSettingsKeybindFields();
  settingsHydrating = false;
  setSettingsDirty(false);
}

function setFormMode(mode) {
  if (mode === "edit") {
    dom.formTitle.textContent = "Edit recurrence";
    dom.formSubmitBtn.textContent = "Update";
    editOnlyElements.forEach((el) => {
      el.classList.add("active");
    });
  } else {
    dom.formTitle.textContent = "Create a recurrence";
    dom.formSubmitBtn.textContent = "Create";
    editOnlyElements.forEach((el) => {
      el.classList.remove("active");
    });
  }
}

async function refreshCalendar() {
  state.loadedRange = null;
  if (refreshView) {
    await refreshView(state.view);
  }
}

function normalizeOccurrenceKey(value) {
  const date = value ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

function isOccurrenceStarred(payload, occurrenceStart) {
  if (!payload || !occurrenceStart) return false;
  const key = normalizeOccurrenceKey(occurrenceStart);
  if (!key) return false;
  if (payload.starred) {
    const unstarred = Array.isArray(payload.unstarred) ? payload.unstarred : [];
    return !unstarred.some((item) => normalizeOccurrenceKey(item) === key);
  }
  const stars = Array.isArray(payload.stars) ? payload.stars : [];
  return stars.some((item) => normalizeOccurrenceKey(item) === key);
}

function updateStarButtons() {
  if (!dom.starRecurrenceBtn || !dom.starOccurrenceBtn) return;
  const payload = state.editingRecurrencePayload || {};
  const isStarred = Boolean(payload.starred);
  dom.starRecurrenceBtn.textContent = isStarred ? "Unstar recurrence" : "Star recurrence";
  dom.starRecurrenceBtn.classList.toggle("active", isStarred);

  const occurrenceStart = state.editingOccurrenceStart;
  const occurrenceStarred = isOccurrenceStarred(payload, occurrenceStart);
  dom.starOccurrenceBtn.textContent = occurrenceStarred ? "Unstar occurrence" : "Star occurrence";
  dom.starOccurrenceBtn.classList.toggle("active", occurrenceStarred);
}

function markUnsavedChanges() {
  if (state.editingRecurrenceId) {
    dom.formStatus.textContent = "Unsaved changes.";
  }
}

const BLOB_TYPES = {
  TASK: "task",
  EVENT: "event",
};

function normalizeBlobType(value) {
  return value === BLOB_TYPES.EVENT ? BLOB_TYPES.EVENT : BLOB_TYPES.TASK;
}

function getRangeInputs(container) {
  if (!container) return null;
  const direct = {
    defaultStart: container.querySelector('[name="defaultStart"]'),
    defaultEnd: container.querySelector('[name="defaultEnd"]'),
    schedStart: container.querySelector('[name="schedulableStart"]'),
    schedEnd: container.querySelector('[name="schedulableEnd"]'),
  };
  if (direct.defaultStart && direct.defaultEnd && direct.schedStart && direct.schedEnd) {
    return direct;
  }
  const weekly = {
    defaultStart: container.querySelector('[name="slotDefaultStart"]'),
    defaultEnd: container.querySelector('[name="slotDefaultEnd"]'),
    schedStart: container.querySelector('[name="slotSchedStart"]'),
    schedEnd: container.querySelector('[name="slotSchedEnd"]'),
  };
  if (weekly.defaultStart && weekly.defaultEnd && weekly.schedStart && weekly.schedEnd) {
    return weekly;
  }
  const multiple = {
    defaultStart: container.querySelector('[name="multiDefaultStart"]'),
    defaultEnd: container.querySelector('[name="multiDefaultEnd"]'),
    schedStart: container.querySelector('[name="multiSchedStart"]'),
    schedEnd: container.querySelector('[name="multiSchedEnd"]'),
  };
  if (multiple.defaultStart && multiple.defaultEnd && multiple.schedStart && multiple.schedEnd) {
    return multiple;
  }
  return null;
}

function syncDefaultToSched(container) {
  const inputs = getRangeInputs(container);
  if (!inputs) return;
  if (!inputs.schedStart.value || !inputs.schedEnd.value) return;
  inputs.defaultStart.value = inputs.schedStart.value;
  inputs.defaultEnd.value = inputs.schedEnd.value;
  inputs.defaultStart.dispatchEvent(new Event("change", { bubbles: true }));
  inputs.defaultEnd.dispatchEvent(new Event("change", { bubbles: true }));
}

function setBlobTypeOnContainer(container, nextType) {
  if (!container) return;
  const type = normalizeBlobType(nextType);
  container.dataset.blobType = type;
  container.classList.toggle("is-event", type === BLOB_TYPES.EVENT);
  const rangeInputs = getRangeInputs(container);
  if (rangeInputs?.defaultStart && rangeInputs?.defaultEnd) {
    const shouldRequireDefault = type === BLOB_TYPES.TASK;
    if (!rangeInputs.defaultStart.disabled) {
      rangeInputs.defaultStart.required = shouldRequireDefault;
    }
    if (!rangeInputs.defaultEnd.disabled) {
      rangeInputs.defaultEnd.required = shouldRequireDefault;
    }
  }
  if (container === nonWeeklyField) {
    state.currentBlobType = type;
    if (state.selectionMode) {
      if (type === BLOB_TYPES.EVENT) {
        state.selectionStep = "schedulable";
        dom.formStatus.textContent = "Click start/end for schedulable range.";
      } else if (!state.pendingSchedulableRange) {
        state.selectionStep = "schedulable";
        dom.formStatus.textContent = "Click start/end for schedulable range.";
      }
    }
  }
  const hiddenInput = container.querySelector("[data-blob-type-input]");
  if (hiddenInput) {
    hiddenInput.value = type;
  }
  container.querySelectorAll("[data-blob-type]").forEach((button) => {
    const isActive = button.dataset.blobType === type;
    button.classList.toggle("active", isActive);
    button.setAttribute("aria-pressed", isActive.toString());
  });
  if (type === BLOB_TYPES.EVENT) {
    syncDefaultToSched(container);
  }
}

function isEventFromRanges(defaultStart, defaultEnd, schedStart, schedEnd) {
  return Boolean(defaultStart && defaultEnd && schedStart && schedEnd) &&
    defaultStart === schedStart &&
    defaultEnd === schedEnd;
}

function bindBlobTypeSync(container) {
  const inputs = getRangeInputs(container);
  if (!inputs) return;
  const syncIfEvent = () => {
    if (container.dataset.blobType === BLOB_TYPES.EVENT) {
      syncDefaultToSched(container);
    }
  };
  inputs.schedStart.addEventListener("change", syncIfEvent);
  inputs.schedEnd.addEventListener("change", syncIfEvent);
}

function bindBlobTypeToggle(container, onChange) {
  if (!container) return;
  container.querySelectorAll("[data-blob-type]").forEach((button) => {
    button.addEventListener("click", () => {
      setBlobTypeOnContainer(container, button.dataset.blobType);
      if (onChange) {
        onChange();
      }
    });
  });
  bindBlobTypeSync(container);
}

const DEFAULT_MAX_SPLITS = 1;
const DEFAULT_MIN_SPLIT_MINUTES = 15;

function getPolicyFlagsFromPolicy(policy = {}) {
  const rawMask = Number(policy.scheduling_policies);
  const mask = Number.isFinite(rawMask) ? rawMask : 0;
  const splittable =
    typeof policy.is_splittable === "boolean" ? policy.is_splittable : Boolean(mask & 1);
  const overlappable =
    typeof policy.is_overlappable === "boolean"
      ? policy.is_overlappable
      : Boolean(mask & 2);
  const invisible =
    typeof policy.is_invisible === "boolean" ? policy.is_invisible : Boolean(mask & 4);
  const rawMaxSplits = policy.max_splits;
  const maxSplits = rawMaxSplits == null
    ? DEFAULT_MAX_SPLITS
    : Math.max(0, Math.round(Number(rawMaxSplits)));
  const rawMinSplit = policy.min_split_duration_seconds ?? policy.min_split_duration;
  const minSplitSeconds = rawMinSplit == null ? null : Number(rawMinSplit);
  const minSplitDurationMinutes = Number.isFinite(minSplitSeconds)
    ? Math.max(0, Math.round(minSplitSeconds / 60))
    : DEFAULT_MIN_SPLIT_MINUTES;
  const roundToGranularity =
    typeof policy.round_to_granularity === "boolean"
      ? policy.round_to_granularity
      : Boolean(mask & 8);
  return { splittable, overlappable, invisible, maxSplits, minSplitDurationMinutes, roundToGranularity };
}

function getPolicyPayloadFromForm() {
  const maxSplitsRaw = dom.blobForm.policyMaxSplits?.value;
  const minSplitMinutesRaw = dom.blobForm.policyMinSplitDuration?.value;
  const maxSplitsValue = Number(maxSplitsRaw);
  const minSplitMinutesValue = Number(minSplitMinutesRaw);
  const maxSplits = maxSplitsRaw === "" || !Number.isFinite(maxSplitsValue)
    ? DEFAULT_MAX_SPLITS
    : Math.max(0, Math.round(maxSplitsValue));
  const minSplitMinutes = minSplitMinutesRaw === "" || !Number.isFinite(minSplitMinutesValue)
    ? DEFAULT_MIN_SPLIT_MINUTES
    : Math.max(0, Math.round(minSplitMinutesValue));
  const roundToGranularity = Boolean(dom.blobForm.policyRoundToGranularity?.checked);
  return getPolicyPayloadFromFlags(
    Boolean(dom.blobForm.policySplittable?.checked),
    Boolean(dom.blobForm.policyOverlappable?.checked),
    Boolean(dom.blobForm.policyInvisible?.checked),
    maxSplits,
    minSplitMinutes * 60,
    roundToGranularity
  );
}

function getPolicyPayloadFromFlags(
  splittable,
  overlappable,
  invisible,
  maxSplits = DEFAULT_MAX_SPLITS,
  minSplitDurationSeconds = DEFAULT_MIN_SPLIT_MINUTES * 60,
  roundToGranularity = false
) {
  const schedulingPolicies =
    (splittable ? 1 : 0)
    | (overlappable ? 2 : 0)
    | (invisible ? 4 : 0)
    | (roundToGranularity ? 8 : 0);
  return {
    is_splittable: splittable,
    is_overlappable: overlappable,
    is_invisible: invisible,
    max_splits: maxSplits,
    min_split_duration_seconds: minSplitDurationSeconds,
    round_to_granularity: roundToGranularity,
    scheduling_policies: schedulingPolicies,
  };
}

function setPolicyAdvancedVisibility(container, isSplittable) {
  const scope = container?.closest?.(".weekly-slot")
    || container?.closest?.("form")
    || container;
  const advancedRow = scope?.querySelector?.(".slot-policy-advanced");
  if (!advancedRow) return;
  advancedRow.classList.toggle("is-hidden", !isSplittable);
}

function setDependencies(ids) {
  dependencyIds = Array.from(new Set((ids || []).filter(Boolean)));
  renderDependencyList();
}

function getDependencies() {
  return dependencyIds.slice();
}

function normalizeTagName(value) {
  if (typeof value !== "string") return "";
  return value.trim();
}

function tagKey(value) {
  return normalizeTagName(value).toLowerCase();
}

function parseTagInput(value) {
  if (!value) return [];
  return value
    .split(",")
    .map((item) => normalizeTagName(item))
    .filter(Boolean);
}

function formatTagInput(tags) {
  return (tags || []).map((item) => normalizeTagName(item)).filter(Boolean).join(", ");
}

function setTags(tags) {
  const next = [];
  const seen = new Set();
  (tags || []).forEach((tag) => {
    const name = normalizeTagName(tag);
    if (!name) return;
    const key = tagKey(name);
    if (seen.has(key)) return;
    seen.add(key);
    next.push(name);
  });
  tagNames = next;
  renderTagList();
}

function getTags() {
  return tagNames.slice();
}

function setSlotTagList(slot, tags) {
  const next = [];
  const seen = new Set();
  (tags || []).forEach((tag) => {
    const name = normalizeTagName(tag);
    if (!name) return;
    const key = tagKey(name);
    if (seen.has(key)) return;
    seen.add(key);
    next.push(name);
  });
  slotTagStore.set(slot, next);
  renderSlotTagList(slot);
}

function getSlotTagList(slot) {
  return slotTagStore.get(slot) || [];
}

function setSlotTags(slot, tags) {
  setSlotTagList(slot, tags);
}

function getSlotTags(slot) {
  return getSlotTagList(slot);
}

function setSlotDependencies(slot, ids) {
  const next = [];
  const seen = new Set();
  (ids || []).forEach((id) => {
    const value = typeof id === "string" ? id.trim() : "";
    if (!value) return;
    if (seen.has(value)) return;
    seen.add(value);
    next.push(value);
  });
  slotDependencyStore.set(slot, next);
  renderSlotDependencyList(slot);
}

function getSlotDependencies(slot) {
  return slotDependencyStore.get(slot) || [];
}

function getRecurrenceColor() {
  const selected = document.querySelector('input[name="recurrenceColor"]:checked');
  const value = selected?.value || "default";
  return value === "default" ? null : value;
}

function setRecurrenceColor(value) {
  const target = value || "default";
  document.querySelectorAll('input[name="recurrenceColor"]').forEach((input) => {
    input.checked = input.value === target;
  });
}

function getRecurrenceEndValue() {
  if (!dom.recurrenceEnd) return null;
  const value = dom.recurrenceEnd.value;
  if (!value) return null;
  const iso = toProjectIsoFromLocalInput(
    value,
    appConfig.userTimeZone,
    appConfig.projectTimeZone
  );
  return iso || null;
}

function setRecurrenceEndValue(value) {
  if (!dom.recurrenceEnd) return;
  dom.recurrenceEnd.value = value
    ? toLocalInputValueInTimeZone(value, appConfig.userTimeZone)
    : "";
}

function findBlobById(id) {
  return state.blobs.find((item) => item.id === id) || null;
}

function findBlobByName(name) {
  if (!name) return null;
  const normalized = name.trim().toLowerCase();
  if (!normalized) return null;
  return state.blobs.find((item) => item.name?.toLowerCase() === normalized) || null;
}

function getDependencySuggestions(query) {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return [];
  const matches = state.blobs.filter((item) => {
    if (dependencyIds.includes(item.id)) return false;
    const name = item.name?.toLowerCase() || "";
    return name.includes(normalized) || item.id.toLowerCase().includes(normalized);
  });
  matches.sort((a, b) => (a.name || "").localeCompare(b.name || ""));
  return matches.slice(0, 6);
}

function getAvailableTags() {
  const seen = new Map();
  state.blobs.forEach((blob) => {
    (blob.tags || []).forEach((tag) => {
      const name = normalizeTagName(tag);
      if (!name) return;
      const key = tagKey(name);
      if (!seen.has(key)) {
        seen.set(key, name);
      }
    });
  });
  return Array.from(seen.values());
}

function getTagSuggestions(query) {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return [];
  const selected = new Set(tagNames.map((tag) => tagKey(tag)));
  const matches = getAvailableTags().filter((tag) => {
    if (selected.has(tagKey(tag))) return false;
    return tag.toLowerCase().includes(normalized);
  });
  matches.sort((a, b) => a.localeCompare(b));
  return matches.slice(0, 6);
}

function getSlotTagSuggestions(query, selectedTags) {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return [];
  const selected = new Set((selectedTags || []).map((tag) => tagKey(tag)));
  const matches = getAvailableTags().filter((tag) => {
    if (selected.has(tagKey(tag))) return false;
    return tag.toLowerCase().includes(normalized);
  });
  matches.sort((a, b) => a.localeCompare(b));
  return matches.slice(0, 6);
}

function getSlotDependencySuggestions(query, selectedIds) {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return [];
  const selected = new Set((selectedIds || []).map((id) => id.toLowerCase()));
  const matches = state.blobs.filter((item) => {
    if (selected.has(item.id.toLowerCase())) return false;
    const name = item.name?.toLowerCase() || "";
    return name.includes(normalized) || item.id.toLowerCase().includes(normalized);
  });
  matches.sort((a, b) => (a.name || "").localeCompare(b.name || ""));
  return matches.slice(0, 6);
}

function renderDependencySuggestions() {
  if (!dom.dependencySuggestions) return;
  const query = dom.dependencyInput?.value || "";
  const matches = getDependencySuggestions(query);
  dom.dependencySuggestions.innerHTML = "";
  if (!query.trim() || matches.length === 0) return;
  matches.forEach((match) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "dependency-suggestion";
    button.dataset.dependencyId = match.id;
    button.textContent = match.name || "Untitled";
    button.title = match.id;
    dom.dependencySuggestions.appendChild(button);
  });
}

function renderTagSuggestions() {
  if (!dom.tagSuggestions) return;
  const query = dom.tagInput?.value || "";
  const matches = getTagSuggestions(query);
  dom.tagSuggestions.innerHTML = "";
  if (!query.trim() || matches.length === 0) return;
  matches.forEach((match) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "tag-suggestion";
    button.dataset.tagName = match;
    button.textContent = match;
    dom.tagSuggestions.appendChild(button);
  });
}

function renderSlotTagSuggestions(slot) {
  const suggestions = slot.querySelector(".slot-tag-suggestions");
  const input = slot.querySelector('[name="slotTagInput"]');
  if (!suggestions || !input) return;
  const query = input.value || "";
  const matches = getSlotTagSuggestions(query, getSlotTagList(slot));
  suggestions.innerHTML = "";
  if (!query.trim() || matches.length === 0) return;
  matches.forEach((match) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "tag-suggestion";
    button.dataset.tagName = match;
    button.textContent = match;
    suggestions.appendChild(button);
  });
}

function renderSlotDependencySuggestions(slot) {
  const suggestions = slot.querySelector(".slot-dependency-suggestions");
  const input = slot.querySelector('[name="slotDependencyInput"]');
  if (!suggestions || !input) return;
  const query = input.value || "";
  const matches = getSlotDependencySuggestions(query, getSlotDependencies(slot));
  suggestions.innerHTML = "";
  if (!query.trim() || matches.length === 0) return;
  matches.forEach((match) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "dependency-suggestion";
    button.dataset.dependencyId = match.id;
    button.textContent = match.name || "Untitled";
    button.title = match.id;
    suggestions.appendChild(button);
  });
}

function renderDependencyList() {
  if (!dom.dependencyList) return;
  dom.dependencyList.innerHTML = "";
  dependencyIds.forEach((id) => {
    const blob = findBlobById(id);
    const name = blob?.name || "Unknown blob";
    const recurrenceName = blob?.recurrence_payload?.recurrence_name;
    const pill = document.createElement("div");
    pill.className = "dependency-pill";
    pill.dataset.dependencyId = id;

    const label = document.createElement("span");
    label.className = "dependency-name";
    label.textContent = name;
    pill.appendChild(label);

    const tooltip = document.createElement("div");
    tooltip.className = "dependency-tooltip";

    const title = document.createElement("div");
    title.className = "dependency-tooltip-title";
    title.textContent = name;
    tooltip.appendChild(title);

    const idRow = document.createElement("div");
    idRow.className = "dependency-tooltip-row";
    const idLabel = document.createElement("span");
    idLabel.className = "dependency-tooltip-label";
    idLabel.textContent = "Blob id";
    const idValue = document.createElement("span");
    idValue.className = "dependency-tooltip-value";
    idValue.textContent = id;
    idRow.appendChild(idLabel);
    idRow.appendChild(idValue);
    tooltip.appendChild(idRow);

    if (recurrenceName) {
      const recurrenceRow = document.createElement("div");
      recurrenceRow.className = "dependency-tooltip-row";
      const recurrenceLabel = document.createElement("span");
      recurrenceLabel.className = "dependency-tooltip-label";
      recurrenceLabel.textContent = "Recurrence";
      const recurrenceValue = document.createElement("span");
      recurrenceValue.className = "dependency-tooltip-value";
      recurrenceValue.textContent = recurrenceName;
      recurrenceRow.appendChild(recurrenceLabel);
      recurrenceRow.appendChild(recurrenceValue);
      tooltip.appendChild(recurrenceRow);
    }

    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "ghost small dependency-remove";
    removeBtn.textContent = "Remove dependency";
    removeBtn.dataset.removeDependency = id;
    tooltip.appendChild(removeBtn);

    pill.appendChild(tooltip);
    dom.dependencyList.appendChild(pill);
  });
}

function renderTagList() {
  if (!dom.tagList) return;
  dom.tagList.innerHTML = "";
  tagNames.forEach((name) => {
    const pill = document.createElement("div");
    pill.className = "tag-pill";
    pill.dataset.tagName = name;

    const label = document.createElement("span");
    label.className = "tag-name";
    label.textContent = name;
    pill.appendChild(label);

    const tooltip = document.createElement("div");
    tooltip.className = "tag-tooltip";
    const title = document.createElement("div");
    title.className = "tag-tooltip-title";
    title.textContent = name;
    tooltip.appendChild(title);

    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "ghost small tag-remove";
    removeBtn.textContent = "Remove tag";
    removeBtn.dataset.removeTag = name;
    tooltip.appendChild(removeBtn);

    pill.appendChild(tooltip);
    dom.tagList.appendChild(pill);
  });
}

function renderSlotTagList(slot) {
  const list = slot.querySelector(".slot-tag-list");
  if (!list) return;
  list.innerHTML = "";
  getSlotTagList(slot).forEach((name) => {
    const pill = document.createElement("div");
    pill.className = "tag-pill";
    pill.dataset.tagName = name;

    const label = document.createElement("span");
    label.className = "tag-name";
    label.textContent = name;
    pill.appendChild(label);

    const tooltip = document.createElement("div");
    tooltip.className = "tag-tooltip";
    const title = document.createElement("div");
    title.className = "tag-tooltip-title";
    title.textContent = name;
    tooltip.appendChild(title);

    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "ghost small tag-remove";
    removeBtn.textContent = "Remove tag";
    removeBtn.dataset.removeSlotTag = name;
    tooltip.appendChild(removeBtn);

    pill.appendChild(tooltip);
    list.appendChild(pill);
  });
}

function renderSlotDependencyList(slot) {
  const list = slot.querySelector(".slot-dependency-list");
  if (!list) return;
  list.innerHTML = "";
  getSlotDependencies(slot).forEach((id) => {
    const blob = findBlobById(id);
    const name = blob?.name || "Unknown blob";
    const pill = document.createElement("div");
    pill.className = "dependency-pill";
    pill.dataset.dependencyId = id;

    const label = document.createElement("span");
    label.className = "dependency-name";
    label.textContent = name;
    pill.appendChild(label);

    const tooltip = document.createElement("div");
    tooltip.className = "dependency-tooltip";

    const title = document.createElement("div");
    title.className = "dependency-tooltip-title";
    title.textContent = name;
    tooltip.appendChild(title);

    const idRow = document.createElement("div");
    idRow.className = "dependency-tooltip-row";
    const idLabel = document.createElement("span");
    idLabel.className = "dependency-tooltip-label";
    idLabel.textContent = "Blob id";
    const idValue = document.createElement("span");
    idValue.className = "dependency-tooltip-value";
    idValue.textContent = id;
    idRow.appendChild(idLabel);
    idRow.appendChild(idValue);
    tooltip.appendChild(idRow);

    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "ghost small dependency-remove";
    removeBtn.textContent = "Remove dependency";
    removeBtn.dataset.removeSlotDependency = id;
    tooltip.appendChild(removeBtn);

    pill.appendChild(tooltip);
    list.appendChild(pill);
  });
}

function addDependencyFromInput() {
  if (!dom.dependencyInput) return;
  const raw = dom.dependencyInput.value.trim();
  if (!raw) return;
  const matches = getDependencySuggestions(raw);
  const candidate =
    matches[0] ||
    findBlobById(raw) ||
    findBlobByName(raw);
  if (!candidate) {
    dom.formStatus.textContent = "No matching blob found.";
    return;
  }
  if (!dependencyIds.includes(candidate.id)) {
    dependencyIds.push(candidate.id);
    renderDependencyList();
  }
  dom.formStatus.textContent = "";
  dom.dependencyInput.value = "";
  dom.dependencySuggestions.innerHTML = "";
}

function addTagFromInput() {
  if (!dom.tagInput) return;
  const raw = dom.tagInput.value.trim();
  if (!raw) return;
  const matches = getTagSuggestions(raw);
  const candidate = matches[0] || raw;
  const key = tagKey(candidate);
  const seen = new Set(tagNames.map((tag) => tagKey(tag)));
  if (!seen.has(key)) {
    tagNames.push(candidate);
    renderTagList();
  }
  dom.formStatus.textContent = "";
  dom.tagInput.value = "";
  dom.tagSuggestions.innerHTML = "";
}

function addSlotTagFromInput(slot) {
  const input = slot.querySelector('[name="slotTagInput"]');
  const suggestions = slot.querySelector(".slot-tag-suggestions");
  if (!input) return;
  const raw = input.value.trim();
  if (!raw) return;
  const matches = getSlotTagSuggestions(raw, getSlotTagList(slot));
  const candidate = matches[0] || raw;
  const key = tagKey(candidate);
  const seen = new Set(getSlotTagList(slot).map((tag) => tagKey(tag)));
  if (!seen.has(key)) {
    setSlotTagList(slot, [...getSlotTagList(slot), candidate]);
  }
  dom.formStatus.textContent = "";
  input.value = "";
  if (suggestions) {
    suggestions.innerHTML = "";
  }
}

function addSlotDependencyFromInput(slot) {
  const input = slot.querySelector('[name="slotDependencyInput"]');
  const suggestions = slot.querySelector(".slot-dependency-suggestions");
  if (!input) return;
  const raw = input.value.trim();
  if (!raw) return;
  const matches = getSlotDependencySuggestions(raw, getSlotDependencies(slot));
  const candidate =
    matches[0] ||
    findBlobById(raw) ||
    findBlobByName(raw);
  if (!candidate) {
    dom.formStatus.textContent = "No matching blob found.";
    return;
  }
  const existing = getSlotDependencies(slot);
  if (!existing.includes(candidate.id)) {
    setSlotDependencies(slot, [...existing, candidate.id]);
  }
  dom.formStatus.textContent = "";
  input.value = "";
  if (suggestions) {
    suggestions.innerHTML = "";
  }
}

function applyPolicyToForm(policy) {
  const flags = getPolicyFlagsFromPolicy(policy || {});
  if (dom.blobForm.policySplittable) {
    dom.blobForm.policySplittable.checked = flags.splittable;
  }
  if (dom.blobForm.policyOverlappable) {
    dom.blobForm.policyOverlappable.checked = flags.overlappable;
  }
  if (dom.blobForm.policyInvisible) {
    dom.blobForm.policyInvisible.checked = flags.invisible;
  }
  if (dom.blobForm.policyMaxSplits) {
    dom.blobForm.policyMaxSplits.value = String(flags.maxSplits ?? 0);
  }
  if (dom.blobForm.policyMinSplitDuration) {
    dom.blobForm.policyMinSplitDuration.value = String(flags.minSplitDurationMinutes ?? 0);
  }
  if (dom.blobForm.policyRoundToGranularity) {
    dom.blobForm.policyRoundToGranularity.checked = flags.roundToGranularity;
  }
  setPolicyAdvancedVisibility(dom.blobForm.policySplittable || dom.blobForm, flags.splittable);
}

function applyPolicyToSlot(slot, policy) {
  const flags = getPolicyFlagsFromPolicy(policy || {});
  const splittableEl = slot.querySelector('[name="slotPolicySplittable"]');
  const overlappableEl = slot.querySelector('[name="slotPolicyOverlappable"]');
  const invisibleEl = slot.querySelector('[name="slotPolicyInvisible"]');
  const maxSplitsEl = slot.querySelector('[name="slotPolicyMaxSplits"]');
  const minSplitDurationEl = slot.querySelector('[name="slotPolicyMinSplitDuration"]');
  const roundToGranularityEl = slot.querySelector('[name="slotPolicyRoundToGranularity"]');
  if (splittableEl) splittableEl.checked = flags.splittable;
  if (overlappableEl) overlappableEl.checked = flags.overlappable;
  if (invisibleEl) invisibleEl.checked = flags.invisible;
  if (maxSplitsEl) maxSplitsEl.value = String(flags.maxSplits ?? 0);
  if (minSplitDurationEl) {
    minSplitDurationEl.value = String(flags.minSplitDurationMinutes ?? 0);
  }
  if (roundToGranularityEl) {
    roundToGranularityEl.checked = flags.roundToGranularity;
  }
  setPolicyAdvancedVisibility(slot, flags.splittable);
}

function syncSlotPoliciesFromForm() {
  if (!dom.weeklySlots) return;
  const sharedPolicy = getPolicyPayloadFromForm();
  dom.weeklySlots.querySelectorAll(".weekly-slot").forEach((slot) => {
    applyPolicyToSlot(slot, sharedPolicy);
  });
}

function syncSlotTagsFromForm() {
  if (!dom.weeklySlots) return;
  const sharedTags = getTags();
  dom.weeklySlots.querySelectorAll(".weekly-slot").forEach((slot) => {
    setSlotTags(slot, sharedTags);
  });
}

function collectSlotTagsUnion() {
  if (!dom.weeklySlots) return [];
  const merged = [];
  const seen = new Set();
  dom.weeklySlots.querySelectorAll(".weekly-slot").forEach((slot) => {
    getSlotTags(slot).forEach((tag) => {
      const name = normalizeTagName(tag);
      if (!name) return;
      const key = tagKey(name);
      if (seen.has(key)) return;
      seen.add(key);
      merged.push(name);
    });
  });
  return merged;
}

function updateRecurrenceUI() {
  const type = dom.recurrenceType?.value || "single";
  const isMultiple = type === "multiple";
  storeWeeklyFieldPlacement(weeklyFieldPlacement.dependency);
  storeWeeklyFieldPlacement(weeklyFieldPlacement.tag);
  if (type === "weekly" && weeklyRecurrenceFields) {
    moveWeeklyField(weeklyFieldPlacement.tag, weeklyRecurrenceFields);
    restoreWeeklyField(weeklyFieldPlacement.dependency);
  } else {
    restoreWeeklyField(weeklyFieldPlacement.dependency);
    restoreWeeklyField(weeklyFieldPlacement.tag);
  }
  recurrenceFieldGroups.forEach((group) => {
    const matches = group.dataset.recurrence === type;
    group.classList.toggle("active", matches);
  });
  dom.formPanel.classList.toggle("weekly-mode", type === "weekly");
  dom.formPanel.classList.toggle("date-mode", type === "date");
  dom.formPanel.classList.toggle("multiple-mode", isMultiple);
  dom.formPanel.classList.toggle("single-mode", type === "single");
  const weeklyWrapper = dom.weeklySlots?.closest(".weekly-slots");
  if (weeklyWrapper) {
    weeklyWrapper.classList.toggle("per-slot", Boolean(dom.weeklyPerSlot?.checked));
  }
  const isWeeklyPerSlot = Boolean(dom.weeklyPerSlot?.checked);
  document.querySelectorAll(".non-weekly-field").forEach((field) => {
    field.classList.toggle("hidden", isMultiple);
  });
  document.querySelectorAll(".dependency-field:not(.slot-dependency-field)").forEach((field) => {
    field.classList.toggle("hidden", isMultiple || type === "weekly");
  });
  document.querySelectorAll(".tag-field").forEach((field) => {
    field.classList.toggle("hidden", isMultiple || (type === "weekly" && isWeeklyPerSlot));
  });
  document.querySelectorAll(".color-field").forEach((field) => {
    field.classList.toggle("hidden", isMultiple);
  });
  document.querySelectorAll(".recurrence-extras").forEach((field) => {
    field.classList.toggle("hidden", isMultiple);
  });
  document.querySelectorAll(".non-weekly-field input").forEach((field) => {
    const isCheckbox = field.type === "checkbox";
    const isOptional = field.type === "hidden" || field.name === "blobDescription";
    const isMetaField = field.name === "blobName" || field.name === "blobDescription";
    const isPolicyField = field.name?.startsWith?.("policy");
    const isTimeRangeField = [
      "defaultStart",
      "defaultEnd",
      "schedulableStart",
      "schedulableEnd",
    ].includes(field.name);
    if (type === "weekly" || isMultiple) {
      field.disabled = true;
      field.required = false;
    } else if (type === "single" && isMetaField) {
      field.disabled = true;
      field.required = false;
    } else if (type === "date") {
      if (isTimeRangeField || isMetaField || isPolicyField) {
        field.disabled = true;
        field.required = false;
      } else {
        field.disabled = false;
        field.required = !isCheckbox && !isOptional;
      }
    } else {
      field.disabled = false;
      field.required = !isCheckbox && !isOptional;
    }
  });
  document.querySelectorAll(".multiple-slots input").forEach((field) => {
    if (isMultiple) {
      field.disabled = false;
      if (field.name === "multiName") {
        field.required = true;
      }
    } else {
      field.disabled = true;
      field.required = false;
    }
  });
  const annualDateField = dom.blobForm.annualDate;
  if (annualDateField) {
    annualDateField.disabled = type !== "date";
    annualDateField.required = type === "date";
  }
  if (dom.recurrenceEnd) {
    dom.recurrenceEnd.disabled = type === "single" || isMultiple;
    if (type === "single" || isMultiple) {
      dom.recurrenceEnd.value = "";
    }
  }

  if (dom.blobForm?.policySplittable) {
    setPolicyAdvancedVisibility(dom.blobForm.policySplittable, dom.blobForm.policySplittable.checked);
  }

  if (type === "multiple") {
    const slotCount = getMultipleSlots().length;
    dom.recurrenceSummary.textContent = `Grouping ${slotCount} occurrence(s).`;
  } else {
    const defaultStart = dom.blobForm.defaultStart.value;
    const annualDate = dom.blobForm.annualDate?.value || "";
    const startDate = annualDate
      ? new Date(`${annualDate}T00:00:00`)
      : defaultStart
        ? new Date(
            toProjectIsoFromLocalInput(
              defaultStart,
              appConfig.userTimeZone,
              appConfig.projectTimeZone
            )
          )
        : state.anchorDate;
    if (Number.isNaN(startDate.getTime())) {
      dom.recurrenceSummary.textContent = "Set a default start time to preview the cadence.";
      return;
    }
    if (type === "weekly") {
      const interval = Number(dom.blobForm.weeklyInterval.value || 1);
      const slotSelections = getWeeklySlotSelections();
      const slotCount = slotSelections.reduce((total, slot) => total + slot.days.length, 0);
    dom.recurrenceSummary.textContent = `Repeats every ${interval} week(s) with ${slotCount} occurrence(s).`;
    } else if (type === "delta") {
      const value = Number(dom.blobForm.deltaValue.value || 1);
      const unit = dom.blobForm.deltaUnit.value || "days";
      dom.recurrenceSummary.textContent = `Repeats every ${value} ${unit}.`;
    } else if (type === "date") {
      if (!annualDate) {
        dom.recurrenceSummary.textContent = "Select an annual date.";
        return;
      }
      const dateLabel = startDate.toLocaleDateString(undefined, {
        month: "long",
        day: "numeric",
      });
      dom.recurrenceSummary.textContent = `Repeats annually on ${dateLabel}.`;
    } else {
      dom.recurrenceSummary.textContent = "One-time event. Switch to create repeats.";
    }
  }

  const endValue = dom.recurrenceEnd?.value;
  if (endValue && type !== "single" && !isMultiple) {
    const endDate = new Date(endValue);
    if (!Number.isNaN(endDate.getTime())) {
      const endLabel = endDate.toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
      dom.recurrenceSummary.textContent = `${dom.recurrenceSummary.textContent} Ends ${endLabel}.`;
    }
  }
}

function timeToMinutes(value) {
  if (!value) return null;
  const [hours, minutes] = value.split(":").map((part) => Number(part));
  if (Number.isNaN(hours) || Number.isNaN(minutes)) return null;
  return hours * 60 + minutes;
}

function timeValueFromDate(date, fallback, timeZone) {
  if (!date || Number.isNaN(date.getTime())) return fallback;
  const local = formatDateTimeLocalInTimeZone(date, timeZone);
  return local.split("T")[1] || fallback;
}

function weekdayIndexFromDateString(dateString) {
  const [year, month, day] = dateString.split("-").map((part) => Number(part));
  if ([year, month, day].some((item) => Number.isNaN(item))) {
    return 0;
  }
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

function dayOffsetFromSunday(dayIndex) {
  return dayIndex;
}

function getWeeklyAnchorStartFromPayload(payload) {
  const blobs = Array.isArray(payload?.blobs_of_week) ? payload.blobs_of_week : [];
  let earliest = null;
  blobs.forEach((weeklyBlob) => {
    const startRaw =
      weeklyBlob?.schedulable_timerange?.start ||
      weeklyBlob?.default_scheduled_timerange?.start;
    if (!startRaw) return;
    const start = new Date(startRaw);
    if (Number.isNaN(start.getTime())) return;
    if (!earliest || start < earliest) {
      earliest = start;
    }
  });
  return earliest ? getWeekStart(earliest) : null;
}

function clearWeeklySlots() {
  if (dom.weeklySlots) {
    dom.weeklySlots.innerHTML = "";
  }
}

function createWeeklySlot(slotData = {}) {
  if (!dom.weeklySlots) return;
  const lastSlot = dom.weeklySlots.querySelector(".weekly-slot:last-of-type");
  const lastValues = lastSlot
    ? {
        defaultStart: lastSlot.querySelector('[name="slotDefaultStart"]')?.value,
        defaultEnd: lastSlot.querySelector('[name="slotDefaultEnd"]')?.value,
        schedStart: lastSlot.querySelector('[name="slotSchedStart"]')?.value,
        schedEnd: lastSlot.querySelector('[name="slotSchedEnd"]')?.value,
      }
    : null;
  const slot = document.createElement("div");
  slot.className = "weekly-slot";
  const slotId = typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID()
    : `slot-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  slot.dataset.slotId = slotId;
  const dayValues = Array.isArray(slotData.days)
    ? slotData.days
    : [slotData.day ?? 0];
  const defaultStart = slotData.defaultStart || lastValues?.defaultStart || "09:00";
  const defaultEnd = slotData.defaultEnd || lastValues?.defaultEnd || "10:00";
  const schedStart = slotData.schedStart || lastValues?.schedStart || "08:30";
  const schedEnd = slotData.schedEnd || lastValues?.schedEnd || "10:30";
  const nameValue = slotData.name || "";
  const descriptionValue = slotData.description || "";
  const tagsValue = slotData.tags || [];
  const fallbackPolicy = dom.weeklyPerSlot?.checked ? getPolicyPayloadFromForm() : {};
  const policyFlags = getPolicyFlagsFromPolicy(slotData.policy ?? fallbackPolicy);
  const slotType = normalizeBlobType(
    slotData.blobType || (isEventFromRanges(defaultStart, defaultEnd, schedStart, schedEnd)
      ? BLOB_TYPES.EVENT
      : BLOB_TYPES.TASK)
  );
  slot.innerHTML = `
    <div class="weekly-slot-row slot-day-row">
      <div class="slot-day-field">
        <span class="slot-day-label">Days</span>
        <div class="slot-day-toggle" role="group" aria-label="Day of week">
          ${WEEK_DAYS.map(
            (day, index) =>
              `<button type="button" class="day-pill ${dayValues.includes(index) ? "active" : ""}" data-day="${index}" aria-pressed="${dayValues.includes(index) ? "true" : "false"}">${day.charAt(0)}</button>`
          ).join("")}
        </div>
      </div>
    </div>
    <div class="weekly-slot-row blob-type-row">
      <div class="blob-type-toggle" role="group" aria-label="Occurrence type">
        <button type="button" class="type-pill ${slotType === BLOB_TYPES.TASK ? "active" : ""}" data-blob-type="task" aria-pressed="${slotType === BLOB_TYPES.TASK}">
          Task
        </button>
        <button type="button" class="type-pill ${slotType === BLOB_TYPES.EVENT ? "active" : ""}" data-blob-type="event" aria-pressed="${slotType === BLOB_TYPES.EVENT}">
          Event
        </button>
      </div>
      <input type="hidden" name="slotBlobType" value="${slotType}" data-blob-type-input />
    </div>
    <div class="weekly-slot-row time-range-row schedulable-range-row">
      <label>
        Schedulable start
        <input type="time" name="slotSchedStart" value="${schedStart}" required />
      </label>
      <label>
        Schedulable end
        <input type="time" name="slotSchedEnd" value="${schedEnd}" required />
      </label>
    </div>
    <div class="weekly-slot-row time-range-row default-range-row">
      <label>
        Default start
        <input type="time" name="slotDefaultStart" value="${defaultStart}" required />
      </label>
      <label>
        Default end
        <input type="time" name="slotDefaultEnd" value="${defaultEnd}" required />
      </label>
    </div>
    <div class="weekly-slot-row slot-meta">
      <label>
        Occurrence name
        <input type="text" name="slotName" value="${nameValue}" />
      </label>
      <label>
        Occurrence description
        <input type="text" name="slotDescription" value="${descriptionValue}" />
      </label>
    </div>
    <div class="weekly-slot-row policy-label-row">
      <span class="policy-label">Policy options</span>
    </div>
    <div class="weekly-slot-row slot-policy">
      <label class="policy-option policy-splittable">
        <input type="checkbox" name="slotPolicySplittable" ${
          policyFlags.splittable ? "checked" : ""
        } />
        <span>Splittable</span>
      </label>
      <label class="policy-option">
        <input type="checkbox" name="slotPolicyOverlappable" ${
          policyFlags.overlappable ? "checked" : ""
        } />
        <span>Overlappable</span>
      </label>
      <label class="policy-option">
        <input type="checkbox" name="slotPolicyInvisible" ${
          policyFlags.invisible ? "checked" : ""
        } />
        <span>Invisible</span>
      </label>
    </div>
    <div class="weekly-slot-row slot-policy-advanced ${policyFlags.splittable ? "" : "is-hidden"}">
      <label>
        Max splits
        <input
          type="number"
          name="slotPolicyMaxSplits"
          min="0"
          step="1"
          value="${policyFlags.maxSplits ?? DEFAULT_MAX_SPLITS}"
        />
      </label>
      <label>
        Min split duration (min)
        <input
          type="number"
          name="slotPolicyMinSplitDuration"
          min="0"
          step="1"
          value="${policyFlags.minSplitDurationMinutes ?? DEFAULT_MIN_SPLIT_MINUTES}"
        />
      </label>
      <label class="policy-option">
        <input
          type="checkbox"
          name="slotPolicyRoundToGranularity"
          ${policyFlags.roundToGranularity ? "checked" : ""}
        />
        <span>Round to granularity</span>
      </label>
    </div>
    <div class="weekly-slot-row slot-tags slot-tag-field">
      <span class="tag-label">Tags</span>
      <div class="tag-input-row">
        <input
          type="text"
          name="slotTagInput"
          class="needs-input"
          placeholder="Search or add a tag"
          autocomplete="off"
        />
        <button
          type="button"
          class="ghost small"
          data-action="add-slot-tag"
          aria-label="Add tag"
          title="Add tag"
        >
          +
        </button>
      </div>
      <div class="tag-suggestions slot-tag-suggestions"></div>
      <div class="tag-list slot-tag-list"></div>
    </div>
    <div class="weekly-slot-actions">
      <button type="button" class="ghost small" data-action="remove-slot">Remove</button>
    </div>
  `;
  setBlobTypeOnContainer(slot, slotType);
  slot.querySelector('[data-action="remove-slot"]').addEventListener("click", () => {
    slot.remove();
    updateRecurrenceUI();
    validateWeeklySlots();
  });
  slotTagStore.set(slot, Array.isArray(tagsValue) ? tagsValue : []);
  renderSlotTagList(slot);
  slot.querySelectorAll("input").forEach((field) => {
    field.addEventListener("change", () => {
      if (field.name === "slotPolicySplittable") {
        setPolicyAdvancedVisibility(slot, field.checked);
      }
      updateRecurrenceUI();
      validateWeeklySlots();
    });
  });
  slot.querySelectorAll(".day-pill").forEach((button) => {
    button.addEventListener("click", () => {
      button.classList.toggle("active");
      button.setAttribute(
        "aria-pressed",
        button.classList.contains("active") ? "true" : "false"
      );
      updateRecurrenceUI();
      validateWeeklySlots();
    });
  });
  const slotTagInput = slot.querySelector('[name="slotTagInput"]');
  const slotTagSuggestions = slot.querySelector(".slot-tag-suggestions");
  const addSlotTagBtn = slot.querySelector('[data-action="add-slot-tag"]');
  if (slotTagInput) {
    slotTagInput.addEventListener("input", () => renderSlotTagSuggestions(slot));
    slotTagInput.addEventListener("focus", () => renderSlotTagSuggestions(slot));
    slotTagInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        addSlotTagFromInput(slot);
      }
    });
  }
  if (addSlotTagBtn) {
    addSlotTagBtn.addEventListener("click", () => addSlotTagFromInput(slot));
  }
  if (slotTagSuggestions) {
    slotTagSuggestions.addEventListener("click", (event) => {
      const target = event.target.closest(".tag-suggestion");
      if (!target) return;
      const name = target.dataset.tagName;
      if (name) {
        const key = tagKey(name);
        const seen = new Set(getSlotTagList(slot).map((tag) => tagKey(tag)));
        if (!seen.has(key)) {
          setSlotTagList(slot, [...getSlotTagList(slot), name]);
        }
      }
      if (slotTagInput) {
        slotTagInput.value = "";
      }
      slotTagSuggestions.innerHTML = "";
    });
  }
  const slotTagList = slot.querySelector(".slot-tag-list");
  if (slotTagList) {
    slotTagList.addEventListener("click", (event) => {
      const target = event.target.closest("[data-remove-slot-tag]");
      if (!target) return;
      const name = target.dataset.removeSlotTag;
      setSlotTagList(
        slot,
        getSlotTagList(slot).filter((tag) => tagKey(tag) !== tagKey(name))
      );
    });
  }
  bindBlobTypeToggle(slot, () => {
    validateWeeklySlots();
  });
  dom.weeklySlots.appendChild(slot);
  updateRecurrenceUI();
  validateWeeklySlots();
}

function getSelectedDays(slot) {
  return Array.from(slot.querySelectorAll(".day-pill.active"))
    .map((pill) => Number(pill.dataset.day))
    .filter((value) => !Number.isNaN(value));
}

function getWeeklySlotSelections() {
  if (!dom.weeklySlots) return [];
  const selections = [];
  dom.weeklySlots.querySelectorAll(".weekly-slot").forEach((slot) => {
    const splittable = Boolean(slot.querySelector('[name="slotPolicySplittable"]')?.checked);
    const overlappable = Boolean(slot.querySelector('[name="slotPolicyOverlappable"]')?.checked);
    const invisible = Boolean(slot.querySelector('[name="slotPolicyInvisible"]')?.checked);
    const maxSplitsRaw = slot.querySelector('[name="slotPolicyMaxSplits"]')?.value;
    const minSplitMinutesRaw = slot.querySelector('[name="slotPolicyMinSplitDuration"]')?.value;
    const maxSplitsValue = Number(maxSplitsRaw);
    const minSplitMinutesValue = Number(minSplitMinutesRaw);
    const maxSplits = maxSplitsRaw === "" || !Number.isFinite(maxSplitsValue)
      ? DEFAULT_MAX_SPLITS
      : Math.max(0, Math.round(maxSplitsValue));
    const minSplitMinutes = minSplitMinutesRaw === "" || !Number.isFinite(minSplitMinutesValue)
      ? DEFAULT_MIN_SPLIT_MINUTES
      : Math.max(0, Math.round(minSplitMinutesValue));
    const roundToGranularity = Boolean(
      slot.querySelector('[name="slotPolicyRoundToGranularity"]')?.checked
    );
    const slotType = normalizeBlobType(slot.querySelector('[name="slotBlobType"]')?.value);
    const schedStart = slot.querySelector('[name="slotSchedStart"]').value;
    const schedEnd = slot.querySelector('[name="slotSchedEnd"]').value;
    const defaultStart = slotType === BLOB_TYPES.EVENT
      ? schedStart
      : slot.querySelector('[name="slotDefaultStart"]').value;
    const defaultEnd = slotType === BLOB_TYPES.EVENT
      ? schedEnd
      : slot.querySelector('[name="slotDefaultEnd"]').value;
    selections.push({
      days: getSelectedDays(slot),
      blobType: slotType,
      defaultStart,
      defaultEnd,
      schedStart,
      schedEnd,
      name: slot.querySelector('[name="slotName"]').value,
      description: slot.querySelector('[name="slotDescription"]').value,
      tags: getSlotTags(slot),
      policy: getPolicyPayloadFromFlags(
        splittable,
        overlappable,
        invisible,
        maxSplits,
        minSplitMinutes * 60,
        roundToGranularity
      ),
    });
  });
  return selections;
}

function getWeeklySlots() {
  const slots = [];
  getWeeklySlotSelections().forEach((slot) => {
    slot.days.forEach((day) => {
      slots.push({ ...slot, day });
    });
  });
  return slots;
}

function validateWeeklySlots() {
  if (!dom.weeklySlotStatus) return true;
  const selections = getWeeklySlotSelections();
  if (selections.length === 0) {
    dom.weeklySlotStatus.textContent = "Add at least one weekly occurrence.";
    return false;
  }
  for (const slot of selections) {
    if (slot.days.length === 0) {
      dom.weeklySlotStatus.textContent = "Weekly occurrences need a day of week.";
      return false;
    }
  }
  const slots = getWeeklySlots();
  const ranges = [];
  for (const slot of slots) {
    const defaultStart = timeToMinutes(slot.defaultStart);
    const defaultEnd = timeToMinutes(slot.defaultEnd);
    const schedStart = timeToMinutes(slot.schedStart);
    const schedEnd = timeToMinutes(slot.schedEnd);
    if (
      defaultStart === null ||
      defaultEnd === null ||
      schedStart === null ||
      schedEnd === null
    ) {
      dom.weeklySlotStatus.textContent = "Weekly occurrences need valid times.";
      return false;
    }
    if (defaultEnd <= defaultStart || schedEnd <= schedStart) {
      dom.weeklySlotStatus.textContent = "Weekly occurrences must end after they start.";
      return false;
    }
    if (schedStart > defaultStart || schedEnd < defaultEnd) {
      dom.weeklySlotStatus.textContent =
        "Schedulable range must contain default range for each occurrence.";
      return false;
    }
    const offset = dayOffsetFromSunday(slot.day);
    ranges.push({
      start: offset * 1440 + schedStart,
      end: offset * 1440 + schedEnd,
    });
  }
  const sorted = ranges.sort((a, b) => a.start - b.start);
  for (let i = 0; i < sorted.length - 1; i += 1) {
    if (sorted[i].end > sorted[i + 1].start) {
      dom.weeklySlotStatus.textContent = "Weekly occurrences cannot overlap.";
      return false;
    }
  }
  dom.weeklySlotStatus.textContent = "";
  return true;
}

function clearMultipleSlots() {
  if (dom.multipleSlots) {
    dom.multipleSlots.innerHTML = "";
  }
}

function createMultipleSlot(slotData = {}) {
  if (!dom.multipleSlots) return;
  const slot = document.createElement("div");
  slot.className = "weekly-slot multiple-slot";
  const slotId = typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID()
    : `multi-slot-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  slot.dataset.slotId = slotId;

  const defaultStart = slotData.defaultStart || "";
  const defaultEnd = slotData.defaultEnd || "";
  const schedStart = slotData.schedStart || "";
  const schedEnd = slotData.schedEnd || "";
  const nameValue = slotData.name || "";
  const descriptionValue = slotData.description || "";
  const tagsValue = slotData.tags || [];
  const policyFlags = getPolicyFlagsFromPolicy(slotData.policy || {});
  const slotType = normalizeBlobType(
    slotData.blobType || (isEventFromRanges(defaultStart, defaultEnd, schedStart, schedEnd)
      ? BLOB_TYPES.EVENT
      : BLOB_TYPES.TASK)
  );

  slot.innerHTML = `
    <div class="weekly-slot-row blob-type-row">
      <div class="blob-type-toggle" role="group" aria-label="Occurrence type">
        <button type="button" class="type-pill ${slotType === BLOB_TYPES.TASK ? "active" : ""}" data-blob-type="task" aria-pressed="${slotType === BLOB_TYPES.TASK}">
          Task
        </button>
        <button type="button" class="type-pill ${slotType === BLOB_TYPES.EVENT ? "active" : ""}" data-blob-type="event" aria-pressed="${slotType === BLOB_TYPES.EVENT}">
          Event
        </button>
      </div>
      <input type="hidden" name="multiBlobType" value="${slotType}" data-blob-type-input />
    </div>
    <div class="weekly-slot-row time-range-row schedulable-range-row">
      <label>
        Schedulable start
        <div class="datetime-field">
          <input type="text" class="datetime-display" placeholder="Select date/time" readonly />
          <button type="button" class="ghost small datetime-trigger" aria-label="Pick date">
            📅
          </button>
          <input type="hidden" name="multiSchedStart" data-datetime-input />
        </div>
      </label>
      <label>
        Schedulable end
        <div class="datetime-field">
          <input type="text" class="datetime-display" placeholder="Select date/time" readonly />
          <button type="button" class="ghost small datetime-trigger" aria-label="Pick date">
            📅
          </button>
          <input type="hidden" name="multiSchedEnd" data-datetime-input />
        </div>
      </label>
    </div>
    <div class="weekly-slot-row time-range-row default-range-row">
      <label>
        Default start
        <div class="datetime-field">
          <input type="text" class="datetime-display" placeholder="Select date/time" readonly />
          <button type="button" class="ghost small datetime-trigger" aria-label="Pick date">
            📅
          </button>
          <input type="hidden" name="multiDefaultStart" data-datetime-input />
        </div>
      </label>
      <label>
        Default end
        <div class="datetime-field">
          <input type="text" class="datetime-display" placeholder="Select date/time" readonly />
          <button type="button" class="ghost small datetime-trigger" aria-label="Pick date">
            📅
          </button>
          <input type="hidden" name="multiDefaultEnd" data-datetime-input />
        </div>
      </label>
    </div>
    <div class="weekly-slot-row slot-meta">
      <label>
        Occurrence name
        <input type="text" name="multiName" class="needs-input" value="${nameValue}" required />
      </label>
      <label>
        Occurrence description
        <input type="text" name="multiDescription" class="needs-input" value="${descriptionValue}" />
      </label>
    </div>
    <div class="weekly-slot-row policy-label-row">
      <span class="policy-label">Policy options</span>
    </div>
    <div class="weekly-slot-row slot-policy">
      <label class="policy-option policy-splittable">
        <input type="checkbox" name="slotPolicySplittable" ${
          policyFlags.splittable ? "checked" : ""
        } />
        <span>Splittable</span>
      </label>
      <label class="policy-option">
        <input type="checkbox" name="slotPolicyOverlappable" ${
          policyFlags.overlappable ? "checked" : ""
        } />
        <span>Overlappable</span>
      </label>
      <label class="policy-option">
        <input type="checkbox" name="slotPolicyInvisible" ${
          policyFlags.invisible ? "checked" : ""
        } />
        <span>Invisible</span>
      </label>
    </div>
    <div class="weekly-slot-row slot-policy-advanced ${policyFlags.splittable ? "" : "is-hidden"}">
      <label>
        Max splits
        <input
          type="number"
          name="slotPolicyMaxSplits"
          min="0"
          step="1"
          value="${policyFlags.maxSplits ?? DEFAULT_MAX_SPLITS}"
        />
      </label>
      <label>
        Min split duration (min)
        <input
          type="number"
          name="slotPolicyMinSplitDuration"
          min="0"
          step="1"
          value="${policyFlags.minSplitDurationMinutes ?? DEFAULT_MIN_SPLIT_MINUTES}"
        />
      </label>
      <label class="policy-option">
        <input type="checkbox" name="slotPolicyRoundToGranularity" ${
          policyFlags.roundToGranularity ? "checked" : ""
        } />
        <span>Round to granularity</span>
      </label>
    </div>
    <div class="dependency-field slot-dependency-field">
      <span class="dependency-label">Dependencies</span>
      <div class="dependency-input-row">
        <input
          type="text"
          name="slotDependencyInput"
          class="needs-input"
          placeholder="Search by blob name or id"
          autocomplete="off"
        />
        <button
          type="button"
          class="ghost small"
          data-action="add-slot-dependency"
          aria-label="Add dependency"
          title="Add dependency"
        >
          +
        </button>
      </div>
      <div class="dependency-suggestions slot-dependency-suggestions"></div>
      <div class="dependency-list slot-dependency-list"></div>
    </div>
    <div class="weekly-slot-row slot-tags slot-tag-field">
      <span class="tag-label">Tags</span>
      <div class="tag-input-row">
        <input
          type="text"
          name="slotTagInput"
          class="needs-input"
          placeholder="Search or add a tag"
          autocomplete="off"
        />
        <button
          type="button"
          class="ghost small"
          data-action="add-slot-tag"
          aria-label="Add tag"
          title="Add tag"
        >
          +
        </button>
      </div>
      <div class="tag-suggestions slot-tag-suggestions"></div>
      <div class="tag-list slot-tag-list"></div>
    </div>
    <div class="weekly-slot-row weekly-slot-actions">
      <button type="button" class="ghost small" data-action="remove-multiple-slot">
        Remove
      </button>
    </div>
  `;

  dom.multipleSlots.appendChild(slot);

  const defaultStartInput = slot.querySelector('[name="multiDefaultStart"]');
  const defaultEndInput = slot.querySelector('[name="multiDefaultEnd"]');
  const schedStartInput = slot.querySelector('[name="multiSchedStart"]');
  const schedEndInput = slot.querySelector('[name="multiSchedEnd"]');
  if (defaultStartInput) defaultStartInput.value = defaultStart;
  if (defaultEndInput) defaultEndInput.value = defaultEnd;
  if (schedStartInput) schedStartInput.value = schedStart;
  if (schedEndInput) schedEndInput.value = schedEnd;
  setBlobTypeOnContainer(slot, slotType);

  setSlotTagList(slot, Array.isArray(tagsValue) ? tagsValue : []);
  setSlotDependencies(slot, Array.isArray(slotData.dependencies) ? slotData.dependencies : []);

  const removeBtn = slot.querySelector('[data-action="remove-multiple-slot"]');
  if (removeBtn) {
    removeBtn.addEventListener("click", () => {
      slot.remove();
      validateMultipleSlots();
      updateRecurrenceUI();
    });
  }

  bindDateTimePickers();
  syncDateTimeDisplays();
  const tagInput = slot.querySelector('[name="slotTagInput"]');
  const tagSuggestions = slot.querySelector(".slot-tag-suggestions");
  const addTagBtn = slot.querySelector('[data-action="add-slot-tag"]');
  if (tagInput) {
    tagInput.addEventListener("input", () => renderSlotTagSuggestions(slot));
    tagInput.addEventListener("focus", () => renderSlotTagSuggestions(slot));
    tagInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === ",") {
        event.preventDefault();
        addSlotTagFromInput(slot);
      }
    });
  }
  if (addTagBtn) {
    addTagBtn.addEventListener("click", () => addSlotTagFromInput(slot));
  }
  if (tagSuggestions) {
    tagSuggestions.addEventListener("click", (event) => {
      const target = event.target.closest("[data-tag-name]");
      if (!target) return;
      const candidate = target.dataset.tagName;
      if (!candidate) return;
      const currentTags = getSlotTagList(slot);
      if (!currentTags.some((tag) => tagKey(tag) === tagKey(candidate))) {
        setSlotTagList(slot, [...currentTags, candidate]);
      }
      if (tagInput) {
        tagInput.value = "";
      }
      tagSuggestions.innerHTML = "";
    });
  }
  const tagList = slot.querySelector(".slot-tag-list");
  if (tagList) {
    tagList.addEventListener("click", (event) => {
      const target = event.target.closest("[data-remove-slot-tag]");
      if (!target) return;
      const name = target.dataset.removeSlotTag;
      setSlotTagList(
        slot,
        getSlotTagList(slot).filter((tag) => tagKey(tag) !== tagKey(name))
      );
    });
  }
  const dependencyInput = slot.querySelector('[name="slotDependencyInput"]');
  const dependencySuggestions = slot.querySelector(".slot-dependency-suggestions");
  const addDependencyBtn = slot.querySelector('[data-action="add-slot-dependency"]');
  if (dependencyInput) {
    dependencyInput.addEventListener("input", () => renderSlotDependencySuggestions(slot));
    dependencyInput.addEventListener("focus", () => renderSlotDependencySuggestions(slot));
    dependencyInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === ",") {
        event.preventDefault();
        addSlotDependencyFromInput(slot);
      }
    });
  }
  if (addDependencyBtn) {
    addDependencyBtn.addEventListener("click", () => addSlotDependencyFromInput(slot));
  }
  if (dependencySuggestions) {
    dependencySuggestions.addEventListener("click", (event) => {
      const target = event.target.closest("[data-dependency-id]");
      if (!target) return;
      const candidate = target.dataset.dependencyId;
      if (!candidate) return;
      const current = getSlotDependencies(slot);
      if (!current.includes(candidate)) {
        setSlotDependencies(slot, [...current, candidate]);
      }
      if (dependencyInput) {
        dependencyInput.value = "";
      }
      dependencySuggestions.innerHTML = "";
    });
  }
  const dependencyList = slot.querySelector(".slot-dependency-list");
  if (dependencyList) {
    dependencyList.addEventListener("click", (event) => {
      const target = event.target.closest("[data-remove-slot-dependency]");
      if (!target) return;
      const id = target.dataset.removeSlotDependency;
      setSlotDependencies(
        slot,
        getSlotDependencies(slot).filter((depId) => depId !== id)
      );
    });
  }
  bindBlobTypeToggle(slot, () => {
    validateMultipleSlots();
  });
  ["slotPolicySplittable", "slotPolicyOverlappable", "slotPolicyInvisible"].forEach((name) => {
    const field = slot.querySelector(`[name="${name}"]`);
    if (!field) return;
    field.addEventListener("change", () => {
      if (name === "slotPolicySplittable") {
        setPolicyAdvancedVisibility(field, field.checked);
      }
    });
  });

  validateMultipleSlots();
  updateRecurrenceUI();
}

function getMultipleSlots() {
  if (!dom.multipleSlots) return [];
  const slots = [];
  dom.multipleSlots.querySelectorAll(".multiple-slot").forEach((slot) => {
    const slotType = normalizeBlobType(slot.querySelector('[name="multiBlobType"]')?.value);
    const schedStart = slot.querySelector('[name="multiSchedStart"]')?.value || "";
    const schedEnd = slot.querySelector('[name="multiSchedEnd"]')?.value || "";
    slots.push({
      blobType: slotType,
      defaultStart: slotType === BLOB_TYPES.EVENT
        ? schedStart
        : slot.querySelector('[name="multiDefaultStart"]')?.value || "",
      defaultEnd: slotType === BLOB_TYPES.EVENT
        ? schedEnd
        : slot.querySelector('[name="multiDefaultEnd"]')?.value || "",
      schedStart,
      schedEnd,
      name: slot.querySelector('[name="multiName"]')?.value?.trim() || "",
      description: slot.querySelector('[name="multiDescription"]')?.value?.trim() || "",
      tags: getSlotTags(slot),
      dependencies: getSlotDependencies(slot),
      policy: getPolicyPayloadFromFlags(
        Boolean(slot.querySelector('[name="slotPolicySplittable"]')?.checked),
        Boolean(slot.querySelector('[name="slotPolicyOverlappable"]')?.checked),
        Boolean(slot.querySelector('[name="slotPolicyInvisible"]')?.checked),
        Number(slot.querySelector('[name="slotPolicyMaxSplits"]')?.value || 0),
        Number(slot.querySelector('[name="slotPolicyMinSplitDuration"]')?.value || 0),
        Boolean(slot.querySelector('[name="slotPolicyRoundToGranularity"]')?.checked)
      ),
    });
  });
  return slots;
}

function validateMultipleSlots() {
  if (!dom.multipleSlotStatus) return true;
  const slots = getMultipleSlots();
  if (slots.length === 0) {
    dom.multipleSlotStatus.textContent = "Add at least one occurrence.";
    return false;
  }
  for (const slot of slots) {
    if (!slot.name) {
      dom.multipleSlotStatus.textContent = "Occurrences need a name.";
      return false;
    }
    const defaultStart = new Date(slot.defaultStart);
    const defaultEnd = new Date(slot.defaultEnd);
    const schedStart = new Date(slot.schedStart);
    const schedEnd = new Date(slot.schedEnd);
    if ([defaultStart, defaultEnd, schedStart, schedEnd].some((dt) => Number.isNaN(dt.getTime()))) {
      dom.multipleSlotStatus.textContent = "Occurrences need valid date/time values.";
      return false;
    }
    if (defaultEnd <= defaultStart) {
      dom.multipleSlotStatus.textContent = "Default end must be after default start.";
      return false;
    }
    if (schedEnd <= schedStart) {
      dom.multipleSlotStatus.textContent = "Schedulable end must be after schedulable start.";
      return false;
    }
    if (schedStart > defaultStart || schedEnd < defaultEnd) {
      dom.multipleSlotStatus.textContent =
        "Schedulable range must contain default range for each occurrence.";
      return false;
    }
  }
  dom.multipleSlotStatus.textContent = "";
  return true;
}

function resetFormMode() {
  state.editingRecurrenceId = null;
  state.editingRecurrenceType = null;
  state.editingRecurrencePayload = null;
  state.editingWeeklyAnchorStart = null;
  state.editingOccurrenceStart = null;
  state.selectionMode = false;
  state.selectionStep = null;
  state.pendingDefaultRange = null;
  state.pendingSchedulableRange = null;
  state.selectionPointer = null;
  if (state.selectionScrollHandler) {
    window.removeEventListener("scroll", state.selectionScrollHandler);
    window.removeEventListener("resize", state.selectionScrollHandler);
    state.selectionScrollHandler = null;
  }
  dom.blobForm.reset();
  setBlobTypeOnContainer(nonWeeklyField, BLOB_TYPES.TASK);
  if (dom.recurrenceType) {
    dom.recurrenceType.value = "single";
  }
  setRecurrenceColor(null);
  setRecurrenceEndValue(null);
  applyPolicyToForm({});
  setDependencies([]);
  setTags([]);
  if (dom.dependencyInput) {
    dom.dependencyInput.value = "";
  }
  if (dom.dependencySuggestions) {
    dom.dependencySuggestions.innerHTML = "";
  }
  if (dom.tagInput) {
    dom.tagInput.value = "";
  }
  if (dom.tagSuggestions) {
    dom.tagSuggestions.innerHTML = "";
  }
  clearWeeklySlots();
  createWeeklySlot();
  if (dom.weeklySlotStatus) {
    dom.weeklySlotStatus.textContent = "";
  }
  clearMultipleSlots();
  createMultipleSlot();
  if (dom.multipleSlotStatus) {
    dom.multipleSlotStatus.textContent = "";
  }
  updateRecurrenceUI();
  setFormMode("create");
  updateStarButtons();
  dom.formStatus.textContent = "";
  document.querySelectorAll(".selection-overlay").forEach((overlay) => {
    overlay.classList.remove("active");
    overlay.style.top = "";
    overlay.style.height = "";
  });
  document.querySelectorAll(".selection-caret").forEach((caret) => {
    caret.classList.remove("active");
    caret.style.top = "";
  });
  syncDateTimeDisplays();
}

function openEditForm(blob) {
  if (!isBlobEditableInMainUi(blob)) {
    alertDialog(
      "This event belongs to a source calendar and is read-only in the main timeline. Copy it to Main to edit."
    );
    return;
  }
  state.selectionMode = false;
  state.selectionStep = null;
  state.pendingDefaultRange = null;
  state.pendingSchedulableRange = null;
  state.editingWeeklyAnchorStart = null;
  const recurrenceType = blob.recurrence_type || "single";
  if (dom.recurrenceType) {
    dom.recurrenceType.value = recurrenceType;
  }
  dom.blobForm.recurrenceName.value = blob.recurrence_payload?.recurrence_name || "";
  dom.blobForm.recurrenceDescription.value =
    blob.recurrence_payload?.recurrence_description || "";
  setRecurrenceEndValue(blob.recurrence_payload?.end_date || null);
  setRecurrenceColor(blob.recurrence_payload?.color || null);
  if (recurrenceType === "multiple") {
    setRecurrenceEndValue(null);
    setRecurrenceColor(null);
  }
  if (recurrenceType !== "multiple") {
    dom.blobForm.blobName.value = blob.name || "";
    dom.blobForm.blobDescription.value = blob.description || "";
    setDependencies(Array.isArray(blob.dependencies) ? blob.dependencies : []);
    setTags(Array.isArray(blob.tags) ? blob.tags : []);
  } else {
    dom.blobForm.blobName.value = "";
    dom.blobForm.blobDescription.value = "";
    setDependencies([]);
    setTags([]);
  }
  const blobTimeZone = blob.tz || appConfig.userTimeZone;
  if (recurrenceType !== "date") {
    dom.blobForm.defaultStart.value = toLocalInputValueInTimeZone(
      blob.default_scheduled_timerange?.start,
      blobTimeZone
    );
    dom.blobForm.defaultEnd.value = toLocalInputValueInTimeZone(
      blob.default_scheduled_timerange?.end,
      blobTimeZone
    );
    dom.blobForm.schedulableStart.value = toLocalInputValueInTimeZone(
      blob.schedulable_timerange?.start,
      blobTimeZone
    );
    dom.blobForm.schedulableEnd.value = toLocalInputValueInTimeZone(
      blob.schedulable_timerange?.end,
      blobTimeZone
    );
    setBlobTypeOnContainer(
      nonWeeklyField,
      isEventFromRanges(
        dom.blobForm.defaultStart.value,
        dom.blobForm.defaultEnd.value,
        dom.blobForm.schedulableStart.value,
        dom.blobForm.schedulableEnd.value
      )
        ? BLOB_TYPES.EVENT
        : BLOB_TYPES.TASK
    );
  }
  if (dom.blobForm.annualDate) {
    const dateValue = toLocalInputValueInTimeZone(
      blob.default_scheduled_timerange?.start,
      blobTimeZone
    );
    dom.blobForm.annualDate.value = dateValue ? dateValue.split("T")[0] : "";
  }
  if (recurrenceType === "date") {
    setBlobTypeOnContainer(nonWeeklyField, BLOB_TYPES.EVENT);
  }
  clearWeeklySlots();
  clearMultipleSlots();
  if (blob.recurrence_payload?.interval && dom.blobForm.weeklyInterval) {
    dom.blobForm.weeklyInterval.value = blob.recurrence_payload.interval;
  }
  if (recurrenceType === "weekly" && blob.recurrence_payload?.blobs_of_week) {
    const blobs = blob.recurrence_payload.blobs_of_week;
    state.editingWeeklyAnchorStart = getWeeklyAnchorStartFromPayload(
      blob.recurrence_payload
    );
    applyPolicyToForm(blobs[0]?.policy || {});
    const sharedName = blobs[0]?.name || "";
    const sharedDescription = blobs[0]?.description || "";
    const sharedTags = Array.isArray(blobs[0]?.tags) ? blobs[0].tags : [];
    dom.blobForm.blobName.value = sharedName;
    dom.blobForm.blobDescription.value = sharedDescription || "";
    const tagsDiffer = blobs.some((item) => {
      const itemTags = Array.isArray(item.tags) ? item.tags : [];
      if (itemTags.length !== sharedTags.length) return true;
      const sharedKeys = new Set(sharedTags.map((tag) => tagKey(tag)));
      return itemTags.some((tag) => !sharedKeys.has(tagKey(tag)));
    });
    const hasCustom =
      blobs.some((item) => item.name !== sharedName || item.description !== sharedDescription) ||
      tagsDiffer ||
      false;
    if (dom.weeklyPerSlot) {
      const storedPerSlot = typeof blob.recurrence_payload?.weekly_per_slot === "boolean"
        ? blob.recurrence_payload.weekly_per_slot
        : null;
      dom.weeklyPerSlot.checked = storedPerSlot !== null ? storedPerSlot : hasCustom;
    }
    const groupedSlots = new Map();
    blobs.forEach((weeklyBlob) => {
      const slotTimeZone = weeklyBlob.tz || appConfig.userTimeZone;
      const start = new Date(weeklyBlob.default_scheduled_timerange?.start);
      const end = new Date(weeklyBlob.default_scheduled_timerange?.end);
      const schedStart = new Date(weeklyBlob.schedulable_timerange?.start);
      const schedEnd = new Date(weeklyBlob.schedulable_timerange?.end);
      const startLocal = Number.isNaN(start.getTime())
        ? ""
        : formatDateTimeLocalInTimeZone(start, slotTimeZone);
      const dayValue = startLocal
        ? weekdayIndexFromDateString(startLocal.split("T")[0])
        : 1;
      const tags = Array.isArray(weeklyBlob.tags) ? weeklyBlob.tags : [];
      const normalizedTags = tags.map((tag) => tagKey(tag)).sort();
      const policyFlags = getPolicyFlagsFromPolicy(weeklyBlob.policy || {});
      const slot = {
        defaultStart: timeValueFromDate(start, "09:00", slotTimeZone),
        defaultEnd: timeValueFromDate(end, "10:00", slotTimeZone),
        schedStart: timeValueFromDate(schedStart, "08:30", slotTimeZone),
        schedEnd: timeValueFromDate(schedEnd, "10:30", slotTimeZone),
        name: weeklyBlob.name || "",
        description: weeklyBlob.description || "",
        tags,
        policy: weeklyBlob.policy || {},
        days: [dayValue],
        blobType: isEventFromRanges(
          timeValueFromDate(start, "09:00", slotTimeZone),
          timeValueFromDate(end, "10:00", slotTimeZone),
          timeValueFromDate(schedStart, "08:30", slotTimeZone),
          timeValueFromDate(schedEnd, "10:30", slotTimeZone)
        )
          ? BLOB_TYPES.EVENT
          : BLOB_TYPES.TASK,
      };
      const key = JSON.stringify({
        defaultStart: slot.defaultStart,
        defaultEnd: slot.defaultEnd,
        schedStart: slot.schedStart,
        schedEnd: slot.schedEnd,
        name: slot.name,
        description: slot.description,
        tags: normalizedTags,
        policy: policyFlags,
      });
      const existing = groupedSlots.get(key);
      if (existing) {
        if (!existing.days.includes(dayValue)) {
          existing.days.push(dayValue);
        }
      } else {
        groupedSlots.set(key, slot);
      }
    });
    groupedSlots.forEach((slot) => {
      createWeeklySlot({
        days: slot.days,
        defaultStart: slot.defaultStart,
        defaultEnd: slot.defaultEnd,
        schedStart: slot.schedStart,
        schedEnd: slot.schedEnd,
        name: slot.name,
        description: slot.description,
        tags: slot.tags,
        policy: slot.policy,
        blobType: slot.blobType,
      });
    });
    setDependencies(Array.isArray(blobs[0]?.dependencies) ? blobs[0].dependencies : []);
    setTags(hasCustom ? [] : sharedTags);
  } else if (recurrenceType === "multiple" && blob.recurrence_payload?.blobs) {
    const blobs = blob.recurrence_payload.blobs;
    if (!blobs.length) {
      createMultipleSlot();
    } else {
      blobs.forEach((multiBlob) => {
        const slotTimeZone = multiBlob.tz || appConfig.userTimeZone;
        const defaultStart = toLocalInputValueInTimeZone(
          multiBlob.default_scheduled_timerange?.start,
          slotTimeZone
        );
        const defaultEnd = toLocalInputValueInTimeZone(
          multiBlob.default_scheduled_timerange?.end,
          slotTimeZone
        );
        const schedStart = toLocalInputValueInTimeZone(
          multiBlob.schedulable_timerange?.start,
          slotTimeZone
        );
        const schedEnd = toLocalInputValueInTimeZone(
          multiBlob.schedulable_timerange?.end,
          slotTimeZone
        );
        createMultipleSlot({
          defaultStart,
          defaultEnd,
          schedStart,
          schedEnd,
          name: multiBlob.name || "",
          description: multiBlob.description || "",
          tags: Array.isArray(multiBlob.tags) ? multiBlob.tags : [],
          dependencies: Array.isArray(multiBlob.dependencies) ? multiBlob.dependencies : [],
          policy: multiBlob.policy || {},
          blobType: isEventFromRanges(defaultStart, defaultEnd, schedStart, schedEnd)
            ? BLOB_TYPES.EVENT
            : BLOB_TYPES.TASK,
        });
      });
    }
  } else {
    applyPolicyToForm(blob.policy);
    createWeeklySlot();
  }
  if (blob.recurrence_payload?.delta_seconds && dom.blobForm.deltaValue) {
    const deltaSeconds = Number(blob.recurrence_payload.delta_seconds);
    let value = Math.max(1, Math.round(deltaSeconds / 86400));
    let unit = "days";
    if (deltaSeconds % 604800 === 0) {
      value = Math.max(1, Math.round(deltaSeconds / 604800));
      unit = "weeks";
    } else if (deltaSeconds % 3600 === 0) {
      value = Math.max(1, Math.round(deltaSeconds / 3600));
      unit = "hours";
    } else if (deltaSeconds % 60 === 0) {
      value = Math.max(1, Math.round(deltaSeconds / 60));
      unit = "minutes";
    }
    dom.blobForm.deltaValue.value = value;
    dom.blobForm.deltaUnit.value = unit;
  }
  if (dom.multipleSlots && dom.multipleSlots.children.length === 0) {
    createMultipleSlot();
  }
  state.editingRecurrenceId = blob.recurrence_id || null;
  state.editingRecurrenceType = recurrenceType;
  state.editingRecurrencePayload = blob.recurrence_payload || {};
  state.editingOccurrenceStart = blob.schedulable_timerange?.start || null;
  updateRecurrenceUI();
  setFormMode("edit");
  updateStarButtons();
  dom.formStatus.textContent = "";
  toggleForm(true);
  syncDateTimeDisplays();
}

async function deleteRecurrence() {
  if (!state.editingRecurrenceId) return;
  const confirmed = await confirmDialog("Delete this entire recurrence?", {
    confirmText: "Delete",
    cancelText: "Cancel",
    destructive: true,
  });
  if (!confirmed) return;
  dom.formStatus.textContent = "Deleting recurrence...";
  try {
    await deleteRecurrenceWithUndo(state.editingRecurrenceId);
    dom.formStatus.textContent = "Deleted.";
    toggleForm(false);
    resetFormMode();
    await refreshCalendar();
  } catch (error) {
    dom.formStatus.textContent = error?.message || "Error deleting recurrence.";
  }
}

async function deleteOccurrence() {
  if (!state.editingRecurrenceId) return;
  if (state.editingRecurrenceType === "single") {
    await deleteRecurrence();
    return;
  }
  const occurrenceStart = state.editingOccurrenceStart;
  if (!occurrenceStart) {
    dom.formStatus.textContent = "Missing occurrence start.";
    return;
  }
  const confirmed = await confirmDialog("Delete only this occurrence?", {
    confirmText: "Delete",
    cancelText: "Cancel",
    destructive: true,
  });
  if (!confirmed) return;
  dom.formStatus.textContent = "Deleting occurrence...";
  try {
    const blob = state.blobs.find((item) => item.recurrence_id === state.editingRecurrenceId);
    await deleteOccurrenceWithUndo(
      blob || {
        recurrence_id: state.editingRecurrenceId,
        recurrence_type: state.editingRecurrenceType,
        recurrence_payload: state.editingRecurrencePayload,
        schedulable_timerange: { start: occurrenceStart },
      }
    );
    dom.formStatus.textContent = "Deleted.";
    toggleForm(false);
    resetFormMode();
    await refreshCalendar();
  } catch (error) {
    dom.formStatus.textContent = error?.message || "Error deleting occurrence.";
  }
}

function toggleStarRecurrence() {
  if (!state.editingRecurrenceId) return;
  const payload = state.editingRecurrencePayload || {};
  const nextStarred = !payload.starred;
  state.editingRecurrencePayload = {
    ...payload,
    starred: nextStarred,
    unstarred: nextStarred ? payload.unstarred || [] : [],
  };
  updateStarButtons();
  markUnsavedChanges();
}

function toggleStarOccurrence() {
  if (!state.editingRecurrenceId) return;
  const occurrenceStart = state.editingOccurrenceStart;
  if (!occurrenceStart) {
    dom.formStatus.textContent = "Missing occurrence start.";
    return;
  }
  const key = normalizeOccurrenceKey(occurrenceStart);
  if (!key) {
    dom.formStatus.textContent = "Invalid occurrence start.";
    return;
  }
  const payload = state.editingRecurrencePayload || {};
  if (payload.starred) {
    const unstarred = Array.isArray(payload.unstarred) ? payload.unstarred : [];
    const nextUnstarred = unstarred.some((item) => normalizeOccurrenceKey(item) === key)
      ? unstarred.filter((item) => normalizeOccurrenceKey(item) !== key)
      : [...unstarred, key];
    state.editingRecurrencePayload = { ...payload, unstarred: nextUnstarred };
  } else {
    const stars = Array.isArray(payload.stars) ? payload.stars : [];
    const nextStars = stars.some((item) => normalizeOccurrenceKey(item) === key)
      ? stars.filter((item) => normalizeOccurrenceKey(item) !== key)
      : [...stars, key];
    state.editingRecurrencePayload = { ...payload, stars: nextStars };
  }
  updateStarButtons();
  markUnsavedChanges();
}

async function handleBlobSubmit(event) {
  event.preventDefault();
  console.log("Form submit clicked", {
    recurrenceType: dom.blobForm.recurrenceType?.value,
    blobType: dom.blobForm.blobType?.value,
  });
  dom.formStatus.textContent = "Saving...";
  const formData = new FormData(dom.blobForm);
  const policyPayload = getPolicyPayloadFromForm();
  const dependencies = getDependencies();
  const tags = getTags();
  const recurrenceType = formData.get("recurrenceType") || "single";
  const blobType = normalizeBlobType(formData.get("blobType"));
  const perSlot = recurrenceType === "weekly" && Boolean(dom.weeklyPerSlot?.checked);
  const recurrenceColor = getRecurrenceColor();
  const recurrenceEnd = getRecurrenceEndValue();
  const recurrenceName = formData.get("recurrenceName");
  const recurrenceDescription = formData.get("recurrenceDescription") || null;
  const schedulableStart = formData.get("schedulableStart");
  const schedulableEnd = formData.get("schedulableEnd");
  const defaultStart = blobType === BLOB_TYPES.EVENT
    ? schedulableStart
    : formData.get("defaultStart");
  const defaultEnd = blobType === BLOB_TYPES.EVENT
    ? schedulableEnd
    : formData.get("defaultEnd");
  if (!["weekly", "multiple", "date"].includes(recurrenceType)) {
    const defaultStartDate = new Date(defaultStart);
    const defaultEndDate = new Date(defaultEnd);
    const schedStartDate = new Date(schedulableStart);
    const schedEndDate = new Date(schedulableEnd);
    if (
      [defaultStartDate, defaultEndDate, schedStartDate, schedEndDate].some(
        (dt) => Number.isNaN(dt.getTime())
      )
    ) {
      dom.formStatus.textContent = "Select valid start and end times.";
      return;
    }
    if (defaultEndDate <= defaultStartDate) {
      dom.formStatus.textContent = "Default end must be after default start.";
      return;
    }
    if (schedEndDate <= schedStartDate) {
      dom.formStatus.textContent = "Schedulable end must be after schedulable start.";
      return;
    }
    if (schedStartDate > defaultStartDate || schedEndDate < defaultEndDate) {
      dom.formStatus.textContent =
        "Schedulable range must contain default range.";
      return;
    }
  }
  const blobName = recurrenceType === "single"
    ? (recurrenceName || "Unnamed Blob")
    : (formData.get("blobName") || "Unnamed Blob");
  const blobDescription = recurrenceType === "single"
    ? recurrenceDescription
    : (formData.get("blobDescription") || null);
  let baseBlob = {
    name: blobName,
    description: blobDescription,
    tz: appConfig.userTimeZone,
    default_scheduled_timerange: {
      start: toProjectIsoFromLocalInput(
        defaultStart,
        appConfig.userTimeZone,
        appConfig.projectTimeZone
      ),
      end: toProjectIsoFromLocalInput(
        defaultEnd,
        appConfig.userTimeZone,
        appConfig.projectTimeZone
      ),
    },
    schedulable_timerange: {
      start: toProjectIsoFromLocalInput(
        schedulableStart,
        appConfig.userTimeZone,
        appConfig.projectTimeZone
      ),
      end: toProjectIsoFromLocalInput(
        schedulableEnd,
        appConfig.userTimeZone,
        appConfig.projectTimeZone
      ),
    },
    policy: policyPayload,
    dependencies,
    tags,
  };
  const priorPayload = state.editingRecurrencePayload || {};
  let recurrencePayload = {};
  if (recurrenceType === "weekly") {
    const isValid = validateWeeklySlots();
    if (!isValid) {
      dom.formStatus.textContent = "Fix weekly slot errors before saving.";
      return;
    }
    const editAnchor =
      state.editingRecurrenceId &&
      state.editingRecurrenceType === "weekly" &&
      state.editingWeeklyAnchorStart instanceof Date &&
      !Number.isNaN(state.editingWeeklyAnchorStart.getTime())
        ? state.editingWeeklyAnchorStart
        : state.anchorDate;
    const weekStart = getWeekStart(editAnchor);
    const slots = getWeeklySlots();
    const fallbackName = formData.get("recurrenceName") || "Unnamed Blob";
    const sharedName = perSlot ? formData.get("blobName") : (formData.get("blobName") || fallbackName);
    const sharedDescription = perSlot
      ? (formData.get("blobDescription") || null)
      : (formData.get("blobDescription") || recurrenceDescription || null);
    const sharedPolicy = policyPayload;
    const blobsOfWeek = slots.map((slot) => {
    const offset = dayOffsetFromSunday(slot.day);
      const slotDate = addDays(weekStart, offset);
      const slotDateValue = formatDateTimeLocalInTimeZone(
        slotDate,
        appConfig.userTimeZone
      ).split("T")[0];
      const defaultStart = toProjectIsoFromLocalInput(
        `${slotDateValue}T${slot.defaultStart}`,
        appConfig.userTimeZone,
        appConfig.projectTimeZone
      );
      const defaultEnd = toProjectIsoFromLocalInput(
        `${slotDateValue}T${slot.defaultEnd}`,
        appConfig.userTimeZone,
        appConfig.projectTimeZone
      );
      const schedStart = toProjectIsoFromLocalInput(
        `${slotDateValue}T${slot.schedStart}`,
        appConfig.userTimeZone,
        appConfig.projectTimeZone
      );
      const schedEnd = toProjectIsoFromLocalInput(
        `${slotDateValue}T${slot.schedEnd}`,
        appConfig.userTimeZone,
        appConfig.projectTimeZone
      );
      return {
        name: perSlot && slot.name ? slot.name : sharedName,
        description: perSlot ? slot.description || null : sharedDescription,
        tz: appConfig.userTimeZone,
        default_scheduled_timerange: {
          start: defaultStart,
          end: defaultEnd,
        },
        schedulable_timerange: {
          start: schedStart,
          end: schedEnd,
        },
        policy: perSlot ? slot.policy : sharedPolicy,
        dependencies,
        tags: perSlot ? slot.tags : tags,
      };
    });
    recurrencePayload = {
      interval: Math.max(1, Number(formData.get("weeklyInterval") || 1)),
      recurrence_name: recurrenceName || null,
      recurrence_description: recurrenceDescription,
      end_date: recurrenceEnd,
      color: recurrenceColor,
      weekly_per_slot: perSlot,
      blobs_of_week: blobsOfWeek,
    };
  } else if (recurrenceType === "delta") {
    const value = Math.max(1, Number(formData.get("deltaValue") || 1));
    const unit = formData.get("deltaUnit") || "days";
    const unitSeconds = {
      minutes: 60,
      hours: 3600,
      days: 86400,
      weeks: 604800,
    };
    recurrencePayload = {
      delta_seconds: value * (unitSeconds[unit] || 86400),
      recurrence_name: recurrenceName || null,
      recurrence_description: recurrenceDescription,
      end_date: recurrenceEnd,
      color: recurrenceColor,
      start_blob: baseBlob,
    };
  } else if (recurrenceType === "multiple") {
    const isValid = validateMultipleSlots();
    if (!isValid) {
      dom.formStatus.textContent = "Fix occurrence errors before saving.";
      return;
    }
    const slots = getMultipleSlots();
    const blobs = slots.map((slot) => ({
      name: slot.name,
      description: slot.description || null,
      tz: appConfig.userTimeZone,
      default_scheduled_timerange: {
        start: toProjectIsoFromLocalInput(
          slot.defaultStart,
          appConfig.userTimeZone,
          appConfig.projectTimeZone
        ),
        end: toProjectIsoFromLocalInput(
          slot.defaultEnd,
          appConfig.userTimeZone,
          appConfig.projectTimeZone
        ),
      },
      schedulable_timerange: {
        start: toProjectIsoFromLocalInput(
          slot.schedStart,
          appConfig.userTimeZone,
          appConfig.projectTimeZone
        ),
        end: toProjectIsoFromLocalInput(
          slot.schedEnd,
          appConfig.userTimeZone,
          appConfig.projectTimeZone
        ),
      },
      policy: slot.policy || {},
      dependencies: slot.dependencies || [],
      tags: slot.tags || [],
    }));
    recurrencePayload = {
      recurrence_name: recurrenceName || null,
      recurrence_description: recurrenceDescription,
      end_date: null,
      color: null,
      blobs,
    };
  } else if (recurrenceType === "date") {
    const annualDate = formData.get("annualDate")?.toString().trim() || "";
    if (!annualDate) {
      dom.formStatus.textContent = "Select an annual date.";
      return;
    }
    const datePolicy = getPolicyPayloadFromFlags(
      false,
      false,
      true,
      DEFAULT_MAX_SPLITS,
      DEFAULT_MIN_SPLIT_MINUTES * 60,
      false
    );
    const dayStart = toProjectIsoFromLocalInput(
      `${annualDate}T00:00`,
      appConfig.userTimeZone,
      appConfig.projectTimeZone
    );
    const dayEnd = toProjectIsoFromLocalInput(
      `${annualDate}T23:59`,
      appConfig.userTimeZone,
      appConfig.projectTimeZone
    );
    baseBlob = {
      ...baseBlob,
      name: recurrenceName || "Untitled event",
      description: recurrenceDescription,
      default_scheduled_timerange: {
        start: dayStart,
        end: dayEnd,
      },
      schedulable_timerange: {
        start: dayStart,
        end: dayEnd,
      },
      policy: datePolicy,
      dependencies: [],
    };
    recurrencePayload = {
      recurrence_name: recurrenceName || null,
      recurrence_description: recurrenceDescription,
      end_date: recurrenceEnd,
      color: recurrenceColor,
      blob: baseBlob,
    };
  } else {
    recurrencePayload = {
      recurrence_name: recurrenceName || null,
      recurrence_description: recurrenceDescription,
      end_date: recurrenceEnd,
      color: recurrenceColor,
      blob: baseBlob,
    };
  }
  if (state.editingRecurrenceId) {
    recurrencePayload = {
      ...recurrencePayload,
      starred: priorPayload.starred || false,
      stars: Array.isArray(priorPayload.stars) ? priorPayload.stars : [],
      exclusions: Array.isArray(priorPayload.exclusions) ? priorPayload.exclusions : [],
      unstarred: Array.isArray(priorPayload.unstarred) ? priorPayload.unstarred : [],
    };
  }
  try {
    const isEditing = Boolean(state.editingRecurrenceId);
    if (isEditing) {
      await updateRecurrence(
        state.editingRecurrenceId,
        recurrenceType,
        recurrencePayload
      );
    } else {
      await createRecurrence(recurrenceType, recurrencePayload);
    }
    dom.blobForm.reset();
    dom.formStatus.textContent = isEditing ? "Updated." : "Created.";
    toggleForm(false);
    resetFormMode();
    await refreshCalendar();
  } catch (error) {
    dom.formStatus.textContent = error?.message || "Error saving recurrence.";
  }
}

function handleSettingsSubmit(event) {
  event.preventDefault();
  const formData = new FormData(dom.settingsForm);
  const keybinds = getSettingsKeybindValues(formData);
  const scheduleName = formData.get("scheduleName")?.toString().trim() || "";
  const subtitle = formData.get("subtitle")?.toString().trim() || "";
  const granularity = Math.max(1, Number(formData.get("minuteGranularity") || 1));
  const finishEarlyBufferMinutes = Math.max(
    1,
    Number(formData.get("finishEarlyBufferMinutes") || 1)
  );
  const includeActiveOccurrences =
    formData.get("includeActiveOccurrences") === "on";
  const lookaheadMinutes = Math.max(1, Number(formData.get("lookaheadMinutes") || 1));
  const userTimeZone = formData.get("userTimeZone")?.toString().trim() || "";
  const theme = formData.get("theme")?.toString().trim() || "sand";
  const engineInitialTemp = Math.max(0.0001, Number(formData.get("engineInitialTemp") || 0.0001));
  const engineFinalTemp = Math.max(0.000001, Number(formData.get("engineFinalTemp") || 0.000001));
  const engineNumIters = Math.max(1, Math.round(Number(formData.get("engineNumIters") || 1)));
  const engineAdvancedEnabled = formData.get("engineAdvancedEnabled") === "on";
  const engineIllegalScheduleWeight = Math.max(
    0,
    Number(formData.get("engineIllegalScheduleWeight") || 0)
  );
  const engineOverlapCostWeight = Math.max(
    0,
    Number(formData.get("engineOverlapCostWeight") || 0)
  );
  const engineSplitCostWeight = Math.max(
    0,
    Number(formData.get("engineSplitCostWeight") || 0)
  );
  const engineConsistencyCostWeight = Math.max(
    0,
    Number(formData.get("engineConsistencyCostWeight") || 0)
  );
  const engineGranularityCostWeight = Math.max(
    0,
    Number(formData.get("engineGranularityCostWeight") || 0)
  );
  if (userTimeZone) {
    try {
      Intl.DateTimeFormat("en-US", { timeZone: userTimeZone });
    } catch (error) {
      dom.settingsStatus.textContent = "Invalid timezone. Choose a valid timezone.";
      return;
    }
  }
  appConfig.scheduleName = scheduleName || appConfig.scheduleName;
  appConfig.subtitle = subtitle || appConfig.subtitle;
  appConfig.minuteGranularity = granularity;
  appConfig.finishEarlyBufferMinutes = finishEarlyBufferMinutes;
  appConfig.includeActiveOccurrences = includeActiveOccurrences;
  appConfig.lookaheadSeconds = lookaheadMinutes * 60;
  appConfig.theme = theme;
  appConfig.engineInitialTemp = engineInitialTemp;
  appConfig.engineFinalTemp = engineFinalTemp;
  appConfig.engineNumIters = engineNumIters;
  appConfig.engineAdvancedEnabled = engineAdvancedEnabled;
  appConfig.engineIllegalScheduleWeight = engineIllegalScheduleWeight;
  appConfig.engineOverlapCostWeight = engineOverlapCostWeight;
  appConfig.engineSplitCostWeight = engineSplitCostWeight;
  appConfig.engineConsistencyCostWeight = engineConsistencyCostWeight;
  appConfig.engineGranularityCostWeight = engineGranularityCostWeight;
  appConfig.keybinds = keybinds;
  if (userTimeZone) {
    appConfig.userTimeZone = userTimeZone;
  }
  dom.brandTitle.textContent = appConfig.scheduleName;
  dom.brandSubtitle.textContent = appConfig.subtitle;
  applyTheme(appConfig.theme);
  if (dom.timeZoneLabel) {
    dom.timeZoneLabel.textContent = appConfig.userTimeZone || "Local";
  }
  dom.settingsStatus.textContent = "";
  setSettingsDirty(false);
  saveSettings(appConfig);
}

function handleAddClick() {
  openCreateForm(BLOB_TYPES.TASK);
}

function openCreateForm(blobType = BLOB_TYPES.TASK) {
  resetFormMode();
  setBlobTypeOnContainer(nonWeeklyField, blobType);
  toggleForm(true);
  startInteractiveCreate({ blobType });
  syncDateTimeDisplays();
}

function handleSettingsClick() {
  setUtilitySidebarActive("settingsBtn");
  toggleSettings(true);
  populateTimeZones();
  hydrateSettingsForm();
  setActiveSettingsTab("general");
  dom.settingsStatus.textContent = "";
  setSettingsDirty(false);
}

function handleLlmOpen() {
  toggleLlm(true);
  setLlmPreviewControls(Boolean(state.previewBlobs?.length));
}

function handleCloseLlm() {
  toggleLlm(false);
}

async function handleLlmSubmit(event) {
  event.preventDefault();
  if (!dom.llmStatus) return;
  const formData = new FormData(dom.llmForm);
  const message = formData.get("llmPrompt")?.toString().trim() || "";
  if (!message) {
    dom.llmStatus.textContent = "Add a prompt to continue.";
    return;
  }
  dom.llmStatus.textContent = "Generating preview...";
  setLlmPreviewControls(false);
  const contextRaw = formData.get("llmContext")?.toString().trim() || "";
  const context = contextRaw ? [{ type: "text", content: contextRaw, label: "User notes" }] : [];
  const range = getViewRange(state.view, state.anchorDate);
  const payload = {
    message,
    context,
    view_start: toProjectIsoFromDate(range.start, appConfig.projectTimeZone),
    view_end: toProjectIsoFromDate(range.end, appConfig.projectTimeZone),
    user_timezone: appConfig.userTimeZone,
    project_timezone: appConfig.projectTimeZone,
    granularity_minutes: appConfig.minuteGranularity,
  };
  try {
    const draft = await createLLMRecurrenceDraft(payload);
    state.llmDraftRecurrences = draft.recurrences || [];
    state.previewBlobs = Array.isArray(draft.occurrences) ? draft.occurrences : [];
    state.llmDraftNotes = draft.notes || null;
    const hasPreview = Boolean(state.previewBlobs?.length);
    const viewRange = getViewRange(state.view, state.anchorDate);
    const hasPreviewInView =
      hasPreview &&
      state.previewBlobs.some((blob) => {
        const defaultRange = blob.default_scheduled_timerange || {};
        const schedRange = blob.schedulable_timerange || {};
        const start = new Date(defaultRange.start || schedRange.start || "");
        const end = new Date(defaultRange.end || schedRange.end || "");
        if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
          return false;
        }
        return overlaps(viewRange.start, viewRange.end, start, end);
      });
    if (refreshView) {
      if (hasPreview && !hasPreviewInView) {
        const first = state.previewBlobs[0];
        const firstStart = new Date(
          first?.default_scheduled_timerange?.start ||
            first?.schedulable_timerange?.start ||
            ""
        );
        if (!Number.isNaN(firstStart.getTime())) {
          state.anchorDate = firstStart;
          await refreshView("week");
        } else {
          await refreshView(state.view);
        }
      } else {
        await refreshView(state.view);
      }
    }
    if (draft.notes) {
      dom.llmStatus.textContent = `Preview ready. ${draft.notes}`;
    } else if (!hasPreview && state.llmDraftRecurrences?.length) {
      dom.llmStatus.textContent =
        "Draft created, but no preview in the current view. Try a different date range.";
    } else {
      dom.llmStatus.textContent = "Preview ready. Does this look good?";
    }
    setLlmPreviewControls(hasPreview);
  } catch (error) {
    dom.llmStatus.textContent = error?.message || "Failed to generate preview.";
    state.previewBlobs = [];
    state.llmDraftRecurrences = null;
    state.llmDraftNotes = null;
    setActive(state.view);
  }
}

async function handleLlmConfirm() {
  if (!state.llmDraftRecurrences?.length) {
    if (dom.llmStatus) dom.llmStatus.textContent = "No draft to confirm yet.";
    return;
  }
  if (dom.llmStatus) dom.llmStatus.textContent = "Saving draft...";
  try {
    await createRecurrencesBulk(state.llmDraftRecurrences);
    await clearLlmPreview();
    if (dom.llmStatus) dom.llmStatus.textContent = "Saved.";
    toggleLlm(false);
  } catch (error) {
    if (dom.llmStatus) {
      dom.llmStatus.textContent = error?.message || "Unable to save draft.";
    }
  }
}

async function handleLlmDiscard() {
  await clearLlmPreview();
  if (dom.llmStatus) dom.llmStatus.textContent = "Preview cleared.";
}

function handleCloseSettings() {
  applyTheme(appConfig.theme);
  toggleSettings(false);
  dom.settingsStatus.textContent = "";
  setSettingsDirty(false);
  setUtilitySidebarActive(null);
}

function handleCloseForm() {
  toggleForm(false);
  resetFormMode();
}

function bindDraggableForm() {
  if (!dom.formPanel) return;
  const header = dom.formPanel.querySelector(".form-header");
  if (!header) return;

  const onPointerDown = (event) => {
    if (event.button !== 0) return;
    if (event.target.closest("button")) return;
    const rect = dom.formPanel.getBoundingClientRect();
    isDraggingForm = true;
    dragOffset = {
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
    };
    dom.formPanel.classList.add("dragging");
    dom.formPanel.setPointerCapture?.(event.pointerId);
  };

  const onPointerMove = (event) => {
    if (!isDraggingForm) return;
    const nextX = Math.max(12, event.clientX - dragOffset.x);
    const nextY = Math.max(12, event.clientY - dragOffset.y);
    formPosition = { x: nextX, y: nextY };
    dom.formPanel.style.left = `${nextX}px`;
    dom.formPanel.style.top = `${nextY}px`;
    dom.formPanel.style.right = "auto";
  };

  const stopDrag = () => {
    if (!isDraggingForm) return;
    isDraggingForm = false;
    dom.formPanel.classList.remove("dragging");
  };

  header.addEventListener("pointerdown", onPointerDown);
  window.addEventListener("pointermove", onPointerMove);
  window.addEventListener("pointerup", stopDrag);
  window.addEventListener("pointercancel", stopDrag);
}

function bindDraggableLlmPanel() {
  if (!dom.llmPanel) return;
  const header = dom.llmPanel.querySelector(".form-header");
  if (!header) return;

  const onPointerDown = (event) => {
    if (event.button !== 0) return;
    if (event.target.closest("button")) return;
    const rect = dom.llmPanel.getBoundingClientRect();
    isDraggingLlm = true;
    llmDragOffset = {
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
    };
    dom.llmPanel.classList.add("dragging");
    dom.llmPanel.setPointerCapture?.(event.pointerId);
  };

  const onPointerMove = (event) => {
    if (!isDraggingLlm) return;
    const nextX = Math.max(12, event.clientX - llmDragOffset.x);
    const nextY = Math.max(12, event.clientY - llmDragOffset.y);
    llmPosition = { x: nextX, y: nextY };
    dom.llmPanel.style.left = `${nextX}px`;
    dom.llmPanel.style.top = `${nextY}px`;
    dom.llmPanel.style.right = "auto";
  };

  const stopDrag = () => {
    if (!isDraggingLlm) return;
    isDraggingLlm = false;
    dom.llmPanel.classList.remove("dragging");
  };

  header.addEventListener("pointerdown", onPointerDown);
  window.addEventListener("pointermove", onPointerMove);
  window.addEventListener("pointerup", stopDrag);
  window.addEventListener("pointercancel", stopDrag);
}

function getActiveView() {
  const activeViewEntry = Object.entries(dom.views).find(([, el]) => el.classList.contains("active"));
  if (activeViewEntry) {
    return activeViewEntry[0];
  }
  const activeTab = Array.from(dom.tabs).find((tab) => tab.classList.contains("active"));
  return activeTab?.dataset.view || state.view;
}

function handlePrevDay() {
  const view = getActiveView();
  const next = shiftAnchorDate(view, state.anchorDate, -1);
  if (!next) return;
  state.anchorDate = next;
  if (refreshView) {
    refreshView(view);
  }
}

function handleNextDay() {
  const view = getActiveView();
  const next = shiftAnchorDate(view, state.anchorDate, 1);
  if (!next) return;
  state.anchorDate = next;
  if (refreshView) {
    refreshView(view);
  }
}

function handleToday() {
  const view = getActiveView();
  state.anchorDate = new Date();
  if (refreshView) {
    refreshView(view);
  }
}

function bindFormHandlers(onRefresh) {
  setRefreshHandler(onRefresh);
  if (dom.formPanel) {
    dom.formPanel.addEventListener("click", (event) => {
      event.stopPropagation();
    });
  }
  if (dom.llmPanel) {
    dom.llmPanel.addEventListener("click", (event) => {
      event.stopPropagation();
    });
  }
  dom.blobForm.addEventListener("submit", handleBlobSubmit);
  dom.settingsForm.addEventListener("submit", handleSettingsSubmit);
  dom.settingsForm.addEventListener("input", (event) => {
    if (settingsHydrating) return;
    if (event.target instanceof Element && event.target.closest("[data-settings-ignore='true']")) {
      return;
    }
    setSettingsDirty(true);
  });
  dom.settingsForm.addEventListener("change", (event) => {
    if (settingsHydrating) return;
    if (event.target instanceof Element && event.target.closest("[data-settings-ignore='true']")) {
      return;
    }
    setSettingsDirty(true);
    if (!(event.target instanceof Element)) return;
    if (
      event.target instanceof HTMLInputElement &&
      event.target.name === "engineAdvancedEnabled"
    ) {
      updateAdvancedEngineVisibility(event.target.checked);
      return;
    }
    if (event.target instanceof HTMLSelectElement && event.target.name === "theme") {
      applyTheme(event.target.value || appConfig.theme);
    }
  });
  dom.settingsForm.addEventListener("keydown", (event) => {
    if (settingsHydrating) return;
    if (!(event.target instanceof HTMLInputElement)) return;
    const fieldName = event.target.name || "";
    if (!KEYBIND_FIELD_NAMES.has(fieldName)) return;
    if (!KEYBIND_ACTION_BY_FIELD[fieldName]) return;
    if (event.key === "Tab") return;
    event.preventDefault();
    if (event.key === "Backspace" || event.key === "Delete") {
      event.target.value = "";
      if (dom.settingsStatus) {
        dom.settingsStatus.textContent = "";
      }
      setSettingsDirty(true);
      return;
    }
    const combo = buildKeybindFromKeyboardEvent(event);
    if (!combo) return;
    event.target.value = combo;
    if (dom.settingsStatus) {
      dom.settingsStatus.textContent = "";
    }
    setSettingsDirty(true);
  });
  if (dom.deleteRecurrenceBtn) {
    dom.deleteRecurrenceBtn.addEventListener("click", deleteRecurrence);
  }
  if (dom.deleteOccurrenceBtn) {
    dom.deleteOccurrenceBtn.addEventListener("click", deleteOccurrence);
  }
  if (dom.starRecurrenceBtn) {
    dom.starRecurrenceBtn.addEventListener("click", toggleStarRecurrence);
  }
  if (dom.starOccurrenceBtn) {
    dom.starOccurrenceBtn.addEventListener("click", toggleStarOccurrence);
  }
  bindDraggableForm();
  bindDraggableLlmPanel();
  bindSidebarResize();
  bindDateTimePickers();
  dom.toggleFormBtn.addEventListener("click", handleAddClick);
  if (dom.llmScheduleBtn) {
    dom.llmScheduleBtn.addEventListener("click", handleLlmOpen);
  }
  if (dom.settingsBtn) {
    dom.settingsBtn.addEventListener("click", handleSettingsClick);
  }
  if (dom.sidebarToggleBtn) {
    dom.sidebarToggleBtn.addEventListener("click", () => {
      toggleSidebarCollapsed();
    });
  }
  if (dom.closeSettingsBtn) {
    dom.closeSettingsBtn.addEventListener("click", handleCloseSettings);
  }
  if (dom.settingsBackdrop) {
    dom.settingsBackdrop.addEventListener("click", handleCloseSettings);
  }
  if (dom.closeLlmBtn) {
    dom.closeLlmBtn.addEventListener("click", handleCloseLlm);
  }
  if (dom.llmForm) {
    dom.llmForm.addEventListener("submit", handleLlmSubmit);
  }
  if (dom.llmConfirmBtn) {
    dom.llmConfirmBtn.addEventListener("click", handleLlmConfirm);
  }
  if (dom.llmDiscardBtn) {
    dom.llmDiscardBtn.addEventListener("click", handleLlmDiscard);
  }
  dom.closeFormBtn.addEventListener("click", handleCloseForm);
  dom.prevDayBtn.addEventListener("click", handlePrevDay);
  dom.nextDayBtn.addEventListener("click", handleNextDay);
  dom.goTodayBtn.addEventListener("click", handleToday);
  if (dom.recurrenceType) {
    dom.recurrenceType.addEventListener("change", updateRecurrenceUI);
    dom.blobForm.defaultStart.addEventListener("change", updateRecurrenceUI);
    dom.blobForm.weeklyInterval.addEventListener("input", updateRecurrenceUI);
    dom.blobForm.deltaValue.addEventListener("input", updateRecurrenceUI);
    dom.blobForm.deltaUnit.addEventListener("change", updateRecurrenceUI);
  }
  if (dom.addMultipleSlotBtn) {
    dom.addMultipleSlotBtn.addEventListener("click", () => {
      createMultipleSlot();
    });
  }
  if (dom.recurrenceEnd) {
    dom.recurrenceEnd.addEventListener("change", updateRecurrenceUI);
  }
  if (dom.dependencyInput) {
    dom.dependencyInput.addEventListener("input", renderDependencySuggestions);
    dom.dependencyInput.addEventListener("focus", renderDependencySuggestions);
    dom.dependencyInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        addDependencyFromInput();
      }
    });
  }
  if (dom.addDependencyBtn) {
    dom.addDependencyBtn.addEventListener("click", addDependencyFromInput);
  }
  if (dom.tagInput) {
    dom.tagInput.addEventListener("input", renderTagSuggestions);
    dom.tagInput.addEventListener("focus", renderTagSuggestions);
    dom.tagInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        addTagFromInput();
      }
    });
  }
  if (dom.addTagBtn) {
    dom.addTagBtn.addEventListener("click", addTagFromInput);
  }
  if (dom.dependencySuggestions) {
    dom.dependencySuggestions.addEventListener("click", (event) => {
      const target = event.target.closest(".dependency-suggestion");
      if (!target) return;
      const id = target.dataset.dependencyId;
      if (id && !dependencyIds.includes(id)) {
        dependencyIds.push(id);
        renderDependencyList();
      }
      dom.formStatus.textContent = "";
      if (dom.dependencyInput) {
        dom.dependencyInput.value = "";
      }
      dom.dependencySuggestions.innerHTML = "";
    });
  }
  if (dom.tagSuggestions) {
    dom.tagSuggestions.addEventListener("click", (event) => {
      const target = event.target.closest(".tag-suggestion");
      if (!target) return;
      const name = target.dataset.tagName;
      if (name) {
        const key = tagKey(name);
        const seen = new Set(tagNames.map((tag) => tagKey(tag)));
        if (!seen.has(key)) {
          tagNames.push(name);
          renderTagList();
        }
      }
      dom.formStatus.textContent = "";
      if (dom.tagInput) {
        dom.tagInput.value = "";
      }
      dom.tagSuggestions.innerHTML = "";
    });
  }
  if (dom.dependencyList) {
    dom.dependencyList.addEventListener("click", (event) => {
      const target = event.target.closest("[data-remove-dependency]");
      if (!target) return;
      const id = target.dataset.removeDependency;
      dependencyIds = dependencyIds.filter((depId) => depId !== id);
      renderDependencyList();
    });
  }
  if (dom.tagList) {
    dom.tagList.addEventListener("click", (event) => {
      const target = event.target.closest("[data-remove-tag]");
      if (!target) return;
      const name = target.dataset.removeTag;
      tagNames = tagNames.filter((tag) => tagKey(tag) !== tagKey(name));
      renderTagList();
    });
  }
  if (dom.weeklyPerSlot) {
    dom.weeklyPerSlot.addEventListener("change", () => {
      const weeklyWrapper = dom.weeklySlots?.closest(".weekly-slots");
      const wasPerSlot = weeklyWrapper?.classList.contains("per-slot");
      updateRecurrenceUI();
      if (wasPerSlot && !dom.weeklyPerSlot.checked) {
        const merged = collectSlotTagsUnion();
        setTags(merged);
      }
      if (!wasPerSlot && dom.weeklyPerSlot.checked) {
        syncSlotPoliciesFromForm();
        syncSlotTagsFromForm();
      }
    });
  }
  if (dom.addWeeklySlotBtn) {
    dom.addWeeklySlotBtn.addEventListener("click", () => createWeeklySlot());
  }
  ["policySplittable", "policyOverlappable", "policyInvisible"].forEach((name) => {
    const field = dom.blobForm?.[name];
    if (field) {
      field.addEventListener("change", () => {
        if (name === "policySplittable") {
          setPolicyAdvancedVisibility(field, field.checked);
        }
        if (!dom.weeklyPerSlot?.checked) {
          syncSlotPoliciesFromForm();
        }
      });
    }
  });
  if (dom.weeklySlots && dom.weeklySlots.children.length === 0) {
    createWeeklySlot();
  }
  if (dom.multipleSlots && dom.multipleSlots.children.length === 0) {
    createMultipleSlot();
  }
  setLlmPreviewControls(Boolean(state.previewBlobs?.length));
  bindBlobTypeToggle(nonWeeklyField);
  applySidebarState();
  if (settingsTabs.length) {
    settingsTabs.forEach((tab) => {
      tab.addEventListener("click", () => {
        setActiveSettingsTab(tab.dataset.settingsTab);
      });
    });
  }
  updateRecurrenceUI();
}

export {
  bindFormHandlers,
  handleAddClick,
  openCreateForm,
  openEditForm,
  resetFormMode,
  toggleForm,
  toggleSettings,
};
