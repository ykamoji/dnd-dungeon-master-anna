#!/usr/bin/env python3
# Copyright (c) 2026 Yash
# SPDX-License-Identifier: MIT
"""Anna Executa for the D&D Dungeon Master static app.

The process speaks Anna's JSON-RPC 2.0-over-stdio protocol. Game state is
passed into and out of each invoke; Anna APS persistence belongs to the UI.
"""
from __future__ import annotations

import copy
import datetime as dt
import json
import queue
import sys
import threading
import uuid
from pathlib import Path
from typing import Any

from dnd_game_master_core.workflow import (
    DEFAULT_TIMEOUT_S,
    SAMPLING_MAX_TOKENS_PER_CALL,
    InvokeBudget,
    create_campaign as run_setup_workflow,
    draft_turn as run_turn_workflow,
    resolve_turn as commit_turn_workflow,
)
from dnd_game_master_core.data import get_class_profiles


APP_NAME = "dnd-game-master"
SAMPLING_ERROR_MESSAGES = {
    -32001: "Anna's AI is not enabled for this game. Re-enable D&D Game Master under Installed Apps.",
    -32002: "Your Anna AI quota is used up. Try again later.",
    -32003: "Anna's AI provider had a problem. Please try again.",
    -32004: "Anna rejected the model request. Please try again.",
    -32005: "Anna's model response timed out. Please try again.",
    -32006: "This turn used all of its AI calls. Please try again.",
    -32007: "This turn used all of its AI tokens. Please try again.",
    -32009: "The AI request was declined.",
    -32010: "The selected AI model cannot return structured output.",
}

try:
    _manifest_path = Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parent)) / "manifest.json"
    with _manifest_path.open(encoding="utf-8") as _manifest_file:
        MANIFEST = json.load(_manifest_file)
except (OSError, json.JSONDecodeError):
    MANIFEST = {
        "name": APP_NAME,
        "display_name": "D&D Game Master",
        "version": "0.0.0",
        "description": "Runs player-approved D&D campaign scenes and turns.",
        "credentials": [],
        "tools": [],
        "runtime": {"type": "binary"},
    }
# One source of truth: scripts/stamp_version.py writes the version into manifest.json.
APP_VERSION = str(MANIFEST.get("version") or "0.0.0")


# ExecutaError codes reported as `{"success": false, "error": ...}` tool results.
TOOL_FAILURE_CODES = {-32603}


class ExecutaError(Exception):
    def __init__(self, message: str, code: int = -32603):
        super().__init__(message)
        self.code = code


class SamplingBridge:
    """Multiplex reverse sampling replies while stdin continues receiving frames."""

    def __init__(self) -> None:
        self._write_lock = threading.Lock()
        self._pending_lock = threading.Lock()
        self._pending: dict[str, queue.Queue[dict[str, Any]]] = {}
        self.enabled = False
        # Hosts that never send `initialize` (the local `anna-app dev` harness) are given the
        # benefit of the doubt; only a host that negotiated a non-2.0 protocol is refused.
        self.negotiated = False
        self.disabled_reason = "Anna sampling was not negotiated. Reconnect through an Anna v2 host."

    def write(self, frame: dict[str, Any]) -> None:
        payload = json.dumps(frame, ensure_ascii=False, separators=(",", ":"))
        with self._write_lock:
            sys.stdout.write(payload + "\n")
            sys.stdout.flush()

    def negotiate(self, protocol_version: str) -> None:
        self.negotiated = True
        self.enabled = protocol_version == "2.0"
        if self.enabled:
            self.disabled_reason = ""

    def dispatch_response(self, message: dict[str, Any]) -> bool:
        if "method" in message or "id" not in message:
            return False
        request_id = str(message["id"])
        with self._pending_lock:
            waiter = self._pending.pop(request_id, None)
        if waiter is None:
            return False
        waiter.put(message)
        return True

    def notify_progress(self, invoke_id: str, data: dict[str, Any]) -> None:
        """Send an `executa/progress` notification. Anna drops it for sync invokes."""
        if not invoke_id:
            return
        self.write({
            "jsonrpc": "2.0",
            "method": "executa/progress",
            "params": {"type": "tool_update", "data": data, "context": {"invoke_id": invoke_id}},
        })

    def create_message(
        self,
        *,
        invoke_id: str,
        tool_name: str,
        system_prompt: str,
        user_prompt: str,
        max_tokens: int = 1200,
        timeout: float = 30.0,
        temperature: float = 0.7,
        response_format: dict[str, Any] | None = None,
    ) -> "SampleText":
        if self.negotiated and not self.enabled:
            raise ExecutaError(self.disabled_reason, code=-32008)

        request_id = uuid.uuid4().hex
        waiter: queue.Queue[dict[str, Any]] = queue.Queue(maxsize=1)
        with self._pending_lock:
            self._pending[request_id] = waiter

        response_format = response_format or {"type": "json_object"}
        params: dict[str, Any] = {
            "messages": [
                {"role": "user", "content": {"type": "text", "text": user_prompt}}
            ],
            "maxTokens": min(int(max_tokens), SAMPLING_MAX_TOKENS_PER_CALL),
            "includeContext": "none",
            "_clientTimeoutS": timeout,
            "systemPrompt": system_prompt,
            "temperature": temperature,
            "responseFormat": response_format,
            "metadata": {"executa_invoke_id": invoke_id, "tool": tool_name},
        }
        if response_format.get("type") == "json_schema":
            # Models without strict-schema support degrade to JSON mode instead of failing (-32010).
            params["onUnsupported"] = "json_object"
        if invoke_id:
            params["context"] = {"invoke_id": invoke_id}

        try:
            self.write({
                "jsonrpc": "2.0",
                "id": request_id,
                "method": "sampling/createMessage",
                "params": params,
            })
            # The host enforces `_clientTimeoutS`; wait slightly longer for its own timeout error.
            response = waiter.get(timeout=timeout + 5)
        except queue.Empty as exc:
            with self._pending_lock:
                self._pending.pop(request_id, None)
            raise ExecutaError(SAMPLING_ERROR_MESSAGES[-32005], -32005) from exc
        except Exception:
            with self._pending_lock:
                self._pending.pop(request_id, None)
            raise

        if response.get("error"):
            error = response["error"] if isinstance(response["error"], dict) else {}
            try:
                code = int(error.get("code", -32603))
            except (TypeError, ValueError):
                code = -32603
            raw_message = str(error.get("message") or "")
            print(f"sampling error {code} for {tool_name}: {raw_message}", file=sys.stderr, flush=True)
            if code == -32008:
                message = self.disabled_reason
            else:
                message = SAMPLING_ERROR_MESSAGES.get(code) or raw_message or "Anna could not complete the model request."
            raise ExecutaError(message, code)

        result = response.get("result") or {}
        content = result.get("content")
        if isinstance(content, dict):
            text = content.get("text")
        elif isinstance(content, list):
            text = "\n".join(
                str(part.get("text", ""))
                for part in content
                if isinstance(part, dict) and part.get("type") == "text"
            )
        else:
            text = None
        stop_reason = str(result.get("stopReason") or "")
        if not isinstance(text, str) or not text.strip():
            if stop_reason == "maxTokens":
                raise ExecutaError("The model ran out of room before answering. Please try again.")
            raise ExecutaError("Anna returned an empty model response. Please try again.")
        return SampleText(text.strip(), usage=result.get("usage"), stop_reason=stop_reason)


class SampleText(str):
    """Model text that also carries the host's token usage and stop reason."""

    usage: dict[str, Any]
    stop_reason: str

    def __new__(cls, text: str, *, usage: Any = None, stop_reason: str = "") -> "SampleText":
        value = super().__new__(cls, text)
        value.usage = usage if isinstance(usage, dict) else {}
        value.stop_reason = stop_reason
        return value


SAMPLING = SamplingBridge()


def _now() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat()


def _bounded_text(value: Any, fallback: str = "", limit: int = 4000) -> str:
    text = value.strip() if isinstance(value, str) else fallback
    return text[:limit]


def _json_from_model(text: str) -> dict[str, Any]:
    candidate = text.strip()
    fence = chr(96) * 3
    if candidate.startswith(fence):
        candidate = candidate.split("\n", 1)[-1]
        if candidate.endswith(fence):
            candidate = candidate[:-3].strip()
        if candidate.lower().startswith("json"):
            candidate = candidate[4:].strip()
    try:
        parsed = json.loads(candidate)
    except json.JSONDecodeError:
        decoder = json.JSONDecoder()
        start = candidate.find("{")
        if start < 0:
            raise ExecutaError("Anna's response was not valid JSON. Please try again.")
        try:
            parsed, _ = decoder.raw_decode(candidate[start:])
        except json.JSONDecodeError as exc:
            raise ExecutaError("Anna's response was not valid JSON. Please try again.") from exc
    if not isinstance(parsed, dict):
        raise ExecutaError("Anna returned an unexpected campaign response. Please try again.")
    return parsed


def _progress_sink(invoke_id: str) -> Any:
    return (lambda data: SAMPLING.notify_progress(invoke_id, data)) if invoke_id else None


def create_campaign(
    name: str,
    premise: str,
    party: Any,
    invoke_id: str,
    campaign_id: str | None = None,
    game_id: str | None = None,
    deadline_ms: Any = None,
) -> dict[str, Any]:
    try:
        return run_setup_workflow(
            name, premise, party, invoke_id, campaign_id, game_id, SAMPLING.create_message,
            budget=InvokeBudget.for_invoke(deadline_ms, DEFAULT_TIMEOUT_S["create_campaign"]),
            progress=_progress_sink(invoke_id),
        )
    except ExecutaError:
        raise
    except Exception as exc:
        raise ExecutaError(str(exc) or "The campaign setup could not be completed.") from exc


def draft_turn(
    campaign: Any,
    action: str,
    invoke_id: str,
    dice: Any = None,
    deadline_ms: Any = None,
) -> dict[str, Any]:
    try:
        return run_turn_workflow(
            campaign, action, invoke_id, dice, SAMPLING.create_message,
            budget=InvokeBudget.for_invoke(deadline_ms, DEFAULT_TIMEOUT_S["draft_turn"]),
            progress=_progress_sink(invoke_id),
        )
    except ExecutaError:
        raise
    except Exception as exc:
        raise ExecutaError(str(exc) or "The turn could not be drafted.") from exc


def resolve_turn(campaign: Any, draft: Any, approved: bool) -> dict[str, Any]:
    try:
        return commit_turn_workflow(campaign, draft, approved)
    except ExecutaError:
        raise
    except Exception as exc:
        raise ExecutaError(str(exc) or "The turn could not be resolved.") from exc


def _invoke(params: dict[str, Any]) -> dict[str, Any]:
    tool_name = params.get("tool")
    arguments = params.get("arguments") or {}
    if not isinstance(arguments, dict):
        raise ExecutaError("Tool arguments must be an object.", -32602)
    context = params.get("context") if isinstance(params.get("context"), dict) else {}
    invoke_id = str(context.get("invoke_id") or params.get("invoke_id") or "")
    # Absolute wall-clock deadline (epoch ms) that Anna propagates for this invoke.
    deadline_ms = context.get("deadline_ms") or params.get("deadline_ms")
    # `campaign` carries the compact state; `state` is accepted as an alias.
    state = arguments.get("campaign") if arguments.get("campaign") is not None else arguments.get("state")

    if tool_name == "create_campaign":
        data = create_campaign(
            arguments.get("name", ""), arguments.get("premise", ""), arguments.get("party"), invoke_id,
            arguments.get("campaign_id"), arguments.get("game_id"), deadline_ms,
        )
    elif tool_name == "get_class_profiles":
        # The Anna host turns a bare list result into `{}`, so wrap it in an object.
        data = {"classes": get_class_profiles()}
    elif tool_name == "draft_turn":
        data = draft_turn(state, arguments.get("action", ""), invoke_id, arguments.get("dice"), deadline_ms)
    elif tool_name == "resolve_turn":
        if not isinstance(arguments.get("approved"), bool):
            raise ExecutaError("'approved' must be true or false.", -32602)
        data = resolve_turn(state, arguments.get("draft"), arguments["approved"])
    else:
        raise ExecutaError(f"Unknown D&D Game Master method: {tool_name}", -32601)
    return {"success": True, "tool": tool_name, "data": data}


def _response(request_id: Any, result: Any = None, error: dict[str, Any] | None = None) -> dict[str, Any]:
    message: dict[str, Any] = {"jsonrpc": "2.0", "id": request_id}
    if error is not None:
        message["error"] = error
    else:
        message["result"] = result
    return message


def _handle_request(message: dict[str, Any]) -> None:
    request_id = message.get("id")
    method = message.get("method")
    params = message.get("params") or {}
    if not isinstance(params, dict):
        params = {}

    if method == "initialize":
        protocol_version = str(params.get("protocolVersion") or "1.1")
        SAMPLING.negotiate(protocol_version)
        result = {
            "protocolVersion": protocol_version if protocol_version in ("1.1", "2.0") else "2.0",
            "serverInfo": {"name": APP_NAME, "version": APP_VERSION},
            "server_info": {"name": APP_NAME, "version": APP_VERSION},
            "client_capabilities": {"sampling": {}} if protocol_version == "2.0" else {},
            # Anna only mints a per-invoke sampling_token for plugins that list sampling here.
            "capabilities": {"sampling": {}} if protocol_version == "2.0" else {},
        }
        SAMPLING.write(_response(request_id, result=result))
        return
    if method == "describe":
        SAMPLING.write(_response(request_id, result=MANIFEST))
        return
    if method == "health":
        SAMPLING.write(_response(request_id, result={"status": "ready", "message": "", "version": APP_VERSION, "timestamp": _now()}))
        return
    if method == "shutdown":
        SAMPLING.write(_response(request_id, result={"ok": True}))
        return
    if method != "invoke":
        if request_id is not None:
            SAMPLING.write(_response(request_id, error={"code": -32601, "message": f"Method not found: {method}"}))
        return

    try:
        SAMPLING.write(_response(request_id, result=_invoke(params)))
    except ExecutaError as exc:
        if exc.code in TOOL_FAILURE_CODES:
            # Expected failures (bad input, model or budget trouble) are a tool result the
            # app shows as-is; JSON-RPC errors are kept for protocol and programmer errors.
            SAMPLING.write(_response(request_id, result={
                "success": False, "tool": params.get("tool"), "error": str(exc),
            }))
        else:
            SAMPLING.write(_response(request_id, error={"code": exc.code, "message": str(exc)}))
    except Exception as exc:
        print(f"invoke failed: {type(exc).__name__}: {exc}", file=sys.stderr, flush=True)
        SAMPLING.write(_response(
            request_id,
            error={"code": -32603, "message": "The game action failed unexpectedly. Please retry."},
        ))


def _handle_line(line: str, pool: Any) -> None:
    try:
        message = json.loads(line)
    except json.JSONDecodeError:
        SAMPLING.write(_response(None, error={"code": -32700, "message": "Parse error"}))
        return
    if not isinstance(message, dict):
        SAMPLING.write(_response(None, error={"code": -32600, "message": "Invalid Request"}))
        return
    if "method" not in message:
        if not SAMPLING.dispatch_response(message):
            print(f"unmatched host response id={message.get('id')!r}", file=sys.stderr, flush=True)
        return
    if message.get("method") in ("initialize", "describe", "health", "shutdown"):
        _handle_request(message)
        return
    pool.submit(_handle_request, message)


def main() -> None:
    # The protocol is UTF-8 JSON; Windows would otherwise default to the ANSI code page
    # and fail to encode characters such as "ā" in the bundled game data.
    for stream in (sys.stdin, sys.stdout, sys.stderr):
        stream.reconfigure(encoding="utf-8")
    print(f"{APP_NAME} Executa started", file=sys.stderr, flush=True)
    from concurrent.futures import ThreadPoolExecutor

    pool = ThreadPoolExecutor(max_workers=4, thread_name_prefix="dnd-invoke")
    try:
        for raw in sys.stdin:
            line = raw.strip()
            if line:
                _handle_line(line, pool)
    finally:
        pool.shutdown(wait=False, cancel_futures=True)


if __name__ == "__main__":
    main()
