from __future__ import annotations

import uuid
from typing import Any

import httpx

from backend.llm.base import BaseModelProvider, Message, ModelResponse, ToolCall, ToolSpec


class GeminiProvider(BaseModelProvider):
    name = "gemini"

    def __init__(
        self,
        api_key: str,
        model: str = "gemini-1.5-pro",
        api_base: str = "https://generativelanguage.googleapis.com/v1beta",
        timeout_seconds: float = 30.0,
        client: httpx.AsyncClient | None = None,
    ) -> None:
        self._api_key = api_key
        self._model = model
        self._api_base = api_base.rstrip("/")
        timeout = max(1.0, float(timeout_seconds))
        self._client = client or httpx.AsyncClient(
            timeout=httpx.Timeout(timeout=timeout, connect=min(10.0, timeout))
        )
        self._owns_client = client is None

    def _build_contents(self, messages: list[Message]) -> list[dict[str, Any]]:
        contents: list[dict[str, Any]] = []
        for message in messages:
            parts: list[dict[str, Any]] = []
            if message.content:
                parts.append({"text": message.content})
            if message.tool_calls:
                for call in message.tool_calls:
                    parts.append(
                        {
                            "functionCall": {
                                "name": call.name,
                                "args": call.arguments or {},
                            }
                        }
                    )
            if message.tool_results:
                for result in message.tool_results:
                    parts.append(
                        {
                            "functionResponse": {
                                "name": result.name,
                                "response": result.output,
                            }
                        }
                    )
            if not parts:
                continue
            role = "model" if message.role == "assistant" else "user"
            contents.append({"role": role, "parts": parts})
        return contents

    def _build_tools(self, tools: list[ToolSpec]) -> list[dict[str, Any]]:
        if not tools:
            return []
        declarations = []
        for tool in tools:
            declarations.append(
                {
                    "name": tool.name,
                    "description": tool.description or "",
                    "parameters": tool.parameters or {"type": "object", "properties": {}},
                }
            )
        return [{"function_declarations": declarations}]

    async def generate(
        self, messages: list[Message], tools: list[ToolSpec]
    ) -> ModelResponse:
        payload: dict[str, Any] = {"contents": self._build_contents(messages)}
        tool_payload = self._build_tools(tools)
        if tool_payload:
            payload["tools"] = tool_payload
        url = f"{self._api_base}/models/{self._model}:generateContent"
        response = await self._client.post(
            url,
            headers={"x-goog-api-key": self._api_key},
            json=payload,
        )
        response.raise_for_status()
        data = response.json()
        candidates = data.get("candidates") or []
        if not candidates:
            return ModelResponse(text="")
        parts = (candidates[0].get("content") or {}).get("parts") or []
        text_parts: list[str] = []
        tool_calls: list[ToolCall] = []
        for part in parts:
            if "text" in part:
                text_parts.append(part["text"])
                continue
            func_call = part.get("functionCall")
            if func_call:
                tool_calls.append(
                    ToolCall(
                        id=str(uuid.uuid4()),
                        name=func_call.get("name", ""),
                        arguments=func_call.get("args") or {},
                    )
                )
        return ModelResponse(text="".join(text_parts), tool_calls=tool_calls)

    async def aclose(self) -> None:
        if self._owns_client:
            await self._client.aclose()
