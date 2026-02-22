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
    CalendarViewRead,
    CalendarViewCreateRequest,
    CalendarVisibilityUpdateRequest,
    CopyToMainApplyRequest,
    CopyToMainPreviewItem,
    CopyToMainPreviewResponse,
    CopyToMainResponse,
    GoogleCalendarSelectionUpdateRequest,
    GoogleConnectRequest,
    GoogleConnectedAccountRead,
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
from backend.schemas import RecurrenceRead
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
MAIN_CALENDAR_VIEW_ID = "main"
MAIN_CALENDAR_NAME = "Main calendar"
GOOGLE_PROVIDER = "google"
CUSTOM_PROVIDER = "custom"


@dataclass(slots=True)
class _PreviewItem:
    imported: RecurrencePrimitive
    account_key: str
    account_id: str | None
    account_name: str | None
    calendar_view_id: str
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
    accounts = _get_google_accounts(connection)
    if not accounts:
        return GoogleConnectionStatus(connected=False)
    primary = accounts[0]
    return GoogleConnectionStatus(
        connected=True,
        account_id=primary.get("account_id"),
        account_name=primary.get("account_name"),
        accounts=[
            GoogleConnectedAccountRead(
                id=account["id"],
                account_id=account.get("account_id"),
                account_name=account.get("account_name"),
            )
            for account in accounts
        ],
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

    connection = await _require_google_connection(session)
    metadata_json = dict(connection.metadata_json or {})
    accounts = _get_google_accounts(connection)
    target = None
    if account_id:
        for item in accounts:
            if item.get("account_id") == account_id:
                target = item
                break
    if target is None:
        target = {
            "id": str(uuid.uuid4()),
            "account_id": account_id,
            "account_name": account_name,
        }
        accounts.append(target)
    oauth_payload = dict(target.get("oauth") or {})
    if not refresh_token:
        refresh_token = str(oauth_payload.get("refresh_token") or "").strip() or None
    oauth_payload.update(
        {
            "refresh_token": refresh_token,
            "token_type": token_payload.get("token_type"),
            "scope": token_payload.get("scope"),
            "expires_at": expires_at,
        }
    )
    target.update(
        {
            "account_id": account_id,
            "account_name": account_name,
            "access_token": access_token,
            "oauth": oauth_payload,
            "account": account,
            "updated_at": datetime.now(tz=timezone.utc).isoformat(),
        }
    )
    metadata_json["accounts"] = accounts
    metadata_json["account"] = account
    _set_google_connection_fields(connection, accounts=accounts, metadata_json=metadata_json)
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
    connection = await _ensure_google_connection(session)
    metadata_json = dict(connection.metadata_json or {})
    accounts = _get_google_accounts(connection)
    target = None
    if account_id:
        for item in accounts:
            if item.get("account_id") == account_id:
                target = item
                break
    if target is None:
        target = {
            "id": str(uuid.uuid4()),
            "account_id": account_id,
            "account_name": account_name,
        }
        accounts.append(target)
    target.update(
        {
            "account_id": account_id,
            "account_name": account_name,
            "access_token": token,
            "oauth": dict(target.get("oauth") or {}),
            "account": account,
            "updated_at": datetime.now(tz=timezone.utc).isoformat(),
        }
    )
    metadata_json["accounts"] = accounts
    metadata_json["account"] = account
    _set_google_connection_fields(connection, accounts=accounts, metadata_json=metadata_json)
    await session.commit()
    primary = accounts[0]
    return GoogleConnectionStatus(
        connected=True,
        account_id=primary.get("account_id"),
        account_name=primary.get("account_name"),
        accounts=[
            GoogleConnectedAccountRead(
                id=account_item["id"],
                account_id=account_item.get("account_id"),
                account_name=account_item.get("account_name"),
            )
            for account_item in accounts
        ],
    )


@integration_router.delete(
    "/google/connect",
    status_code=status.HTTP_204_NO_CONTENT,
    response_class=Response,
    operation_id="google_disconnect_account",
)
async def disconnect_google_account(
    account_key: str | None = Query(default=None),
    session: AsyncSession = Depends(get_session),
) -> Response:
    connection = await _get_google_connection(session)
    if connection is None:
        return Response(status_code=status.HTTP_204_NO_CONTENT)
    accounts = _get_google_accounts(connection)
    if not accounts:
        await session.delete(connection)
        await session.commit()
        return Response(status_code=status.HTTP_204_NO_CONTENT)

    if account_key:
        removed_ids = {account_key}
        accounts = [item for item in accounts if item["id"] != account_key]
    else:
        removed_ids = {item["id"] for item in accounts}
        accounts = []

    removed_count = 0
    if removed_ids:
        result = await session.execute(select(RecurrenceModel))
        for recurrence in result.scalars().all():
            source = _integration_source(recurrence.payload)
            if not source:
                continue
            if source.get("provider") != GOOGLE_PROVIDER:
                continue
            if source.get("account_key") not in removed_ids:
                continue
            await session.delete(recurrence)
            removed_count += 1

    metadata_json = dict(connection.metadata_json or {})
    metadata_json["accounts"] = accounts
    visibility = _get_calendar_visibility_map(connection)
    if visibility:
        filtered = {
            key: value
            for key, value in visibility.items()
            if _calendar_view_account_key(key) not in removed_ids
        }
        metadata_json["calendar_visibility"] = filtered
    selection_map = _get_google_calendar_selection_map(connection)
    if selection_map:
        filtered_selection = {
            key: value
            for key, value in selection_map.items()
            if _calendar_view_account_key(key) not in removed_ids
        }
        metadata_json["google_calendar_selection"] = filtered_selection
    custom_calendars = _get_custom_calendars(connection)
    keep_connection = bool(accounts or custom_calendars)
    if keep_connection:
        _set_google_connection_fields(
            connection,
            accounts=accounts,
            metadata_json=metadata_json,
        )
    else:
        await session.delete(connection)
    await session.commit()
    if removed_count:
        await _mark_schedule_dirty(session)
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
    accounts = _get_google_accounts(connection)
    selection_map = _get_google_calendar_selection_map(connection)
    calendars: list[IntegrationCalendarRead] = []
    for account in accounts:
        access_token = str(account.get("access_token") or "").strip()
        account_key = account["id"]
        if not access_token:
            continue
        adapter = GoogleCalendarAdapter(access_token)
        try:
            account_calendars = await adapter.list_calendars()
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
        for item in account_calendars:
            calendar_id = str(item.get("id") or "").strip()
            if not calendar_id:
                continue
            view_id = _calendar_view_id(
                provider=GOOGLE_PROVIDER,
                account_key=account_key,
                calendar_id=calendar_id,
            )
            calendars.append(
                IntegrationCalendarRead(
                    id=view_id,
                    calendar_id=calendar_id,
                    account_key=account_key,
                    account_id=account.get("account_id"),
                    account_name=account.get("account_name"),
                    name=str(item.get("name") or calendar_id),
                    description=item.get("description"),
                    time_zone=str(item.get("time_zone") or "UTC"),
                    primary=bool(item.get("primary")),
                    selected=selection_map.get(view_id, True),
                    access_role=str(item.get("access_role") or "reader"),
                )
            )
    calendars.sort(
        key=lambda item: (
            (item.account_name or "").lower(),
            item.name.lower(),
            item.calendar_id.lower(),
        )
    )
    return calendars


@integration_router.put(
    "/google/calendars/{calendar_view_id}/selection",
    response_model=IntegrationCalendarRead,
    operation_id="google_set_calendar_selection",
)
async def set_google_calendar_selection(
    calendar_view_id: str,
    payload: GoogleCalendarSelectionUpdateRequest,
    session: AsyncSession = Depends(get_session),
) -> IntegrationCalendarRead:
    selector = _parse_calendar_view_id(calendar_view_id)
    if not selector:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Invalid calendar id.",
        )
    provider, _, _ = selector
    if provider != GOOGLE_PROVIDER:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Selection is only supported for Google calendars.",
        )

    connection = await _ensure_google_connection(session)
    metadata_json = dict(connection.metadata_json or {})
    selection_map = _get_google_calendar_selection_map(connection)
    selection_map[calendar_view_id] = bool(payload.selected)
    metadata_json["google_calendar_selection"] = selection_map
    _set_google_connection_fields(
        connection,
        accounts=_get_google_accounts(connection),
        metadata_json=metadata_json,
    )
    await session.commit()

    calendars = await list_google_calendars(session)
    for item in calendars:
        if item.id == calendar_view_id:
            return item
    raise HTTPException(
        status_code=status.HTTP_404_NOT_FOUND,
        detail="Google calendar not found.",
    )


@integration_router.get(
    "/calendars",
    response_model=list[CalendarViewRead],
    operation_id="list_calendar_views",
)
async def list_calendar_views(
    session: AsyncSession = Depends(get_session),
) -> list[CalendarViewRead]:
    result = await session.execute(select(RecurrenceModel))
    recurrences = result.scalars().all()
    google_connection = await _get_google_connection(session)
    visibility = _get_calendar_visibility_map(google_connection)
    custom_calendars = _get_custom_calendars(google_connection)

    views: dict[str, CalendarViewRead] = {
        MAIN_CALENDAR_VIEW_ID: CalendarViewRead(
            id=MAIN_CALENDAR_VIEW_ID,
            name=MAIN_CALENDAR_NAME,
            source="main",
            is_main=True,
            visible=True,
            recurrence_count=0,
        )
    }
    for recurrence in recurrences:
        payload = recurrence.payload or {}
        if _is_main_calendar_payload(payload):
            views[MAIN_CALENDAR_VIEW_ID].recurrence_count += 1
            continue
        calendar_view = _calendar_view_from_payload(payload)
        if not calendar_view:
            continue
        view_id = str(calendar_view.get("id") or "").strip()
        if not view_id:
            continue
        if view_id not in views:
            views[view_id] = CalendarViewRead(
                id=view_id,
                name=str(calendar_view.get("name") or view_id),
                source=str(calendar_view.get("source") or GOOGLE_PROVIDER),
                is_main=False,
                visible=visibility.get(view_id, True),
                account_key=calendar_view.get("account_key"),
                account_name=calendar_view.get("account_name"),
                calendar_id=calendar_view.get("calendar_id"),
                recurrence_count=0,
            )
        views[view_id].recurrence_count += 1
    for calendar in custom_calendars:
        calendar_id = calendar["id"]
        if calendar_id in views:
            continue
        views[calendar_id] = CalendarViewRead(
            id=calendar_id,
            name=calendar["name"],
            source=CUSTOM_PROVIDER,
            is_main=False,
            visible=visibility.get(calendar_id, True),
            recurrence_count=0,
        )

    ordered = [views[MAIN_CALENDAR_VIEW_ID]]
    ordered.extend(
        sorted(
            (item for key, item in views.items() if key != MAIN_CALENDAR_VIEW_ID),
            key=lambda item: ((item.account_name or "").lower(), item.name.lower(), item.id),
        )
    )
    return ordered


@integration_router.post(
    "/calendars/custom",
    response_model=CalendarViewRead,
    operation_id="create_custom_calendar_view",
)
async def create_custom_calendar_view(
    payload: CalendarViewCreateRequest,
    session: AsyncSession = Depends(get_session),
) -> CalendarViewRead:
    connection = await _ensure_google_connection(session)
    metadata_json = dict(connection.metadata_json or {})
    calendars = _get_custom_calendars(connection)
    base_name = payload.name.strip()
    duplicate = next((item for item in calendars if item["name"].lower() == base_name.lower()), None)
    if duplicate:
        return CalendarViewRead(
            id=duplicate["id"],
            name=duplicate["name"],
            source=CUSTOM_PROVIDER,
            is_main=False,
            visible=True,
        )
    calendar_id = f"{CUSTOM_PROVIDER}:{uuid.uuid4()}"
    calendars.append({"id": calendar_id, "name": base_name})
    metadata_json["custom_calendars"] = calendars
    visibility = _get_calendar_visibility_map(connection)
    visibility.setdefault(calendar_id, True)
    metadata_json["calendar_visibility"] = visibility
    _set_google_connection_fields(
        connection,
        accounts=_get_google_accounts(connection),
        metadata_json=metadata_json,
    )
    await session.commit()
    return CalendarViewRead(
        id=calendar_id,
        name=base_name,
        source=CUSTOM_PROVIDER,
        is_main=False,
        visible=True,
        recurrence_count=0,
    )


@integration_router.put(
    "/calendars/{calendar_view_id}/visibility",
    response_model=CalendarViewRead,
    operation_id="set_calendar_visibility",
)
async def set_calendar_visibility(
    calendar_view_id: str,
    payload: CalendarVisibilityUpdateRequest,
    session: AsyncSession = Depends(get_session),
) -> CalendarViewRead:
    if calendar_view_id == MAIN_CALENDAR_VIEW_ID:
        if not payload.visible:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="Main calendar visibility cannot be disabled.",
            )
        return CalendarViewRead(
            id=MAIN_CALENDAR_VIEW_ID,
            name=MAIN_CALENDAR_NAME,
            source="main",
            is_main=True,
            visible=True,
        )
    connection = await _ensure_google_connection(session)
    metadata_json = dict(connection.metadata_json or {})
    visibility = _get_calendar_visibility_map(connection)
    visibility[calendar_view_id] = bool(payload.visible)
    metadata_json["calendar_visibility"] = visibility
    _set_google_connection_fields(
        connection,
        accounts=_get_google_accounts(connection),
        metadata_json=metadata_json,
    )
    await session.commit()
    views = await list_calendar_views(session)
    for item in views:
        if item.id == calendar_view_id:
            return item
    return CalendarViewRead(
        id=calendar_view_id,
        name=calendar_view_id,
        source="unknown",
        visible=bool(payload.visible),
    )


@integration_router.delete(
    "/calendars/{calendar_view_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    response_class=Response,
    operation_id="delete_calendar_view",
)
async def delete_calendar_view(
    calendar_view_id: str,
    session: AsyncSession = Depends(get_session),
) -> Response:
    if calendar_view_id == MAIN_CALENDAR_VIEW_ID:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Main calendar cannot be deleted.",
        )
    connection = await _get_google_connection(session)
    custom_calendars = _get_custom_calendars(connection)
    custom_removed = len([item for item in custom_calendars if item["id"] == calendar_view_id]) > 0
    next_custom_calendars = [item for item in custom_calendars if item["id"] != calendar_view_id]

    result = await session.execute(select(RecurrenceModel))
    deleted_count = 0
    for recurrence in result.scalars().all():
        if _calendar_view_id_from_payload(recurrence.payload) != calendar_view_id:
            continue
        await session.delete(recurrence)
        deleted_count += 1

    had_visibility = False
    had_selection = False
    if connection is not None:
        metadata_json = dict(connection.metadata_json or {})
        visibility = _get_calendar_visibility_map(connection)
        if calendar_view_id in visibility:
            had_visibility = True
            visibility.pop(calendar_view_id, None)
            metadata_json["calendar_visibility"] = visibility
        selection_map = _get_google_calendar_selection_map(connection)
        if calendar_view_id in selection_map:
            had_selection = True
            selection_map.pop(calendar_view_id, None)
            metadata_json["google_calendar_selection"] = selection_map
        metadata_json["custom_calendars"] = next_custom_calendars
        accounts = _get_google_accounts(connection)
        if accounts or next_custom_calendars:
            _set_google_connection_fields(
                connection,
                accounts=accounts,
                metadata_json=metadata_json,
            )
        else:
            await session.delete(connection)

    if not (deleted_count or custom_removed or had_visibility or had_selection):
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Calendar view not found.",
        )

    await session.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


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
    accounts = _get_google_accounts(connection)
    accounts_by_id = {account["id"]: account for account in accounts}
    calendar_ids = payload.calendar_ids or []
    account_calendar_ids: dict[str, list[str]] = {}
    for calendar_view_id in calendar_ids:
        selector = _parse_calendar_view_id(calendar_view_id)
        if not selector:
            continue
        provider, account_key, calendar_id = selector
        if provider != GOOGLE_PROVIDER:
            continue
        if account_key not in accounts_by_id:
            continue
        account_calendar_ids.setdefault(account_key, []).append(calendar_id)

    imported_items: list[tuple[dict, str, RecurrencePrimitive]] = []
    for account_key, selected_calendar_ids in account_calendar_ids.items():
        account = accounts_by_id[account_key]
        access_token = str(account.get("access_token") or "").strip()
        if not access_token or not selected_calendar_ids:
            continue
        adapter = GoogleCalendarAdapter(access_token)
        try:
            imported = await adapter.list_recurrence_primitives(
                calendar_ids=selected_calendar_ids,
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
        for recurrence in imported:
            imported_items.append(
                (
                    account,
                    _calendar_view_id(
                        provider=GOOGLE_PROVIDER,
                        account_key=account_key,
                        calendar_id=recurrence.calendar_id,
                    ),
                    recurrence,
                )
            )

    existing = await _build_local_recurrence_primitives(
        session=session,
        range_start=payload.range_start,
        range_end=bounded_end,
        include_imported=False,
    )
    preview_items: list[GoogleSyncPreviewItem] = []
    session_items: dict[str, _PreviewItem] = {}
    for account, calendar_view_id, imported_recurrence in imported_items:
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
        account_key = str(account.get("id") or "")
        item_id = f"{account_key}:{imported_recurrence.key}"
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
                account_key=account_key,
                account_name=account.get("account_name"),
                calendar_view_id=calendar_view_id,
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
            account_key=account_key,
            account_id=account.get("account_id"),
            account_name=account.get("account_name"),
            calendar_view_id=calendar_view_id,
            candidate_ids=[candidate.recurrence_id for candidate in candidate_items],
        )
    preview_id = str(uuid.uuid4())
    _cleanup_preview_sessions()
    _PREVIEW_SESSIONS[preview_id] = _PreviewSession(
        created_at=datetime.now(tz=timezone.utc),
        items=session_items,
        calendar_ids=calendar_ids,
    )
    return GoogleSyncPreviewResponse(
        preview_id=preview_id,
        name_distance_threshold=DEFAULT_NAME_EDIT_DISTANCE_THRESHOLD,
        calendar_ids=calendar_ids,
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
    deleted_count = 0
    selected_calendar_ids = set(preview.calendar_ids or [])
    result = await session.execute(select(RecurrenceModel))
    existing_rows = result.scalars().all()
    existing_imported = {
        _integration_source_key(_integration_source(row.payload)): row
        for row in existing_rows
        if _is_imported_google_recurrence(row.payload)
        and _calendar_view_id_from_payload(row.payload) in selected_calendar_ids
        and _integration_source_key(_integration_source(row.payload)) is not None
    }
    touched_source_keys: set[tuple[str, str, str, str]] = set()

    for decision in payload.decisions:
        item = preview.items.get(decision.item_id)
        if item is None:
            skipped_count += 1
            continue
        if decision.action == "skip":
            skipped_count += 1
            continue
        recurrence_type, recurrence_payload = _build_recurrence_payload(
            item.imported,
            account_key=item.account_key,
            account_id=item.account_id,
            account_name=item.account_name,
            calendar_view_id=item.calendar_view_id,
        )
        source_key = _integration_source_key(_integration_source(recurrence_payload))
        if source_key is None:
            skipped_count += 1
            continue
        touched_source_keys.add(source_key)
        existing = existing_imported.get(source_key)
        if existing is None:
            session.add(
                RecurrenceModel(
                    id=str(uuid.uuid4()),
                    type=recurrence_type,
                    payload=recurrence_payload,
                )
            )
            created_count += 1
            continue
        existing.type = recurrence_type
        existing.payload = recurrence_payload
        merged_count += 1

    for source_key, recurrence in existing_imported.items():
        if source_key in touched_source_keys:
            continue
        await session.delete(recurrence)
        deleted_count += 1

    if created_count or merged_count or deleted_count:
        await session.commit()
    _PREVIEW_SESSIONS.pop(payload.preview_id, None)
    return GoogleSyncApplyResponse(
        created_count=created_count,
        merged_count=merged_count,
        skipped_count=skipped_count,
        deleted_count=deleted_count,
    )


@integration_router.post(
    "/calendars/{calendar_view_id}/copy-to-main/preview",
    response_model=CopyToMainPreviewResponse,
    operation_id="preview_copy_calendar_to_main",
)
async def preview_copy_calendar_to_main(
    calendar_view_id: str,
    session: AsyncSession = Depends(get_session),
) -> CopyToMainPreviewResponse:
    if calendar_view_id == MAIN_CALENDAR_VIEW_ID:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Main calendar is already the ground-truth calendar.",
        )
    rows = await _calendar_rows_for_view(session, calendar_view_id)
    if not rows:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="No imported recurrences found for that calendar.",
        )

    now = datetime.now(tz=timezone.utc)
    range_start = now - timedelta(days=1)
    range_end = now + timedelta(days=MAX_SYNC_PREVIEW_RANGE_DAYS)
    existing_main = await _build_main_recurrence_primitives(
        session=session,
        range_start=range_start,
        range_end=range_end,
    )

    items: list[CopyToMainPreviewItem] = []
    for row in rows:
        source_payload = dict(row.payload or {})
        imported_primitive = _stored_recurrence_to_primitive(
            recurrence_id=row.id,
            recurrence_type=row.type,
            payload=source_payload,
            range_start=range_start,
            range_end=range_end,
        )
        if imported_primitive is None:
            continue
        matches = find_recurrence_matches(
            imported_primitive,
            existing_main,
            DEFAULT_NAME_EDIT_DISTANCE_THRESHOLD,
        )
        suggested_action = "create"
        if len(matches) == 1:
            suggested_action = "merge"
        elif len(matches) > 1:
            suggested_action = "review"
        items.append(
            CopyToMainPreviewItem(
                recurrence_id=row.id,
                recurrence_name=imported_primitive.title,
                event_count=len(imported_primitive.events),
                suggested_action=suggested_action,
                match_candidates=[
                    MergeCandidatePreview(
                        recurrence_id=match.key,
                        recurrence_name=match.title,
                        event_count=len(match.events),
                    )
                    for match in matches
                ],
            )
        )

    if not items:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="No copyable recurrences found for that calendar.",
        )
    return CopyToMainPreviewResponse(
        calendar_view_id=calendar_view_id,
        calendar_view_name=_calendar_view_name_from_payload(rows[0].payload) or calendar_view_id,
        items=items,
    )


@integration_router.post(
    "/calendars/{calendar_view_id}/copy-to-main/apply",
    response_model=CopyToMainResponse,
    operation_id="apply_copy_calendar_to_main",
)
async def apply_copy_calendar_to_main(
    calendar_view_id: str,
    payload: CopyToMainApplyRequest,
    session: AsyncSession = Depends(get_session),
) -> CopyToMainResponse:
    if calendar_view_id == MAIN_CALENDAR_VIEW_ID:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Main calendar is already the ground-truth calendar.",
        )
    rows = await _calendar_rows_for_view(session, calendar_view_id)
    if not rows:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="No imported recurrences found for that calendar.",
        )
    rows_by_id = {row.id: row for row in rows}

    now = datetime.now(tz=timezone.utc)
    range_start = now - timedelta(days=1)
    range_end = now + timedelta(days=MAX_SYNC_PREVIEW_RANGE_DAYS)
    existing_main_rows = await _main_recurrence_rows(session)
    existing_main_by_id = {row.id: row for row in existing_main_rows}
    existing_main = await _build_main_recurrence_primitives(
        session=session,
        range_start=range_start,
        range_end=range_end,
    )
    imported_cache: dict[str, RecurrencePrimitive] = {}
    created_count = 0
    merged_count = 0
    skipped_count = 0

    for decision in payload.decisions:
        source_row = rows_by_id.get(decision.recurrence_id)
        if source_row is None:
            skipped_count += 1
            continue
        if decision.action == "skip":
            skipped_count += 1
            continue

        imported = imported_cache.get(source_row.id)
        if imported is None:
            imported = _stored_recurrence_to_primitive(
                recurrence_id=source_row.id,
                recurrence_type=source_row.type,
                payload=dict(source_row.payload or {}),
                range_start=range_start,
                range_end=range_end,
            )
            if imported is None:
                skipped_count += 1
                continue
            imported_cache[source_row.id] = imported

        if decision.action == "merge":
            matches = find_recurrence_matches(
                imported,
                existing_main,
                DEFAULT_NAME_EDIT_DISTANCE_THRESHOLD,
            )
            target_id = (decision.merge_recurrence_id or "").strip() or None
            if target_id is None and len(matches) == 1:
                target_id = matches[0].key
            if not target_id:
                skipped_count += 1
                continue
            target_row = existing_main_by_id.get(target_id)
            if target_row is None:
                skipped_count += 1
                continue
            target_row.payload = _append_integration_link(
                target_row.payload,
                imported=imported,
            )
            merged_count += 1
            continue

        if decision.action == "create":
            new_payload = _main_payload_from_imported_payload(dict(source_row.payload or {}))
            new_row = RecurrenceModel(
                id=str(uuid.uuid4()),
                type=source_row.type,
                payload=new_payload,
            )
            session.add(new_row)
            created_count += 1
            continue

        skipped_count += 1

    if created_count or merged_count:
        await session.commit()
        await _mark_schedule_dirty(session)

    return CopyToMainResponse(
        created_count=created_count,
        merged_count=merged_count,
        skipped_count=skipped_count,
    )


@integration_router.post(
    "/calendars/{calendar_view_id}/copy-to-main",
    response_model=CopyToMainResponse,
    operation_id="copy_calendar_to_main",
)
async def copy_calendar_to_main(
    calendar_view_id: str,
    session: AsyncSession = Depends(get_session),
) -> CopyToMainResponse:
    if calendar_view_id == MAIN_CALENDAR_VIEW_ID:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Main calendar is already the ground-truth calendar.",
        )
    rows = await _calendar_rows_for_view(session, calendar_view_id)
    if not rows:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="No imported recurrences found for that calendar.",
        )
    outcome = await _copy_imported_rows_to_main(session=session, rows=rows)
    if outcome["created_count"] or outcome["merged_count"]:
        await _mark_schedule_dirty(session)
    return CopyToMainResponse(**outcome)


@integration_router.post(
    "/recurrences/{recurrence_id}/copy-to-main",
    response_model=CopyToMainResponse,
    operation_id="copy_recurrence_to_main",
)
async def copy_recurrence_to_main(
    recurrence_id: str,
    session: AsyncSession = Depends(get_session),
) -> CopyToMainResponse:
    result = await session.execute(
        select(RecurrenceModel).where(RecurrenceModel.id == recurrence_id)
    )
    recurrence = result.scalar_one_or_none()
    if recurrence is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Recurrence not found.",
        )
    if not _is_non_main_calendar_payload(recurrence.payload):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Only non-main recurrences can be copied to main.",
        )
    outcome = await _copy_imported_rows_to_main(session=session, rows=[recurrence])
    if outcome["created_count"] or outcome["merged_count"]:
        await _mark_schedule_dirty(session)
    return CopyToMainResponse(**outcome)


@integration_router.post(
    "/recurrences/{recurrence_id}/copy-to-calendar/{calendar_view_id}",
    response_model=RecurrenceRead,
    operation_id="copy_recurrence_to_calendar",
)
async def copy_recurrence_to_calendar(
    recurrence_id: str,
    calendar_view_id: str,
    session: AsyncSession = Depends(get_session),
) -> RecurrenceRead:
    if calendar_view_id == MAIN_CALENDAR_VIEW_ID:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Use copy-to-main for the main calendar.",
        )
    connection = await _get_google_connection(session)
    custom_calendar = _custom_calendar_by_id(connection, calendar_view_id)
    if custom_calendar is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Calendar view not found. Create a custom calendar first.",
        )
    result = await session.execute(
        select(RecurrenceModel).where(RecurrenceModel.id == recurrence_id)
    )
    recurrence = result.scalar_one_or_none()
    if recurrence is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Recurrence not found.",
        )
    next_payload = dict(recurrence.payload or {})
    next_payload.pop("integration_source", None)
    next_payload["calendar_view"] = {
        "id": custom_calendar["id"],
        "name": custom_calendar["name"],
        "source": CUSTOM_PROVIDER,
        "is_main": False,
    }
    copied = RecurrenceModel(
        id=str(uuid.uuid4()),
        type=recurrence.type,
        payload=next_payload,
    )
    session.add(copied)
    await session.commit()
    return RecurrenceRead(id=copied.id, type=copied.type, payload=copied.payload)


async def _get_google_connection(
    session: AsyncSession,
) -> IntegrationConnectionModel | None:
    result = await session.execute(
        select(IntegrationConnectionModel).where(
            IntegrationConnectionModel.provider == GOOGLE_PROVIDER
        )
    )
    return result.scalar_one_or_none()


async def _ensure_google_connection(session: AsyncSession) -> IntegrationConnectionModel:
    connection = await _get_google_connection(session)
    if connection is not None:
        return connection
    connection = IntegrationConnectionModel(
        provider=GOOGLE_PROVIDER,
        account_id=None,
        account_name=None,
        access_token="",
        metadata_json={},
    )
    session.add(connection)
    return connection


async def _require_google_connection(session: AsyncSession) -> IntegrationConnectionModel:
    connection = await _get_google_connection(session)
    if connection is None or not _get_google_accounts(connection):
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Google account is not connected.",
        )
    return connection


def _set_google_connection_fields(
    connection: IntegrationConnectionModel,
    *,
    accounts: list[dict],
    metadata_json: dict,
) -> None:
    metadata = dict(metadata_json or {})
    metadata["accounts"] = accounts
    connection.metadata_json = metadata
    if not accounts:
        connection.account_id = None
        connection.account_name = None
        connection.access_token = ""
        return
    primary = accounts[0]
    connection.account_id = primary.get("account_id")
    connection.account_name = primary.get("account_name")
    connection.access_token = str(primary.get("access_token") or "")


def _get_google_accounts(connection: IntegrationConnectionModel | None) -> list[dict]:
    if connection is None:
        return []
    metadata = dict(connection.metadata_json or {})
    raw_accounts = metadata.get("accounts")
    normalized: list[dict] = []
    if isinstance(raw_accounts, list):
        for raw in raw_accounts:
            if not isinstance(raw, dict):
                continue
            account_key = str(raw.get("id") or "").strip()
            if not account_key:
                account_key = str(uuid.uuid4())
            normalized.append(
                {
                    "id": account_key,
                    "account_id": str(raw.get("account_id") or "").strip() or None,
                    "account_name": str(raw.get("account_name") or "").strip() or None,
                    "access_token": str(raw.get("access_token") or "").strip(),
                    "oauth": dict(raw.get("oauth") or {}),
                    "account": dict(raw.get("account") or {}),
                    "updated_at": raw.get("updated_at"),
                }
            )
    if normalized:
        return normalized
    # Backward-compatible single-account record.
    legacy_token = str(connection.access_token or "").strip()
    if not legacy_token:
        return []
    return [
        {
            "id": str(uuid.uuid4()),
            "account_id": connection.account_id,
            "account_name": connection.account_name,
            "access_token": legacy_token,
            "oauth": dict(metadata.get("oauth") or {}),
            "account": dict(metadata.get("account") or {}),
            "updated_at": None,
        }
    ]


def _calendar_view_id(*, provider: str, account_key: str, calendar_id: str) -> str:
    return f"{provider}:{account_key}:{calendar_id}"


def _parse_calendar_view_id(value: str) -> tuple[str, str, str] | None:
    raw = (value or "").strip()
    parts = raw.split(":", 2)
    if len(parts) != 3:
        return None
    provider, account_key, calendar_id = (part.strip() for part in parts)
    if not provider or not account_key or not calendar_id:
        return None
    return provider, account_key, calendar_id


def _calendar_view_account_key(calendar_view_id: str) -> str | None:
    selector = _parse_calendar_view_id(calendar_view_id)
    if not selector:
        return None
    return selector[1]


def _get_calendar_visibility_map(connection: IntegrationConnectionModel | None) -> dict[str, bool]:
    if connection is None:
        return {}
    metadata = dict(connection.metadata_json or {})
    raw = metadata.get("calendar_visibility")
    if not isinstance(raw, dict):
        return {}
    return {str(key): bool(value) for key, value in raw.items()}


def _get_google_calendar_selection_map(
    connection: IntegrationConnectionModel | None,
) -> dict[str, bool]:
    if connection is None:
        return {}
    metadata = dict(connection.metadata_json or {})
    raw = metadata.get("google_calendar_selection")
    if not isinstance(raw, dict):
        return {}
    return {str(key): bool(value) for key, value in raw.items()}


def _get_custom_calendars(connection: IntegrationConnectionModel | None) -> list[dict]:
    if connection is None:
        return []
    metadata = dict(connection.metadata_json or {})
    raw = metadata.get("custom_calendars")
    if not isinstance(raw, list):
        return []
    calendars: list[dict] = []
    for item in raw:
        if not isinstance(item, dict):
            continue
        calendar_id = str(item.get("id") or "").strip()
        name = str(item.get("name") or "").strip()
        if not calendar_id or not name:
            continue
        calendars.append({"id": calendar_id, "name": name})
    return calendars


def _custom_calendar_by_id(
    connection: IntegrationConnectionModel | None, calendar_id: str
) -> dict | None:
    for item in _get_custom_calendars(connection):
        if item["id"] == calendar_id:
            return item
    return None


def _calendar_view_from_payload(payload: dict | None) -> dict | None:
    if not isinstance(payload, dict):
        return None
    raw = payload.get("calendar_view")
    if not isinstance(raw, dict):
        return None
    return raw


def _calendar_view_id_from_payload(payload: dict | None) -> str | None:
    calendar_view = _calendar_view_from_payload(payload)
    if not calendar_view:
        return None
    value = str(calendar_view.get("id") or "").strip()
    return value or None


def _calendar_view_name_from_payload(payload: dict | None) -> str | None:
    calendar_view = _calendar_view_from_payload(payload)
    if not calendar_view:
        return None
    value = str(calendar_view.get("name") or "").strip()
    return value or None


def _integration_source(payload: dict | None) -> dict | None:
    if not isinstance(payload, dict):
        return None
    raw = payload.get("integration_source")
    if not isinstance(raw, dict):
        return None
    provider = str(raw.get("provider") or "").strip().lower()
    if provider != GOOGLE_PROVIDER:
        return None
    account_key = str(raw.get("account_key") or "").strip()
    calendar_id = str(raw.get("calendar_id") or "").strip()
    external_recurrence_id = str(raw.get("external_recurrence_id") or "").strip()
    if not account_key or not calendar_id or not external_recurrence_id:
        return None
    return {
        "provider": GOOGLE_PROVIDER,
        "account_key": account_key,
        "calendar_id": calendar_id,
        "external_recurrence_id": external_recurrence_id,
        "account_id": raw.get("account_id"),
        "account_name": raw.get("account_name"),
        "calendar_name": raw.get("calendar_name"),
    }


def _integration_source_key(source: dict | None) -> tuple[str, str, str, str] | None:
    if not source:
        return None
    return (
        str(source.get("provider") or ""),
        str(source.get("account_key") or ""),
        str(source.get("calendar_id") or ""),
        str(source.get("external_recurrence_id") or ""),
    )


def _is_imported_google_recurrence(payload: dict | None) -> bool:
    return _integration_source(payload) is not None


def _is_main_calendar_payload(payload: dict | None) -> bool:
    if not isinstance(payload, dict):
        return True
    calendar_view = payload.get("calendar_view")
    if isinstance(calendar_view, dict):
        if "is_main" in calendar_view:
            return bool(calendar_view.get("is_main"))
        return False
    return _integration_source(payload) is None


def _is_non_main_calendar_payload(payload: dict | None) -> bool:
    return not _is_main_calendar_payload(payload)


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


async def _calendar_rows_for_view(
    session: AsyncSession,
    calendar_view_id: str,
) -> list[RecurrenceModel]:
    result = await session.execute(select(RecurrenceModel))
    return [
        row
        for row in result.scalars().all()
        if _is_non_main_calendar_payload(row.payload)
        and _calendar_view_id_from_payload(row.payload) == calendar_view_id
    ]


async def _main_recurrence_rows(session: AsyncSession) -> list[RecurrenceModel]:
    result = await session.execute(select(RecurrenceModel))
    return [
        row for row in result.scalars().all() if _is_main_calendar_payload(row.payload)
    ]


async def _build_local_recurrence_primitives(
    *,
    session: AsyncSession,
    range_start: datetime,
    range_end: datetime,
    include_imported: bool = True,
) -> list[RecurrencePrimitive]:
    result = await session.execute(select(RecurrenceModel))
    recurrences: list[RecurrencePrimitive] = []
    for row in result.scalars().all():
        payload = row.payload or {}
        if not include_imported and _is_imported_google_recurrence(payload):
            continue
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
            identifiers=_recurrence_identifiers_from_payload(payload, fallback=row.id),
            events=events,
        )
        primitive.sort_events()
        recurrences.append(primitive)
    return recurrences


async def _build_main_recurrence_primitives(
    *,
    session: AsyncSession,
    range_start: datetime,
    range_end: datetime,
) -> list[RecurrencePrimitive]:
    result = await session.execute(select(RecurrenceModel))
    recurrences: list[RecurrencePrimitive] = []
    for row in result.scalars().all():
        payload = row.payload or {}
        if not _is_main_calendar_payload(payload):
            continue
        primitive = _stored_recurrence_to_primitive(
            recurrence_id=row.id,
            recurrence_type=row.type,
            payload=payload,
            range_start=range_start,
            range_end=range_end,
        )
        if primitive is None:
            continue
        primitive.key = row.id
        recurrences.append(primitive)
    return recurrences


def _build_recurrence_payload(
    imported: RecurrencePrimitive,
    *,
    account_key: str,
    account_id: str | None,
    account_name: str | None,
    calendar_view_id: str,
) -> tuple[str, dict]:
    link = _integration_link(
        imported,
        account_key=account_key,
        account_id=account_id,
        account_name=account_name,
    )
    color = _color_for_key(imported.key)
    common_payload = {
        "recurrence_name": imported.title,
        "recurrence_description": imported.description,
        "end_date": None,
        "color": color,
        "integration_links": [link],
        "integration_source": {
            "provider": GOOGLE_PROVIDER,
            "account_key": account_key,
            "account_id": account_id,
            "account_name": account_name,
            "calendar_id": imported.calendar_id,
            "calendar_name": imported.calendar_name,
            "external_recurrence_id": _external_recurrence_id(imported.key),
            "external_key": imported.key,
            "synced_at": datetime.now(tz=timezone.utc).isoformat(),
        },
        "calendar_view": {
            "id": calendar_view_id,
            "name": f"{account_name or account_id or 'Google'} · {imported.calendar_name}",
            "source": GOOGLE_PROVIDER,
            "account_key": account_key,
            "account_id": account_id,
            "account_name": account_name,
            "calendar_id": imported.calendar_id,
            "is_main": False,
        },
    }
    if len(imported.events) == 1 and not imported.is_recurring:
        event = imported.events[0]
        return "single", {**common_payload, "blob": _blob_payload_from_event(event)}
    return "multiple", {
        **common_payload,
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
    if imported.provider != GOOGLE_PROVIDER:
        return next_payload
    links = list(next_payload.get("integration_links") or [])
    source = _integration_source(payload)
    link = _integration_link(
        imported,
        account_key=(source or {}).get("account_key"),
        account_id=(source or {}).get("account_id"),
        account_name=(source or {}).get("account_name"),
    )
    exists = any(
        isinstance(item, dict)
        and item.get("provider") == link["provider"]
        and (
            not link.get("account_key")
            or item.get("account_key") == link.get("account_key")
        )
        and item.get("calendar_id") == link["calendar_id"]
        and item.get("external_recurrence_id") == link["external_recurrence_id"]
        for item in links
    )
    if not exists:
        links.append(link)
    next_payload["integration_links"] = links
    return next_payload


async def _copy_imported_rows_to_main(
    *,
    session: AsyncSession,
    rows: list[RecurrenceModel],
) -> dict[str, int]:
    if not rows:
        return {"created_count": 0, "merged_count": 0, "skipped_count": 0}
    now = datetime.now(tz=timezone.utc)
    range_start = now - timedelta(days=1)
    range_end = now + timedelta(days=MAX_SYNC_PREVIEW_RANGE_DAYS)
    existing_main_rows = await _main_recurrence_rows(session)
    existing_main_by_id = {row.id: row for row in existing_main_rows}
    existing_main = await _build_main_recurrence_primitives(
        session=session,
        range_start=range_start,
        range_end=range_end,
    )
    created_count = 0
    merged_count = 0
    skipped_count = 0
    for row in rows:
        source_payload = dict(row.payload or {})
        imported_primitive = _stored_recurrence_to_primitive(
            recurrence_id=row.id,
            recurrence_type=row.type,
            payload=source_payload,
            range_start=range_start,
            range_end=range_end,
        )
        if imported_primitive is None:
            skipped_count += 1
            continue
        matches = find_recurrence_matches(
            imported_primitive,
            existing_main,
            DEFAULT_NAME_EDIT_DISTANCE_THRESHOLD,
        )
        if len(matches) == 1:
            target = matches[0]
            target_id = target.key
            target_row = existing_main_by_id.get(target_id)
            if target_row is None:
                skipped_count += 1
                continue
            target_row.payload = _append_integration_link(
                target_row.payload,
                imported=imported_primitive,
            )
            merged_count += 1
            continue
        new_payload = _main_payload_from_imported_payload(source_payload)
        session.add(
            RecurrenceModel(
                id=str(uuid.uuid4()),
                type=row.type,
                payload=new_payload,
            )
        )
        created_count += 1
    if created_count or merged_count:
        await session.commit()
    return {
        "created_count": created_count,
        "merged_count": merged_count,
        "skipped_count": skipped_count,
    }


def _stored_recurrence_to_primitive(
    *,
    recurrence_id: str,
    recurrence_type: str,
    payload: dict,
    range_start: datetime,
    range_end: datetime,
) -> RecurrencePrimitive | None:
    try:
        recurrence_obj = _recurrence_from_payload(recurrence_type, payload)
    except HTTPException:
        return None
    recurrence_tz = _recurrence_tzinfo(recurrence_obj)
    recurrence_range = _coerce_timerange(TimeRange(start=range_start, end=range_end), recurrence_tz)
    exclusions = _exclusion_set(payload)
    events: list[EventPrimitive] = []
    for blob in recurrence_obj.all_occurrences(recurrence_range):
        sched_start = blob.get_schedulable_timerange().start
        if sched_start.tzinfo is None:
            sched_start = sched_start.replace(tzinfo=timezone.utc)
        if int(sched_start.timestamp()) in exclusions:
            continue
        default_range = blob.get_default_scheduled_timerange()
        tz_name = blob.tz.key if hasattr(blob.tz, "key") else str(blob.tz or "UTC")
        events.append(
            EventPrimitive(
                name=blob.name or str(payload.get("recurrence_name") or "Untitled event"),
                description=blob.description or payload.get("recurrence_description"),
                default_start=default_range.start,
                default_end=default_range.end,
                timezone=tz_name,
            )
        )
    if not events:
        return None
    source = _integration_source(payload)
    calendar_name = (
        str(source.get("calendar_name") or "").strip()
        if source
        else str((payload.get("calendar_view") or {}).get("name") or "")
    )
    primitive_key = recurrence_id
    if source:
        primitive_key = f"{source['calendar_id']}:{source['external_recurrence_id']}"
    primitive = RecurrencePrimitive(
        key=primitive_key,
        provider=GOOGLE_PROVIDER if source else "local",
        calendar_id=str((source or {}).get("calendar_id") or recurrence_id),
        calendar_name=calendar_name or MAIN_CALENDAR_NAME,
        title=str(payload.get("recurrence_name") or events[0].name or recurrence_id),
        description=payload.get("recurrence_description"),
        identifiers=_recurrence_identifiers_from_payload(payload, fallback=primitive_key),
        events=events,
    )
    primitive.sort_events()
    return primitive


def _main_payload_from_imported_payload(payload: dict) -> dict:
    result = dict(payload or {})
    result.pop("integration_source", None)
    result.pop("calendar_view", None)
    links = [item for item in (result.get("integration_links") or []) if isinstance(item, dict)]
    if links:
        result["integration_links"] = links
    return result


def _recurrence_identifiers_from_payload(payload: dict, *, fallback: str) -> list[str]:
    identifiers: list[str] = []
    source = _integration_source(payload)
    if source:
        external_id = str(source.get("external_recurrence_id") or "").strip()
        calendar_id = str(source.get("calendar_id") or "").strip()
        if external_id and calendar_id:
            identifiers.append(f"{calendar_id}:{external_id}")
        if external_id:
            identifiers.append(external_id)

    links = payload.get("integration_links")
    if isinstance(links, list):
        for link in links:
            if not isinstance(link, dict):
                continue
            provider = str(link.get("provider") or "").strip().lower()
            if provider != GOOGLE_PROVIDER:
                continue
            external_id = str(link.get("external_recurrence_id") or "").strip()
            calendar_id = str(link.get("calendar_id") or "").strip()
            if external_id and calendar_id:
                identifiers.append(f"{calendar_id}:{external_id}")
            if external_id:
                identifiers.append(external_id)

    identifiers.append(fallback)
    deduped: list[str] = []
    for item in identifiers:
        normalized = str(item or "").strip()
        if not normalized:
            continue
        if normalized in deduped:
            continue
        deduped.append(normalized)
    return deduped


def _integration_link(
    imported: RecurrencePrimitive,
    *,
    account_key: str | None = None,
    account_id: str | None = None,
    account_name: str | None = None,
) -> dict:
    link = {
        "provider": imported.provider,
        "calendar_id": imported.calendar_id,
        "calendar_name": imported.calendar_name,
        "external_recurrence_id": _external_recurrence_id(imported.key),
        "linked_at": datetime.now(tz=timezone.utc).isoformat(),
    }
    if account_key:
        link["account_key"] = account_key
    if account_id:
        link["account_id"] = account_id
    if account_name:
        link["account_name"] = account_name
    return link


def _external_recurrence_id(value: str) -> str:
    if ":" not in value:
        return value
    return value.split(":", 1)[1]


def _color_for_key(value: str) -> str:
    checksum = sum(ord(char) for char in value)
    return SYNC_COLOR_SEQUENCE[checksum % len(SYNC_COLOR_SEQUENCE)]
