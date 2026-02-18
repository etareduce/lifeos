import { API_BASE, appConfig, state } from "./core.js";
import { toProjectIsoFromDate } from "./utils.js";

async function fetchOccurrences(start, end) {
  try {
    const query = new URLSearchParams({
      start: toProjectIsoFromDate(start, appConfig.projectTimeZone),
      end: toProjectIsoFromDate(end, appConfig.projectTimeZone),
    });
    const response = await fetch(`${API_BASE}/occurrences?${query.toString()}`);
    if (!response.ok) {
      throw new Error("Failed to fetch occurrences");
    }
    const data = await response.json();
    state.blobs = data;
    state.loadedRange = { start, end };
  } catch (error) {
    state.blobs = [];
    state.loadedRange = null;
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
  const response = await fetch(`${API_BASE}/schedule/status`);
  if (!response.ok) {
    throw new Error("Failed to fetch schedule status");
  }
  return response.json();
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
};
