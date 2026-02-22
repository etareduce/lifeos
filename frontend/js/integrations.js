import { appConfig, state } from "./core.js";
import { dom } from "./dom.js";
import {
  applyGoogleSync,
  buildGoogleOAuthStartUrl,
  connectGoogleAccount,
  copyCalendarToMain,
  createCustomCalendar,
  disconnectGoogleAccount,
  getGoogleIntegrationStatus,
  listCalendarViews,
  listGoogleCalendars,
  previewGoogleSync,
  setCalendarVisibility,
} from "./api.js";
import { getViewRange, toProjectIsoFromDate } from "./utils.js";

const googleState = {
  accounts: [],
  calendars: [],
  preview: null,
  calendarViews: [],
};
const MAX_PREVIEW_DAYS = 90;

let refreshHandler = null;

function setRefreshHandler(handler) {
  refreshHandler = handler;
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
  renderAccountList();
}

function setConnectionMessage(message = "", error = false) {
  if (!dom.googleConnectionMessage) return;
  dom.googleConnectionMessage.textContent = message;
  dom.googleConnectionMessage.classList.toggle("error", Boolean(error));
}

function setSyncMessage(message = "", error = false) {
  if (!dom.googleSyncMessage) return;
  dom.googleSyncMessage.textContent = message;
  dom.googleSyncMessage.classList.toggle("error", Boolean(error));
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

function renderCalendarList() {
  if (!dom.googleCalendarList) return;
  if (!googleState.calendars.length) {
    dom.googleCalendarList.innerHTML = "";
    return;
  }
  dom.googleCalendarList.innerHTML = googleState.calendars
    .map((calendar) => {
      const selected = calendar.selected !== false;
      const badge = calendar.primary ? '<span class="integration-calendar-badge">Primary</span>' : "";
      const accountLabel = calendar.account_name || calendar.account_id || "Google account";
      return `
        <label class="integration-calendar-item">
          <input
            type="checkbox"
            data-calendar-id="${calendar.id}"
            ${selected ? "checked" : ""}
          />
          <div class="integration-calendar-meta">
            <span class="integration-calendar-name">${calendar.name}</span>
            <span class="integration-calendar-tz">${accountLabel} · ${calendar.time_zone || "UTC"}</span>
          </div>
          ${badge}
        </label>
      `;
    })
    .join("");
}

function renderCalendarViews() {
  if (!dom.calendarViewList) return;
  if (!googleState.calendarViews.length) {
    dom.calendarViewList.innerHTML = "";
    return;
  }
  dom.calendarViewList.innerHTML = googleState.calendarViews
    .map((view) => {
      const checked = view.visible !== false;
      const badge = view.is_main
        ? '<span class="integration-calendar-badge">Main</span>'
        : `<span class="integration-calendar-badge">${view.source || "calendar"}</span>`;
      const copyDisabled = view.is_main || !view.recurrence_count;
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
              class="ghost small"
              data-copy-calendar-view-id="${view.id}"
              ${copyDisabled ? "disabled" : ""}
            >
              Copy to main
            </button>
          </div>
        </div>
      `;
    })
    .join("");
}

function selectedCalendarIds() {
  if (!dom.googleCalendarList) return [];
  return Array.from(dom.googleCalendarList.querySelectorAll("input[data-calendar-id]:checked"))
    .map((input) => input.getAttribute("data-calendar-id"))
    .filter(Boolean);
}

function renderPreview() {
  if (!dom.googlePreviewList) return;
  const preview = googleState.preview;
  if (!preview?.items?.length) {
    dom.googlePreviewList.innerHTML = "";
    return;
  }
  dom.googlePreviewList.innerHTML = preview.items
    .map((item) => {
      const events = (item.events || [])
        .map((event) => {
          const start = new Date(event.start);
          const end = new Date(event.end);
          const timeLabel = `${start.toLocaleString()} - ${end.toLocaleString()}`;
          return `<div class="integration-event-row"><span>${event.name}</span><span>${timeLabel}</span></div>`;
        })
        .join("");
      const accountLabel = item.account_name || "Google account";
      return `
        <article class="integration-preview-item" data-item-id="${item.item_id}">
          <div class="integration-preview-header">
            <div>
              <div class="integration-preview-title">${item.recurrence_name}</div>
              <div class="integration-preview-subtitle">${accountLabel} · ${item.calendar_name} · ${item.event_count} event(s)</div>
            </div>
          </div>
          <div class="integration-preview-controls">
            <label>
              Action
              <select data-sync-action>
                <option value="create" selected>Update imported calendar</option>
                <option value="skip">Skip</option>
              </select>
            </label>
          </div>
          <div class="integration-event-list">${events}</div>
        </article>
      `;
    })
    .join("");
}

function collectDecisions() {
  if (!dom.googlePreviewList) return [];
  const rows = Array.from(dom.googlePreviewList.querySelectorAll(".integration-preview-item"));
  return rows.map((row) => {
    const itemId = row.getAttribute("data-item-id");
    const action = row.querySelector("[data-sync-action]")?.value || "skip";
    return {
      item_id: itemId,
      action,
      merge_recurrence_id: null,
    };
  });
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
    renderCalendarViews();
  } catch (error) {
    setSyncMessage(error?.message || "Unable to load calendar views.", true);
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
    googleState.preview = null;
    renderCalendarList();
    renderPreview();
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

async function handleLoadCalendars() {
  setSyncMessage("Loading calendars...");
  try {
    const calendars = await listGoogleCalendars();
    googleState.calendars = Array.isArray(calendars) ? calendars : [];
    renderCalendarList();
    setSyncMessage(
      googleState.calendars.length
        ? "Choose calendars, then generate a preview."
        : "No calendars available for connected accounts."
    );
  } catch (error) {
    setSyncMessage(error?.message || "Unable to load calendars.", true);
  }
}

async function handlePreviewSync() {
  const calendarIds = selectedCalendarIds();
  if (!calendarIds.length) {
    setSyncMessage("Select at least one calendar first.", true);
    return;
  }
  const range = getViewRange(state.view, state.anchorDate);
  const maxEnd = new Date(range.start.getTime() + MAX_PREVIEW_DAYS * 24 * 60 * 60 * 1000);
  const boundedEnd = range.end > maxEnd ? maxEnd : range.end;
  setSyncMessage("Generating preview...");
  try {
    const preview = await previewGoogleSync({
      calendar_ids: calendarIds,
      range_start: toProjectIsoFromDate(range.start, appConfig.projectTimeZone),
      range_end: toProjectIsoFromDate(boundedEnd, appConfig.projectTimeZone),
    });
    googleState.preview = preview;
    renderPreview();
    const truncated = boundedEnd < range.end;
    const suffix = truncated ? ` (limited to ${MAX_PREVIEW_DAYS} days)` : "";
    setSyncMessage(`Preview ready (${preview.items?.length || 0} recurrence group(s))${suffix}.`);
  } catch (error) {
    setSyncMessage(error?.message || "Unable to generate preview.", true);
  }
}

async function handleApplySync() {
  if (!googleState.preview?.preview_id) {
    setSyncMessage("Generate a preview before applying sync.", true);
    return;
  }
  const decisions = collectDecisions();
  setSyncMessage("Applying sync...");
  try {
    const result = await applyGoogleSync({
      preview_id: googleState.preview.preview_id,
      decisions,
    });
    setSyncMessage(
      `Sync complete. Created ${result.created_count}, updated ${result.merged_count}, removed ${result.deleted_count || 0}, skipped ${result.skipped_count}.`
    );
    googleState.preview = null;
    renderPreview();
    await hydrateCalendarViews();
    if (refreshHandler) {
      await refreshHandler(state.view);
    }
  } catch (error) {
    setSyncMessage(error?.message || "Unable to apply sync.", true);
  }
}

async function handleCalendarVisibilityChange(input) {
  if (!(input instanceof HTMLInputElement)) return;
  const calendarViewId = input.getAttribute("data-calendar-view-id");
  if (!calendarViewId) return;
  try {
    await setCalendarVisibility(calendarViewId, input.checked);
    await hydrateCalendarViews();
    if (refreshHandler) {
      await refreshHandler(state.view);
    }
  } catch (error) {
    setSyncMessage(error?.message || "Unable to update calendar visibility.", true);
    await hydrateCalendarViews();
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
      `Copied to main. Created ${result.created_count}, merged ${result.merged_count}.`
    );
    await hydrateCalendarViews();
    if (refreshHandler) {
      await refreshHandler(state.view);
    }
  } catch (error) {
    setSyncMessage(error?.message || "Unable to copy calendar to main.", true);
  }
}

async function handleCreateCustomCalendar() {
  const name = dom.customCalendarNameInput?.value?.trim() || "";
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
    await hydrateCalendarViews();
    setSyncMessage("Custom calendar created.");
  } catch (error) {
    setSyncMessage(error?.message || "Unable to create custom calendar.", true);
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

  openGoogleSyncSettings();
  if (oauthStatus === "success") {
    setConnectionMessage("Google account connected.");
    hydrateConnectionStatus();
    hydrateCalendarViews();
    return;
  }
  setConnectionMessage(oauthMessage || "Google sign-in failed.", true);
}

function bindIntegrationHandlers(onRefresh) {
  setRefreshHandler(onRefresh);
  consumeOAuthResultFromUrl();
  dom.googleConnectBtn?.addEventListener("click", handleConnectGoogle);
  dom.googleManualConnectBtn?.addEventListener("click", handleManualConnectGoogle);
  dom.googleDisconnectBtn?.addEventListener("click", () => handleDisconnectGoogle(null));
  dom.googleLoadCalendarsBtn?.addEventListener("click", handleLoadCalendars);
  dom.googlePreviewBtn?.addEventListener("click", handlePreviewSync);
  dom.googleApplyBtn?.addEventListener("click", handleApplySync);
  dom.googleRefreshViewsBtn?.addEventListener("click", hydrateCalendarViews);
  dom.createCustomCalendarBtn?.addEventListener("click", handleCreateCustomCalendar);
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
  dom.calendarViewList?.addEventListener("change", (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (target.matches("input[data-calendar-view-id]")) {
      handleCalendarVisibilityChange(target);
    }
  });
  dom.calendarViewList?.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const button = target.closest("button[data-copy-calendar-view-id]");
    if (button instanceof HTMLButtonElement) {
      handleCopyCalendarToMain(button);
    }
  });
  dom.googleSyncBtn?.addEventListener("click", openGoogleSyncSettings);
  dom.settingsBtn?.addEventListener("click", () => {
    hydrateConnectionStatus();
    hydrateCalendarViews();
  });
  document
    .querySelector('[data-settings-tab="integrations"]')
    ?.addEventListener("click", () => {
      hydrateConnectionStatus();
      hydrateCalendarViews();
    });
}

export { bindIntegrationHandlers, openGoogleSyncSettings };
