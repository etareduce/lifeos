import { appConfig, minuteGranularity, saveView, state } from "./core.js";
import { dom } from "./dom.js";
import { alertDialog, choiceDialog } from "./popups.js";
import {
  deleteOccurrenceWithUndo,
  deleteRecurrenceWithUndo,
  moveOccurrenceToMainWithRefresh,
  moveRecurrenceToMainWithRefresh,
} from "./actions.js";
import {
  addDays,
  clampToGranularity,
  formatTimeRangeInTimeZone,
  getBlobCalendarContext,
  getEffectiveOccurrenceRange,
  getOccurrenceOverride,
  getWeekStart,
  getTagType,
  getTimeZoneParts,
  layoutBlocks,
  overlaps,
  startOfDay,
  toDate,
  toZonedDate,
  toLocalInputFromDate,
} from "./utils.js";

let infoCardEventsBound = false;
let infoCardAnchorEl = null;

function setInfoCardAnchor(element) {
  infoCardAnchorEl = element instanceof Element ? element : null;
}

function getPolicyFlags(policy = {}) {
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
  const showOnTasksPage =
    typeof policy.show_on_tasks_page === "boolean" ? policy.show_on_tasks_page : true;
  return { splittable, overlappable, invisible, showOnTasksPage };
}

function getCalendarViewIdFromBlob(blob) {
  const payload = blob?.recurrence_payload;
  if (!payload || typeof payload !== "object") return "";
  const calendarView = payload.calendar_view;
  if (!calendarView || typeof calendarView !== "object") return "";
  return String(calendarView.id || "").trim();
}

function isBlobVisible(blob) {
  const calendarViewId = getCalendarViewIdFromBlob(blob);
  if (!calendarViewId || calendarViewId === "main") {
    return true;
  }
  const visibility = state.calendarVisibilityByViewId || {};
  if (!Object.prototype.hasOwnProperty.call(visibility, calendarViewId)) {
    return true;
  }
  return visibility[calendarViewId] !== false;
}

function getCalendarBlobs() {
  const visiblePrimary = state.blobs.filter(isBlobVisible);
  const preview = Array.isArray(state.previewBlobs) ? state.previewBlobs : [];
  const visiblePreview = preview.filter(isBlobVisible);
  return visiblePreview.length ? visiblePrimary.concat(visiblePreview) : visiblePrimary;
}

function getBlobById(blobId) {
  if (!blobId) return null;
  const primary = state.blobs.find((item) => item.id === blobId);
  if (primary) return primary;
  const preview = Array.isArray(state.previewBlobs) ? state.previewBlobs : [];
  return preview.find((item) => item.id === blobId) || null;
}

function isOccurrenceStarred(blob) {
  const payload = blob.recurrence_payload || {};
  const occurrenceStart = blob.schedulable_timerange?.start;
  const occurrenceDate = occurrenceStart ? new Date(occurrenceStart) : null;
  if (!occurrenceDate || Number.isNaN(occurrenceDate.getTime())) return false;
  const occurrenceKey = occurrenceDate.toISOString();
  if (payload.starred) {
    const unstarred = Array.isArray(payload.unstarred) ? payload.unstarred : [];
    return !unstarred.some((item) => {
      const itemDate = new Date(item);
      if (Number.isNaN(itemDate.getTime())) return false;
      return itemDate.toISOString() === occurrenceKey;
    });
  }
  const stars = Array.isArray(payload.stars) ? payload.stars : [];
  return stars.some((item) => {
    const itemDate = new Date(item);
    if (Number.isNaN(itemDate.getTime())) return false;
    return itemDate.toISOString() === occurrenceKey;
  });
}

function renderPolicyBadges(policy, { compact = false } = {}) {
  const flags = getPolicyFlags(policy || {});
  const items = [];
  if (flags.splittable) {
    items.push({ key: "splittable", label: "Splittable" });
  }
  if (flags.overlappable) {
    items.push({ key: "overlappable", label: "Overlappable" });
  }
  if (flags.invisible) {
    items.push({ key: "invisible", label: "Invisible" });
  }
  if (!flags.showOnTasksPage) {
    items.push({ key: "hidden-from-tasks", label: "Hidden from Tasks" });
  }
  if (items.length === 0) {
    return "";
  }
  if (compact && items.length > 1) {
    const [first, ...rest] = items;
    const remainingCount = rest.length;
    const remainderLabel = rest.map((item) => item.label).join(", ");
    return `
      <span class="policy-badge ${first.key}">${first.label}</span>
      <span class="policy-badge summary" title="${remainderLabel}">+${remainingCount}</span>
    `;
  }
  return items
    .map((item) => `<span class="policy-badge ${item.key}">${item.label}</span>`)
    .join("");
}

function getRecurrenceColorClass(blob) {
  const color = blob?.recurrence_payload?.color;
  return color ? `palette-${color}` : "";
}

function getBlobTimeZone(blob) {
  return blob?.tz || appConfig.userTimeZone;
}

function calendarSourceLabel(source) {
  const normalized = String(source || "").trim().toLowerCase();
  if (!normalized) return "";
  if (normalized === "main") return "Main";
  if (normalized === "google") return "Google";
  if (normalized === "custom") return "Custom";
  return `${normalized.charAt(0).toUpperCase()}${normalized.slice(1)}`;
}

function resolveBlobCalendarInfo(blob) {
  const { calendarView, integrationSource, calendarViewId, isMain } =
    getBlobCalendarContext(blob);
  const name = String(
    isMain
      ? "Main"
      : calendarView?.name ||
          integrationSource?.calendar_name ||
          calendarViewId ||
          integrationSource?.calendar_id ||
          "Unknown calendar"
  ).trim();
  const source = String(
    isMain ? "main" : calendarView?.source || integrationSource?.provider || ""
  )
    .trim()
    .toLowerCase();
  const account = String(
    calendarView?.account_name ||
      integrationSource?.account_name ||
      integrationSource?.account_id ||
      ""
  ).trim();
  return {
    isMain,
    name: name || "Unknown calendar",
    sourceLabel: calendarSourceLabel(source),
    account,
  };
}

function getZonedParts(value, timeZone) {
  if (!value) return null;
  const date = value instanceof Date ? value : toDate(value);
  if (!date || Number.isNaN(date.getTime())) return null;
  return getTimeZoneParts(date, timeZone);
}

function partsToDayStamp(parts) {
  return Date.UTC(parts.year, parts.month - 1, parts.day);
}

function minutesFromParts(parts) {
  return parts.hour * 60 + parts.minute + (parts.second || 0) / 60;
}

function updateNowLine(trackEl, hourHeight, viewDate) {
  if (!trackEl) return;
  const lineEl = trackEl.querySelector(".current-time-line");
  if (!lineEl) return;
  const nowParts = getZonedParts(new Date(), appConfig.userTimeZone);
  const viewParts = getZonedParts(viewDate, appConfig.userTimeZone);
  if (!nowParts || !viewParts) {
    lineEl.classList.remove("active");
    return;
  }
  if (partsToDayStamp(nowParts) !== partsToDayStamp(viewParts)) {
    lineEl.classList.remove("active");
    return;
  }
  const minutes = Math.min(1440, Math.max(0, minutesFromParts(nowParts)));
  lineEl.style.top = `${(minutes / 60) * hourHeight}px`;
  lineEl.classList.add("active");
}

function getClampedMinutes(startParts, endParts, viewDayStamp) {
  const startStamp = partsToDayStamp(startParts);
  const endStamp = partsToDayStamp(endParts);
  const startMin = minutesFromParts(startParts);
  const endMin = minutesFromParts(endParts);
  const overlapsDay =
    (startStamp < viewDayStamp || (startStamp === viewDayStamp && startMin < 1440)) &&
    (endStamp > viewDayStamp || (endStamp === viewDayStamp && endMin > 0));
  if (!overlapsDay) return null;
  const clampedStart = startStamp < viewDayStamp ? 0 : startMin;
  const clampedEnd = endStamp > viewDayStamp ? 1440 : endMin;
  if (clampedEnd <= clampedStart) return null;
  return { startMin: clampedStart, endMin: clampedEnd };
}

function formatRecurrenceEnd(value) {
  if (!value) return "";
  const end = toZonedDate(toDate(value), appConfig.userTimeZone);
  if (!end || Number.isNaN(end.getTime())) return "";
  return end.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function getInfoCard() {
  if (dom.infoCard) {
    bindInfoCardEvents(dom.infoCard);
    return dom.infoCard;
  }
  const card = document.createElement("div");
  card.id = "infoCard";
  card.className = "info-card";
  card.setAttribute("aria-hidden", "true");
  bindInfoCardEvents(card);
  document.body.appendChild(card);
  dom.infoCard = card;
  return card;
}

function bindInfoCardEvents(card) {
  if (!card || infoCardEventsBound) return;
  infoCardEventsBound = true;
  card.addEventListener("mouseenter", () => {
    state.infoCardHovering = true;
    clearInfoCardHideTimeout();
  });
  card.addEventListener("mouseleave", (event) => {
    state.infoCardHovering = false;
    state.infoCardAnchorHovering = isInfoCardAnchorTarget(event.relatedTarget);
    if (state.infoCardAnchorHovering) return;
    scheduleInfoCardHide();
  });
}

function clearInfoCardHideTimeout() {
  if (state.infoCardHideTimeout) {
    window.clearTimeout(state.infoCardHideTimeout);
    state.infoCardHideTimeout = null;
  }
}

function isInfoCardAnchorHovered() {
  return Boolean(infoCardAnchorEl?.matches(":hover"));
}

function isInfoCardAnchorTarget(target) {
  if (!(target instanceof Element)) return false;
  return Boolean(infoCardAnchorEl && (target === infoCardAnchorEl || infoCardAnchorEl.contains(target)));
}

function clearInfoCardOverlays() {
  const dayOverlay = dom.views.day?.querySelector("#schedulableOverlay");
  const dayOriginalOverlay = dom.views.day?.querySelector("#originalOverlay");
  dayOverlay?.classList.remove("active", "overflow-top", "overflow-bottom");
  dayOriginalOverlay?.classList.remove("active");
  dom.views.week
    ?.querySelectorAll(".schedulable-overlay")
    .forEach((overlay) => overlay.classList.remove("active", "overflow-top", "overflow-bottom"));
  dom.views.week
    ?.querySelectorAll(".original-overlay")
    .forEach((overlay) => overlay.classList.remove("active"));
}

function scheduleInfoCardHide(cleanup) {
  clearInfoCardHideTimeout();
  state.infoCardHideTimeout = window.setTimeout(() => {
    state.infoCardHideTimeout = null;
    const cardHovered = Boolean(dom.infoCard?.matches(":hover"));
    const anchorHovered = isInfoCardAnchorHovered();
    state.infoCardHovering = cardHovered;
    state.infoCardAnchorHovering = anchorHovered;
    if (cardHovered || anchorHovered) {
      return;
    }
    if (typeof cleanup === "function") {
      cleanup();
    }
    hideInfoCard();
  }, 140);
}

function showInfoCardHtml(html, anchorRect) {
  const card = getInfoCard();
  if (!html || !anchorRect) return;
  clearInfoCardHideTimeout();
  card.innerHTML = html;
  card.classList.add("active");
  card.setAttribute("aria-hidden", "false");
  const padding = 12;
  const cardWidth = card.offsetWidth;
  const cardHeight = card.offsetHeight;
  let left = anchorRect.right + padding;
  if (left + cardWidth > window.innerWidth - padding) {
    left = anchorRect.left - cardWidth - padding;
  }
  left = Math.max(padding, Math.min(left, window.innerWidth - cardWidth - padding));
  let top = anchorRect.top;
  top = Math.max(padding, Math.min(top, window.innerHeight - cardHeight - padding));
  card.style.left = `${left}px`;
  card.style.top = `${top}px`;
  card.dataset.bridgeSide = left >= anchorRect.right ? "left" : "right";
}

function showInfoCard(blob, anchorRect) {
  if (!blob || !anchorRect) return;
  const recurrenceName = blob.recurrence_payload?.recurrence_name;
  const recurrenceDescription = blob.recurrence_payload?.recurrence_description;
  const recurrenceEnd = blob.recurrence_payload?.end_date;
  const recurrenceType = blob.recurrence_type || "single";
  const recurrenceTypeLabel = recurrenceType
    ? ({
        single: "Single occurrence",
        multiple: "Multiple occurrence",
        weekly: "Weekly cadence",
        delta: "Fixed interval",
        date: "Annual date",
      }[recurrenceType] || `${recurrenceType.charAt(0).toUpperCase()}${recurrenceType.slice(1)}`)
    : "Single occurrence";
  const starred = isOccurrenceStarred(blob);
  const blobName = blob.name || "Untitled";
  const blobDescription = blob.description || recurrenceDescription;
  const calendarInfo = resolveBlobCalendarInfo(blob);
  const calendarMeta = [calendarInfo.sourceLabel, calendarInfo.account]
    .filter(Boolean)
    .join(" · ");
  const blobId = blob.id;
  const isPreview = Boolean(blob.preview);
  const effectiveRange = getEffectiveOccurrenceRange(blob);
  const timeLabel = effectiveRange
    ? formatTimeRangeInTimeZone(
        effectiveRange.start,
        effectiveRange.effectiveEnd,
        getBlobTimeZone(blob)
      )
    : "";
  const defaultRange = blob.default_scheduled_timerange || {};
  const defaultLabel =
    defaultRange.start && defaultRange.end
      ? formatTimeRangeInTimeZone(
          defaultRange.start,
          defaultRange.end,
          getBlobTimeZone(blob)
        )
      : "";
  const schedulableRange = blob.schedulable_timerange || {};
  const schedulableLabel =
    isPreview && schedulableRange.start && schedulableRange.end
      ? formatTimeRangeInTimeZone(
          schedulableRange.start,
          schedulableRange.end,
          getBlobTimeZone(blob)
        )
      : "";
  const policyBadges = renderPolicyBadges(blob.policy);
  const tags = Array.isArray(blob.tags)
    ? blob.tags.map((tag) => (typeof tag === "string" ? tag.trim() : "")).filter(Boolean)
    : [];
  const recurrenceTypeBlock =
    recurrenceType
      ? `
        <div class="info-divider"></div>
        <div class="info-label">Recurrence type</div>
        <div class="info-text">${recurrenceTypeLabel}</div>
      `
      : "";
  const recurrenceBlock =
    recurrenceName || recurrenceDescription
      ? `
        <div class="info-divider"></div>
        <div class="info-label">Recurrence</div>
        ${recurrenceName ? `<div class="info-text">${recurrenceName}</div>` : ""}
        ${recurrenceDescription ? `<div class="info-text">${recurrenceDescription}</div>` : ""}
      `
      : "";
  const recurrenceEndLabel = formatRecurrenceEnd(recurrenceEnd);
  const recurrenceEndBlock = recurrenceEndLabel
    ? `
        <div class="info-divider"></div>
        <div class="info-label">Recurrence ends</div>
        <div class="info-text">${recurrenceEndLabel}</div>
      `
    : "";
  const tagBlock =
    tags.length > 0
      ? `
        <div class="info-divider"></div>
        <div class="info-label">Tags</div>
        <div class="info-tags">
          ${tags.map((tag) => `<span class="info-tag">${tag}</span>`).join("")}
        </div>
      `
    : "";
  const calendarBlock = `
      <div class="info-divider"></div>
      <div class="info-label">Calendar</div>
      <div class="info-text">${calendarInfo.name}</div>
      ${calendarMeta ? `<div class="info-text">${calendarMeta}</div>` : ""}
    `;
  const showBlobId = Boolean(blobId) && calendarInfo.isMain;
  const idBlock = showBlobId
    ? `
        <div class="info-divider"></div>
        <div class="info-label">Blob id</div>
        <div class="info-id-row">
          <span class="info-id info-id-pill" title="${blobId}">${blobId}</span>
          <button
            class="ghost small info-copy"
            data-copy-blob-id="${blobId}"
            aria-label="Copy blob id"
            title="Copy blob id"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
              <path
                d="M8 8a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-6a2 2 0 0 1-2-2V8zm-2 3H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v1h-2V6H5v3h1v2z"
              />
            </svg>
          </button>
        </div>
      `
    : "";
  const override = getOccurrenceOverride(blob);
  let addedMinutes = Number(override?.added_minutes || 0);
  if (!Number.isFinite(addedMinutes)) addedMinutes = 0;
  const finishDate = override?.finished_at ? toDate(override.finished_at) : null;
  const hasFinish = finishDate && !Number.isNaN(finishDate.getTime());
  const finishDateLabel =
    hasFinish && finishDate
      ? toZonedDate(finishDate, getBlobTimeZone(blob))?.toLocaleString() || ""
      : "";
  const adjustmentsBlock =
    hasFinish || addedMinutes
      ? `
        <div class="info-divider"></div>
        <div class="info-label">Adjustments</div>
        ${hasFinish ? `<div class="info-text">Finished at ${finishDateLabel}</div>` : ""}
        ${addedMinutes ? `<div class="info-text">Added time: ${addedMinutes} min</div>` : ""}
      `
      : "";

  const showTime = recurrenceType !== "date";
  const timeBlock = showTime
    ? `
    <div class="info-divider"></div>
    <div class="info-label">${isPreview ? "Default scheduled" : "Time"}</div>
    <div class="info-text">${isPreview ? (defaultLabel || timeLabel) : timeLabel}</div>
  `
    : "";
  const schedulableBlock = schedulableLabel
    ? `
      <div class="info-divider"></div>
      <div class="info-label">Schedulable window</div>
      <div class="info-text">${schedulableLabel}</div>
    `
    : "";
  const previewBadge = isPreview ? `<span class="info-preview">Preview</span>` : "";
  const canMoveToMain = !calendarInfo.isMain && Boolean(blob.recurrence_id);
  const moveAction = canMoveToMain
    ? `
      <button class="info-move" type="button" aria-label="Move to main options" title="Move to Main calendar">
        <svg viewBox="0 0 24 24" focusable="false" aria-hidden="true">
          <path d="M4 6.5h10.5A3.5 3.5 0 0 1 18 10v.2" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />
          <path d="M14 12l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
          <rect x="4" y="13.5" width="8" height="6.5" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.8" />
        </svg>
      </button>
    `
    : "";
  const actions = isPreview
    ? ""
    : `
      <span class="info-title-actions">
        ${moveAction}
        <button class="info-edit" type="button" aria-label="Edit recurrence" title="Edit recurrence">
          <svg viewBox="0 0 24 24" focusable="false" aria-hidden="true">
            <path d="M4 16.8V20h3.2L18 9.2 14.8 6 4 16.8z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" />
            <path d="M13.6 7.2l3.2 3.2" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />
          </svg>
        </button>
        <button class="info-close" type="button" aria-label="Delete options" title="Delete">
          <svg viewBox="0 0 24 24" focusable="false" aria-hidden="true">
            <path d="M5 7h14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />
            <path d="M9 7V5.8A1.8 1.8 0 0 1 10.8 4h2.4A1.8 1.8 0 0 1 15 5.8V7" fill="none" stroke="currentColor" stroke-width="1.8" />
            <path d="M8 9.5v8.7A1.8 1.8 0 0 0 9.8 20h4.4A1.8 1.8 0 0 0 16 18.2V9.5" fill="none" stroke="currentColor" stroke-width="1.8" />
            <path d="M11 11.5v6M13 11.5v6" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
          </svg>
        </button>
        <button class="info-star-btn ${starred ? "active" : ""}" type="button" aria-label="${starred ? "Unstar" : "Star"}" title="${starred ? "Unstar" : "Star"}">
          <span class="info-star" aria-hidden="true">★</span>
        </button>
      </span>
    `;
  const html = `
    <div class="info-title">
      ${blobName}
      ${previewBadge}
      ${actions}
    </div>
    ${blobDescription ? `<div class="info-text">${blobDescription}</div>` : ""}
    ${calendarBlock}
    ${recurrenceTypeBlock}
    ${recurrenceBlock}
    ${recurrenceEndBlock}
    ${tagBlock}
    ${idBlock}
    ${timeBlock}
    ${schedulableBlock}
    ${adjustmentsBlock}
    ${policyBadges ? `<div class="info-label">Policy</div><div class="policy-badges">${policyBadges}</div>` : ""}
  `;
  showInfoCardHtml(html, anchorRect);
  const card = dom.infoCard;
  if (card) {
    card.dataset.blobId = blob.id || "";
  }
}

function hideInfoCard() {
  const card = dom.infoCard;
  if (!card) return;
  clearInfoCardHideTimeout();
  state.infoCardHovering = false;
  state.infoCardAnchorHovering = false;
  setInfoCardAnchor(null);
  clearInfoCardOverlays();
  card.classList.remove("active");
  card.setAttribute("aria-hidden", "true");
  delete card.dataset.blobId;
  delete card.dataset.bridgeSide;
}

function clearInfoCardLock() {
  if (!state.infoCardLocked) return;
  state.infoCardLocked = false;
  state.lockedBlobId = null;
  if (state.view === "day") {
    dom.views.day?.querySelectorAll(".day-block").forEach((el) => el.classList.remove("active"));
    dom.views.day
      ?.querySelectorAll(".full-day-chip")
      .forEach((el) => el.classList.remove("active"));
    const overlay = dom.views.day?.querySelector("#schedulableOverlay");
    overlay?.classList.remove("active", "overflow-top", "overflow-bottom");
  } else if (state.view === "week") {
    dom.views.week
      ?.querySelectorAll(".day-block")
      .forEach((el) => el.classList.remove("active"));
    dom.views.week
      ?.querySelectorAll(".full-day-chip")
      .forEach((el) => el.classList.remove("active"));
    dom.views.week
      ?.querySelectorAll(".schedulable-overlay")
      .forEach((overlay) => overlay.classList.remove("active", "overflow-top", "overflow-bottom"));
  }
  hideInfoCard();
}

function setDateLabel(text) {
  dom.dateLabel.textContent = text;
}

function formatDayLabel(date) {
  return date.toLocaleDateString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

function formatWeekLabel(date) {
  return `Week of ${date.toLocaleDateString(undefined, {
    month: "long",
    day: "numeric",
    year: "numeric",
  })}`;
}

function formatMonthLabel(date) {
  return date.toLocaleDateString(undefined, { month: "long", year: "numeric" });
}

function updateSelectionOverlay(overlayEl, startMin, endMin, hourHeight) {
  const top = (startMin / 60) * hourHeight;
  const height = Math.max(12, ((endMin - startMin) / 60) * hourHeight);
  overlayEl.style.top = `${top}px`;
  overlayEl.style.height = `${height}px`;
  overlayEl.classList.add("active");
}

function updateCaret(caretEl, minutes, hourHeight) {
  const top = (minutes / 60) * hourHeight;
  caretEl.style.top = `${top}px`;
  caretEl.classList.add("active");
}

async function toggleStarFromCalendar(blob) {
  if (!blob?.recurrence_id || blob.preview) return;
  const wasLocked = state.infoCardLocked;
  const lockedId = state.lockedBlobId;
  const activeInfoBlobId = dom.infoCard?.dataset?.blobId || null;
  const occurrenceStart = blob.schedulable_timerange?.start;
  const occurrenceDate = occurrenceStart ? new Date(occurrenceStart) : null;
  if (!occurrenceDate || Number.isNaN(occurrenceDate.getTime())) return;
  const occurrenceKey = occurrenceDate.toISOString();
  const payload = blob.recurrence_payload || {};
  let nextPayload = { ...payload };
  if (payload.starred) {
    const unstarred = Array.isArray(payload.unstarred) ? payload.unstarred : [];
    const nextUnstarred = unstarred.some((item) => {
      const itemDate = new Date(item);
      return !Number.isNaN(itemDate.getTime()) && itemDate.toISOString() === occurrenceKey;
    })
      ? unstarred.filter((item) => {
          const itemDate = new Date(item);
          return Number.isNaN(itemDate.getTime()) || itemDate.toISOString() !== occurrenceKey;
        })
      : [...unstarred, occurrenceKey];
    nextPayload = { ...payload, unstarred: nextUnstarred };
  } else {
    const stars = Array.isArray(payload.stars) ? payload.stars : [];
    const nextStars = stars.some((item) => {
      const itemDate = new Date(item);
      return !Number.isNaN(itemDate.getTime()) && itemDate.toISOString() === occurrenceKey;
    })
      ? stars.filter((item) => {
          const itemDate = new Date(item);
          return Number.isNaN(itemDate.getTime()) || itemDate.toISOString() !== occurrenceKey;
        })
      : [...stars, occurrenceKey];
    nextPayload = { ...payload, stars: nextStars };
  }

  state.blobs = state.blobs.map((item) =>
    item.recurrence_id === blob.recurrence_id
      ? { ...item, recurrence_payload: nextPayload }
      : item
  );
  setActive(state.view);
  const shouldRestoreInfoCard =
    (wasLocked && lockedId === blob.id) || activeInfoBlobId === blob.id;
  if (shouldRestoreInfoCard) {
    const viewRoot = state.view === "week" ? dom.views.week : dom.views.day;
    const blockEl =
      viewRoot?.querySelector(`.day-block[data-blob-id="${blob.id}"]`) ||
      viewRoot?.querySelector(`.full-day-chip[data-blob-id="${blob.id}"]`);
    const updatedBlob = state.blobs.find((item) => item.id === blob.id);
    if (blockEl && updatedBlob) {
      state.infoCardLocked = false;
      showInfoCard(updatedBlob, blockEl.getBoundingClientRect());
      if (wasLocked && lockedId === blob.id) {
        state.infoCardLocked = true;
        state.lockedBlobId = blob.id;
        blockEl.classList.add("active");
      }
    }
  }

  try {
    await fetch(`${API_BASE}/recurrences/${blob.recurrence_id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: blob.recurrence_type || "single",
        payload: nextPayload,
      }),
    });
  } catch (error) {
    // Ignore network errors; state will resync on next refresh.
  }
}

async function handleInfoCardDelete(event) {
  const button = event.target.closest(".info-close");
  if (!button) return;
  const blobId = dom.infoCard?.dataset?.blobId || state.lockedBlobId;
  if (!blobId) return;
  const blob = getBlobById(blobId);
  if (blob?.preview) return;
  if (!blob?.recurrence_id) return;
  const choice = await choiceDialog("Delete this occurrence or the full recurrence?", {
    confirmText: "Delete recurrence",
    confirmValue: "recurrence",
    altText: "Delete occurrence",
    altValue: "occurrence",
    cancelText: "Cancel",
    destructive: true,
    altDestructive: true,
    confirmVariant: "ghost",
    altVariant: "ghost",
    actionOrder: "confirm-alt-cancel",
  });
  if (!choice) return;
  try {
    if (choice === "occurrence" && blob.recurrence_type === "single") {
      await deleteRecurrenceWithUndo(blob.recurrence_id);
      return;
    }
    if (choice === "occurrence") {
      await deleteOccurrenceWithUndo(blob);
      return;
    }
    if (choice === "recurrence") {
      await deleteRecurrenceWithUndo(blob.recurrence_id);
    }
  } catch (error) {
    await alertDialog(error?.message || "Unable to delete.");
  }
}

async function handleInfoCardEdit(event) {
  const button = event.target.closest(".info-edit");
  if (!button) return;
  const blobId = dom.infoCard?.dataset?.blobId || state.lockedBlobId;
  if (!blobId) return;
  const blob = getBlobById(blobId);
  if (!blob?.recurrence_id || blob.preview) return;
  clearInfoCardLock();
  try {
    const { openEditForm } = await import("./forms.js");
    openEditForm(blob);
  } catch (error) {
    await alertDialog(error?.message || "Unable to open edit form.");
  }
}

async function handleInfoCardMove(event) {
  const button = event.target.closest(".info-move");
  if (!button) return;
  const blobId = dom.infoCard?.dataset?.blobId || state.lockedBlobId;
  if (!blobId) return;
  const blob = getBlobById(blobId);
  if (!blob?.recurrence_id || blob.preview) return;
  const calendarInfo = resolveBlobCalendarInfo(blob);
  if (calendarInfo.isMain) return;
  const choice = await choiceDialog(
    "Move this occurrence or the full recurrence to Main calendar?",
    {
      confirmText: "Move recurrence",
      confirmValue: "recurrence",
      altText: "Move occurrence",
      altValue: "occurrence",
      cancelText: "Cancel",
      confirmVariant: "ghost",
      altVariant: "ghost",
      actionOrder: "confirm-alt-cancel",
    }
  );
  if (!choice) return;
  try {
    if (choice === "occurrence" && blob.recurrence_type !== "single") {
      await moveOccurrenceToMainWithRefresh(blob);
      return;
    }
    await moveRecurrenceToMainWithRefresh(blob.recurrence_id);
  } catch (error) {
    await alertDialog(error?.message || "Unable to move to main calendar.");
  }
}

function renderDay() {
  const dayStart = startOfDay(state.anchorDate);
  const hourHeight = 54;
  const hours = Array.from({ length: 24 }, (_, idx) => {
    const hour = idx % 24;
    const labelHour = hour === 0 ? 12 : hour > 12 ? hour - 12 : hour;
    const suffix = hour < 12 ? "AM" : "PM";
    return `${labelHour} ${suffix}`;
  });

  const fullDayEvents = [];
  const blocks = getCalendarBlobs()
    .map((blob) => {
      const blobTimeZone = getBlobTimeZone(blob);
      const viewDayParts = getZonedParts(state.anchorDate, blobTimeZone);
      const viewDayStamp = viewDayParts ? partsToDayStamp(viewDayParts) : null;
      if (!viewDayStamp) return null;
      const effectiveRange = getEffectiveOccurrenceRange(blob);
      if (!effectiveRange) return null;
      const startParts = getZonedParts(effectiveRange.start, blobTimeZone);
      const endParts = getZonedParts(effectiveRange.effectiveEnd, blobTimeZone);
      const schedStartParts = getZonedParts(blob.schedulable_timerange?.start, blobTimeZone);
      const schedEndParts = getZonedParts(blob.schedulable_timerange?.end, blobTimeZone);
      if (!startParts || !endParts) return null;
      const startStamp = partsToDayStamp(startParts);
      const endStamp = partsToDayStamp(endParts);
      const fullDay =
        startStamp === endStamp &&
        startParts.hour === 0 &&
        startParts.minute === 0 &&
        endParts.hour === 23 &&
        endParts.minute >= 59;
      if (fullDay && startStamp === viewDayStamp) {
        fullDayEvents.push({
          id: blob.id,
          title: blob.name,
          type: getTagType(blob.tags),
          colorClass: getRecurrenceColorClass(blob),
          starred: isOccurrenceStarred(blob),
          preview: Boolean(blob.preview),
        });
        return null;
      }
      const clamped = getClampedMinutes(startParts, endParts, viewDayStamp);
      if (!clamped) return null;
      const minutes = clamped.endMin - clamped.startMin;
      const showContent = partsToDayStamp(startParts) === viewDayStamp;
      const baseRange = blob.realized_timerange || blob.default_scheduled_timerange || {};
      const baseStart = toDate(baseRange.start);
      const baseEnd = toDate(baseRange.end);
      const isAdjusted =
        baseEnd &&
        !Number.isNaN(baseEnd.getTime()) &&
        effectiveRange.effectiveEnd.getTime() !== baseEnd.getTime();
      return {
        id: blob.id,
        title: blob.name,
        time: formatTimeRangeInTimeZone(
          effectiveRange.start,
          effectiveRange.effectiveEnd,
          blobTimeZone
        ),
        type: getTagType(blob.tags),
        colorClass: getRecurrenceColorClass(blob),
        policy: blob.policy,
        starred: isOccurrenceStarred(blob),
        top: (clamped.startMin / 60) * hourHeight,
        height: Math.max(18, (minutes / 60) * hourHeight),
        startMin: clamped.startMin,
        endMin: clamped.endMin,
        schedStartIso: blob.schedulable_timerange?.start || "",
        schedEndIso: blob.schedulable_timerange?.end || "",
        originalStartIso: baseRange.start || "",
        originalEndIso: baseRange.end || "",
        adjusted: Boolean(isAdjusted),
        schedStartParts,
        schedEndParts,
        showContent,
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.top - b.top);

  layoutBlocks(blocks);

  const hoursHtml = hours.map((hour) => `<div class="hour">${hour}</div>`).join("");
  const fullDayHtml = fullDayEvents.length
    ? `
      <div class="all-day-row">
        <div class="all-day-label">All day</div>
        <div class="full-day-events">
          ${fullDayEvents
            .map(
              (event) => `
              <div class="full-day-chip ${event.type} ${event.colorClass} ${event.preview ? "preview" : ""}" data-blob-id="${event.id}" data-preview="${event.preview ? "true" : "false"}">
                <button class="full-day-chip-button" type="button" title="${event.title || "Untitled"}">
                  <span>${event.title || "Untitled"}</span>
                </button>
                <button class="full-day-star-toggle ${event.starred ? "active" : ""}" type="button" aria-label="${event.starred ? "Unstar" : "Star"}">★</button>
              </div>
            `
            )
            .join("")}
        </div>
      </div>
    `
    : "";
  const blockHtml = blocks
    .map(
      (block) => {
        const policyBadges = renderPolicyBadges(block.policy, { compact: true });
        return `
        <div class="day-block ${block.type} ${block.colorClass} ${block.preview ? "preview" : ""} ${block.showContent ? "" : "continuation"}" style="top: ${block.top}px; height: ${block.height}px; --stack-index: ${block.stackIndex}; --stack-count: ${block.stackCount}; --stack-step: ${block.stackStep}px;" data-blob-id="${block.id}" data-preview="${block.preview ? "true" : "false"}" data-sched-start="${block.schedStartIso}" data-sched-end="${block.schedEndIso}" data-original-start="${block.originalStartIso}" data-original-end="${block.originalEndIso}" data-adjusted="${block.adjusted ? "true" : "false"}">
          ${
            block.showContent
              ? `
                <button class="star-toggle ${block.starred ? "active" : ""}" aria-pressed="${block.starred ? "true" : "false"}" title="${block.starred ? "Unstar" : "Star"}">★</button>
                <div class="event-header">
                  <span class="event-title">${block.title}</span>
                  <span class="event-time">${block.time}</span>
                </div>
                ${policyBadges ? `<div class="policy-badges">${policyBadges}</div>` : ""}
              `
              : ""
          }
        </div>
      `;
      }
    )
    .join("");

  dom.views.day.innerHTML = `
    <div class="day-grid" style="--hour-height: ${hourHeight}px;">
      <div class="hours">${hoursHtml}</div>
      <div class="day-column">
        ${fullDayHtml}
        <div class="day-track">
        <div class="schedulable-overlay" id="schedulableOverlay"></div>
        <div class="selection-overlay default-range" id="selectionOverlayDefault"></div>
        <div class="selection-overlay schedulable-range" id="selectionOverlaySchedulable"></div>
        <div class="selection-caret default-range" id="selectionCaretDefault"></div>
        <div class="selection-caret schedulable-range" id="selectionCaretSchedulable"></div>
        <div class="original-overlay" id="originalOverlay"></div>
        <div class="current-time-line"></div>
        ${blockHtml || "<div class='day-empty'>No events yet</div>"}
      </div>
      </div>
    </div>
  `;

  const overlay = dom.views.day.querySelector("#schedulableOverlay");
  const originalOverlay = dom.views.day.querySelector("#originalOverlay");
  const dayTrack = dom.views.day.querySelector(".day-track");
  const selectionOverlayDefault = dom.views.day.querySelector("#selectionOverlayDefault");
  const selectionOverlaySchedulable = dom.views.day.querySelector(
    "#selectionOverlaySchedulable"
  );
  const selectionCaretDefault = dom.views.day.querySelector("#selectionCaretDefault");
  const selectionCaretSchedulable = dom.views.day.querySelector(
    "#selectionCaretSchedulable"
  );
  const blocksEls = dom.views.day.querySelectorAll(".day-block");
  const fullDayEls = dom.views.day.querySelectorAll(".full-day-chip");

  const clearActiveBlocks = () => {
    blocksEls.forEach((el) => el.classList.remove("active"));
  };

  const applyInfoCardAndOverlay = (blockEl) => {
    const blob = getBlobById(blockEl.dataset.blobId);
    if (!blob) return;
    const blobTimeZone = getBlobTimeZone(blob);
    showInfoCard(blob, blockEl.getBoundingClientRect());
    const viewParts = getZonedParts(state.anchorDate, blobTimeZone);
    if (!viewParts) return;
    const viewStamp = partsToDayStamp(viewParts);
    originalOverlay?.classList.remove("active");
    const schedStartParts = getZonedParts(
      blockEl.getAttribute("data-sched-start"),
      blobTimeZone
    );
    const schedEndParts = getZonedParts(
      blockEl.getAttribute("data-sched-end"),
      blobTimeZone
    );
    const origStartParts = getZonedParts(
      blockEl.getAttribute("data-original-start"),
      blobTimeZone
    );
    const origEndParts = getZonedParts(
      blockEl.getAttribute("data-original-end"),
      blobTimeZone
    );
    if (!schedStartParts || !schedEndParts) return;
    const clamped = getClampedMinutes(schedStartParts, schedEndParts, viewStamp);
    if (!clamped) return;
    const minutes = clamped.endMin - clamped.startMin;
    const top = clamped.startMin;
    overlay.style.top = `${(top / 60) * hourHeight}px`;
    overlay.style.height = `${Math.max(18, (minutes / 60) * hourHeight)}px`;
    overlay.classList.toggle("overflow-top", partsToDayStamp(schedStartParts) < viewStamp);
    overlay.classList.toggle("overflow-bottom", partsToDayStamp(schedEndParts) > viewStamp);
    overlay.classList.add("active");
    if (
      blockEl.getAttribute("data-adjusted") === "true" &&
      origStartParts &&
      origEndParts
    ) {
      const origClamped = getClampedMinutes(origStartParts, origEndParts, viewStamp);
      if (origClamped) {
        const origMinutes = origClamped.endMin - origClamped.startMin;
        const origTop = origClamped.startMin;
        originalOverlay.style.top = `${(origTop / 60) * hourHeight}px`;
        originalOverlay.style.height = `${Math.max(
          18,
          (origMinutes / 60) * hourHeight
        )}px`;
        originalOverlay.classList.add("active");
      }
    }
  };

  blocksEls.forEach((blockEl) => {
    blockEl.addEventListener("mouseenter", () => {
      if (dom.formPanel?.classList.contains("active") && !state.editingRecurrenceId) return;
      state.infoCardAnchorHovering = true;
      setInfoCardAnchor(blockEl);
      clearInfoCardHideTimeout();
      applyInfoCardAndOverlay(blockEl);
    });
    blockEl.addEventListener("mouseleave", (event) => {
      state.infoCardAnchorHovering = false;
      if (infoCardAnchorEl === blockEl) {
        setInfoCardAnchor(null);
      }
      if (event.relatedTarget instanceof Element && event.relatedTarget.closest(".info-card")) {
        return;
      }
      scheduleInfoCardHide(() => {
        overlay.classList.remove("active", "overflow-top", "overflow-bottom");
        originalOverlay?.classList.remove("active");
      });
    });
    blockEl.addEventListener("click", (event) => {
      if (event.shiftKey) return;
      if (dom.formPanel?.classList.contains("active") && !state.editingRecurrenceId) return;
      if (event.target.closest(".star-toggle")) return;
      clearActiveBlocks();
      blockEl.classList.add("active");
      applyInfoCardAndOverlay(blockEl);
    });
    const starBtn = blockEl.querySelector(".star-toggle");
    if (starBtn) {
      starBtn.addEventListener("click", (event) => {
        event.stopPropagation();
        const blob = getBlobById(blockEl.dataset.blobId);
        if (!blob?.preview) {
          toggleStarFromCalendar(blob);
        }
      });
    }
  });
  fullDayEls.forEach((chipEl) => {
    if (!chipEl.dataset.blobId) return;
    const starBtn = chipEl.querySelector(".full-day-star-toggle");
    if (starBtn) {
      starBtn.addEventListener("click", (event) => {
        event.stopPropagation();
        const blob = getBlobById(chipEl.dataset.blobId);
        if (!blob?.preview) {
          toggleStarFromCalendar(blob);
        }
      });
    }
    chipEl.addEventListener("mouseenter", () => {
      if (dom.formPanel?.classList.contains("active") && !state.editingRecurrenceId) return;
      state.infoCardAnchorHovering = true;
      setInfoCardAnchor(chipEl);
      clearInfoCardHideTimeout();
      const blob = getBlobById(chipEl.dataset.blobId);
      showInfoCard(blob, chipEl.getBoundingClientRect());
    });
    chipEl.addEventListener("mouseleave", (event) => {
      state.infoCardAnchorHovering = false;
      if (infoCardAnchorEl === chipEl) {
        setInfoCardAnchor(null);
      }
      if (event.relatedTarget instanceof Element && event.relatedTarget.closest(".info-card")) {
        return;
      }
      scheduleInfoCardHide();
    });
    chipEl.addEventListener("click", (event) => {
      if (event.shiftKey) return;
      if (dom.formPanel?.classList.contains("active") && !state.editingRecurrenceId) return;
      if (event.target.closest(".full-day-star-toggle")) return;
      fullDayEls.forEach((el) => el.classList.remove("active"));
      chipEl.classList.add("active");
      const blob = getBlobById(chipEl.dataset.blobId);
      showInfoCard(blob, chipEl.getBoundingClientRect());
    });
  });
  if (state.activeBlockClickHandler) {
    document.removeEventListener("click", state.activeBlockClickHandler);
  }
  state.activeBlockClickHandler = (event) => {
    if (event.button !== 0) return;
    if (event.target.closest(".day-block")) return;
    if (event.target.closest(".full-day-chip")) return;
    if (event.target.closest(".info-card")) return;
    clearActiveBlocks();
    overlay.classList.remove("active", "overflow-top", "overflow-bottom");
    originalOverlay?.classList.remove("active");
    hideInfoCard();
    state.infoCardLocked = false;
    state.lockedBlobId = null;
  };
  document.addEventListener("click", state.activeBlockClickHandler);
  if (state.infoCardActionHandler) {
    document.removeEventListener("click", state.infoCardActionHandler);
  }
  state.infoCardActionHandler = (event) => {
    if (event.target.closest(".info-move")) {
      handleInfoCardMove(event);
      return;
    }
    if (event.target.closest(".info-edit")) {
      handleInfoCardEdit(event);
      return;
    }
    if (event.target.closest(".info-close")) {
      handleInfoCardDelete(event);
      return;
    }
    if (event.target.closest(".info-star-btn")) {
      const blobId = dom.infoCard?.dataset?.blobId || state.lockedBlobId;
      if (!blobId) return;
      const blob = getBlobById(blobId);
      if (!blob?.preview) {
        toggleStarFromCalendar(blob);
      }
    }
  };
  document.addEventListener("click", state.infoCardActionHandler);

  if (state.selectionMode) {
    let clickStart = null;
    const trackMinutes = 24 * 60;

    const toMinutes = (clientY) => {
      const rect = dayTrack.getBoundingClientRect();
      const y = Math.min(Math.max(clientY - rect.top, 0), rect.height);
      return clampToGranularity(Math.round((y / rect.height) * trackMinutes));
    };

    const finalizeRange = (startMin, endMin) => {
      const isEvent = state.currentBlobType === "event";
      const startDate = new Date(dayStart.getTime() + startMin * 60000);
      const endDate = new Date(dayStart.getTime() + endMin * 60000);
      if (state.selectionStep === "schedulable") {
        state.pendingSchedulableRange = { start: startDate, end: endDate };
        if (isEvent) {
          state.pendingDefaultRange = { start: startDate, end: endDate };
          state.selectionMode = false;
          state.selectionStep = null;
        } else {
          state.selectionStep = "default";
          dom.formStatus.textContent = "Click start/end for default range.";
          selectionCaretSchedulable.classList.remove("active");
          return;
        }
      } else if (state.selectionStep === "default") {
        state.pendingDefaultRange = { start: startDate, end: endDate };
        state.selectionMode = false;
        state.selectionStep = null;
        selectionCaretDefault.classList.remove("active");
      }
      selectionOverlayDefault.classList.add("active");
      selectionOverlaySchedulable.classList.add("active");
      const defaultRange = state.pendingDefaultRange;
      const schedRange = state.pendingSchedulableRange;
      if (defaultRange && schedRange) {
        dom.blobForm.defaultStart.value = toLocalInputFromDate(defaultRange.start);
        dom.blobForm.defaultEnd.value = toLocalInputFromDate(defaultRange.end);
        dom.blobForm.schedulableStart.value = toLocalInputFromDate(schedRange.start);
        dom.blobForm.schedulableEnd.value = toLocalInputFromDate(schedRange.end);
        dom.blobForm.defaultStart.dispatchEvent(new Event("change", { bubbles: true }));
        dom.blobForm.defaultEnd.dispatchEvent(new Event("change", { bubbles: true }));
        dom.blobForm.schedulableStart.dispatchEvent(new Event("change", { bubbles: true }));
        dom.blobForm.schedulableEnd.dispatchEvent(new Event("change", { bubbles: true }));
      }
      dom.formStatus.textContent = "Ranges captured. Fill details and create.";
    };

    const onClick = (event) => {
      if (event.button !== 0) return;
      if (event.target.closest(".day-block") && !state.selectionMode) return;
      if (state.selectionStep === null) return;
      const minutes = toMinutes(event.clientY);
      if (clickStart === null) {
        clickStart = minutes;
        const overlayEl =
          state.selectionStep === "default"
            ? selectionOverlayDefault
            : selectionOverlaySchedulable;
        const caretEl =
          state.selectionStep === "default"
            ? selectionCaretDefault
            : selectionCaretSchedulable;
        const endMin = Math.min(trackMinutes, minutes + minuteGranularity);
        updateSelectionOverlay(overlayEl, minutes, endMin, hourHeight);
        updateCaret(caretEl, minutes, hourHeight);
      } else {
        const startMin = Math.min(clickStart, minutes);
        const endMin = Math.min(
          trackMinutes,
          Math.max(clickStart + minuteGranularity, minutes)
        );
        const overlayEl =
          state.selectionStep === "default"
            ? selectionOverlayDefault
            : selectionOverlaySchedulable;
        updateSelectionOverlay(overlayEl, startMin, endMin, hourHeight);
        finalizeRange(startMin, endMin);
        clickStart = null;
      }
    };

    const onMouseMove = (event) => {
      if (state.selectionStep === null) return;
      const minutes = toMinutes(event.clientY);
      const overlayEl =
        state.selectionStep === "default"
          ? selectionOverlayDefault
          : selectionOverlaySchedulable;
      const caretEl =
        state.selectionStep === "default"
          ? selectionCaretDefault
          : selectionCaretSchedulable;
      if (clickStart === null) {
        updateCaret(caretEl, minutes, hourHeight);
      } else {
        const startMin = Math.min(clickStart, minutes);
        const endMin = Math.min(
          trackMinutes,
          Math.max(clickStart + minuteGranularity, minutes)
        );
        updateSelectionOverlay(overlayEl, startMin, endMin, hourHeight);
        updateCaret(caretEl, clickStart, hourHeight);
      }
      state.selectionPointer = { x: event.clientX, y: event.clientY };
    };

    dayTrack.addEventListener("click", onClick);
    dayTrack.addEventListener("mousemove", onMouseMove);
    if (state.selectionScrollHandler) {
      window.removeEventListener("scroll", state.selectionScrollHandler);
      window.removeEventListener("resize", state.selectionScrollHandler);
    }
    state.selectionScrollHandler = () => {
      if (state.selectionStep === null) return;
      if (!state.selectionPointer) return;
      const minutes = toMinutes(state.selectionPointer.y);
      const overlayEl =
        state.selectionStep === "default"
          ? selectionOverlayDefault
          : selectionOverlaySchedulable;
      const caretEl =
        state.selectionStep === "default"
          ? selectionCaretDefault
          : selectionCaretSchedulable;
      if (clickStart === null) {
        updateCaret(caretEl, minutes, hourHeight);
      } else {
        const startMin = Math.min(clickStart, minutes);
        const endMin = Math.min(
          trackMinutes,
          Math.max(clickStart + minuteGranularity, minutes)
        );
        updateSelectionOverlay(overlayEl, startMin, endMin, hourHeight);
        updateCaret(caretEl, clickStart, hourHeight);
      }
    };
    window.addEventListener("scroll", state.selectionScrollHandler, { passive: true });
    window.addEventListener("resize", state.selectionScrollHandler);
  }

  setDateLabel(formatDayLabel(state.anchorDate));
  updateNowLine(dayTrack, hourHeight, state.anchorDate);
}

function renderWeek() {
  const weekStart = getWeekStart(state.anchorDate);
  const days = Array.from({ length: 7 }, (_, idx) => addDays(weekStart, idx));
  const calendarBlobs = getCalendarBlobs();
  const hourHeight = 54;
  const hours = Array.from({ length: 24 }, (_, idx) => {
    const hour = idx % 24;
    const labelHour = hour === 0 ? 12 : hour > 12 ? hour - 12 : hour;
    const suffix = hour < 12 ? "AM" : "PM";
    return `${labelHour} ${suffix}`;
  });

  const dayStampsByTimeZone = new Map();
  const getDayStampsForTimeZone = (timeZone) => {
    if (dayStampsByTimeZone.has(timeZone)) {
      return dayStampsByTimeZone.get(timeZone);
    }
    const stamps = days.map((date) => {
      const parts = getZonedParts(date, timeZone);
      return parts ? partsToDayStamp(parts) : null;
    });
    dayStampsByTimeZone.set(timeZone, stamps);
    return stamps;
  };

  const blobMetas = calendarBlobs
    .map((blob) => {
      const blobTimeZone = getBlobTimeZone(blob);
      const effectiveRange = getEffectiveOccurrenceRange(blob);
      if (!effectiveRange) return null;
      const startParts = getZonedParts(effectiveRange.start, blobTimeZone);
      const endParts = getZonedParts(effectiveRange.effectiveEnd, blobTimeZone);
      if (!startParts || !endParts) return null;
      const schedStartParts = getZonedParts(blob.schedulable_timerange?.start, blobTimeZone);
      const schedEndParts = getZonedParts(blob.schedulable_timerange?.end, blobTimeZone);
      const startStamp = partsToDayStamp(startParts);
      const endStamp = partsToDayStamp(endParts);
      const fullDay =
        startStamp === endStamp &&
        startParts.hour === 0 &&
        startParts.minute === 0 &&
        endParts.hour === 23 &&
        endParts.minute >= 59;
      const baseRange = blob.realized_timerange || blob.default_scheduled_timerange || {};
      const baseEnd = toDate(baseRange.end);
      const isAdjusted =
        baseEnd &&
        !Number.isNaN(baseEnd.getTime()) &&
        effectiveRange.effectiveEnd.getTime() !== baseEnd.getTime();
      return {
        id: blob.id,
        title: blob.name,
        type: getTagType(blob.tags),
        colorClass: getRecurrenceColorClass(blob),
        policy: blob.policy,
        starred: isOccurrenceStarred(blob),
        preview: Boolean(blob.preview),
        blobTimeZone,
        dayStamps: getDayStampsForTimeZone(blobTimeZone),
        effectiveRange,
        startParts,
        endParts,
        startStamp,
        endStamp,
        fullDay,
        schedStartParts,
        schedEndParts,
        time: formatTimeRangeInTimeZone(
          effectiveRange.start,
          effectiveRange.effectiveEnd,
          blobTimeZone
        ),
        schedStartIso: blob.schedulable_timerange?.start || "",
        schedEndIso: blob.schedulable_timerange?.end || "",
        originalStartIso: baseRange.start || "",
        originalEndIso: baseRange.end || "",
        adjusted: Boolean(isAdjusted),
      };
    })
    .filter(Boolean);

  const dayEntries = days.map((date, dayIndex) => {
    const fullDayEvents = [];
    const blocks = blobMetas
      .map((meta) => {
        const viewStamp = meta.dayStamps[dayIndex];
        if (!viewStamp) return null;
        if (meta.fullDay && meta.startStamp === viewStamp) {
          fullDayEvents.push({
            id: meta.id,
            title: meta.title,
            type: meta.type,
            colorClass: meta.colorClass,
            starred: meta.starred,
            preview: meta.preview,
          });
          return null;
        }
        const clamped = getClampedMinutes(meta.startParts, meta.endParts, viewStamp);
        if (!clamped) return null;
        const minutes = clamped.endMin - clamped.startMin;
        const showContent = meta.startStamp === viewStamp;
        return {
          id: meta.id,
          title: meta.title,
          time: meta.time,
          type: meta.type,
          colorClass: meta.colorClass,
          policy: meta.policy,
          starred: meta.starred,
          top: (clamped.startMin / 60) * hourHeight,
          height: Math.max(18, (minutes / 60) * hourHeight),
          startMin: clamped.startMin,
          endMin: clamped.endMin,
          schedStartIso: meta.schedStartIso,
          schedEndIso: meta.schedEndIso,
          originalStartIso: meta.originalStartIso,
          originalEndIso: meta.originalEndIso,
          adjusted: meta.adjusted,
          schedStartParts: meta.schedStartParts,
          schedEndParts: meta.schedEndParts,
          showContent,
          preview: meta.preview,
        };
      })
      .filter(Boolean)
      .sort((a, b) => a.top - b.top);

    layoutBlocks(blocks);

    return { date, fullDayEvents, blocks };
  });

  const maxFullDayCount = dayEntries.reduce(
    (max, entry) => Math.max(max, entry.fullDayEvents.length),
    0
  );

  const labelColumns = dayEntries
    .map(
      ({ date }) => `
      <div class="week-day-label">
        <button data-date="${date.toISOString()}">
          ${date.toLocaleDateString(undefined, {
            weekday: "short",
            month: "short",
            day: "numeric",
          })}
        </button>
      </div>
    `
    )
    .join("");

  const allDayColumnsHtml = dayEntries
    .map(({ fullDayEvents }) => {
      const placeholderCount = Math.max(0, maxFullDayCount - fullDayEvents.length);
      return `
        <div class="week-all-day-column">
          <div class="full-day-events">
            ${fullDayEvents
              .map(
                (event) => `
                <div class="full-day-chip ${event.type} ${event.colorClass} ${event.preview ? "preview" : ""}" data-blob-id="${event.id}" data-preview="${event.preview ? "true" : "false"}">
                  <button class="full-day-chip-button" type="button" title="${event.title || "Untitled"}">
                    <span>${event.title || "Untitled"}</span>
                  </button>
                  <button class="full-day-star-toggle ${event.starred ? "active" : ""}" type="button" aria-label="${event.starred ? "Unstar" : "Star"}">★</button>
                </div>
              `
              )
              .join("")}
            ${Array.from({ length: placeholderCount })
              .map(() => `<div class="full-day-chip placeholder" aria-hidden="true"></div>`)
              .join("")}
          </div>
        </div>
      `;
    })
    .join("");

  const trackColumns = dayEntries
    .map(({ date, blocks }) => {
      const blockHtml = blocks
        .map(
          (block) => {
            const policyBadges = renderPolicyBadges(block.policy, { compact: true });
            return `
            <div class="day-block ${block.type} ${block.colorClass} ${block.preview ? "preview" : ""} ${block.showContent ? "" : "continuation"}" style="top: ${block.top}px; height: ${block.height}px; --stack-index: ${block.stackIndex}; --stack-count: ${block.stackCount}; --stack-step: ${block.stackStep}px;" data-blob-id="${block.id}" data-preview="${block.preview ? "true" : "false"}" data-sched-start="${block.schedStartIso}" data-sched-end="${block.schedEndIso}" data-original-start="${block.originalStartIso}" data-original-end="${block.originalEndIso}" data-adjusted="${block.adjusted ? "true" : "false"}">
              ${
                block.showContent
                  ? `
                    <button class="star-toggle ${block.starred ? "active" : ""}" aria-pressed="${block.starred ? "true" : "false"}" title="${block.starred ? "Unstar" : "Star"}">★</button>
                    <div class="event-header">
                      <span class="event-title">${block.title}</span>
                      <span class="event-time">${block.time}</span>
                    </div>
                    ${policyBadges ? `<div class="policy-badges">${policyBadges}</div>` : ""}
                  `
                  : ""
              }
            </div>
          `;
          }
        )
        .join("");

      return `
        <div class="week-day-column" style="--hour-height: ${hourHeight}px;" data-date="${date.toISOString()}">
          <div class="week-day-track">
            <div class="schedulable-overlay"></div>
            <div class="original-overlay"></div>
            <div class="selection-overlay default-range"></div>
            <div class="selection-overlay schedulable-range"></div>
            <div class="selection-caret default-range"></div>
            <div class="selection-caret schedulable-range"></div>
            <div class="current-time-line"></div>
            ${blockHtml || "<div class='day-empty'>No events yet</div>"}
          </div>
        </div>
      `;
    })
    .join("");

  const hoursHtml = hours.map((hour) => `<div class="hour">${hour}</div>`).join("");
  const allDayRowClass = maxFullDayCount > 0 ? "" : "empty";
  dom.views.week.innerHTML = `
    <div class="week-timeline" style="--hour-height: ${hourHeight}px;">
      <div class="week-hours-spacer"></div>
      <div class="week-days-labels">${labelColumns}</div>
      <div class="week-all-day-label ${allDayRowClass}">All day</div>
      <div class="week-all-day ${allDayRowClass}">${allDayColumnsHtml}</div>
      <div class="week-hours">${hoursHtml}</div>
      <div class="week-days-tracks">${trackColumns}</div>
    </div>
  `;

  const dayColumns = Array.from(dom.views.week.querySelectorAll(".week-day-column"));
  const allDayColumns = Array.from(dom.views.week.querySelectorAll(".week-all-day-column"));
  const dayTracks = dayColumns.map((column, index) => {
    return {
      track: column.querySelector(".week-day-track"),
      overlay: column.querySelector(".schedulable-overlay"),
      originalOverlay: column.querySelector(".original-overlay"),
      dayDate: days[index],
    };
  });

  allDayColumns.forEach((column) => {
    column.querySelectorAll(".full-day-chip").forEach((chipEl) => {
      if (!chipEl.dataset.blobId) return;
      const starBtn = chipEl.querySelector(".full-day-star-toggle");
      if (starBtn) {
        starBtn.addEventListener("click", (event) => {
          event.stopPropagation();
          const blob = getBlobById(chipEl.dataset.blobId);
          if (!blob?.preview) {
            toggleStarFromCalendar(blob);
          }
        });
      }
      chipEl.addEventListener("mouseenter", () => {
        if (dom.formPanel?.classList.contains("active") && !state.editingRecurrenceId) return;
        state.infoCardAnchorHovering = true;
        setInfoCardAnchor(chipEl);
        clearInfoCardHideTimeout();
        const blob = getBlobById(chipEl.dataset.blobId);
        showInfoCard(blob, chipEl.getBoundingClientRect());
      });
      chipEl.addEventListener("mouseleave", (event) => {
        state.infoCardAnchorHovering = false;
        if (infoCardAnchorEl === chipEl) {
          setInfoCardAnchor(null);
        }
        if (event.relatedTarget instanceof Element && event.relatedTarget.closest(".info-card")) {
          return;
        }
        scheduleInfoCardHide();
      });
      chipEl.addEventListener("click", (event) => {
        if (event.shiftKey) return;
        if (dom.formPanel?.classList.contains("active") && !state.editingRecurrenceId) return;
        if (event.target.closest(".full-day-star-toggle")) return;
        allDayColumns.forEach((col) =>
          col.querySelectorAll(".full-day-chip").forEach((el) => el.classList.remove("active"))
        );
        chipEl.classList.add("active");
        const blob = getBlobById(chipEl.dataset.blobId);
        showInfoCard(blob, chipEl.getBoundingClientRect());
      });
    });
  });
  dayColumns.forEach((column) => {
    column.querySelectorAll(".day-block").forEach((blockEl) => {
      const applyInfoCardAndOverlay = () => {
        const blob = getBlobById(blockEl.dataset.blobId);
        if (!blob) return;
        const blobTimeZone = getBlobTimeZone(blob);
        showInfoCard(blob, blockEl.getBoundingClientRect());
        const schedStartParts = getZonedParts(
          blockEl.getAttribute("data-sched-start"),
          blobTimeZone
        );
        const schedEndParts = getZonedParts(
          blockEl.getAttribute("data-sched-end"),
          blobTimeZone
        );
        const origStartParts = getZonedParts(
          blockEl.getAttribute("data-original-start"),
          blobTimeZone
        );
        const origEndParts = getZonedParts(
          blockEl.getAttribute("data-original-end"),
          blobTimeZone
        );
        if (!schedStartParts || !schedEndParts) return;
        const schedStartStamp = partsToDayStamp(schedStartParts);
        const schedEndStamp = partsToDayStamp(schedEndParts);
        dayTracks.forEach(({ overlay, originalOverlay, dayDate }) => {
          const viewParts = getZonedParts(dayDate, blobTimeZone);
          const viewStamp = viewParts ? partsToDayStamp(viewParts) : null;
          if (!viewStamp) return;
          const clamped = getClampedMinutes(schedStartParts, schedEndParts, viewStamp);
          if (!clamped) {
            overlay.classList.remove("active", "overflow-top", "overflow-bottom");
            originalOverlay?.classList.remove("active");
            return;
          }
          const minutes = clamped.endMin - clamped.startMin;
          const top = clamped.startMin;
          overlay.style.top = `${(top / 60) * hourHeight}px`;
          overlay.style.height = `${Math.max(18, (minutes / 60) * hourHeight)}px`;
          overlay.classList.toggle("overflow-top", schedStartStamp < viewStamp);
          overlay.classList.toggle("overflow-bottom", schedEndStamp > viewStamp);
          overlay.classList.add("active");
          if (
            blockEl.getAttribute("data-adjusted") === "true" &&
            origStartParts &&
            origEndParts
          ) {
            const origClamped = getClampedMinutes(origStartParts, origEndParts, viewStamp);
            if (origClamped) {
              const origMinutes = origClamped.endMin - origClamped.startMin;
              const origTop = origClamped.startMin;
              originalOverlay.style.top = `${(origTop / 60) * hourHeight}px`;
              originalOverlay.style.height = `${Math.max(
                18,
                (origMinutes / 60) * hourHeight
              )}px`;
              originalOverlay.classList.add("active");
            }
          }
        });
      };

      blockEl.addEventListener("mouseenter", () => {
        if (dom.formPanel?.classList.contains("active") && !state.editingRecurrenceId) return;
        state.infoCardAnchorHovering = true;
        setInfoCardAnchor(blockEl);
        clearInfoCardHideTimeout();
        applyInfoCardAndOverlay();
      });
      blockEl.addEventListener("mouseleave", (event) => {
        state.infoCardAnchorHovering = false;
        if (infoCardAnchorEl === blockEl) {
          setInfoCardAnchor(null);
        }
        if (event.relatedTarget instanceof Element && event.relatedTarget.closest(".info-card")) {
          return;
        }
        scheduleInfoCardHide(() => {
          dayTracks.forEach(({ overlay, originalOverlay }) => {
            overlay.classList.remove("active", "overflow-top", "overflow-bottom");
            originalOverlay?.classList.remove("active");
          });
        });
      });
      blockEl.addEventListener("click", (event) => {
        if (event.shiftKey) return;
        if (dom.formPanel?.classList.contains("active") && !state.editingRecurrenceId) return;
        if (event.target.closest(".star-toggle")) return;
        state.infoCardLocked = false;
        state.lockedBlobId = null;
        dayColumns.forEach((col) =>
          col.querySelectorAll(".day-block").forEach((el) => el.classList.remove("active"))
        );
        blockEl.classList.add("active");
        applyInfoCardAndOverlay();
      });
      const starBtn = blockEl.querySelector(".star-toggle");
      if (starBtn) {
        starBtn.addEventListener("click", (event) => {
          event.stopPropagation();
          const blob = getBlobById(blockEl.dataset.blobId);
          if (!blob?.preview) {
            toggleStarFromCalendar(blob);
          }
        });
      }
    });
  });
  if (state.activeBlockClickHandler) {
    document.removeEventListener("click", state.activeBlockClickHandler);
  }
  state.activeBlockClickHandler = (event) => {
    if (event.button !== 0) return;
    if (event.target.closest(".day-block")) return;
    if (event.target.closest(".full-day-chip")) return;
    if (event.target.closest(".info-card")) return;
    dayColumns.forEach((col) =>
      col.querySelectorAll(".day-block").forEach((el) => el.classList.remove("active"))
    );
    allDayColumns.forEach((col) =>
      col.querySelectorAll(".full-day-chip").forEach((el) => el.classList.remove("active"))
    );
    dayTracks.forEach(({ overlay, originalOverlay }) => {
      overlay.classList.remove("active", "overflow-top", "overflow-bottom");
      originalOverlay?.classList.remove("active");
    });
    hideInfoCard();
    state.infoCardLocked = false;
    state.lockedBlobId = null;
  };
  document.addEventListener("click", state.activeBlockClickHandler);
  if (state.infoCardActionHandler) {
    document.removeEventListener("click", state.infoCardActionHandler);
  }
  state.infoCardActionHandler = (event) => {
    if (event.target.closest(".info-move")) {
      handleInfoCardMove(event);
      return;
    }
    if (event.target.closest(".info-edit")) {
      handleInfoCardEdit(event);
      return;
    }
    if (event.target.closest(".info-close")) {
      handleInfoCardDelete(event);
      return;
    }
    if (event.target.closest(".info-star-btn")) {
      const blobId = dom.infoCard?.dataset?.blobId || state.lockedBlobId;
      if (!blobId) return;
      const blob = getBlobById(blobId);
      if (!blob?.preview) {
        toggleStarFromCalendar(blob);
      }
    }
  };
  document.addEventListener("click", state.infoCardActionHandler);

  if (state.selectionMode) {
    let clickStart = null;
    let activeColumnIndex = null;
    const trackMinutes = 24 * 60;

    const toMinutes = (clientY, track) => {
      const rect = track.getBoundingClientRect();
      const y = Math.min(Math.max(clientY - rect.top, 0), rect.height);
      return clampToGranularity(Math.round((y / rect.height) * trackMinutes));
    };

    const clearSelectionOverlays = (overlaySelector) => {
      dayColumns.forEach((column) => {
        const overlay = column.querySelector(overlaySelector);
        overlay.classList.remove("active");
      });
    };

    const clearSelectionCarets = (caretSelector) => {
      dayColumns.forEach((column) => {
        const caret = column.querySelector(caretSelector);
        caret.classList.remove("active");
      });
    };

    const updateSelectionRange = (startCol, startMin, endCol, endMin, overlaySelector) => {
      const rangeStart = Math.min(startCol, endCol);
      const rangeEnd = Math.max(startCol, endCol);
      clearSelectionOverlays(overlaySelector);
      for (let index = rangeStart; index <= rangeEnd; index += 1) {
        const overlay = dayColumns[index].querySelector(overlaySelector);
        const isStart = index === startCol;
        const isEnd = index === endCol;
        const rangeStartMin = isStart ? startMin : 0;
        const rangeEndMin = isEnd ? endMin : trackMinutes;
        const normalizedStart = Math.min(rangeStartMin, rangeEndMin);
        const normalizedEnd = Math.max(
          normalizedStart + minuteGranularity,
          rangeEndMin
        );
        updateSelectionOverlay(
          overlay,
          Math.min(normalizedStart, trackMinutes - minuteGranularity),
          Math.min(normalizedEnd, trackMinutes),
          hourHeight
        );
      }
    };

    const finalizeRange = (startCol, startMin, endCol, endMin) => {
      const rangeStartCol = Math.min(startCol, endCol);
      const rangeEndCol = Math.max(startCol, endCol);
      const rangeStartMin = startCol <= endCol ? startMin : endMin;
      const rangeEndMin = startCol <= endCol ? endMin : startMin;
      const startDay = startOfDay(days[rangeStartCol]);
      const endDay = startOfDay(days[rangeEndCol]);
      const startDate = new Date(startDay.getTime() + rangeStartMin * 60000);
      const endDate = new Date(endDay.getTime() + rangeEndMin * 60000);
      const isEvent = state.currentBlobType === "event";
      if (state.selectionStep === "schedulable") {
        state.pendingSchedulableRange = { start: startDate, end: endDate };
        if (isEvent) {
          state.pendingDefaultRange = { start: startDate, end: endDate };
          state.selectionMode = false;
          state.selectionStep = null;
        } else {
          state.selectionStep = "default";
          dom.formStatus.textContent = "Click start/end for default range.";
          clearSelectionCarets(".selection-caret.schedulable-range");
          return;
        }
      } else if (state.selectionStep === "default") {
        state.pendingDefaultRange = { start: startDate, end: endDate };
        state.selectionMode = false;
        state.selectionStep = null;
        clearSelectionCarets(".selection-caret.default-range");
      }
      const defaultRange = state.pendingDefaultRange;
      const schedRange = state.pendingSchedulableRange;
      if (defaultRange && schedRange) {
        dom.blobForm.defaultStart.value = toLocalInputFromDate(defaultRange.start);
        dom.blobForm.defaultEnd.value = toLocalInputFromDate(defaultRange.end);
        dom.blobForm.schedulableStart.value = toLocalInputFromDate(schedRange.start);
        dom.blobForm.schedulableEnd.value = toLocalInputFromDate(schedRange.end);
        dom.blobForm.defaultStart.dispatchEvent(new Event("change", { bubbles: true }));
        dom.blobForm.defaultEnd.dispatchEvent(new Event("change", { bubbles: true }));
        dom.blobForm.schedulableStart.dispatchEvent(new Event("change", { bubbles: true }));
        dom.blobForm.schedulableEnd.dispatchEvent(new Event("change", { bubbles: true }));
      }
      dom.formStatus.textContent = "Ranges captured. Fill details and create.";
    };

    dayColumns.forEach((column, columnIndex) => {
      const track = column.querySelector(".week-day-track");
      const onClick = (event) => {
        if (event.button !== 0) return;
        if (event.target.closest(".day-block") && !state.selectionMode) return;
        if (state.selectionStep === null) return;
        const minutes = toMinutes(event.clientY, track);
        if (clickStart === null) {
          clickStart = minutes;
          activeColumnIndex = columnIndex;
          const endMin = Math.min(trackMinutes, minutes + minuteGranularity);
          const overlaySelector =
            state.selectionStep === "default"
              ? ".selection-overlay.default-range"
              : ".selection-overlay.schedulable-range";
          const caretSelector =
            state.selectionStep === "default"
              ? ".selection-caret.default-range"
              : ".selection-caret.schedulable-range";
          updateSelectionRange(columnIndex, minutes, columnIndex, endMin, overlaySelector);
          clearSelectionCarets(caretSelector);
          updateCaret(column.querySelector(caretSelector), minutes, hourHeight);
        } else {
          const sameDay = activeColumnIndex === columnIndex;
          const startMin = Math.min(clickStart, minutes);
          const endMin = sameDay
            ? Math.min(
                trackMinutes,
                Math.max(clickStart + minuteGranularity, minutes)
              )
            : Math.min(trackMinutes, minutes);
          const overlaySelector =
            state.selectionStep === "default"
              ? ".selection-overlay.default-range"
              : ".selection-overlay.schedulable-range";
          updateSelectionRange(activeColumnIndex, clickStart, columnIndex, endMin, overlaySelector);
          finalizeRange(activeColumnIndex, clickStart, columnIndex, endMin);
          clickStart = null;
          activeColumnIndex = null;
        }
      };

      const onMouseMove = (event) => {
        if (state.selectionStep === null) return;
        const minutes = toMinutes(event.clientY, track);
        const sameDay = activeColumnIndex === columnIndex;
        const endMin = sameDay
          ? Math.min(trackMinutes, Math.max(clickStart + minuteGranularity, minutes))
          : Math.min(trackMinutes, minutes);
        const overlaySelector =
          state.selectionStep === "default"
            ? ".selection-overlay.default-range"
            : ".selection-overlay.schedulable-range";
        const caretSelector =
          state.selectionStep === "default"
            ? ".selection-caret.default-range"
            : ".selection-caret.schedulable-range";
        if (clickStart === null) {
          clearSelectionCarets(caretSelector);
          updateCaret(column.querySelector(caretSelector), minutes, hourHeight);
        } else {
          updateSelectionRange(activeColumnIndex, clickStart, columnIndex, endMin, overlaySelector);
          clearSelectionCarets(caretSelector);
          updateCaret(dayColumns[activeColumnIndex].querySelector(caretSelector), clickStart, hourHeight);
        }
        state.selectionPointer = { x: event.clientX, y: event.clientY, columnIndex };
      };

      track.addEventListener("click", onClick);
      track.addEventListener("mousemove", onMouseMove);
    });

    if (state.selectionScrollHandler) {
      window.removeEventListener("scroll", state.selectionScrollHandler);
      window.removeEventListener("resize", state.selectionScrollHandler);
    }
    state.selectionScrollHandler = () => {
      if (state.selectionStep === null) return;
      if (!state.selectionPointer) return;
      const target = document.elementFromPoint(
        state.selectionPointer.x,
        state.selectionPointer.y
      );
      const columnEl = target ? target.closest(".week-day-column") : null;
      const columnIndex =
        (columnEl && dayColumns.indexOf(columnEl)) ??
        state.selectionPointer.columnIndex ??
        activeColumnIndex;
      if (columnIndex === null || columnIndex === undefined || columnIndex < 0) return;
      const track = dayColumns[columnIndex].querySelector(".week-day-track");
      const minutes = toMinutes(state.selectionPointer.y, track);
      const sameDay = activeColumnIndex === columnIndex;
      const endMin = sameDay
        ? Math.min(trackMinutes, Math.max(clickStart + minuteGranularity, minutes))
        : Math.min(trackMinutes, minutes);
      const overlaySelector =
        state.selectionStep === "default"
          ? ".selection-overlay.default-range"
          : ".selection-overlay.schedulable-range";
      const caretSelector =
        state.selectionStep === "default"
          ? ".selection-caret.default-range"
          : ".selection-caret.schedulable-range";
      if (clickStart === null) {
        clearSelectionCarets(caretSelector);
        updateCaret(dayColumns[columnIndex].querySelector(caretSelector), minutes, hourHeight);
      } else {
        updateSelectionRange(activeColumnIndex, clickStart, columnIndex, endMin, overlaySelector);
        clearSelectionCarets(caretSelector);
        updateCaret(dayColumns[activeColumnIndex].querySelector(caretSelector), clickStart, hourHeight);
      }
    };
    window.addEventListener("scroll", state.selectionScrollHandler, { passive: true });
    window.addEventListener("resize", state.selectionScrollHandler);
  }

  setDateLabel(formatWeekLabel(weekStart));
  dayTracks.forEach(({ track, dayDate }) => {
    updateNowLine(track, hourHeight, dayDate);
  });
}

function renderMonth() {
  const monthStart = new Date(state.anchorDate.getFullYear(), state.anchorDate.getMonth(), 1);
  const monthEnd = new Date(state.anchorDate.getFullYear(), state.anchorDate.getMonth() + 1, 1);
  const dayOfWeek = monthStart.getDay();
  const gridStart = addDays(monthStart, -dayOfWeek);
  const gridEnd = addDays(gridStart, 42);
  const days = Array.from({ length: 42 }, (_, idx) => addDays(gridStart, idx));
  const weekdayLabels = Array.from({ length: 7 }, (_, idx) =>
    new Date(2024, 0, 7 + idx).toLocaleDateString(undefined, { weekday: "short" })
  );

  const counts = new Map();
  const dayStars = new Map();
  const toKey = (date) => {
    const year = date.getFullYear();
    const month = `${date.getMonth() + 1}`.padStart(2, "0");
    const day = `${date.getDate()}`.padStart(2, "0");
    return `${year}-${month}-${day}`;
  };

  const starredKeys = new Set();
  const calendarBlobs = getCalendarBlobs();
  calendarBlobs.forEach((blob) => {
    if (!isOccurrenceStarred(blob)) return;
    const blobTimeZone = getBlobTimeZone(blob);
    const effectiveRange = getEffectiveOccurrenceRange(blob);
    if (!effectiveRange) return;
    const start = toZonedDate(effectiveRange.start, blobTimeZone);
    const end = toZonedDate(effectiveRange.effectiveEnd, blobTimeZone);
    if (!start || !end) return;
    if (!overlaps(gridStart, gridEnd, start, end)) return;
    let cursor = startOfDay(start < gridStart ? gridStart : start);
    while (cursor < gridEnd && cursor < end) {
      const key = toKey(cursor);
      counts.set(key, (counts.get(key) || 0) + 1);
      const list = dayStars.get(key) || [];
      list.push(blob.name || "Untitled");
      dayStars.set(key, list);
      if (cursor >= monthStart && cursor < monthEnd) {
        starredKeys.add(key);
      }
      cursor = addDays(cursor, 1);
    }
  });
  const monthStarredCount = starredKeys.size;

  const dayCells = days
    .map((date) => {
      const key = toKey(date);
      const count = counts.get(key) || 0;
      const stars = dayStars.get(key) || [];
      const limited = stars.slice(0, 2);
      const extra = Math.max(0, stars.length - limited.length);
      const starsHtml = limited.map((name) => `<span class="month-day-star">${name}</span>`).join("");
      const extraHtml = extra ? `<span class="month-day-more">+${extra}</span>` : "";
      const countHtml = count > 0 ? `<span class="month-day-count">${count}</span>` : "";
      return `
        <button class="month-day ${date.getMonth() === monthStart.getMonth() ? "" : "other"}" data-date="${date.toISOString()}" data-stars='${JSON.stringify(stars)}'>
          <span class="month-day-number">${date.getDate()}</span>
          <span class="month-day-events">${starsHtml}${extraHtml}${countHtml}</span>
        </button>
      `;
    })
    .join("");

  dom.views.month.innerHTML = `
    <div class="month-calendar">
      <div class="month-summary">Starred: ${monthStarredCount}</div>
      <div class="month-weekdays">
        ${weekdayLabels.map((label) => `<div>${label}</div>`).join("")}
      </div>
      <div class="month-grid-days">
        ${dayCells}
      </div>
    </div>
  `;
  dom.views.month.querySelectorAll(".month-day").forEach((dayEl) => {
    dayEl.addEventListener("mouseenter", () => {
      state.infoCardAnchorHovering = true;
      setInfoCardAnchor(dayEl);
      clearInfoCardHideTimeout();
      let stars = [];
      try {
        const starsRaw = dayEl.getAttribute("data-stars");
        stars = starsRaw ? JSON.parse(starsRaw) : [];
      } catch (error) {
        stars = [];
      }
      if (!stars.length) {
        hideInfoCard();
        state.infoCardAnchorHovering = false;
        return;
      }
      const dateIso = dayEl.getAttribute("data-date");
      const date = dateIso ? new Date(dateIso) : null;
      const dateLabel = date
        ? date.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })
        : "Starred";
      const listItems = stars
        .slice(0, 6)
        .map((name) => `<li>${name}</li>`)
        .join("");
      const more = stars.length > 6 ? `<div class="info-text">+${stars.length - 6} more</div>` : "";
      const html = `
        <div class="info-title">${dateLabel}</div>
        <div class="info-label">Starred</div>
        <ul class="info-list">${listItems}</ul>
        ${more}
      `;
      showInfoCardHtml(html, dayEl.getBoundingClientRect());
    });
    dayEl.addEventListener("mouseleave", (event) => {
      state.infoCardAnchorHovering = false;
      if (infoCardAnchorEl === dayEl) {
        setInfoCardAnchor(null);
      }
      if (event.relatedTarget instanceof Element && event.relatedTarget.closest(".info-card")) {
        return;
      }
      scheduleInfoCardHide();
    });
  });
  setDateLabel(formatMonthLabel(state.anchorDate));
}

function renderYear() {
  const year = state.anchorDate.getFullYear();
  const calendarBlobs = getCalendarBlobs();
  const months = Array.from({ length: 12 }, (_, idx) => new Date(year, idx, 1));
  const cards = months
    .map((monthStart) => {
      const monthEnd = new Date(year, monthStart.getMonth() + 1, 1);
      const events = calendarBlobs.filter((blob) => {
        if (!isOccurrenceStarred(blob)) return false;
        const blobTimeZone = getBlobTimeZone(blob);
        const effectiveRange = getEffectiveOccurrenceRange(blob);
        if (!effectiveRange) return false;
        const start = toZonedDate(effectiveRange.start, blobTimeZone);
        const end = toZonedDate(effectiveRange.effectiveEnd, blobTimeZone);
        return start && end && overlaps(monthStart, monthEnd, start, end);
      });
      return `
        <button class="card year-month" data-date="${monthStart.toISOString()}">
          <div class="card-title">${monthStart.toLocaleDateString(undefined, {
            month: "long",
          })}</div>
          <div class="card-summary">Starred: ${events.length}</div>
        </button>
      `;
    })
    .join("");

  dom.views.year.innerHTML = `<div class="year-grid">${cards}</div>`;
  setDateLabel(`Year ${year}`);
}

function renderAll() {
  renderDay();
  renderWeek();
  renderMonth();
  renderYear();
}

function updateNowIndicators() {
  if (state.view === "day") {
    const dayTrack = dom.views.day?.querySelector(".day-track");
    updateNowLine(dayTrack, 54, state.anchorDate);
  } else if (state.view === "week") {
    const columns = dom.views.week?.querySelectorAll(".week-day-column") || [];
    columns.forEach((column) => {
      const dateIso = column.getAttribute("data-date");
      if (!dateIso) return;
      const dayDate = new Date(dateIso);
      if (Number.isNaN(dayDate.getTime())) return;
      const track = column.querySelector(".week-day-track");
      updateNowLine(track, 54, dayDate);
    });
  }
}

function setActive(view, options = {}) {
  state.view = view;
  saveView(view);
  state.infoCardLocked = false;
  state.lockedBlobId = null;
  hideInfoCard();
  dom.tabs.forEach((tab) => tab.classList.toggle("active", tab.dataset.view === view));
  Object.entries(dom.views).forEach(([key, el]) => {
    el.classList.toggle("active", key === view);
  });
  if (dom.prevDayBtn && dom.nextDayBtn) {
    const labelMap = { day: "day", week: "week", month: "month", year: "year" };
    const label = labelMap[view] || "day";
    dom.prevDayBtn.title = `Previous ${label}`;
    dom.nextDayBtn.title = `Next ${label}`;
  }

  if (options.deferRender) {
    return;
  }

  if (view === "day") {
    renderDay();
  } else if (view === "week") {
    renderWeek();
  } else if (view === "month") {
    renderMonth();
  } else if (view === "year") {
    renderYear();
  }
}

function startInteractiveCreate(options = {}) {
  const nextType = options.blobType === "event" ? "event" : state.currentBlobType || "task";
  state.currentBlobType = nextType;
  state.selectionMode = true;
  state.selectionStep = "schedulable";
  state.pendingDefaultRange = null;
  state.pendingSchedulableRange = null;
  dom.formStatus.textContent = "Click start/end for schedulable range.";
  const targetView = state.view === "day" || state.view === "week" ? state.view : "day";
  setActive(targetView);
}

export {
  clearInfoCardLock,
  renderAll,
  renderDay,
  renderMonth,
  renderWeek,
  renderYear,
  setActive,
  startInteractiveCreate,
  updateNowIndicators,
};
