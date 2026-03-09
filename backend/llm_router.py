import asyncio
import re
from datetime import datetime, timezone

import httpx
from fastapi import APIRouter, HTTPException, Request, status

from backend.config import (
    get_gemini_api_key,
    get_gemini_http_timeout_seconds,
    get_gemini_model,
    get_llm_recurrence_draft_timeout_seconds,
    get_max_blob_creation_retries,
)
from backend.llm import (
    GeminiProvider,
    Message,
    OpenAPIToolRegistry,
    ToolCallingRuntime,
)
from backend.llm.base import ToolSpec
from backend.preview import build_preview_occurrences
from backend.schemas import (
    LLMChatRequest,
    LLMChatResponse,
    LLMRecurrenceDraftRequest,
    LLMRecurrenceDraftResponse,
    LLMDurationEstimateRequest,
    LLMDurationEstimateResponse,
    PreviewOccurrence,
    RecurrenceCreate,
)


llm_router = APIRouter(prefix="/llm", tags=["llm"])


def _build_gemini_provider(api_key: str) -> GeminiProvider:
    return GeminiProvider(
        api_key=api_key,
        model=get_gemini_model(),
        timeout_seconds=get_gemini_http_timeout_seconds(),
    )


@llm_router.post("/chat", response_model=LLMChatResponse, operation_id="llm_chat")
async def llm_chat(payload: LLMChatRequest, request: Request) -> LLMChatResponse:
    api_key = get_gemini_api_key()
    if not api_key:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="GEMINI_API_KEY is not configured",
        )

    base_url = str(request.base_url).rstrip("/")
    registry = OpenAPIToolRegistry.from_openapi(request.app.openapi(), base_url=base_url)
    provider = _build_gemini_provider(api_key)
    runtime = ToolCallingRuntime(provider, registry, max_steps=payload.max_steps or 6)

    messages = []
    if payload.system:
        messages.append(Message(role="system", content=payload.system))
    messages.append(Message(role="user", content=payload.message))

    try:
        response, _conversation = await runtime.run(messages)
    except httpx.TimeoutException as exc:
        raise HTTPException(
            status_code=status.HTTP_504_GATEWAY_TIMEOUT,
            detail="LLM request timed out. Try a shorter prompt or retry.",
        ) from exc
    except httpx.HTTPError as exc:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="LLM provider request failed.",
        ) from exc
    finally:
        await provider.aclose()
        await registry.aclose()

    return LLMChatResponse(text=response.text, tool_calls=response.tool_calls)


def _format_context(parts) -> str:
    if not parts:
        return ""
    blocks = []
    for idx, part in enumerate(parts, start=1):
        label = part.label or f"Context {idx}"
        blocks.append(f"[{label} | {part.type}]\n{part.content}")
    return "\n\n".join(blocks)


def _normalize_calendar_view_context(raw_calendar_views) -> tuple[dict[str, dict], str]:
    calendar_views_by_id: dict[str, dict] = {}
    for raw_view in raw_calendar_views or []:
        view_id = str(getattr(raw_view, "id", "") or "").strip()
        if not view_id:
            continue
        source = str(getattr(raw_view, "source", "") or "").strip().lower() or "main"
        is_main = bool(getattr(raw_view, "is_main", False)) or view_id == "main" or source == "main"
        normalized = {
            "id": view_id,
            "name": str(getattr(raw_view, "name", "") or view_id).strip() or view_id,
            "source": source,
            "is_main": is_main,
        }
        for key in ("account_key", "account_name", "account_id", "calendar_id"):
            value = str(getattr(raw_view, key, "") or "").strip()
            if value:
                normalized[key] = value
        calendar_views_by_id[view_id] = normalized

    if "main" not in calendar_views_by_id:
        calendar_views_by_id["main"] = {
            "id": "main",
            "name": "Main",
            "source": "main",
            "is_main": True,
        }

    view_lines: list[str] = []
    ordered_ids = sorted(calendar_views_by_id.keys(), key=lambda item: (item != "main", item))
    for view_id in ordered_ids:
        view = calendar_views_by_id[view_id]
        line_parts = [
            f"id={view['id']}",
            f"name={view.get('name')}",
            f"source={view.get('source')}",
            f"is_main={'true' if view.get('is_main') else 'false'}",
        ]
        for key in ("account_key", "account_name", "account_id", "calendar_id"):
            value = view.get(key)
            if value:
                line_parts.append(f"{key}={value}")
        view_lines.append("- " + ", ".join(line_parts))
    return (calendar_views_by_id, "\n".join(view_lines))


def _calendar_strong_aliases(view: dict) -> set[str]:
    aliases: set[str] = set()
    for key in ("name", "calendar_id"):
        value = str(view.get(key) or "").strip().lower()
        if value:
            aliases.add(value)
    return aliases


def _tokenize_lower(value: str) -> list[str]:
    return [token for token in re.split(r"[^a-z0-9]+", value.lower()) if token]


def _match_calendar_view(
    explicit_id: str, explicit_name: str, available_calendar_views_by_id: dict[str, dict]
) -> dict | None:
    if explicit_id:
        matched = available_calendar_views_by_id.get(explicit_id)
        if matched:
            return matched
        if explicit_id == "main":
            return {"id": "main", "is_main": True}

    normalized_name = explicit_name.strip().lower()
    if not normalized_name:
        return None

    query_tokens = set(_tokenize_lower(normalized_name))
    best_view: dict | None = None
    best_score = 0
    tie = False
    for view in available_calendar_views_by_id.values():
        if not isinstance(view, dict):
            continue
        score = 0
        for alias in _calendar_strong_aliases(view):
            if normalized_name == alias:
                score = max(score, 1000 + len(alias))
                continue
            if normalized_name in alias or alias in normalized_name:
                score = max(score, 600 + min(len(alias), len(normalized_name)))
                continue
            alias_tokens = [token for token in _tokenize_lower(alias) if len(token) >= 3]
            if alias_tokens and all(token in query_tokens for token in alias_tokens):
                score = max(score, 200 + sum(len(token) for token in alias_tokens))
        if score > best_score:
            best_score = score
            best_view = view
            tie = False
        elif score == best_score and score > 0:
            tie = True
    if best_score <= 0 or tie:
        return None
    return best_view


def _infer_calendar_view_from_text(
    message: str,
    context_parts,
    available_calendar_views_by_id: dict[str, dict],
) -> dict | None:
    chunks = [str(message or "").strip()]
    for part in context_parts or []:
        content = str(getattr(part, "content", "") or "").strip()
        if content:
            chunks.append(content)
    combined = " ".join(chunk for chunk in chunks if chunk).strip().lower()
    if not combined:
        return None

    text_tokens = set(_tokenize_lower(combined))
    best_view: dict | None = None
    best_score = 0
    tie = False
    for view in available_calendar_views_by_id.values():
        if not isinstance(view, dict) or view.get("is_main"):
            continue
        score = 0
        for alias in _calendar_strong_aliases(view):
            if alias in combined:
                score = max(score, 1000 + len(alias))
                continue
            alias_tokens = [token for token in _tokenize_lower(alias) if len(token) >= 3]
            if alias_tokens and all(token in text_tokens for token in alias_tokens):
                score = max(score, 200 + sum(len(token) for token in alias_tokens))
        if score > best_score:
            best_score = score
            best_view = view
            tie = False
        elif score == best_score and score > 0:
            tie = True
    if best_score <= 0 or tie:
        return None
    return dict(best_view)


def _normalize_llm_recurrence(
    recurrence: RecurrenceCreate,
    user_timezone: str,
    fallback_name: str,
    available_calendar_views_by_id: dict[str, dict] | None = None,
    inferred_calendar_view: dict | None = None,
) -> RecurrenceCreate:
    payload = dict(recurrence.payload or {})
    recurrence_name = payload.get("recurrence_name")
    recurrence_description = payload.get("recurrence_description")
    available_calendar_views_by_id = available_calendar_views_by_id or {}

    def _apply_blob_defaults(blob: dict) -> dict:
        if not isinstance(blob, dict):
            return blob
        if not blob.get("tz") and user_timezone:
            blob["tz"] = user_timezone
        if not blob.get("name"):
            blob["name"] = recurrence_name or fallback_name
        if not blob.get("description") and recurrence_description:
            blob["description"] = recurrence_description
        policy = blob.get("policy")
        if isinstance(policy, dict) and policy.get("is_splittable"):
            if not policy.get("max_splits"):
                policy["max_splits"] = 1
            if not (
                policy.get("min_split_duration_seconds")
                or policy.get("min_split_duration")
            ):
                policy["min_split_duration_seconds"] = 15 * 60
            blob["policy"] = policy
        return blob

    if recurrence.type == "multiple":
        if "blobs" not in payload:
            if "blob" in payload:
                payload["blobs"] = [_apply_blob_defaults(payload.pop("blob"))]
            elif {"default_scheduled_timerange", "schedulable_timerange"}.issubset(payload):
                payload = {"blobs": [_apply_blob_defaults(payload)]}
        if "blobs" in payload:
            payload["blobs"] = [_apply_blob_defaults(blob) for blob in payload.get("blobs") or []]
    if recurrence.type == "single":
        if "blob" not in payload and {
            "default_scheduled_timerange",
            "schedulable_timerange",
        }.issubset(payload):
            payload = {"blob": _apply_blob_defaults(payload)}
        if "blob" in payload:
            payload["blob"] = _apply_blob_defaults(payload.get("blob"))
    if recurrence.type == "delta":
        if "start_blob" not in payload and "blob" in payload:
            payload["start_blob"] = payload.pop("blob")
        if "start_blob" in payload:
            payload["start_blob"] = _apply_blob_defaults(payload.get("start_blob"))
    if recurrence.type == "weekly":
        if "blobs_of_week" not in payload:
            if "blob" in payload:
                payload["blobs_of_week"] = [payload.pop("blob")]
            elif "blobs" in payload:
                payload["blobs_of_week"] = payload.pop("blobs")
            elif {"default_scheduled_timerange", "schedulable_timerange"}.issubset(payload):
                payload = {"blobs_of_week": [payload]}
        if "blobs_of_week" in payload:
            payload["blobs_of_week"] = [
                _apply_blob_defaults(blob) for blob in payload.get("blobs_of_week") or []
            ]

    raw_calendar_view = payload.get("calendar_view")
    if isinstance(raw_calendar_view, dict):
        explicit_id = str(raw_calendar_view.get("id") or "").strip()
        explicit_name = str(raw_calendar_view.get("name") or "").strip().lower()
        matched = _match_calendar_view(
            explicit_id, explicit_name, available_calendar_views_by_id
        )
        if matched and matched.get("is_main"):
            payload.pop("calendar_view", None)
        elif matched:
            payload["calendar_view"] = dict(matched)
        elif inferred_calendar_view:
            payload["calendar_view"] = dict(inferred_calendar_view)
        else:
            payload.pop("calendar_view", None)
    elif inferred_calendar_view:
        payload["calendar_view"] = dict(inferred_calendar_view)
    else:
        payload.pop("calendar_view", None)

    return recurrence.model_copy(update={"payload": payload})


def _validate_llm_recurrences(recurrences: list[RecurrenceCreate]) -> None:
    missing: list[str] = []
    for idx, recurrence in enumerate(recurrences, start=1):
        payload = recurrence.payload or {}
        blobs: list[dict] = []
        if recurrence.type == "weekly":
            blobs = payload.get("blobs_of_week") or []
        elif recurrence.type == "multiple":
            blobs = payload.get("blobs") or []
        elif recurrence.type == "delta":
            blob = payload.get("start_blob")
            if isinstance(blob, dict):
                blobs = [blob]
        else:
            blob = payload.get("blob")
            if isinstance(blob, dict):
                blobs = [blob]
        if not blobs:
            continue
        for blob_idx, blob in enumerate(blobs, start=1):
            if not isinstance(blob, dict):
                missing.append(
                    f"recurrence {idx} ({recurrence.type}) blob {blob_idx} must be an object"
                )
                continue
            default_tr = blob.get("default_scheduled_timerange") or {}
            sched_tr = blob.get("schedulable_timerange") or {}
            if not default_tr.get("start"):
                missing.append(
                    f"recurrence {idx} ({recurrence.type}) blob {blob_idx} missing default_scheduled_timerange.start"
                )
            if not default_tr.get("end"):
                missing.append(
                    f"recurrence {idx} ({recurrence.type}) blob {blob_idx} missing default_scheduled_timerange.end"
                )
            if not sched_tr.get("start"):
                missing.append(
                    f"recurrence {idx} ({recurrence.type}) blob {blob_idx} missing schedulable_timerange.start"
                )
            if not sched_tr.get("end"):
                missing.append(
                    f"recurrence {idx} ({recurrence.type}) blob {blob_idx} missing schedulable_timerange.end"
                )
    if missing:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Missing datetime fields: " + "; ".join(missing),
        )


@llm_router.post(
    "/recurrence-draft",
    response_model=LLMRecurrenceDraftResponse,
    operation_id="llm_recurrence_draft",
)
async def llm_recurrence_draft(
    payload: LLMRecurrenceDraftRequest,
) -> LLMRecurrenceDraftResponse:
    api_key = get_gemini_api_key()
    if not api_key:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="GEMINI_API_KEY is not configured",
        )
    provider = _build_gemini_provider(api_key)
    tool_spec = ToolSpec(
        name="propose_recurrences",
        description="Return draft recurrences for the scheduler.",
        parameters={
            "type": "object",
            "properties": {
                "recurrences": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "type": {"type": "string"},
                            "payload": {"type": "object"},
                        },
                        "required": ["type", "payload"],
                    },
                },
                "notes": {"type": "string"},
            },
            "required": ["recurrences"],
        },
    )
    (calendar_views_by_id, calendar_view_lines) = _normalize_calendar_view_context(
        payload.calendar_views
    )
    system = (
        "You are a scheduling assistant for Elastisched.\n"
        "Use the propose_recurrences tool to return draft recurrences.\n"
        "Supported recurrence types: single, multiple, weekly, delta, date.\n"
        "Each payload must follow Elastisched recurrence payloads. Use ISO-8601 datetimes with timezone offsets.\n"
        "Always include schedulable_timerange and default_scheduled_timerange for blobs.\n"
        "Each timerange must include start and end datetimes.\n"
        "Ensure default_scheduled_timerange is within schedulable_timerange.\n"
        "Provide recurrence_name and recurrence_description when available.\n"
        "Recurrence payload shape by type: single/date -> payload.blob, delta -> payload.start_blob + payload.delta_seconds, "
        "multiple -> payload.blobs, weekly -> payload.blobs_of_week.\n"
        "For weekly recurrences, always use payload.blobs_of_week (never payload.blob or payload.blobs).\n"
        "Blob policies are supported via blob.policy. When a task should be splittable/overlappable/invisible "
        "or rounded, include policy keys: is_splittable, is_overlappable, is_invisible, round_to_granularity, "
        "max_splits, min_split_duration_seconds. If is_splittable is true, set max_splits and min_split_duration_seconds.\n"
        "Supported recurrence-level display keys include color and show_borders_only.\n"
        "Do not include edit-time metadata like starred, stars, unstarred, or exclusions.\n"
        "Optional calendar targeting uses payload.calendar_view.\n"
        "If the user specifies a calendar by name/id, set payload.calendar_view to that exact calendar view.\n"
        "If no calendar is specified or no valid calendar can be matched, default to main by omitting payload.calendar_view.\n"
        "Available calendar views:\n"
        f"{calendar_view_lines}\n"
        "Tags belong in blob.tags as a list of strings (not in description).\n"
        "Set blob.tz to the user timezone.\n"
        f"Current datetime: {datetime.now(timezone.utc).isoformat()} (UTC).\n"
        f"User timezone: {payload.user_timezone}. Project timezone: {payload.project_timezone}.\n"
        f"Round durations to {payload.granularity_minutes} minute increments when estimating."
    )
    context_block = _format_context(payload.context)
    user_lines = [payload.message]
    if context_block:
        user_lines.append("\nAdditional context:\n" + context_block)
    base_messages = [
        Message(role="system", content=system),
        Message(role="user", content="\n".join(user_lines)),
    ]
    inferred_calendar_view = _infer_calendar_view_from_text(
        payload.message,
        payload.context,
        calendar_views_by_id,
    )
    retries = get_max_blob_creation_retries()
    request_timeout_seconds = get_llm_recurrence_draft_timeout_seconds()
    last_error = "LLM did not return a draft recurrence."

    try:
        try:
            async with asyncio.timeout(request_timeout_seconds):
                for attempt in range(retries + 1):
                    messages = list(base_messages)
                    if attempt > 0:
                        messages.append(
                            Message(
                                role="user",
                                content=(
                                    "The previous attempt failed validation with this error:\n"
                                    f"{last_error}\n"
                                    "Please correct the recurrence payloads and try again."
                                ),
                            )
                        )
                    try:
                        response = await provider.generate(messages, [tool_spec])
                    except httpx.TimeoutException as exc:
                        raise HTTPException(
                            status_code=status.HTTP_504_GATEWAY_TIMEOUT,
                            detail="LLM request timed out. Try a shorter prompt or retry.",
                        ) from exc
                    except httpx.HTTPError as exc:
                        raise HTTPException(
                            status_code=status.HTTP_502_BAD_GATEWAY,
                            detail="LLM provider request failed.",
                        ) from exc
                    if not response.tool_calls:
                        last_error = "LLM did not return a draft recurrence."
                        continue
                    call = response.tool_calls[0]
                    raw_recurrences = call.arguments.get("recurrences") or []
                    try:
                        recurrences = []
                        for index, item in enumerate(raw_recurrences, start=1):
                            recurrences.append(
                                _normalize_llm_recurrence(
                                    RecurrenceCreate.model_validate(item),
                                    payload.user_timezone,
                                    f"Draft {index}",
                                    calendar_views_by_id,
                                    inferred_calendar_view,
                                )
                            )
                    except Exception:
                        last_error = "LLM returned invalid recurrence payloads."
                        continue
                    try:
                        _validate_llm_recurrences(recurrences)
                        occurrences = build_preview_occurrences(
                            recurrences, payload.view_start, payload.view_end
                        )
                    except HTTPException as exc:
                        last_error = str(exc.detail)
                        continue
                    preview_occurrences = [
                        PreviewOccurrence.model_validate({**item.model_dump(), "preview": True})
                        for item in occurrences
                    ]
                    notes = call.arguments.get("notes")
                    return LLMRecurrenceDraftResponse(
                        recurrences=recurrences,
                        occurrences=preview_occurrences,
                        notes=notes,
                    )
        except TimeoutError as exc:
            raise HTTPException(
                status_code=status.HTTP_504_GATEWAY_TIMEOUT,
                detail="Draft generation timed out. Try a shorter prompt or retry.",
            ) from exc
    finally:
        await provider.aclose()

    raise HTTPException(
        status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
        detail=last_error,
    )


@llm_router.post(
    "/estimate-duration",
    response_model=LLMDurationEstimateResponse,
    operation_id="llm_estimate_duration",
)
async def llm_estimate_duration(
    payload: LLMDurationEstimateRequest,
) -> LLMDurationEstimateResponse:
    api_key = get_gemini_api_key()
    if not api_key:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="GEMINI_API_KEY is not configured",
        )
    provider = _build_gemini_provider(api_key)
    tool_spec = ToolSpec(
        name="estimate_duration",
        description="Estimate task duration in minutes.",
        parameters={
            "type": "object",
            "properties": {
                "estimated_minutes": {"type": "integer", "minimum": 1},
                "rationale": {"type": "string"},
            },
            "required": ["estimated_minutes"],
        },
    )
    system = (
        "Estimate a realistic duration for the task described.\n"
        "Return only by calling estimate_duration."
    )
    context_block = _format_context(payload.context)
    user_lines = [
        f"Task name: {payload.name}",
        f"Task description: {payload.description or 'None'}",
    ]
    if context_block:
        user_lines.append("\nAdditional context:\n" + context_block)
    user_lines.append(
        f"Round to {payload.granularity_minutes} minute increments."
    )
    messages = [
        Message(role="system", content=system),
        Message(role="user", content="\n".join(user_lines)),
    ]

    try:
        response = await provider.generate(messages, [tool_spec])
    except httpx.TimeoutException as exc:
        raise HTTPException(
            status_code=status.HTTP_504_GATEWAY_TIMEOUT,
            detail="LLM request timed out. Try again.",
        ) from exc
    except httpx.HTTPError as exc:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="LLM provider request failed.",
        ) from exc
    finally:
        await provider.aclose()

    if not response.tool_calls:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="LLM did not return a duration estimate.",
        )
    call = response.tool_calls[0]
    estimated = int(call.arguments.get("estimated_minutes") or 0)
    if estimated <= 0:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="LLM returned an invalid duration.",
        )
    granularity = max(1, payload.granularity_minutes)
    rounded = max(granularity, int(round(estimated / granularity) * granularity))
    return LLMDurationEstimateResponse(
        estimated_minutes=estimated,
        rounded_minutes=rounded,
        rationale=call.arguments.get("rationale"),
    )
