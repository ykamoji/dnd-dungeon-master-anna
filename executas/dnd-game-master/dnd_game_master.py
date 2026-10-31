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
import os
import queue
import sys
import threading
import urllib.error
import urllib.request
import uuid
from pathlib import Path
from typing import Any

from dnd_game_master_core.workflow import (
    create_campaign as run_setup_workflow,
    draft_turn as run_turn_workflow,
    resolve_turn as commit_turn_workflow,
)
from dnd_game_master_core.data import get_class_profiles


APP_NAME = "dnd-game-master"
APP_VERSION = "0.2.0"
VOICE_AUDIO_MODEL = "gemini-3.8-live"
VOICE_TRANSCRIPTION_MODEL = "gemini-3.5-transcribe-live"
VOICE_NAMES = {
    "Puck", "Charon", "Fenrir", "Orus", "Autonoe", "Enceladus", "Iapetus",
    "Umbriel", "Rasalgethi", "Alnilam", "Schedar", "Gacrux", "Achird",
    "Zubenelgenubi", "Sadachbia", "Sadaltager", "Zephyr", "Kore", "Leda",
    "Aoede", "Callirrhoe", "Algieba", "Despina", "Erinome", "Algenib",
    "Laomedeia", "Achernar", "Pulcherrima", "Vindemiatrix", "Sulafat",
}
VOICE_EMOTIONS = {
    "angry", "amused", "anxious", "calm", "curious", "determined", "excited",
    "fearful", "happy", "hopeful", "mischievous", "sad", "sarcastic", "solemn",
    "surprised", "tender", "whispering",
}
MAX_CAMPAIGN_EVENTS = 500
MAX_PROMPT_CHARS = 18000

try:
    _manifest_path = Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parent)) / "manifest.json"
    with _manifest_path.open(encoding="utf-8") as _manifest_file:
        MANIFEST = json.load(_manifest_file)
except (OSError, json.JSONDecodeError):
    MANIFEST = {
        "name": APP_NAME,
        "display_name": "D&D Game Master",
        "version": APP_VERSION,
        "description": "Runs player-approved D&D campaign scenes and turns.",
        "host_capabilities": ["llm.sample"],
        "credentials": [],
        "tools": [],
        "runtime": {"type": "binary"},
    }


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
        self.disabled_reason = "Anna sampling was not negotiated. Reconnect through an Anna v2 host."

    def write(self, frame: dict[str, Any]) -> None:
        payload = json.dumps(frame, ensure_ascii=False, separators=(",", ":"))
        with self._write_lock:
            sys.stdout.write(payload + "\n")
            sys.stdout.flush()

    def negotiate(self, protocol_version: str) -> None:
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

    def create_message(
        self,
        *,
        invoke_id: str,
        tool_name: str,
        system_prompt: str,
        user_prompt: str,
        max_tokens: int = 1200,
        timeout: float = 30.0,
    ) -> str:
        if not self.enabled:
            raise ExecutaError(self.disabled_reason, code=-32008)

        request_id = uuid.uuid4().hex
        waiter: queue.Queue[dict[str, Any]] = queue.Queue(maxsize=1)
        with self._pending_lock:
            self._pending[request_id] = waiter

        params: dict[str, Any] = {
            "messages": [
                {"role": "user", "content": {"type": "text", "text": user_prompt}}
            ],
            "maxTokens": max_tokens,
            "includeContext": "none",
            "_clientTimeoutS": timeout,
            "systemPrompt": system_prompt,
            "temperature": 0.7,
            "responseFormat": {"type": "json_object"},
            "metadata": {"executa_invoke_id": invoke_id, "tool": tool_name},
            "context": {"invoke_id": invoke_id},
        }

        try:
            self.write({
                "jsonrpc": "2.0",
                "id": request_id,
                "method": "sampling/createMessage",
                "params": params,
            })
            response = waiter.get(timeout=timeout)
        except queue.Empty as exc:
            with self._pending_lock:
                self._pending.pop(request_id, None)
            raise ExecutaError("Anna's model response timed out. Please try again.", -32005) from exc
        except Exception:
            with self._pending_lock:
                self._pending.pop(request_id, None)
            raise

        if response.get("error"):
            error = response["error"]
            message = str(error.get("message") or "Anna could not complete the model request.")
            raise ExecutaError(message, int(error.get("code", -32603)))

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
        if not isinstance(text, str) or not text.strip():
            raise ExecutaError("Anna returned an empty model response. Please try again.")
        return text.strip()


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


def create_campaign(
    name: str,
    premise: str,
    party: Any,
    invoke_id: str,
    campaign_id: str | None = None,
    game_id: str | None = None,
) -> dict[str, Any]:
    try:
        return run_setup_workflow(
            name, premise, party, invoke_id, campaign_id, game_id, SAMPLING.create_message
        )
    except ExecutaError:
        raise
    except Exception as exc:
        raise ExecutaError(str(exc) or "The campaign setup could not be completed.") from exc


def draft_turn(campaign: Any, action: str, invoke_id: str, dice: Any = None) -> dict[str, Any]:
    try:
        return run_turn_workflow(campaign, action, invoke_id, dice, SAMPLING.create_message)
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


def _voice_api_key(credentials: Any) -> str | None:
    credential_map = credentials if isinstance(credentials, dict) else {}
    # GEMINI_API_KEY is the declared Anna credential. GOOGLE_API_KEY remains a
    # local-only alias so the original project's ignored .env works unchanged.
    for key in ("GEMINI_API_KEY", "GOOGLE_API_KEY"):
        value = credential_map.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    for key in ("GEMINI_API_KEY", "GOOGLE_API_KEY"):
        value = os.environ.get(key)
        if value and value.strip():
            return value.strip()
    if getattr(sys, "frozen", False):
        return None

    # Local-only convenience: read only the voice key from the ignored .env.
    # Anna cloud credentials arrive through params.context.credentials and do
    # not depend on a repository file being present.
    env_path = Path(__file__).resolve().parents[2] / ".env"
    values: dict[str, str] = {}
    try:
        for line in env_path.read_text(encoding="utf-8").splitlines():
            candidate = line.strip()
            if candidate.startswith("export "):
                candidate = candidate[len("export "):].lstrip()
            if not candidate or candidate.startswith("#") or "=" not in candidate:
                continue
            name, raw_value = candidate.split("=", 1)
            name = name.strip()
            if name in ("GEMINI_API_KEY", "GOOGLE_API_KEY"):
                values[name] = raw_value.strip().strip("\"'")
    except OSError:
        return None
    return values.get("GEMINI_API_KEY") or values.get("GOOGLE_API_KEY")


def issue_voice_token(
    credentials: Any,
    mode: Any = "text",
    emotion: Any = "",
    voice_name: Any = "",
) -> dict[str, Any]:
    api_key = _voice_api_key(credentials)
    if not isinstance(api_key, str) or not api_key.strip():
        raise ExecutaError(
            "Voice is not configured yet. Add a GEMINI_API_KEY credential to the bundled Executa."
        )

    mode = mode if isinstance(mode, str) and mode in ("text", "audio") else "text"
    voice_name = voice_name if isinstance(voice_name, str) and voice_name in VOICE_NAMES else "Kore"
    emotion = " ".join(str(emotion or "").split())[:80]
    if emotion.casefold() not in VOICE_EMOTIONS:
        emotion = ""

    if mode == "audio":
        model = VOICE_AUDIO_MODEL
        prompt = "Speak the provided text exactly as written. Do not add, omit, or paraphrase words."
        if emotion:
            prompt += f" Use a {emotion} vocal delivery."
        live_config = {
            "responseModalities": ["AUDIO"],
            "speechConfig": {
                "voiceConfig": {
                    "prebuiltVoiceConfig": {"voiceName": voice_name}
                }
            },
            "systemInstruction": {"parts": [{"text": prompt}]},
        }
    else:
        model = VOICE_TRANSCRIPTION_MODEL
        live_config = {
            "responseModalities": ["TEXT"],
            "inputAudioTranscription": {"languageCodes": []},
        }

    now = dt.datetime.now(dt.timezone.utc)
    request_body = {
        "uses": 1,
        "expireTime": (now + dt.timedelta(minutes=15)).isoformat().replace("+00:00", "Z"),
        "newSessionExpireTime": (now + dt.timedelta(seconds=60)).isoformat().replace("+00:00", "Z"),
        "liveConnectConstraints": {
            "model": f"models/{model}",
            "config": live_config,
        },
    }
    request = urllib.request.Request(
        "https://generativelanguage.googleapis.com/v1beta/auth_tokens",
        data=json.dumps(request_body).encode("utf-8"),
        headers={"Content-Type": "application/json", "x-goog-api-key": api_key.strip()},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=15) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        raise ExecutaError(
            f"Gemini did not issue a Live voice token (HTTP {exc.code}). Check the configured credential."
        ) from exc
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as exc:
        raise ExecutaError("Could not reach Gemini to start voice. Please try again.") from exc

    token = payload.get("name") if isinstance(payload, dict) else None
    if not isinstance(token, str) or not token:
        raise ExecutaError("Gemini returned an invalid Live voice token response.")
    return {
        "token": token,
        "model": model,
        "expires_in_seconds": 60,
        "websocket_url": (
            "wss://generativelanguage.googleapis.com/ws/"
            "google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained"
        ),
    }


def _invoke(params: dict[str, Any]) -> dict[str, Any]:
    tool_name = params.get("tool")
    arguments = params.get("arguments") or {}
    if not isinstance(arguments, dict):
        raise ExecutaError("Tool arguments must be an object.", -32602)
    context = params.get("context") if isinstance(params.get("context"), dict) else {}
    invoke_id = str(context.get("invoke_id") or params.get("invoke_id") or "")

    if tool_name == "create_campaign":
        data = create_campaign(arguments.get("name", ""), arguments.get("premise", ""), arguments.get("party"), invoke_id, arguments.get("campaign_id"), arguments.get("game_id"))
    elif tool_name == "get_class_profiles":
        # The Anna host turns a bare list result into `{}`, so wrap it in an object.
        data = {"classes": get_class_profiles()}
    elif tool_name == "draft_turn":
        data = draft_turn(arguments.get("campaign"), arguments.get("action", ""), invoke_id, arguments.get("dice"))
    elif tool_name == "resolve_turn":
        if not isinstance(arguments.get("approved"), bool):
            raise ExecutaError("'approved' must be true or false.", -32602)
        data = resolve_turn(arguments.get("campaign"), arguments.get("draft"), arguments["approved"])
    elif tool_name == "voice_token":
        data = issue_voice_token(
            context.get("credentials"),
            arguments.get("type", "text"),
            arguments.get("emotion", ""),
            arguments.get("voice_name", ""),
        )
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
            "client_capabilities": {"sampling": {}} if protocol_version == "2.0" else {},
            "capabilities": {},
        }
        SAMPLING.write(_response(request_id, result=result))
        return
    if method == "describe":
        SAMPLING.write(_response(request_id, result=MANIFEST))
        return
    if method == "health":
        SAMPLING.write(_response(request_id, result={"status": "healthy", "version": APP_VERSION, "timestamp": _now()}))
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
