import { API_BASE, appConfig, state } from "./core.js";
import { toProjectIsoFromDate } from "./utils.js";

let occurrenceRequestVersion = 0;
let activeOccurrenceController = null;

async function fetchOccurrences(start, end) {
  const requestVersion = ++occurrenceRequestVersion;
  if (activeOccurrenceController) {
    activeOccurrenceController.abort();
  }
  const controller = new AbortController();
  activeOccurrenceController = controller;
  const timeoutId = window.setTimeout(() => controller.abort(), 12000);
  try {
    const query = new URLSearchParams({
      start: toProjectIsoFromDate(start, appConfig.projectTimeZone),
      end: toProjectIsoFromDate(end, appConfig.projectTimeZone),
    });
    const response = await fetch(`${API_BASE}/occurrences?${query.toString()}`, {
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error("Failed to fetch occurrences");
    }
    const data = await response.json();
    if (requestVersion !== occurrenceRequestVersion) {
      return;
    }
    state.blobs = data;
    state.loadedRange = { start, end };
  } catch (error) {
    if (requestVersion !== occurrenceRequestVersion) {
      return;
    }
    if (error?.name === "AbortError") {
      return;
    }
    state.blobs = [];
    state.loadedRange = null;
  } finally {
    if (activeOccurrenceController === controller) {
      activeOccurrenceController = null;
    }
    window.clearTimeout(timeoutId);
  }
}

function rangeCovers(loadedRange, start, end) {
  if (!loadedRange) return false;
  return start >= loadedRange.start && end <= loadedRange.end;
}

async function ensureOccurrences(start, end) {
  if (rangeCovers(state.loadedRange, start, end)) {
    return;
  }
  await fetchOccurrences(start, end);
}

async function fetchScheduleStatus() {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(`${API_BASE}/schedule/status`, {
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error("Failed to fetch schedule status");
    }
    return response.json();
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error("Schedule status request timed out");
    }
    throw error;
  } finally {
    window.clearTimeout(timeoutId);
  }
}

async function runSchedule(granularityMinutes, lookaheadSeconds) {
  const payload = {
    granularity_minutes: granularityMinutes,
    lookahead_seconds: lookaheadSeconds,
    user_timezone: appConfig.userTimeZone,
    include_active_occurrences: appConfig.includeActiveOccurrences,
    initial_temp: appConfig.engineInitialTemp,
    final_temp: appConfig.engineFinalTemp,
    num_iters: appConfig.engineNumIters,
    illegal_schedule_weight: appConfig.engineIllegalScheduleWeight,
    overlap_cost_weight: appConfig.engineOverlapCostWeight,
    split_cost_weight: appConfig.engineSplitCostWeight,
    consistency_cost_weight: appConfig.engineConsistencyCostWeight,
    granularity_cost_weight: appConfig.engineGranularityCostWeight,
  };
  const response = await fetch(`${API_BASE}/schedule`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    let detail = "Failed to run scheduler";
    const contentType = response.headers.get("content-type") || "";
    if (contentType.includes("application/json")) {
      const data = await response.json();
      detail = data.detail || detail;
    } else {
      detail = (await response.text()) || detail;
    }
    throw new Error(detail);
  }
  return response.json();
}

async function getRecurrence(recurrenceId) {
  const response = await fetch(`${API_BASE}/recurrences/${recurrenceId}`);
  if (!response.ok) {
    throw new Error("Failed to fetch recurrence");
  }
  return response.json();
}

async function createRecurrence(type, payload) {
  if (Array.isArray(type)) {
    return createRecurrencesBulk(type);
  }
  const response = await fetch(`${API_BASE}/recurrences`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type, payload }),
  });
  if (!response.ok) {
    let detail = "Failed to create recurrence";
    const contentType = response.headers.get("content-type") || "";
    if (contentType.includes("application/json")) {
      const data = await response.json();
      detail = data.detail || detail;
    } else {
      detail = (await response.text()) || detail;
    }
    throw new Error(detail);
  }
  return response.json();
}

async function createRecurrencesBulk(recurrences) {
  const response = await fetch(`${API_BASE}/recurrences/bulk`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(recurrences),
  });
  if (!response.ok) {
    let detail = "Failed to create recurrences";
    const contentType = response.headers.get("content-type") || "";
    if (contentType.includes("application/json")) {
      const data = await response.json();
      detail = data.detail || detail;
    } else {
      detail = (await response.text()) || detail;
    }
    throw new Error(detail);
  }
  return response.json();
}

async function deleteRecurrence(recurrenceId) {
  let response = null;
  try {
    response = await fetch(`${API_BASE}/recurrences/${recurrenceId}`, {
      method: "DELETE",
    });
  } catch (error) {
    throw new Error("Failed to delete recurrence. Network error.");
  }
  if (!response.ok) {
    if (response.status === 404) {
      return;
    }
    let detail = "Failed to delete recurrence";
    const contentType = response.headers.get("content-type") || "";
    if (contentType.includes("application/json")) {
      const data = await response.json();
      detail = data.detail || detail;
    } else {
      detail = (await response.text()) || detail;
    }
    throw new Error(detail);
  }
}

async function updateRecurrence(recurrenceId, type, payload) {
  const response = await fetch(`${API_BASE}/recurrences/${recurrenceId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type, payload }),
  });
  if (!response.ok) {
    let detail = "Failed to update recurrence";
    const contentType = response.headers.get("content-type") || "";
    if (contentType.includes("application/json")) {
      const data = await response.json();
      detail = data.detail || detail;
    } else {
      detail = (await response.text()) || detail;
    }
    throw new Error(detail);
  }
  return response.json();
}

async function createLLMRecurrenceDraft(payload) {
  const response = await fetch(`${API_BASE}/llm/recurrence-draft`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    let detail = "Failed to generate draft schedule";
    const contentType = response.headers.get("content-type") || "";
    if (contentType.includes("application/json")) {
      const data = await response.json();
      detail = data.detail || detail;
    } else {
      detail = (await response.text()) || detail;
    }
    throw new Error(detail);
  }
  return response.json();
}

async function estimateTaskDuration(payload) {
  const response = await fetch(`${API_BASE}/llm/estimate-duration`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    let detail = "Failed to estimate duration";
    const contentType = response.headers.get("content-type") || "";
    if (contentType.includes("application/json")) {
      const data = await response.json();
      detail = data.detail || detail;
    } else {
      detail = (await response.text()) || detail;
    }
    throw new Error(detail);
  }
  return response.json();
}

async function getGoogleIntegrationStatus() {
  const response = await fetch(`${API_BASE}/integrations/google/status`);
  if (!response.ok) {
    throw new Error("Failed to fetch Google integration status");
  }
  return response.json();
}

function buildGoogleOAuthStartUrl(returnTo) {
  const params = new URLSearchParams();
  if (returnTo) {
    params.set("return_to", returnTo);
  }
  const query = params.toString();
  return `${API_BASE}/integrations/google/oauth/start${query ? `?${query}` : ""}`;
}

async function connectGoogleAccount(accessToken) {
  const response = await fetch(`${API_BASE}/integrations/google/connect`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ access_token: accessToken }),
  });
  if (!response.ok) {
    let detail = "Failed to connect Google account";
    const contentType = response.headers.get("content-type") || "";
    if (contentType.includes("application/json")) {
      const data = await response.json();
      detail = data.detail || detail;
    } else {
      detail = (await response.text()) || detail;
    }
    throw new Error(detail);
  }
  return response.json();
}

async function disconnectGoogleAccount(accountKey = null) {
  const params = new URLSearchParams();
  if (accountKey) {
    params.set("account_key", accountKey);
  }
  const query = params.toString();
  const response = await fetch(`${API_BASE}/integrations/google/connect${query ? `?${query}` : ""}`, {
    method: "DELETE",
  });
  if (!response.ok && response.status !== 404) {
    throw new Error("Failed to disconnect Google account");
  }
}

async function listGoogleCalendars() {
  const response = await fetch(`${API_BASE}/integrations/google/calendars`);
  if (!response.ok) {
    let detail = "Failed to load Google calendars";
    const contentType = response.headers.get("content-type") || "";
    if (contentType.includes("application/json")) {
      const data = await response.json();
      detail = data.detail || detail;
    } else {
      detail = (await response.text()) || detail;
    }
    throw new Error(detail);
  }
  return response.json();
}

async function previewGoogleSync(payload) {
  const response = await fetch(`${API_BASE}/integrations/google/preview`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    let detail = "Failed to generate Google sync preview";
    const contentType = response.headers.get("content-type") || "";
    if (contentType.includes("application/json")) {
      const data = await response.json();
      detail = data.detail || detail;
    } else {
      detail = (await response.text()) || detail;
    }
    throw new Error(detail);
  }
  return response.json();
}

async function applyGoogleSync(payload) {
  const response = await fetch(`${API_BASE}/integrations/google/apply`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    let detail = "Failed to apply Google sync";
    const contentType = response.headers.get("content-type") || "";
    if (contentType.includes("application/json")) {
      const data = await response.json();
      detail = data.detail || detail;
    } else {
      detail = (await response.text()) || detail;
    }
    throw new Error(detail);
  }
  return response.json();
}

async function listCalendarViews() {
  const response = await fetch(`${API_BASE}/integrations/calendars`);
  if (!response.ok) {
    let detail = "Failed to load calendar views";
    const contentType = response.headers.get("content-type") || "";
    if (contentType.includes("application/json")) {
      const data = await response.json();
      detail = data.detail || detail;
    } else {
      detail = (await response.text()) || detail;
    }
    throw new Error(detail);
  }
  return response.json();
}

async function setCalendarVisibility(calendarViewId, visible) {
  const response = await fetch(`${API_BASE}/integrations/calendars/${encodeURIComponent(calendarViewId)}/visibility`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ visible: Boolean(visible) }),
  });
  if (!response.ok) {
    let detail = "Failed to update calendar visibility";
    const contentType = response.headers.get("content-type") || "";
    if (contentType.includes("application/json")) {
      const data = await response.json();
      detail = data.detail || detail;
    } else {
      detail = (await response.text()) || detail;
    }
    throw new Error(detail);
  }
  return response.json();
}

async function setGoogleCalendarSelection(calendarViewId, selected, options = {}) {
  const relatedViewIds = Array.isArray(options?.relatedViewIds)
    ? options.relatedViewIds
        .map((value) => String(value || "").trim())
        .filter(Boolean)
    : [];
  const payload = {
    selected: Boolean(selected),
    visible:
      typeof options?.visible === "boolean"
        ? options.visible
        : Boolean(selected),
    related_view_ids: relatedViewIds,
  };
  const response = await fetch(
    `${API_BASE}/integrations/google/calendars/${encodeURIComponent(calendarViewId)}/selection`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }
  );
  if (!response.ok) {
    let detail = "Failed to update Google calendar selection";
    const contentType = response.headers.get("content-type") || "";
    if (contentType.includes("application/json")) {
      const data = await response.json();
      detail = data.detail || detail;
    } else {
      detail = (await response.text()) || detail;
    }
    throw new Error(detail);
  }
  return response.json();
}

async function previewCopyCalendarToMain(calendarViewId) {
  const response = await fetch(
    `${API_BASE}/integrations/calendars/${encodeURIComponent(calendarViewId)}/copy-to-main/preview`,
    {
      method: "POST",
    }
  );
  if (!response.ok) {
    let detail = "Failed to preview copy-to-main merge";
    const contentType = response.headers.get("content-type") || "";
    if (contentType.includes("application/json")) {
      const data = await response.json();
      detail = data.detail || detail;
    } else {
      detail = (await response.text()) || detail;
    }
    throw new Error(detail);
  }
  return response.json();
}

async function applyCopyCalendarToMain(calendarViewId, decisions) {
  const response = await fetch(
    `${API_BASE}/integrations/calendars/${encodeURIComponent(calendarViewId)}/copy-to-main/apply`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decisions: Array.isArray(decisions) ? decisions : [] }),
    }
  );
  if (!response.ok) {
    let detail = "Failed to copy calendar to main";
    const contentType = response.headers.get("content-type") || "";
    if (contentType.includes("application/json")) {
      const data = await response.json();
      detail = data.detail || detail;
    } else {
      detail = (await response.text()) || detail;
    }
    throw new Error(detail);
  }
  return response.json();
}

async function copyCalendarToMain(calendarViewId) {
  const response = await fetch(
    `${API_BASE}/integrations/calendars/${encodeURIComponent(calendarViewId)}/copy-to-main`,
    { method: "POST" }
  );
  if (!response.ok) {
    let detail = "Failed to copy calendar to main";
    const contentType = response.headers.get("content-type") || "";
    if (contentType.includes("application/json")) {
      const data = await response.json();
      detail = data.detail || detail;
    } else {
      detail = (await response.text()) || detail;
    }
    throw new Error(detail);
  }
  return response.json();
}

async function moveRecurrenceToMain(recurrenceId) {
  const response = await fetch(
    `${API_BASE}/integrations/recurrences/${encodeURIComponent(recurrenceId)}/move-to-main`,
    {
      method: "POST",
    }
  );
  if (!response.ok) {
    let detail = "Failed to move recurrence to main";
    const contentType = response.headers.get("content-type") || "";
    if (contentType.includes("application/json")) {
      const data = await response.json();
      detail = data.detail || detail;
    } else {
      detail = (await response.text()) || detail;
    }
    throw new Error(detail);
  }
  return response.json();
}

async function moveOccurrenceToMain(recurrenceId, occurrenceStart) {
  const response = await fetch(
    `${API_BASE}/integrations/recurrences/${encodeURIComponent(
      recurrenceId
    )}/occurrences/move-to-main`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ occurrence_start: occurrenceStart }),
    }
  );
  if (!response.ok) {
    let detail = "Failed to move occurrence to main";
    const contentType = response.headers.get("content-type") || "";
    if (contentType.includes("application/json")) {
      const data = await response.json();
      detail = data.detail || detail;
    } else {
      detail = (await response.text()) || detail;
    }
    throw new Error(detail);
  }
  return response.json();
}

async function createCustomCalendar(name) {
  const response = await fetch(`${API_BASE}/integrations/calendars/custom`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  if (!response.ok) {
    let detail = "Failed to create calendar";
    const contentType = response.headers.get("content-type") || "";
    if (contentType.includes("application/json")) {
      const data = await response.json();
      detail = data.detail || detail;
    } else {
      detail = (await response.text()) || detail;
    }
    throw new Error(detail);
  }
  return response.json();
}

async function deleteCalendarView(calendarViewId) {
  const response = await fetch(`${API_BASE}/integrations/calendars/${encodeURIComponent(calendarViewId)}`, {
    method: "DELETE",
  });
  if (!response.ok && response.status !== 404) {
    let detail = "Failed to delete calendar";
    const contentType = response.headers.get("content-type") || "";
    if (contentType.includes("application/json")) {
      const data = await response.json();
      detail = data.detail || detail;
    } else {
      detail = (await response.text()) || detail;
    }
    throw new Error(detail);
  }
}

export {
  ensureOccurrences,
  fetchOccurrences,
  fetchScheduleStatus,
  runSchedule,
  getRecurrence,
  createRecurrence,
  createRecurrencesBulk,
  deleteRecurrence,
  updateRecurrence,
  createLLMRecurrenceDraft,
  estimateTaskDuration,
  buildGoogleOAuthStartUrl,
  getGoogleIntegrationStatus,
  connectGoogleAccount,
  disconnectGoogleAccount,
  listGoogleCalendars,
  previewGoogleSync,
  applyGoogleSync,
  listCalendarViews,
  setCalendarVisibility,
  setGoogleCalendarSelection,
  previewCopyCalendarToMain,
  applyCopyCalendarToMain,
  copyCalendarToMain,
  moveRecurrenceToMain,
  moveOccurrenceToMain,
  createCustomCalendar,
  deleteCalendarView,
};
