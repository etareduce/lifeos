import { appConfig, state } from "./core.js";
import { dom } from "./dom.js";
import {
  applyGoogleSync,
  buildGoogleOAuthStartUrl,
  connectGoogleAccount,
  disconnectGoogleAccount,
  getGoogleIntegrationStatus,
  listGoogleCalendars,
  previewGoogleSync,
} from "./api.js";
import { getViewRange, toProjectIsoFromDate } from "./utils.js";

const googleState = {
  calendars: [],
  preview: null,
};
const MAX_PREVIEW_DAYS = 90;

let refreshHandler = null;

function setRefreshHandler(handler) {
  refreshHandler = handler;
}

function setConnectionStatus(status) {
  if (!dom.googleConnectionStatus) return;
  const connected = Boolean(status?.connected);
  dom.googleConnectionStatus.classList.toggle("connected", connected);
  dom.googleConnectionStatus.classList.toggle("disconnected", !connected);
  dom.googleConnectionStatus.textContent = connected ? "Connected" : "Not connected";
  if (dom.googleConnectionMeta) {
    dom.googleConnectionMeta.textContent = connected
      ? status.account_name || status.account_id || ""
      : "";
  }
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
      return `
        <label class="integration-calendar-item">
          <input
            type="checkbox"
            data-calendar-id="${calendar.id}"
            ${selected ? "checked" : ""}
          />
          <div class="integration-calendar-meta">
            <span class="integration-calendar-name">${calendar.name}</span>
            <span class="integration-calendar-tz">${calendar.time_zone || "UTC"}</span>
          </div>
          ${badge}
        </label>
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

function suggestedActionLabel(action) {
  if (action === "merge") return "Suggested: merge";
  if (action === "create") return "Suggested: import as new";
  return "Suggested: review";
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
      const hasCandidates = Array.isArray(item.match_candidates) && item.match_candidates.length > 0;
      const defaultAction = item.suggested_action === "merge" && hasCandidates
        ? "merge"
        : item.suggested_action === "create"
          ? "create"
          : "skip";
      const candidateOptions = (item.match_candidates || [])
        .map((candidate) => {
          return `<option value="${candidate.recurrence_id}">${candidate.recurrence_name} (${candidate.event_count})</option>`;
        })
        .join("");
      const events = (item.events || [])
        .map((event) => {
          const start = new Date(event.start);
          const end = new Date(event.end);
          const timeLabel = `${start.toLocaleString()} - ${end.toLocaleString()}`;
          return `<div class="integration-event-row"><span>${event.name}</span><span>${timeLabel}</span></div>`;
        })
        .join("");
      return `
        <article class="integration-preview-item" data-item-id="${item.item_id}">
          <div class="integration-preview-header">
            <div>
              <div class="integration-preview-title">${item.recurrence_name}</div>
              <div class="integration-preview-subtitle">${item.calendar_name} · ${item.event_count} event(s)</div>
            </div>
            <span class="integration-suggestion">${suggestedActionLabel(item.suggested_action)}</span>
          </div>
          <div class="integration-preview-controls">
            <label>
              Action
              <select data-sync-action>
                <option value="create" ${defaultAction === "create" ? "selected" : ""}>Import as new</option>
                <option value="merge" ${defaultAction === "merge" ? "selected" : ""} ${hasCandidates ? "" : "disabled"}>
                  Merge with existing
                </option>
                <option value="skip" ${defaultAction === "skip" ? "selected" : ""}>Skip</option>
              </select>
            </label>
            <label class="integration-merge-target ${defaultAction === "merge" ? "" : "is-hidden"}" data-merge-target-wrap>
              Merge target
              <select data-merge-target ${hasCandidates ? "" : "disabled"}>
                ${candidateOptions}
              </select>
            </label>
          </div>
          <div class="integration-event-list">${events}</div>
        </article>
      `;
    })
    .join("");
}

function updateMergeTargetVisibility(target) {
  const row = target?.closest(".integration-preview-item");
  if (!row) return;
  const actionField = row.querySelector("[data-sync-action]");
  const mergeWrap = row.querySelector("[data-merge-target-wrap]");
  if (!actionField || !mergeWrap) return;
  mergeWrap.classList.toggle("is-hidden", actionField.value !== "merge");
}

function collectDecisions() {
  if (!dom.googlePreviewList) return [];
  const rows = Array.from(dom.googlePreviewList.querySelectorAll(".integration-preview-item"));
  return rows.map((row) => {
    const itemId = row.getAttribute("data-item-id");
    const action = row.querySelector("[data-sync-action]")?.value || "skip";
    const mergeTarget = row.querySelector("[data-merge-target]")?.value || null;
    return {
      item_id: itemId,
      action,
      merge_recurrence_id: action === "merge" ? mergeTarget : null,
    };
  });
}

async function hydrateConnectionStatus() {
  try {
    const status = await getGoogleIntegrationStatus();
    setConnectionStatus(status);
  } catch (error) {
    setConnectionStatus({ connected: false });
    setConnectionMessage(error?.message || "Unable to load integration status.", true);
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
  } catch (error) {
    setConnectionMessage(error?.message || "Unable to connect account.", true);
  }
}

async function handleDisconnectGoogle() {
  setConnectionMessage("Disconnecting...");
  try {
    await disconnectGoogleAccount();
    setConnectionStatus({ connected: false });
    googleState.calendars = [];
    googleState.preview = null;
    renderCalendarList();
    renderPreview();
    setConnectionMessage("Disconnected.");
    setSyncMessage("");
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
        : "No calendars available for this account."
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
      `Sync complete. Created ${result.created_count}, merged ${result.merged_count}, skipped ${result.skipped_count}.`
    );
    googleState.preview = null;
    renderPreview();
    if (refreshHandler) {
      await refreshHandler(state.view);
    }
  } catch (error) {
    setSyncMessage(error?.message || "Unable to apply sync.", true);
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
    return;
  }
  setConnectionMessage(oauthMessage || "Google sign-in failed.", true);
}

function bindIntegrationHandlers(onRefresh) {
  setRefreshHandler(onRefresh);
  consumeOAuthResultFromUrl();
  dom.googleConnectBtn?.addEventListener("click", handleConnectGoogle);
  dom.googleManualConnectBtn?.addEventListener("click", handleManualConnectGoogle);
  dom.googleDisconnectBtn?.addEventListener("click", handleDisconnectGoogle);
  dom.googleLoadCalendarsBtn?.addEventListener("click", handleLoadCalendars);
  dom.googlePreviewBtn?.addEventListener("click", handlePreviewSync);
  dom.googleApplyBtn?.addEventListener("click", handleApplySync);
  dom.googlePreviewList?.addEventListener("change", (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (target.matches("[data-sync-action]")) {
      updateMergeTargetVisibility(target);
    }
  });
  dom.googleSyncBtn?.addEventListener("click", openGoogleSyncSettings);
  dom.settingsBtn?.addEventListener("click", hydrateConnectionStatus);
  document
    .querySelector('[data-settings-tab="integrations"]')
    ?.addEventListener("click", hydrateConnectionStatus);
}

export { bindIntegrationHandlers, openGoogleSyncSettings };
