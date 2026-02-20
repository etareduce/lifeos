from __future__ import annotations

import base64
import hashlib
import secrets
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response, status
from fastapi.responses import RedirectResponse
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.config import (
    get_google_oauth_client_id,
    get_google_oauth_client_secret,
    get_google_oauth_redirect_uri,
    get_google_oauth_scopes,
)
from backend.db import get_session
from .google_calendar.adapter import GoogleCalendarAdapter
from .google_calendar.client import GoogleCalendarAPIError, exchange_oauth_code_for_tokens
from .merge import find_recurrence_matches
from .primitives import EventPrimitive, RecurrencePrimitive
from .schemas import (
    GoogleConnectRequest,
    GoogleConnectionStatus,
    GoogleSyncApplyRequest,
    GoogleSyncApplyResponse,
    GoogleSyncPreviewItem,
    GoogleSyncPreviewRequest,
    GoogleSyncPreviewResponse,
    IntegrationCalendarRead,
    MergeCandidatePreview,
    SyncEventPreview,
)
from .utils import DEFAULT_NAME_EDIT_DISTANCE_THRESHOLD
from backend.models import IntegrationConnectionModel, RecurrenceModel
from backend.recurrence_router import (
    _coerce_timerange,
    _exclusion_set,
    _mark_schedule_dirty,
    _normalize_recurrence_type,
    _recurrence_from_payload,
    _recurrence_tzinfo,
)
from core.timerange import TimeRange


integration_router = APIRouter(prefix="/integrations", tags=["integrations"])

PREVIEW_TTL_SECONDS = 15 * 60
MAX_SYNC_PREVIEW_RANGE_DAYS = 90
OAUTH_STATE_TTL_SECONDS = 10 * 60
SYNC_COLOR_SEQUENCE = [
    "sand",
    "sage",
    "mist",
    "clay",
    "moss",
    "coral",
    "sky",
    "violet",
    "teal",
    "lemon",
    "indigo",
    "ruby",
    "mint",
    "slate",
]


@dataclass(slots=True)
class _PreviewItem:
    imported: RecurrencePrimitive
    candidate_ids: list[str] = field(default_factory=list)


@dataclass(slots=True)
class _PreviewSession:
    created_at: datetime
    items: dict[str, _PreviewItem]
    calendar_ids: list[str]


@dataclass(slots=True)
class _OAuthSession:
    created_at: datetime
    code_verifier: str
    return_to: str


_PREVIEW_SESSIONS: dict[str, _PreviewSession] = {}
_OAUTH_SESSIONS: dict[str, _OAuthSession] = {}


@integration_router.get(
    "/google/status",
    response_model=GoogleConnectionStatus,
    operation_id="google_integration_status",
)
async def google_status(
    session: AsyncSession = Depends(get_session),
) -> GoogleConnectionStatus:
    connection = await _get_google_connection(session)
    if connection is None:
        return GoogleConnectionStatus(connected=False)
    return GoogleConnectionStatus(
        connected=True,
        account_id=connection.account_id,
        account_name=connection.account_name,
    )


@integration_router.get(
    "/google/oauth/start",
    operation_id="google_oauth_start",
)
async def google_oauth_start(
    request: Request,
    return_to: str | None = Query(default=None),
) -> RedirectResponse:
    safe_return_to = _sanitize_return_to(return_to)
    client_id = get_google_oauth_client_id().strip()
    client_secret = get_google_oauth_client_secret().strip()
    if not client_id or not client_secret:
        return RedirectResponse(
            _oauth_result_redirect(
                safe_return_to,
                status_value="error",
                message=(
                    "Google OAuth is not configured. "
                    "Set GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET."
                ),
            ),
            status_code=status.HTTP_302_FOUND,
        )

    redirect_uri = _resolve_oauth_redirect_uri(request)
    state = secrets.token_urlsafe(32)
    code_verifier = secrets.token_urlsafe(64)
    code_challenge = _pkce_challenge(code_verifier)
    _cleanup_oauth_sessions()
    _OAUTH_SESSIONS[state] = _OAuthSession(
        created_at=datetime.now(tz=timezone.utc),
        code_verifier=code_verifier,
        return_to=safe_return_to,
    )

    auth_query = urlencode(
        {
            "client_id": client_id,
            "redirect_uri": redirect_uri,
            "response_type": "code",
            "scope": get_google_oauth_scopes(),
            "access_type": "offline",
            "include_granted_scopes": "true",
            "prompt": "consent",
            "state": state,
            "code_challenge": code_challenge,
            "code_challenge_method": "S256",
        }
    )
    return RedirectResponse(
        url=f"https://accounts.google.com/o/oauth2/v2/auth?{auth_query}",
        status_code=status.HTTP_302_FOUND,
    )


@integration_router.get(
    "/google/oauth/callback",
    include_in_schema=False,
)
async def google_oauth_callback(
    request: Request,
    code: str | None = None,
    state: str | None = None,
    error: str | None = None,
    error_description: str | None = None,
    session: AsyncSession = Depends(get_session),
) -> RedirectResponse:
    oauth_session = _OAUTH_SESSIONS.pop(state or "", None)
    return_to = oauth_session.return_to if oauth_session else "/ui"

    if error:
        return RedirectResponse(
            _oauth_result_redirect(
                return_to,
                status_value="error",
                message=error_description or error,
            ),
            status_code=status.HTTP_302_FOUND,
        )
    if state is None or oauth_session is None:
        return RedirectResponse(
            _oauth_result_redirect(
                "/ui",
                status_value="error",
                message="Invalid or expired OAuth state.",
            ),
            status_code=status.HTTP_302_FOUND,
        )
    age_seconds = (datetime.now(tz=timezone.utc) - oauth_session.created_at).total_seconds()
    if age_seconds > OAUTH_STATE_TTL_SECONDS:
        return RedirectResponse(
            _oauth_result_redirect(
                return_to,
                status_value="error",
                message="Google sign-in expired. Please try again.",
            ),
            status_code=status.HTTP_302_FOUND,
        )
    if not code:
        return RedirectResponse(
            _oauth_result_redirect(
                return_to,
                status_value="error",
                message="Google sign-in did not return an authorization code.",
            ),
            status_code=status.HTTP_302_FOUND,
        )

    redirect_uri = _resolve_oauth_redirect_uri(request)
    try:
        token_payload = await exchange_oauth_code_for_tokens(
            code=code,
            client_id=get_google_oauth_client_id().strip(),
            client_secret=get_google_oauth_client_secret().strip(),
            redirect_uri=redirect_uri,
            code_verifier=oauth_session.code_verifier,
        )
    except GoogleCalendarAPIError as exc:
        return RedirectResponse(
            _oauth_result_redirect(
                return_to,
                status_value="error",
                message=f"Google token exchange failed: {exc}",
            ),
            status_code=status.HTTP_302_FOUND,
        )
    access_token = str(token_payload.get("access_token") or "").strip()
    if not access_token:
        return RedirectResponse(
            _oauth_result_redirect(
                return_to,
                status_value="error",
                message="Google token response did not contain an access token.",
            ),
            status_code=status.HTTP_302_FOUND,
        )

    adapter = GoogleCalendarAdapter(access_token)
    try:
        account = await adapter.get_account_info()
    except GoogleCalendarAPIError as exc:
        return RedirectResponse(
            _oauth_result_redirect(
                return_to,
                status_value="error",
                message=f"Unable to read Google account profile: {exc}",
            ),
            status_code=status.HTTP_302_FOUND,
        )
    finally:
        await adapter.aclose()

    account_id = str(account.get("email") or account.get("id") or "").strip() or None
    account_name = str(account.get("name") or "").strip() or account_id
    refresh_token = str(token_payload.get("refresh_token") or "").strip() or None
    try:
        expires_in = int(token_payload.get("expires_in") or 0)
    except (TypeError, ValueError):
        expires_in = 0
    expires_at = (
        (datetime.now(tz=timezone.utc) + timedelta(seconds=expires_in)).isoformat()
        if expires_in > 0
        else None
    )

    connection = await _get_google_connection(session)
    existing_metadata = dict(connection.metadata_json or {}) if connection else {}
    existing_oauth = (
        dict(existing_metadata.get("oauth") or {})
        if isinstance(existing_metadata.get("oauth"), dict)
        else {}
    )
    if not refresh_token:
        refresh_token = str(existing_oauth.get("refresh_token") or "").strip() or None

    metadata_json = {
        **existing_metadata,
        "account": account,
        "oauth": {
            "refresh_token": refresh_token,
            "token_type": token_payload.get("token_type"),
            "scope": token_payload.get("scope"),
            "expires_at": expires_at,
        },
    }
    if connection is None:
        connection = IntegrationConnectionModel(
            provider="google",
            account_id=account_id,
            account_name=account_name,
            access_token=access_token,
            metadata_json=metadata_json,
        )
        session.add(connection)
    else:
        connection.account_id = account_id
        connection.account_name = account_name
        connection.access_token = access_token
        connection.metadata_json = metadata_json
    await session.commit()

    return RedirectResponse(
        _oauth_result_redirect(return_to, status_value="success", message=None),
        status_code=status.HTTP_302_FOUND,
    )


@integration_router.post(
    "/google/connect",
    response_model=GoogleConnectionStatus,
    operation_id="google_connect_account",
)
async def connect_google_account(
    payload: GoogleConnectRequest,
    session: AsyncSession = Depends(get_session),
) -> GoogleConnectionStatus:
    token = payload.access_token.strip()
    adapter = GoogleCalendarAdapter(token)
    try:
        account = await adapter.get_account_info()
    except GoogleCalendarAPIError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Unable to connect Google account: {exc}",
        ) from exc
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"Google connection failed: {exc}",
        ) from exc
    finally:
        await adapter.aclose()
    account_id = str(account.get("email") or account.get("id") or "").strip() or None
    account_name = str(account.get("name") or "").strip() or account_id
    connection = await _get_google_connection(session)
    if connection is None:
        connection = IntegrationConnectionModel(
            provider="google",
            account_id=account_id,
            account_name=account_name,
            access_token=token,
            metadata_json={"account": account},
        )
        session.add(connection)
    else:
        connection.account_id = account_id
        connection.account_name = account_name
        connection.access_token = token
        connection.metadata_json = {"account": account}
    await session.commit()
    return GoogleConnectionStatus(
        connected=True,
        account_id=connection.account_id,
        account_name=connection.account_name,
    )


@integration_router.delete(
    "/google/connect",
    status_code=status.HTTP_204_NO_CONTENT,
    response_class=Response,
    operation_id="google_disconnect_account",
)
async def disconnect_google_account(
    session: AsyncSession = Depends(get_session),
) -> Response:
    connection = await _get_google_connection(session)
    if connection is None:
        return Response(status_code=status.HTTP_204_NO_CONTENT)
    await session.delete(connection)
    await session.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@integration_router.get(
    "/google/calendars",
    response_model=list[IntegrationCalendarRead],
    operation_id="google_list_calendars",
)
async def list_google_calendars(
    session: AsyncSession = Depends(get_session),
) -> list[IntegrationCalendarRead]:
    connection = await _require_google_connection(session)
    adapter = GoogleCalendarAdapter(connection.access_token)
    try:
        calendars = await adapter.list_calendars()
    except GoogleCalendarAPIError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Unable to list Google calendars: {exc}",
        ) from exc
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"Google calendar request failed: {exc}",
        ) from exc
    finally:
        await adapter.aclose()
    return [IntegrationCalendarRead.model_validate(item) for item in calendars]


@integration_router.post(
    "/google/preview",
    response_model=GoogleSyncPreviewResponse,
    operation_id="google_preview_sync",
)
async def preview_google_sync(
    payload: GoogleSyncPreviewRequest,
    session: AsyncSession = Depends(get_session),
) -> GoogleSyncPreviewResponse:
    if payload.range_end <= payload.range_start:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="range_end must be after range_start.",
        )
    max_end = payload.range_start + timedelta(days=MAX_SYNC_PREVIEW_RANGE_DAYS)
    bounded_end = payload.range_end if payload.range_end <= max_end else max_end
    connection = await _require_google_connection(session)
    adapter = GoogleCalendarAdapter(connection.access_token)
    try:
        imported = await adapter.list_recurrence_primitives(
            calendar_ids=payload.calendar_ids,
            start=payload.range_start,
            end=bounded_end,
        )
    except GoogleCalendarAPIError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Unable to preview Google sync: {exc}",
        ) from exc
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"Google sync preview failed: {exc}",
        ) from exc
    finally:
        await adapter.aclose()

    existing = await _build_local_recurrence_primitives(
        session=session,
        range_start=payload.range_start,
        range_end=bounded_end,
    )
    preview_items: list[GoogleSyncPreviewItem] = []
    session_items: dict[str, _PreviewItem] = {}
    for imported_recurrence in imported:
        matches = find_recurrence_matches(
            imported_recurrence,
            existing,
            DEFAULT_NAME_EDIT_DISTANCE_THRESHOLD,
        )
        suggested_action = "create"
        if len(matches) == 1:
            suggested_action = "merge"
        elif len(matches) > 1:
            suggested_action = "review"
        item_id = imported_recurrence.key
        candidate_items = [
            MergeCandidatePreview(
                recurrence_id=match.key,
                recurrence_name=match.title,
                event_count=len(match.events),
            )
            for match in matches
        ]
        preview_items.append(
            GoogleSyncPreviewItem(
                item_id=item_id,
                provider="google",
                calendar_id=imported_recurrence.calendar_id,
                calendar_name=imported_recurrence.calendar_name,
                recurrence_name=imported_recurrence.title,
                recurrence_description=imported_recurrence.description,
                event_count=len(imported_recurrence.events),
                suggested_action=suggested_action,
                events=[
                    SyncEventPreview(
                        name=event.name,
                        start=event.default_start,
                        end=event.default_end,
                    )
                    for event in imported_recurrence.events[:8]
                ],
                match_candidates=candidate_items,
            )
        )
        session_items[item_id] = _PreviewItem(
            imported=imported_recurrence,
            candidate_ids=[candidate.recurrence_id for candidate in candidate_items],
        )
    preview_id = str(uuid.uuid4())
    _cleanup_preview_sessions()
    _PREVIEW_SESSIONS[preview_id] = _PreviewSession(
        created_at=datetime.now(tz=timezone.utc),
        items=session_items,
        calendar_ids=payload.calendar_ids,
    )
    return GoogleSyncPreviewResponse(
        preview_id=preview_id,
        name_distance_threshold=DEFAULT_NAME_EDIT_DISTANCE_THRESHOLD,
        calendar_ids=payload.calendar_ids,
        items=preview_items,
    )


@integration_router.post(
    "/google/apply",
    response_model=GoogleSyncApplyResponse,
    operation_id="google_apply_sync",
)
async def apply_google_sync(
    payload: GoogleSyncApplyRequest,
    session: AsyncSession = Depends(get_session),
) -> GoogleSyncApplyResponse:
    preview = _PREVIEW_SESSIONS.get(payload.preview_id)
    if preview is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Sync preview session not found or expired.",
        )
    created_count = 0
    merged_count = 0
    skipped_count = 0
    merge_ids = {
        decision.merge_recurrence_id
        for decision in payload.decisions
        if decision.action == "merge" and decision.merge_recurrence_id
    }
    existing_rows = []
    if merge_ids:
        result = await session.execute(
            select(RecurrenceModel).where(RecurrenceModel.id.in_(merge_ids))
        )
        existing_rows = result.scalars().all()
    existing_by_id = {row.id: row for row in existing_rows}

    for decision in payload.decisions:
        item = preview.items.get(decision.item_id)
        if item is None:
            skipped_count += 1
            continue
        if decision.action == "skip":
            skipped_count += 1
            continue
        if decision.action == "merge":
            target_id = decision.merge_recurrence_id or ""
            if target_id not in item.candidate_ids:
                raise HTTPException(
                    status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                    detail=f"Invalid merge target for item {decision.item_id}.",
                )
            recurrence = existing_by_id.get(target_id)
            if recurrence is None:
                raise HTTPException(
                    status_code=status.HTTP_404_NOT_FOUND,
                    detail=f"Recurrence {target_id} no longer exists.",
                )
            recurrence.payload = _append_integration_link(
                recurrence.payload,
                imported=item.imported,
            )
            merged_count += 1
            continue
        if decision.action == "create":
            recurrence_type, recurrence_payload = _build_recurrence_payload(item.imported)
            session.add(
                RecurrenceModel(
                    id=str(uuid.uuid4()),
                    type=recurrence_type,
                    payload=recurrence_payload,
                )
            )
            created_count += 1
            continue
        skipped_count += 1

    if created_count or merged_count:
        await session.commit()
    if created_count:
        await _mark_schedule_dirty(session)
    _PREVIEW_SESSIONS.pop(payload.preview_id, None)
    return GoogleSyncApplyResponse(
        created_count=created_count,
        merged_count=merged_count,
        skipped_count=skipped_count,
    )


async def _get_google_connection(
    session: AsyncSession,
) -> IntegrationConnectionModel | None:
    result = await session.execute(
        select(IntegrationConnectionModel).where(
            IntegrationConnectionModel.provider == "google"
        )
    )
    return result.scalar_one_or_none()


async def _require_google_connection(session: AsyncSession) -> IntegrationConnectionModel:
    connection = await _get_google_connection(session)
    if connection is None or not connection.access_token:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Google account is not connected.",
        )
    return connection


def _resolve_oauth_redirect_uri(request: Request) -> str:
    configured = get_google_oauth_redirect_uri().strip()
    if configured:
        return configured
    base = str(request.base_url).rstrip("/")
    return f"{base}/integrations/google/oauth/callback"


def _sanitize_return_to(value: str | None) -> str:
    if not value:
        return "/ui"
    try:
        split = urlsplit(value)
    except ValueError:
        return "/ui"
    if split.scheme or split.netloc:
        return "/ui"
    path = split.path or "/ui"
    if not path.startswith("/") or path.startswith("//"):
        return "/ui"
    query = split.query or ""
    fragment = split.fragment or ""
    return urlunsplit(("", "", path, query, fragment))


def _pkce_challenge(code_verifier: str) -> str:
    digest = hashlib.sha256(code_verifier.encode("ascii")).digest()
    return base64.urlsafe_b64encode(digest).rstrip(b"=").decode("ascii")


def _oauth_result_redirect(
    return_to: str,
    *,
    status_value: str,
    message: str | None,
) -> str:
    base = _sanitize_return_to(return_to)
    split = urlsplit(base)
    params = dict(parse_qsl(split.query, keep_blank_values=True))
    params["google_oauth"] = status_value
    if message:
        params["google_oauth_message"] = message
    else:
        params.pop("google_oauth_message", None)
    query = urlencode(params)
    return urlunsplit(("", "", split.path, query, split.fragment))


def _cleanup_preview_sessions() -> None:
    now = datetime.now(tz=timezone.utc)
    stale_ids = [
        key
        for key, value in _PREVIEW_SESSIONS.items()
        if (now - value.created_at).total_seconds() > PREVIEW_TTL_SECONDS
    ]
    for key in stale_ids:
        _PREVIEW_SESSIONS.pop(key, None)


def _cleanup_oauth_sessions() -> None:
    now = datetime.now(tz=timezone.utc)
    stale_ids = [
        key
        for key, value in _OAUTH_SESSIONS.items()
        if (now - value.created_at).total_seconds() > OAUTH_STATE_TTL_SECONDS
    ]
    for key in stale_ids:
        _OAUTH_SESSIONS.pop(key, None)


async def _build_local_recurrence_primitives(
    *,
    session: AsyncSession,
    range_start: datetime,
    range_end: datetime,
) -> list[RecurrencePrimitive]:
    result = await session.execute(select(RecurrenceModel))
    recurrences: list[RecurrencePrimitive] = []
    for row in result.scalars().all():
        payload = row.payload or {}
        recurrence_type = _normalize_recurrence_type(row.type)
        try:
            recurrence_obj = _recurrence_from_payload(recurrence_type, payload)
        except HTTPException:
            continue
        recurrence_tz = _recurrence_tzinfo(recurrence_obj)
        recurrence_range = _coerce_timerange(
            TimeRange(start=range_start, end=range_end), recurrence_tz
        )
        exclusions = _exclusion_set(payload)
        events: list[EventPrimitive] = []
        for blob in recurrence_obj.all_occurrences(recurrence_range):
            sched_start = blob.get_schedulable_timerange().start
            if sched_start.tzinfo is None:
                sched_start = sched_start.replace(tzinfo=timezone.utc)
            if int(sched_start.timestamp()) in exclusions:
                continue
            default_range = blob.get_default_scheduled_timerange()
            title = blob.name or str(payload.get("recurrence_name") or "Untitled event")
            tz_name = blob.tz.key if hasattr(blob.tz, "key") else str(blob.tz or "UTC")
            events.append(
                EventPrimitive(
                    name=title,
                    description=blob.description or payload.get("recurrence_description"),
                    default_start=default_range.start,
                    default_end=default_range.end,
                    timezone=tz_name,
                )
            )
        if not events:
            continue
        recurrence_title = str(payload.get("recurrence_name") or events[0].name or row.id)
        primitive = RecurrencePrimitive(
            key=row.id,
            provider="local",
            calendar_id="local",
            calendar_name="Elastisched",
            title=recurrence_title,
            description=payload.get("recurrence_description"),
            events=events,
        )
        primitive.sort_events()
        recurrences.append(primitive)
    return recurrences


def _build_recurrence_payload(imported: RecurrencePrimitive) -> tuple[str, dict]:
    link = _integration_link(imported)
    color = _color_for_key(imported.key)
    if len(imported.events) == 1:
        event = imported.events[0]
        return "single", {
            "recurrence_name": imported.title,
            "recurrence_description": imported.description,
            "end_date": None,
            "color": color,
            "integration_links": [link],
            "blob": _blob_payload_from_event(event),
        }
    return "multiple", {
        "recurrence_name": imported.title,
        "recurrence_description": imported.description,
        "end_date": None,
        "color": color,
        "integration_links": [link],
        "blobs": [_blob_payload_from_event(event) for event in imported.events],
    }


def _blob_payload_from_event(event: EventPrimitive) -> dict:
    return {
        "name": event.name,
        "description": event.description,
        "tz": event.timezone or "UTC",
        "default_scheduled_timerange": {
            "start": event.default_start.isoformat(),
            "end": event.default_end.isoformat(),
        },
        "schedulable_timerange": {
            "start": event.default_start.isoformat(),
            "end": event.default_end.isoformat(),
        },
        "policy": {},
        "dependencies": [],
        "tags": [],
    }


def _append_integration_link(payload: dict | None, *, imported: RecurrencePrimitive) -> dict:
    next_payload = dict(payload or {})
    links = list(next_payload.get("integration_links") or [])
    link = _integration_link(imported)
    exists = any(
        isinstance(item, dict)
        and item.get("provider") == link["provider"]
        and item.get("calendar_id") == link["calendar_id"]
        and item.get("external_recurrence_id") == link["external_recurrence_id"]
        for item in links
    )
    if not exists:
        links.append(link)
    next_payload["integration_links"] = links
    return next_payload


def _integration_link(imported: RecurrencePrimitive) -> dict:
    return {
        "provider": imported.provider,
        "calendar_id": imported.calendar_id,
        "calendar_name": imported.calendar_name,
        "external_recurrence_id": _external_recurrence_id(imported.key),
        "linked_at": datetime.now(tz=timezone.utc).isoformat(),
    }


def _external_recurrence_id(value: str) -> str:
    if ":" not in value:
        return value
    return value.split(":", 1)[1]


def _color_for_key(value: str) -> str:
    checksum = sum(ord(char) for char in value)
    return SYNC_COLOR_SEQUENCE[checksum % len(SYNC_COLOR_SEQUENCE)]
