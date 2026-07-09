import { API_BASE, appConfig, state } from "./core.js";
import { toProjectIsoFromDate } from "./utils.js";

let occurrenceRequestVersion = 0;
let activeOccurrenceController = null;
const SCHEDULE_STATUS_TIMEOUT_MS = 8000;
const SCHEDULE_STATUS_MAX_ATTEMPTS = 2;

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
  let lastError = null;
  for (let attempt = 1; attempt <= SCHEDULE_STATUS_MAX_ATTEMPTS; attempt += 1) {
    const controller = new AbortController();
    const timeoutId = window.setTimeout(
      () => controller.abort(),
      SCHEDULE_STATUS_TIMEOUT_MS
    );
    try {
      const response = await fetch(`${API_BASE}/schedule/status`, {
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error("Failed to fetch schedule status");
      }
      return response.json();
    } catch (error) {
      lastError = error;
      if (attempt < SCHEDULE_STATUS_MAX_ATTEMPTS) {
        continue;
      }
      if (error?.name === "AbortError") {
        throw new Error("Schedule status request timed out");
      }
      throw error;
    } finally {
      window.clearTimeout(timeoutId);
    }
  }
  throw lastError || new Error("Failed to fetch schedule status");
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

function flushPreferenceBatches() {
  const url = `${API_BASE}/analytics/flush-preference-batches`;
  if (typeof navigator !== "undefined" && typeof navigator.sendBeacon === "function") {
    try {
      return navigator.sendBeacon(url, new Blob([], { type: "application/json" }));
    } catch (error) {
      // Fall through to fetch keepalive.
    }
  }
  fetch(url, {
    method: "POST",
    keepalive: true,
  }).catch(() => {});
  return true;
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
  flushPreferenceBatches,
};
