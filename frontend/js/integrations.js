import { appConfig, state } from "./core.js";
import { dom } from "./dom.js";
import { setActive, updateNowIndicators } from "./render.js";
import {
  buildGoogleOAuthStartUrl,
  connectGoogleAccount,
  copyCalendarToMain,
  createCustomCalendar,
  deleteCalendarView,
  disconnectGoogleAccount,
  exportCalendarViews,
  exportUserData,
  getGoogleIntegrationStatus,
  listCalendarViews,
  listGoogleCalendars,
  setCalendarVisibility as apiSetCalendarVisibility,
  setGoogleCalendarSelection as apiSetGoogleCalendarSelection,
  syncGoogleCalendars,
} from "./api.js";
import { addDays, toProjectIsoFromDate } from "./utils.js";

const googleState = {
  accounts: [],
  calendars: [],
  calendarViews: [],
  exportSelectionByViewId: {},
};
const MAX_SYNC_DAYS = 90;

let refreshHandler = null;
let forceReloadTimerId = null;
let repaintRafId = null;
const calendarViewMutationVersions = new Map();
const sourceCalendarMutationVersions = new Map();
const calendarVisibilityPersistChains = new Map();
const sourceCalendarPersistChains = new Map();

function setRefreshHandler(handler) {
  refreshHandler = handler;
}

function refreshCalendarNow() {
  if (state.workspaceMode === "home") {
    if (repaintRafId !== null) {
      window.cancelAnimationFrame(repaintRafId);
    }
    repaintRafId = window.requestAnimationFrame(() => {
      repaintRafId = null;
      setActive(state.view);
      updateNowIndicators();
    });
    return;
  }
  if (!refreshHandler) return;
  void refreshHandler(state.view).catch(() => {});
}

function scheduleCalendarForceReload(delayMs = 180) {
  if (!refreshHandler) return;
  if (forceReloadTimerId !== null) {
    window.clearTimeout(forceReloadTimerId);
  }
  forceReloadTimerId = window.setTimeout(() => {
    forceReloadTimerId = null;
    void refreshHandler(state.view, { forceReload: true }).catch(() => {});
  }, delayMs);
}

function nextMutationVersion(store, id) {
  const key = String(id || "");
  const next = (store.get(key) || 0) + 1;
  store.set(key, next);
  return next;
}

function isMutationVersionCurrent(store, id, version) {
  return (store.get(String(id || "")) || 0) === version;
}

function persistBooleanUpdateInOrder(chainStore, id, requestFn) {
  const key = String(id || "").trim();
  if (!key) {
    return Promise.reject(new Error("Missing calendar id."));
  }
  const previous = chainStore.get(key) || Promise.resolve();
  const task = previous.catch(() => {}).then(requestFn);
  chainStore.set(
    key,
    task.finally(() => {
      if (chainStore.get(key) === task) {
        chainStore.delete(key);
      }
    })
  );
  return task;
}

function persistCalendarVisibility(viewId, visible) {
  return persistBooleanUpdateInOrder(
    calendarVisibilityPersistChains,
    viewId,
    () => apiSetCalendarVisibility(viewId, visible)
  );
}

function persistSourceCalendarSelection(calendarId, selected, relatedViewIds = []) {
  const related = Array.isArray(relatedViewIds)
    ? relatedViewIds.map((item) => String(item || "").trim()).filter(Boolean)
    : [];
  return persistBooleanUpdateInOrder(
    sourceCalendarPersistChains,
    calendarId,
    () =>
      apiSetGoogleCalendarSelection(calendarId, selected, {
        visible: Boolean(selected),
        relatedViewIds: related,
      })
  );
}

function calendarListTargets() {
  return [dom.googleCalendarList, dom.sidebarGoogleCalendarList].filter(Boolean);
}

function setConnectionStatus(status) {
  if (!dom.googleConnectionStatus) return;
  const accounts = Array.isArray(status?.accounts) ? status.accounts : [];
  googleState.accounts = accounts;
  const connected = accounts.length > 0;
  dom.googleConnectionStatus.classList.toggle("connected", connected);
  dom.googleConnectionStatus.classList.toggle("disconnected", !connected);
  dom.googleConnectionStatus.textContent = connected ? "Connected" : "Not connected";
  if (dom.googleConnectionMeta) {
    if (!connected) {
      dom.googleConnectionMeta.textContent = "";
    } else {
      const label = status?.account_name || status?.account_id || accounts[0]?.account_name || "";
      dom.googleConnectionMeta.textContent = `${accounts.length} account(s) · ${label}`;
    }
  }
  if (dom.sidebarGoogleMeta) {
    dom.sidebarGoogleMeta.textContent = connected
      ? `${accounts.length} Google account(s) connected`
      : "No Google accounts connected";
  }
  renderAccountList();
  renderCalendarList();
}

function setConnectionMessage(message = "", error = false) {
  if (!dom.googleConnectionMessage) return;
  dom.googleConnectionMessage.textContent = message;
  dom.googleConnectionMessage.classList.toggle("error", Boolean(error));
}

function setSyncMessage(message = "", error = false) {
  if (dom.googleSyncMessage) {
    dom.googleSyncMessage.textContent = message;
    dom.googleSyncMessage.classList.toggle("error", Boolean(error));
  }
  if (dom.sidebarGoogleSyncMessage) {
    dom.sidebarGoogleSyncMessage.textContent = message;
    dom.sidebarGoogleSyncMessage.classList.toggle("error", Boolean(error));
  }
}

function renderAccountList() {
  if (!dom.googleAccountsList) return;
  if (!googleState.accounts.length) {
    dom.googleAccountsList.innerHTML = "";
    return;
  }
  dom.googleAccountsList.innerHTML = googleState.accounts
    .map((account) => {
      const label = account.account_name || account.account_id || "Google account";
      const subtitle = account.account_id && account.account_id !== label ? account.account_id : "";
      return `
        <div class="integration-account-item">
          <div class="integration-account-meta">
            <div class="integration-account-name">${label}</div>
            ${subtitle ? `<div class="integration-account-subtitle">${subtitle}</div>` : ""}
          </div>
          <button
            type="button"
            class="ghost danger small"
            data-disconnect-account-key="${account.id}"
          >
            Disconnect
          </button>
        </div>
      `;
    })
    .join("");
}

function accountDisplayName(accountKey, accountName, accountId) {
  return accountName || accountId || accountKey || "Google account";
}

function accountSubtitle(accountName, accountId) {
  if (!accountId || accountId === accountName) {
    return "";
  }
  return accountId;
}

function resolveAccountGroupKey(accountKey, accountId, accountName) {
  const directKey = String(accountKey || "").trim();
  if (directKey && googleState.accounts.some((account) => account.id === directKey)) {
    return directKey;
  }
  const normalizedAccountId = String(accountId || "").trim().toLowerCase();
  if (normalizedAccountId) {
    const byId = googleState.accounts.find(
      (account) => String(account.account_id || "").trim().toLowerCase() === normalizedAccountId
    );
    if (byId?.id) {
      return byId.id;
    }
  }
  const normalizedAccountName = String(accountName || "").trim().toLowerCase();
  if (normalizedAccountName) {
    const byName = googleState.accounts.find(
      (account) => String(account.account_name || "").trim().toLowerCase() === normalizedAccountName
    );
    if (byName?.id) {
      return byName.id;
    }
  }
  return directKey || "unassigned";
}

function groupEntriesByAccount(entries, keySelector) {
  const groups = new Map();
  for (const entry of Array.isArray(entries) ? entries : []) {
    const key = String(keySelector(entry) || "unassigned");
    if (!groups.has(key)) {
      groups.set(key, []);
    }
    groups.get(key).push(entry);
  }
  return Array.from(groups.entries()).sort(([left], [right]) => left.localeCompare(right));
}

function renderSidebarAccountGroups(groups, renderItem, options = {}) {
  if (!groups.length) {
    return "";
  }
  const showDisconnect = Boolean(options.showDisconnect);
  const countLabel = options.countLabel || "calendar";
  const summaryTextResolver =
    typeof options.summaryTextResolver === "function" ? options.summaryTextResolver : null;
  const accountMetaByKey = new Map(
    googleState.accounts.map((account) => [account.id, account])
  );
  return groups
    .map(([accountKey, items]) => {
      const accountMeta = accountMetaByKey.get(accountKey) || {};
      const inferredName =
        accountMeta.account_name ||
        items.find((item) => item.account_name)?.account_name ||
        "";
      const inferredId =
        accountMeta.account_id ||
        items.find((item) => item.account_id)?.account_id ||
        "";
      const label = accountDisplayName(accountKey, inferredName, inferredId);
      const subtitle = accountSubtitle(inferredName, inferredId);
      const countText = summaryTextResolver
        ? String(summaryTextResolver(accountKey, items) || "")
        : `${items.length} ${countLabel}${items.length === 1 ? "" : "s"}`;
      const disconnectButton = showDisconnect
        ? `
            <button
              type="button"
              class="ghost danger small"
              data-disconnect-account-key="${accountKey}"
            >
              Disconnect
            </button>
          `
        : "";
      return `
        <details class="sidebar-account-group" open>
          <summary>
            <span>${label}</span>
            <span class="sidebar-calendar-summary">${countText}</span>
          </summary>
          ${subtitle ? `<div class="sidebar-account-subtitle">${subtitle}</div>` : ""}
          ${disconnectButton}
          <div class="sidebar-account-list">
            ${items.map((item) => renderItem(item)).join("")}
          </div>
        </details>
      `;
    })
    .join("");
}

function renderCalendarList() {
  const targets = calendarListTargets();
  if (!targets.length) return;
  const rowHtml = (calendar, includeAccountLabel, showBadge = true) => {
    const selected = calendar.selected !== false;
    const badge =
      showBadge && calendar.primary
        ? '<span class="integration-calendar-badge">Primary</span>'
        : "";
    const accountLabel = accountDisplayName(
      calendar.account_key,
      calendar.account_name,
      calendar.account_id
    );
    const metaLabel = includeAccountLabel
      ? `${accountLabel} · ${calendar.time_zone || "UTC"}`
      : `${calendar.time_zone || "UTC"}`;
    return `
      <label class="integration-calendar-item">
        <input
          type="checkbox"
          data-calendar-id="${calendar.id}"
          ${selected ? "checked" : ""}
        />
        <div class="integration-calendar-meta">
          <span class="integration-calendar-name">${calendar.name}</span>
          <span class="integration-calendar-tz">${metaLabel}</span>
        </div>
        ${badge}
      </label>
    `;
  };

  const settingsHtml = !googleState.calendars.length
    ? ""
    : googleState.calendars.map((calendar) => rowHtml(calendar, true, true)).join("");
  if (dom.googleCalendarList) {
    dom.googleCalendarList.innerHTML = settingsHtml;
  }

  if (dom.sidebarGoogleCalendarList) {
    let groups = groupEntriesByAccount(googleState.calendars, (calendar) =>
      resolveAccountGroupKey(calendar.account_key, calendar.account_id, calendar.account_name)
    );
    if (!groups.length && googleState.accounts.length) {
      groups = googleState.accounts.map((account) => [account.id, []]);
    }
    dom.sidebarGoogleCalendarList.innerHTML = renderSidebarAccountGroups(
      groups,
      (calendar) => rowHtml(calendar, false, false),
      {
        showDisconnect: true,
        countLabel: "source calendar",
        summaryTextResolver: (accountKey, items) => {
          const sourceCount = items.length;
          const syncedCount = googleState.calendarViews.filter(
            (view) =>
              String(view.source || "").toLowerCase() === "google" &&
              resolveAccountGroupKey(view.account_key, null, view.account_name) === accountKey
          ).length;
          return `${sourceCount} source${sourceCount === 1 ? "" : "s"} · ${syncedCount} synced`;
        },
      }
    );
  }
}

function syncCalendarVisibilityState() {
  const visibilityById = {};
  for (const view of Array.isArray(googleState.calendarViews) ? googleState.calendarViews : []) {
    const viewId = String(view?.id || "").trim();
    if (!viewId) continue;
    visibilityById[viewId] = view.visible !== false;
  }
  state.calendarVisibilityByViewId = visibilityById;
}

function renderCalendarViews() {
  const allViews = Array.isArray(googleState.calendarViews) ? googleState.calendarViews : [];
  syncCalendarVisibilityState();
  const renderViewRow = (view, options = {}) => {
    const checked = view.visible !== false;
    const showSourceBadge = options.showSourceBadge !== false;
    const badge = showSourceBadge
      ? view.is_main
        ? '<span class="integration-calendar-badge">Main</span>'
        : `<span class="integration-calendar-badge">${view.source || "calendar"}</span>`
      : "";
    const copyDisabled = view.is_main || !view.recurrence_count;
    const deleteDisabled = view.is_main;
    return `
      <div class="integration-calendar-item">
        <input
          type="checkbox"
          data-calendar-view-id="${view.id}"
          ${checked ? "checked" : ""}
          ${view.is_main ? "disabled" : ""}
        />
        <div class="integration-calendar-meta">
          <span class="integration-calendar-name">${view.name}</span>
          <span class="integration-calendar-tz">${view.recurrence_count || 0} recurrence(s)</span>
        </div>
        <div class="integration-calendar-actions">
          ${badge}
          <button
            type="button"
            class="ghost integration-icon-btn"
            data-copy-calendar-view-id="${view.id}"
            title="Copy to main"
            aria-label="Copy calendar to main"
            ${copyDisabled ? "disabled" : ""}
          >
            <svg viewBox="0 0 24 24" focusable="false" aria-hidden="true">
              <rect x="8" y="8" width="11" height="11" rx="2" fill="none" stroke="currentColor" stroke-width="1.8" />
              <rect x="5" y="5" width="11" height="11" rx="2" fill="none" stroke="currentColor" stroke-width="1.8" />
            </svg>
          </button>
          <button
            type="button"
            class="ghost danger integration-icon-btn"
            data-delete-calendar-view-id="${view.id}"
            title="Delete calendar"
            aria-label="Delete calendar"
            ${deleteDisabled ? "disabled" : ""}
          >
            <svg viewBox="0 0 24 24" focusable="false" aria-hidden="true">
              <path d="M5 7h14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />
              <path d="M9 7V5.8A1.8 1.8 0 0 1 10.8 4h2.4A1.8 1.8 0 0 1 15 5.8V7" fill="none" stroke="currentColor" stroke-width="1.8" />
              <path d="M8 9.5v8.7A1.8 1.8 0 0 0 9.8 20h4.4A1.8 1.8 0 0 0 16 18.2V9.5" fill="none" stroke="currentColor" stroke-width="1.8" />
              <path d="M11 11.5v6M13 11.5v6" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
            </svg>
          </button>
        </div>
      </div>
    `;
  };
  const renderRows = (views, options = {}) => views.map((view) => renderViewRow(view, options)).join("");

  if (dom.calendarViewList) {
    dom.calendarViewList.innerHTML = renderRows(allViews, { showSourceBadge: true });
  }
  if (dom.sidebarCalendarViewList) {
    const topLevelViews = allViews.filter(
      (view) => String(view.source || "").toLowerCase() !== "google"
    );
    dom.sidebarCalendarViewList.innerHTML = renderRows(topLevelViews, { showSourceBadge: true });
  }
  renderExportCalendarViews();
}

function selectedExportCalendarViewIds() {
  return googleState.calendarViews
    .filter(
      (view) =>
        googleState.exportSelectionByViewId[String(view.id)] !== false &&
        Number(view.recurrence_count || 0) > 0
    )
    .map((view) => String(view.id))
    .filter(Boolean);
}

function setExportMessage(message = "", error = false) {
  if (!dom.exportStatus) return;
  dom.exportStatus.textContent = message;
  dom.exportStatus.classList.toggle("error", Boolean(error));
}

function setUserDataExportMessage(message = "", error = false) {
  if (!dom.userDataExportStatus) return;
  dom.userDataExportStatus.textContent = message;
  dom.userDataExportStatus.classList.toggle("error", Boolean(error));
}

function syncExportSelections() {
  const previous = googleState.exportSelectionByViewId || {};
  const next = {};
  for (const view of Array.isArray(googleState.calendarViews) ? googleState.calendarViews : []) {
    const viewId = String(view.id || "");
    if (!viewId) continue;
    if (Object.prototype.hasOwnProperty.call(previous, viewId)) {
      next[viewId] = Boolean(previous[viewId]);
      continue;
    }
    next[viewId] = Number(view.recurrence_count || 0) > 0;
  }
  googleState.exportSelectionByViewId = next;
}

function updateExportControls() {
  if (!dom.exportDownloadBtn) return;
  dom.exportDownloadBtn.disabled = selectedExportCalendarViewIds().length === 0;
}

function renderExportCalendarViews() {
  if (!dom.exportCalendarList) return;
  const views = Array.isArray(googleState.calendarViews) ? googleState.calendarViews : [];
  if (!views.length) {
    dom.exportCalendarList.innerHTML =
      '<div class="settings-card-copy">No calendars available to export yet.</div>';
    updateExportControls();
    return;
  }
  dom.exportCalendarList.innerHTML = views
    .map((view) => {
      const viewId = String(view.id || "");
      const selected = googleState.exportSelectionByViewId[viewId] !== false;
      const recurrenceCount = Number(view.recurrence_count || 0);
      const disabled = recurrenceCount <= 0;
      const sourceLabel = view.is_main ? "Main" : view.source || "calendar";
      return `
        <label class="integration-calendar-item ${disabled ? "is-disabled" : ""}">
          <input
            type="checkbox"
            data-export-calendar-view-id="${viewId}"
            ${selected ? "checked" : ""}
            ${disabled ? "disabled" : ""}
          />
          <div class="integration-calendar-meta">
            <span class="integration-calendar-name">${view.name}</span>
            <span class="integration-calendar-tz">${recurrenceCount} recurrence(s)</span>
          </div>
          <span class="integration-calendar-badge">${sourceLabel}</span>
        </label>
      `;
    })
    .join("");
  updateExportControls();
}

function selectedCalendarIds() {
  return googleState.calendars
    .filter((calendar) => calendar.selected !== false)
    .map((calendar) => calendar.id)
    .filter(Boolean);
}

function normalizeAccountIdentity(value) {
  return String(value || "").trim().toLowerCase();
}

function findSourceCalendarById(calendarId) {
  return googleState.calendars.find((calendar) => calendar.id === calendarId) || null;
}

function matchingGoogleViewIdsForSourceCalendar(sourceCalendar) {
  if (!sourceCalendar) return [];
  const directId = String(sourceCalendar.id || "").trim();
  const calendarId = String(sourceCalendar.calendar_id || "").trim();
  const accountKey = String(sourceCalendar.account_key || "").trim();
  const accountName = normalizeAccountIdentity(sourceCalendar.account_name);
  const accountId = normalizeAccountIdentity(sourceCalendar.account_id);
  const matches = googleState.calendarViews.filter((view) => {
    if (String(view.source || "").toLowerCase() !== "google") return false;
    if (directId && view.id === directId) return true;
    if (!calendarId || String(view.calendar_id || "").trim() !== calendarId) return false;
    if (accountKey && String(view.account_key || "").trim() === accountKey) return true;
    const viewAccountName = normalizeAccountIdentity(view.account_name);
    const viewAccountKey = normalizeAccountIdentity(view.account_key);
    return Boolean(
      (accountName && viewAccountName && viewAccountName === accountName) ||
        (accountId && viewAccountKey && viewAccountKey === accountId)
    );
  });
  return Array.from(new Set(matches.map((view) => view.id).filter(Boolean)));
}

function applyCalendarViewVisibilityToState(viewIds, visible) {
  if (!Array.isArray(viewIds) || !viewIds.length) return;
  const targetIds = new Set(viewIds.map((id) => String(id)));
  googleState.calendarViews = googleState.calendarViews.map((view) =>
    targetIds.has(String(view.id)) ? { ...view, visible: Boolean(visible) } : view
  );
  renderCalendarViews();
}

function mergeCalendarSelections(nextCalendars) {
  return (Array.isArray(nextCalendars) ? nextCalendars : []).map((calendar) => ({
    ...calendar,
    selected: calendar.selected !== false,
  }));
}

async function hydrateConnectionStatus() {
  try {
    const status = await getGoogleIntegrationStatus();
    setConnectionStatus(status);
  } catch (error) {
    setConnectionStatus({ connected: false, accounts: [] });
    setConnectionMessage(error?.message || "Unable to load integration status.", true);
  }
}

async function hydrateCalendarViews() {
  try {
    googleState.calendarViews = await listCalendarViews();
    syncExportSelections();
    renderCalendarViews();
  } catch (error) {
    setSyncMessage(error?.message || "Unable to load calendar views.", true);
    setExportMessage(error?.message || "Unable to load calendar views.", true);
  }
}

async function handleConnectGoogle() {
  const returnTo = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  setConnectionMessage("Redirecting to Google sign-in...");
  window.location.assign(buildGoogleOAuthStartUrl(returnTo));
}

async function handleManualConnectGoogle() {
  const token = dom.googleAccessTokenInput?.value?.trim() || "";
  if (!token) {
    setConnectionMessage("Paste an access token first.", true);
    return;
  }
  setConnectionMessage("Connecting with pasted token...");
  try {
    const status = await connectGoogleAccount(token);
    if (dom.googleAccessTokenInput) dom.googleAccessTokenInput.value = "";
    setConnectionStatus(status);
    setConnectionMessage("Google account connected.");
    await hydrateCalendarViews();
  } catch (error) {
    setConnectionMessage(error?.message || "Unable to connect account.", true);
  }
}

async function handleDisconnectGoogle(accountKey = null) {
  setConnectionMessage(accountKey ? "Disconnecting account..." : "Disconnecting all accounts...");
  try {
    await disconnectGoogleAccount(accountKey);
    await hydrateConnectionStatus();
    googleState.calendars = [];
    renderCalendarList();
    await hydrateCalendarViews();
    setConnectionMessage(accountKey ? "Account disconnected." : "All Google accounts disconnected.");
    setSyncMessage("");
    if (refreshHandler) {
      await refreshHandler(state.view);
    }
  } catch (error) {
    setConnectionMessage(error?.message || "Unable to disconnect account.", true);
  }
}

async function handleLoadCalendars(options = {}) {
  const silent = Boolean(options.silent);
  if (!silent) {
    setSyncMessage("Loading calendars...");
  }
  try {
    const calendars = await listGoogleCalendars();
    googleState.calendars = mergeCalendarSelections(calendars);
    renderCalendarList();
    if (!silent) {
      setSyncMessage(
        googleState.calendars.length
          ? "Choose calendars to sync."
          : "No calendars available for connected accounts."
      );
    }
  } catch (error) {
    if (!silent) {
      setSyncMessage(error?.message || "Unable to load calendars.", true);
    }
  }
}

function buildSyncRange() {
  const rangeStart = new Date();
  const boundedEnd = addDays(rangeStart, MAX_SYNC_DAYS);
  return {
    range_start: toProjectIsoFromDate(rangeStart, appConfig.projectTimeZone),
    range_end: toProjectIsoFromDate(boundedEnd, appConfig.projectTimeZone),
  };
}

async function handleSyncSelected() {
  if (!googleState.accounts.length) {
    setSyncMessage("Connect a Google account first.", true);
    return;
  }
  if (!googleState.calendars.length) {
    await handleLoadCalendars({ silent: true });
  }
  if (!googleState.calendars.length) {
    setSyncMessage("No Google calendars available to sync.", true);
    return;
  }
  const calendarIds = selectedCalendarIds();
  if (!calendarIds.length) {
    setSyncMessage("Select at least one calendar first.", true);
    return;
  }
  const { range_start, range_end } = buildSyncRange();
  setSyncMessage("Syncing selected calendars...");
  try {
    const result = await syncGoogleCalendars({
      calendar_ids: calendarIds,
      range_start,
      range_end,
    });
    await hydrateCalendarViews();
    if (refreshHandler) {
      await refreshHandler(state.view);
    }
    setSyncMessage(
      `Sync complete. Created ${result.created_count}, updated ${result.updated_count}, removed ${result.deleted_count || 0}, skipped ${result.skipped_count}.`
    );
  } catch (error) {
    setSyncMessage(error?.message || "Sync failed.", true);
  }
}

async function handleCalendarVisibilityChange(input) {
  if (!(input instanceof HTMLInputElement)) return;
  const calendarViewId = input.getAttribute("data-calendar-view-id");
  if (!calendarViewId) return;
  const mutationVersion = nextMutationVersion(calendarViewMutationVersions, calendarViewId);
  const previous = googleState.calendarViews.find((view) => view.id === calendarViewId);
  const previousVisible = previous ? previous.visible !== false : !input.checked;
  googleState.calendarViews = googleState.calendarViews.map((view) =>
    view.id === calendarViewId ? { ...view, visible: input.checked } : view
  );
  renderCalendarViews();
  refreshCalendarNow();
  try {
    const updated = await persistCalendarVisibility(calendarViewId, input.checked);
    if (!isMutationVersionCurrent(calendarViewMutationVersions, calendarViewId, mutationVersion)) {
      return;
    }
    googleState.calendarViews = googleState.calendarViews.map((view) =>
      view.id === calendarViewId ? { ...view, ...updated, visible: updated.visible !== false } : view
    );
    renderCalendarViews();
    scheduleCalendarForceReload();
  } catch (error) {
    if (!isMutationVersionCurrent(calendarViewMutationVersions, calendarViewId, mutationVersion)) {
      return;
    }
    googleState.calendarViews = googleState.calendarViews.map((view) =>
      view.id === calendarViewId ? { ...view, visible: previousVisible } : view
    );
    renderCalendarViews();
    refreshCalendarNow();
    setSyncMessage(error?.message || "Unable to update calendar visibility.", true);
  }
}

async function updateCalendarSelectionFromCheckbox(input) {
  if (!(input instanceof HTMLInputElement)) return;
  const calendarId = input.getAttribute("data-calendar-id");
  if (!calendarId) return;
  const previous = findSourceCalendarById(calendarId);
  const previousSelected = previous ? previous.selected !== false : !input.checked;
  const targetViewIds = matchingGoogleViewIdsForSourceCalendar(previous);
  const sourceMutationVersion = nextMutationVersion(sourceCalendarMutationVersions, calendarId);
  const viewMutationVersions = new Map(
    targetViewIds.map((viewId) => [
      viewId,
      nextMutationVersion(calendarViewMutationVersions, viewId),
    ])
  );
  const previousVisibleById = new Map(
    googleState.calendarViews
      .filter((view) => targetViewIds.includes(view.id))
      .map((view) => [view.id, view.visible !== false])
  );
  googleState.calendars = googleState.calendars.map((calendar) =>
    calendar.id === calendarId ? { ...calendar, selected: input.checked } : calendar
  );
  applyCalendarViewVisibilityToState(targetViewIds, input.checked);
  renderCalendarList();
  refreshCalendarNow();
  try {
    const updated = await persistSourceCalendarSelection(
      calendarId,
      input.checked,
      targetViewIds
    );
    let sourceApplied = false;
    if (isMutationVersionCurrent(sourceCalendarMutationVersions, calendarId, sourceMutationVersion)) {
      googleState.calendars = googleState.calendars.map((calendar) =>
        calendar.id === calendarId
          ? {
              ...calendar,
              ...updated,
              selected: updated.selected !== false,
            }
          : calendar
      );
      sourceApplied = true;
    }
    if (sourceApplied) {
      renderCalendarViews();
      renderCalendarList();
    }
    if (targetViewIds.length && sourceApplied) {
      scheduleCalendarForceReload();
    }
  } catch (error) {
    let sourceRolledBack = false;
    if (isMutationVersionCurrent(sourceCalendarMutationVersions, calendarId, sourceMutationVersion)) {
      googleState.calendars = googleState.calendars.map((calendar) =>
        calendar.id === calendarId ? { ...calendar, selected: previousSelected } : calendar
      );
      sourceRolledBack = true;
    }
    let viewRolledBack = false;
    googleState.calendarViews = googleState.calendarViews.map((view) => {
      if (!previousVisibleById.has(view.id)) return view;
      const expectedVersion = viewMutationVersions.get(view.id);
      if (
        typeof expectedVersion === "number" &&
        !isMutationVersionCurrent(calendarViewMutationVersions, view.id, expectedVersion)
      ) {
        return view;
      }
      viewRolledBack = true;
      return { ...view, visible: previousVisibleById.get(view.id) };
    });
    if (sourceRolledBack || viewRolledBack) {
      renderCalendarViews();
      renderCalendarList();
      refreshCalendarNow();
      setSyncMessage(error?.message || "Unable to update Google calendar selection.", true);
    }
  }
}

async function setAllGoogleCalendarSelections(selected) {
  const nextValue = Boolean(selected);
  const changed = googleState.calendars.filter((calendar) => (calendar.selected !== false) !== nextValue);
  if (!changed.length) {
    return;
  }
  const sourceMutationVersions = new Map(
    changed.map((calendar) => [
      calendar.id,
      nextMutationVersion(sourceCalendarMutationVersions, calendar.id),
    ])
  );
  const previousById = new Map(
    changed.map((calendar) => [calendar.id, calendar.selected !== false])
  );
  const relatedViewIdsByCalendarId = new Map();
  const visibilityUpdates = [];
  const previousVisibilityByViewId = new Map();
  for (const calendar of changed) {
    const viewIds = matchingGoogleViewIdsForSourceCalendar(calendar);
    relatedViewIdsByCalendarId.set(calendar.id, viewIds);
    for (const viewId of viewIds) {
      if (!previousVisibilityByViewId.has(viewId)) {
        const view = googleState.calendarViews.find((item) => item.id === viewId);
        previousVisibilityByViewId.set(viewId, view ? view.visible !== false : true);
      }
      visibilityUpdates.push(viewId);
    }
  }
  const uniqueVisibilityUpdates = Array.from(new Set(visibilityUpdates));
  const viewMutationVersions = new Map(
    uniqueVisibilityUpdates.map((viewId) => [
      viewId,
      nextMutationVersion(calendarViewMutationVersions, viewId),
    ])
  );
  googleState.calendars = googleState.calendars.map((calendar) =>
    previousById.has(calendar.id) ? { ...calendar, selected: nextValue } : calendar
  );
  applyCalendarViewVisibilityToState(uniqueVisibilityUpdates, nextValue);
  renderCalendarList();
  refreshCalendarNow();
  setSyncMessage(nextValue ? "Checking source calendars..." : "Unchecking source calendars...");
  try {
    const sourceSelectionPromise = Promise.all(
      changed.map((calendar) =>
        persistSourceCalendarSelection(
          calendar.id,
          nextValue,
          relatedViewIdsByCalendarId.get(calendar.id) || []
        )
      )
    );
    const selectionUpdates = await sourceSelectionPromise;
    const updatesById = new Map(selectionUpdates.map((item) => [item.id, item]));
    let sourceApplied = false;
    googleState.calendars = googleState.calendars.map((calendar) => {
      const updated = updatesById.get(calendar.id);
      if (!updated) return calendar;
      const expectedVersion = sourceMutationVersions.get(calendar.id);
      if (
        typeof expectedVersion === "number" &&
        !isMutationVersionCurrent(sourceCalendarMutationVersions, calendar.id, expectedVersion)
      ) {
        return calendar;
      }
      sourceApplied = true;
      return {
        ...calendar,
        ...updated,
        selected: updated.selected !== false,
      };
    });
    if (sourceApplied) {
      renderCalendarViews();
      renderCalendarList();
      setSyncMessage(
        nextValue
          ? "All source calendars checked."
          : "All source calendars unchecked."
      );
    }
    if (uniqueVisibilityUpdates.length && sourceApplied) {
      scheduleCalendarForceReload();
    }
  } catch (error) {
    let sourceRolledBack = false;
    googleState.calendars = googleState.calendars.map((calendar) => {
      if (!previousById.has(calendar.id)) return calendar;
      const expectedVersion = sourceMutationVersions.get(calendar.id);
      if (
        typeof expectedVersion === "number" &&
        !isMutationVersionCurrent(sourceCalendarMutationVersions, calendar.id, expectedVersion)
      ) {
        return calendar;
      }
      sourceRolledBack = true;
      return { ...calendar, selected: previousById.get(calendar.id) };
    });
    let viewRolledBack = false;
    googleState.calendarViews = googleState.calendarViews.map((view) => {
      if (!previousVisibilityByViewId.has(view.id)) return view;
      const expectedVersion = viewMutationVersions.get(view.id);
      if (
        typeof expectedVersion === "number" &&
        !isMutationVersionCurrent(calendarViewMutationVersions, view.id, expectedVersion)
      ) {
        return view;
      }
      viewRolledBack = true;
      return { ...view, visible: previousVisibilityByViewId.get(view.id) };
    });
    if (sourceRolledBack || viewRolledBack) {
      renderCalendarViews();
      renderCalendarList();
      refreshCalendarNow();
      setSyncMessage(error?.message || "Unable to update source calendar selections.", true);
    }
  }
}

async function handleCopyCalendarToMain(button) {
  if (!(button instanceof HTMLButtonElement)) return;
  const calendarViewId = button.getAttribute("data-copy-calendar-view-id");
  if (!calendarViewId) return;
  setSyncMessage("Copying calendar to main...");
  try {
    const result = await copyCalendarToMain(calendarViewId);
    setSyncMessage(
      `Copied to main. Created ${result.created_count}, merged ${result.merged_count}, skipped ${result.skipped_count || 0}.`
    );
    await hydrateCalendarViews();
    if (refreshHandler) {
      await refreshHandler(state.view);
    }
  } catch (error) {
    setSyncMessage(error?.message || "Unable to copy calendar to main.", true);
  }
}

async function handleDeleteCalendarView(button) {
  if (!(button instanceof HTMLButtonElement)) return;
  const calendarViewId = button.getAttribute("data-delete-calendar-view-id");
  if (!calendarViewId) return;
  setSyncMessage("Deleting calendar...");
  try {
    await deleteCalendarView(calendarViewId);
    renderCalendarList();
    await handleLoadCalendars({ silent: true });
    await hydrateCalendarViews();
    if (refreshHandler) {
      await refreshHandler(state.view);
    }
    setSyncMessage("Calendar deleted.");
  } catch (error) {
    setSyncMessage(error?.message || "Unable to delete calendar.", true);
  }
}

async function handleCreateCustomCalendar(inputElement) {
  const name = inputElement?.value?.trim() || "";
  if (!name) {
    setSyncMessage("Enter a calendar name first.", true);
    return;
  }
  setSyncMessage("Creating custom calendar...");
  try {
    await createCustomCalendar(name);
    if (dom.customCalendarNameInput) {
      dom.customCalendarNameInput.value = "";
    }
    if (dom.sidebarCustomCalendarNameInput) {
      dom.sidebarCustomCalendarNameInput.value = "";
    }
    await hydrateCalendarViews();
    setSyncMessage("Custom calendar created.");
  } catch (error) {
    setSyncMessage(error?.message || "Unable to create custom calendar.", true);
  }
}

function handleExportSelectionChange(input) {
  if (!(input instanceof HTMLInputElement)) return;
  const calendarViewId = String(input.getAttribute("data-export-calendar-view-id") || "").trim();
  if (!calendarViewId) return;
  googleState.exportSelectionByViewId = {
    ...googleState.exportSelectionByViewId,
    [calendarViewId]: input.checked,
  };
  updateExportControls();
}

function setAllExportSelections(selected) {
  const next = Boolean(selected);
  const selection = { ...googleState.exportSelectionByViewId };
  googleState.calendarViews.forEach((view) => {
    if (Number(view.recurrence_count || 0) <= 0) {
      return;
    }
    selection[String(view.id)] = next;
  });
  googleState.exportSelectionByViewId = selection;
  renderExportCalendarViews();
}

function triggerBlobDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename || "elastisched-export.ndjson";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function handleExportCalendars() {
  const calendarViewIds = selectedExportCalendarViewIds();
  if (!calendarViewIds.length) {
    setExportMessage("Select at least one calendar with recurrences first.", true);
    return;
  }
  setExportMessage("Preparing export...");
  try {
    const result = await exportCalendarViews({ calendar_view_ids: calendarViewIds });
    triggerBlobDownload(result.blob, result.filename);
    setExportMessage(`Exported ${calendarViewIds.length} calendar(s).`);
  } catch (error) {
    setExportMessage(error?.message || "Unable to export calendars.", true);
  }
}

async function handleExportUserData() {
  setUserDataExportMessage("Preparing user data export...");
  if (dom.userDataExportBtn) {
    dom.userDataExportBtn.disabled = true;
  }
  try {
    const result = await exportUserData({
      client_settings: {
        app_config: { ...appConfig },
      },
    });
    triggerBlobDownload(result.blob, result.filename || "elastisched-user-data.json");
    setUserDataExportMessage("User data export ready.");
  } catch (error) {
    setUserDataExportMessage(error?.message || "Unable to export user data.", true);
  } finally {
    if (dom.userDataExportBtn) {
      dom.userDataExportBtn.disabled = false;
    }
  }
}

function openGoogleSyncSettings() {
  dom.settingsBtn?.click();
  const tab = document.querySelector('[data-settings-tab="integrations"]');
  tab?.click();
}

function consumeOAuthResultFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const oauthStatus = params.get("google_oauth");
  if (!oauthStatus) {
    return;
  }
  const oauthMessage = params.get("google_oauth_message");
  params.delete("google_oauth");
  params.delete("google_oauth_message");
  const cleanQuery = params.toString();
  const cleanUrl = `${window.location.pathname}${cleanQuery ? `?${cleanQuery}` : ""}${window.location.hash}`;
  window.history.replaceState({}, "", cleanUrl);

  if (oauthStatus === "success") {
    setConnectionMessage("Google account connected.");
    hydrateConnectionStatus();
    handleLoadCalendars({ silent: true });
    hydrateCalendarViews();
    return;
  }
  setConnectionMessage(oauthMessage || "Google sign-in failed.", true);
  setSyncMessage(oauthMessage || "Google sign-in failed.", true);
}

function bindCalendarListHandlers(target) {
  target?.addEventListener("change", (event) => {
    const input = event.target;
    if (!(input instanceof Element)) return;
    if (input.matches("input[data-calendar-id]")) {
      updateCalendarSelectionFromCheckbox(input);
    }
  });
}

function bindCalendarViewHandlers(target) {
  target?.addEventListener("change", (event) => {
    const element = event.target;
    if (!(element instanceof Element)) return;
    if (element.matches("input[data-calendar-view-id]")) {
      handleCalendarVisibilityChange(element);
    }
  });
  target?.addEventListener("click", (event) => {
    const element = event.target;
    if (!(element instanceof Element)) return;
    const button = element.closest("button[data-copy-calendar-view-id]");
    if (button instanceof HTMLButtonElement) {
      handleCopyCalendarToMain(button);
      return;
    }
    const deleteButton = element.closest("button[data-delete-calendar-view-id]");
    if (deleteButton instanceof HTMLButtonElement) {
      handleDeleteCalendarView(deleteButton);
    }
  });
}

function bindIntegrationHandlers(onRefresh) {
  setRefreshHandler(onRefresh);
  consumeOAuthResultFromUrl();

  dom.googleConnectBtn?.addEventListener("click", handleConnectGoogle);
  dom.sidebarGoogleConnectBtn?.addEventListener("click", handleConnectGoogle);
  dom.googleManualConnectBtn?.addEventListener("click", handleManualConnectGoogle);

  dom.googleDisconnectBtn?.addEventListener("click", () => handleDisconnectGoogle(null));
  dom.sidebarGoogleSelectAllBtn?.addEventListener("click", () =>
    setAllGoogleCalendarSelections(true)
  );
  dom.sidebarGoogleClearAllBtn?.addEventListener("click", () =>
    setAllGoogleCalendarSelections(false)
  );

  dom.googleLoadCalendarsBtn?.addEventListener("click", () => handleLoadCalendars());
  dom.sidebarCalendarsRefreshBtn?.addEventListener("click", async () => {
    await handleLoadCalendars();
    await hydrateCalendarViews();
  });
  dom.sidebarGoogleQuickSyncBtn?.addEventListener("click", handleSyncSelected);
  dom.googleApplyBtn?.addEventListener("click", handleSyncSelected);
  dom.googleRefreshViewsBtn?.addEventListener("click", hydrateCalendarViews);
  dom.exportSelectAllBtn?.addEventListener("click", () => setAllExportSelections(true));
  dom.exportClearAllBtn?.addEventListener("click", () => setAllExportSelections(false));
  dom.exportDownloadBtn?.addEventListener("click", handleExportCalendars);
  dom.userDataExportBtn?.addEventListener("click", handleExportUserData);
  dom.exportCalendarList?.addEventListener("change", (event) => {
    const input = event.target;
    if (!(input instanceof Element)) return;
    if (input.matches("input[data-export-calendar-view-id]")) {
      handleExportSelectionChange(input);
    }
  });

  dom.createCustomCalendarBtn?.addEventListener("click", () =>
    handleCreateCustomCalendar(dom.customCalendarNameInput)
  );
  dom.sidebarCreateCustomCalendarBtn?.addEventListener("click", () =>
    handleCreateCustomCalendar(dom.sidebarCustomCalendarNameInput)
  );

  dom.sidebarGoogleAdvancedBtn?.addEventListener("click", openGoogleSyncSettings);
  dom.googleSyncBtn?.addEventListener("click", openGoogleSyncSettings);

  dom.googleAccountsList?.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const button = target.closest("[data-disconnect-account-key]");
    if (!(button instanceof HTMLButtonElement)) return;
    const accountKey = button.getAttribute("data-disconnect-account-key");
    if (accountKey) {
      handleDisconnectGoogle(accountKey);
    }
  });
  dom.sidebarGoogleCalendarList?.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const button = target.closest("[data-disconnect-account-key]");
    if (!(button instanceof HTMLButtonElement)) return;
    const accountKey = button.getAttribute("data-disconnect-account-key");
    if (accountKey) {
      handleDisconnectGoogle(accountKey);
    }
  });

  bindCalendarListHandlers(dom.googleCalendarList);
  bindCalendarListHandlers(dom.sidebarGoogleCalendarList);
  bindCalendarViewHandlers(dom.calendarViewList);
  bindCalendarViewHandlers(dom.sidebarCalendarViewList);

  dom.settingsBtn?.addEventListener("click", () => {
    hydrateConnectionStatus();
    handleLoadCalendars({ silent: true });
    hydrateCalendarViews();
  });
  document
    .querySelector('[data-settings-tab="integrations"]')
    ?.addEventListener("click", () => {
      hydrateConnectionStatus();
      handleLoadCalendars({ silent: true });
      hydrateCalendarViews();
    });

  hydrateConnectionStatus();
  handleLoadCalendars({ silent: true });
  hydrateCalendarViews();
}

export { bindIntegrationHandlers, openGoogleSyncSettings };
