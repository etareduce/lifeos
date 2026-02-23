from __future__ import annotations

from datetime import datetime, timezone
from urllib.parse import quote

import httpx


GOOGLE_CALENDAR_API_BASE = "https://www.googleapis.com/calendar/v3"
GOOGLE_USERINFO_URL = "https://www.googleapis.com/oauth2/v2/userinfo"
GOOGLE_OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token"


class GoogleCalendarAPIError(RuntimeError):
    def __init__(self, message: str, *, status_code: int | None = None) -> None:
        super().__init__(message)
        self.status_code = status_code


class GoogleCalendarClient:
    def __init__(self, access_token: str, client: httpx.AsyncClient | None = None) -> None:
        self._access_token = access_token
        self._client = client or httpx.AsyncClient(timeout=20.0)
        self._owns_client = client is None

    async def aclose(self) -> None:
        if self._owns_client:
            await self._client.aclose()

    async def get_account_info(self) -> dict:
        return await self._request_json("GET", GOOGLE_USERINFO_URL)

    async def list_calendars(self) -> list[dict]:
        payload = await self._request_json(
            "GET",
            f"{GOOGLE_CALENDAR_API_BASE}/users/me/calendarList",
        )
        return payload.get("items") or []

    async def list_events(
        self,
        *,
        calendar_id: str,
        start: datetime,
        end: datetime,
    ) -> list[dict]:
        params = {
            "singleEvents": "true",
            "orderBy": "startTime",
            "showDeleted": "false",
            "maxResults": "2500",
            "timeMin": _to_google_time(start),
            "timeMax": _to_google_time(end),
        }
        payload = await self._request_json(
            "GET",
            f"{GOOGLE_CALENDAR_API_BASE}/calendars/{quote(calendar_id, safe='')}/events",
            params=params,
        )
        return payload.get("items") or []

    async def _request_json(
        self,
        method: str,
        url: str,
        *,
        params: dict | None = None,
    ) -> dict:
        response = await self._client.request(
            method,
            url,
            params=params,
            headers={"Authorization": f"Bearer {self._access_token}"},
        )
        if response.status_code >= 400:
            detail = _error_message(response)
            raise GoogleCalendarAPIError(detail, status_code=response.status_code)
        return response.json()


async def exchange_oauth_code_for_tokens(
    *,
    code: str,
    client_id: str,
    client_secret: str,
    redirect_uri: str,
    code_verifier: str,
) -> dict:
    data = {
        "code": code,
        "client_id": client_id,
        "client_secret": client_secret,
        "code_verifier": code_verifier,
        "grant_type": "authorization_code",
        "redirect_uri": redirect_uri,
    }
    async with httpx.AsyncClient(timeout=20.0) as client:
        response = await client.post(GOOGLE_OAUTH_TOKEN_URL, data=data)
    if response.status_code >= 400:
        raise GoogleCalendarAPIError(
            _error_message(response), status_code=response.status_code
        )
    return response.json()


async def refresh_oauth_access_token(
    *,
    refresh_token: str,
    client_id: str,
    client_secret: str,
) -> dict:
    data = {
        "refresh_token": refresh_token,
        "client_id": client_id,
        "client_secret": client_secret,
        "grant_type": "refresh_token",
    }
    async with httpx.AsyncClient(timeout=20.0) as client:
        response = await client.post(GOOGLE_OAUTH_TOKEN_URL, data=data)
    if response.status_code >= 400:
        raise GoogleCalendarAPIError(
            _error_message(response), status_code=response.status_code
        )
    return response.json()


def _error_message(response: httpx.Response) -> str:
    try:
        payload = response.json()
        error = payload.get("error")
        if isinstance(error, dict):
            message = error.get("message")
            if message:
                return str(message)
        if isinstance(error, str) and error:
            return error
    except ValueError:
        pass
    text = response.text.strip()
    if text:
        return text
    return f"Google API request failed with status {response.status_code}."


def _to_google_time(value: datetime) -> str:
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.isoformat()
