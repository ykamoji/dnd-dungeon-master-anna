# Copyright (c) 2026 Yash
# SPDX-License-Identifier: MIT
"""End-to-end JSON-RPC tests with a fake Anna sampling host."""

import json
import os
from pathlib import Path
import queue
import subprocess
import sys
import threading
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
EXECUTA = ROOT / "executas" / "dnd-game-master"
sys.path.insert(0, str(EXECUTA))
import dnd_game_master as executa_module  # noqa: E402
from dnd_game_master_core.data import gather_tool_results


class ExecutaProcess:
    def __init__(self):
        env = os.environ.copy()
        env.pop("GEMINI_API_KEY", None)
        env.pop("GOOGLE_API_KEY", None)
        self.process = subprocess.Popen(
            [sys.executable, "dnd_game_master.py"],
            cwd=EXECUTA,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1,
            env=env,
        )
        self.lines = queue.Queue()

        def read_stdout():
            for line in self.process.stdout:
                try:
                    self.lines.put(json.loads(line))
                except json.JSONDecodeError:
                    self.lines.put({"_invalid": line})

        self.reader = threading.Thread(target=read_stdout, daemon=True)
        self.reader.start()

    def send(self, value):
        self.process.stdin.write(json.dumps(value) + "\n")
        self.process.stdin.flush()

    def next(self):
        try:
            value = self.lines.get(timeout=12)
        except queue.Empty as exc:
            stderr = ""
            if self.process.poll() is not None:
                stderr = self.process.stderr.read()
            raise AssertionError(f"Executa did not respond in time. {stderr}") from exc
        if "_invalid" in value:
            raise AssertionError(f"Executa wrote a non-JSON frame: {value['_invalid']!r}")
        return value

    def call(self, request_id, method, params=None):
        self.send({"jsonrpc": "2.0", "id": request_id, "method": method, "params": params or {}})
        response = self.next()
        self.assert_id(response, request_id)
        return response

    @staticmethod
    def assert_id(response, expected):
        if response.get("id") != expected:
            raise AssertionError(f"Expected JSON-RPC id {expected!r}, received {response!r}")

    def invoke_with_models(self, request_id, tool, arguments, invoke_id, answers):
        """Answer each reverse-sampling call in order and return the final invocation."""
        self.send({
            "jsonrpc": "2.0",
            "id": request_id,
            "method": "invoke",
            "params": {
                "tool": tool,
                "arguments": arguments,
                "context": {"invoke_id": invoke_id},
            },
        })
        sampled_tools = []
        while True:
            frame = self.next()
            if frame.get("id") == request_id:
                self.assert_id(frame, request_id)
                return frame, sampled_tools
            if frame.get("method") != "sampling/createMessage":
                raise AssertionError(f"Expected an Anna sampling request, got {frame!r}")
            params = frame.get("params", {})
            if params.get("context", {}).get("invoke_id") != invoke_id:
                raise AssertionError("Sampling request did not carry the Executa invoke id.")
            tool_name = params.get("metadata", {}).get("tool")
            sampled_tools.append(tool_name)
            if len(sampled_tools) > len(answers):
                raise AssertionError(f"Unexpected sampling stage {tool_name!r}; expected {answers!r}")
            expected_tool, answer = answers[len(sampled_tools) - 1]
            if tool_name != expected_tool:
                raise AssertionError(f"Expected sampling stage {expected_tool!r}, got {tool_name!r}")
            self.send({
                "jsonrpc": "2.0",
                "id": frame["id"],
                "result": {"content": [{"type": "text", "text": json.dumps(answer)}]},
            })

    def close(self):
        if self.process.poll() is None:
            try:
                self.call("shutdown", "shutdown")
            except Exception:
                pass
            try:
                self.process.stdin.close()
                self.process.wait(timeout=3)
            except Exception:
                self.process.terminate()
                try:
                    self.process.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    self.process.kill()
                    self.process.wait(timeout=3)
        if self.process.stdout:
            self.process.stdout.close()
        if self.process.stderr:
            self.process.stderr.close()


class ExecutaProtocolTests(unittest.TestCase):
    def setUp(self):
        self.app = ExecutaProcess()
        initialized = self.app.call("init", "initialize", {"protocolVersion": "2.0"})
        self.assertEqual(initialized["result"]["protocolVersion"], "2.0")
        self.assertIn("sampling", initialized["result"]["client_capabilities"])

    def tearDown(self):
        self.app.close()

    def test_describe_full_setup_routed_turn_approval_and_resume(self):
        manifest = self.app.call("describe", "describe")["result"]
        self.assertEqual(manifest["name"], "dnd-game-master")
        self.assertEqual(
            {tool["name"] for tool in manifest["tools"]},
            {"create_campaign", "get_class_profiles", "draft_turn", "resolve_turn", "voice_token"},
        )
        profiles_response = self.app.call(
            "classes", "invoke", {"tool": "get_class_profiles", "arguments": {}}
        )
        profiles = profiles_response["result"]["data"]["classes"]
        self.assertEqual(len(profiles), 12)
        ranger = next(profile for profile in profiles if profile["name"] == "Ranger")
        self.assertTrue(ranger["slug"])
        self.assertTrue(ranger["desc"])
        self.assertTrue(ranger["archetypes"])
        credential = next(item for item in manifest["credentials"] if item["name"] == "GEMINI_API_KEY")
        self.assertTrue(credential["sensitive"])
        self.assertFalse(credential["required"])

        story = {
            "found": True,
            "chapter": "Preface",
            "section": "Starting the Adventure",
            "source_path": "Tomb-of-Annihilation/Preface/Starting the Adventure.md",
            "content": "Syndra Silvane recruits adventurers to investigate the death curse.",
        }
        opening = {
            "ready": True,
            "message": "Your campaign is ready.",
            "narrative": "Syndra Silvane lays out the first lead while harbor bells ring across Port Nyanzaru.",
            "scene_summary": "Port Nyanzaru",
            "quest_hook": "Find the source of the death curse.",
            "suggested_actions": ["Ask Syndra about the curse", "Seek a guide", "Visit the harbor"],
            "next_scene_suggestions": ["Meet a guide", "Gather rumors"],
            "progress": 0.1,
        }
        created_response, setup_tools = self.app.invoke_with_models(
            "create",
            "create_campaign",
            {
                "name": "Tomb of Annihilation",
                "campaign_id": "ui-campaign-42",
                "game_id": "tomb-of-annihilation",
                "premise": "A hopeful frontier story.",
                "party": [{
                    "name": "Mira",
                    "class": "Ranger",
                    "ancestry": "Human",
                    "role": "Trail Guide",
                    "skills": ["Nature", "Survival"],
                }],
            },
            "invoke-create",
            [("story_agent", story), ("setup_executor", opening)],
        )
        self.assertEqual(setup_tools, ["story_agent", "setup_executor"])
        created = created_response["result"]["data"]
        self.assertEqual(created["id"], "ui-campaign-42")
        self.assertEqual(created["game_id"], "tomb-of-annihilation")
        self.assertEqual(created["turn"], 0)
        self.assertEqual(created["party"][0]["name"], "Mira")
        self.assertEqual(created["party"][0]["role"], "Trail Guide")
        self.assertEqual(created["party"][0]["skills"], ["Nature", "Survival"])
        self.assertNotIn("armor_class", created["party"][0])
        self.assertEqual(created["party"][0]["armors"], [])
        self.assertTrue(created["party"][0]["armor_proficiencies"])
        self.assertIn("snapshot", created["events"][0])

        first_draft = {
            "narrative": "Mira spots old boot prints and a brass bell beneath the bridge.",
            "scene_summary": "Beneath the Bridge",
            "suggested_actions": ["Study the prints", "Pick up the bell", "Call out"],
            "math_breakdown": "Survival check: d20 17 against DC 12 — success.",
            "combat_log": [{
                "action": "Search the riverbank",
                "target": "Old tracks",
                "roll": "d20 17",
                "result": "Fresh tracks lead inland.",
            }],
            "state_changes": [{"kind": "clue", "text": "The bell is warm."}],
        }
        corrected_draft = {
            **first_draft,
            "narrative": "The bell is warm from someone's hand; the fresh tracks lead inland.",
        }
        pending_response, draft_tools = self.app.invoke_with_models(
            "draft",
            "draft_turn",
            {"campaign": created, "action": "Look under the bridge", "dice": {"d20": 17}},
            "invoke-draft",
            [
                ("intent_classifier", {"intent": "ACTION"}),
                ("story_agent", story),
                ("action_executor", first_draft),
                ("action_evaluator", {"grade": "fail", "comment": "Explain what the check reveals."}),
                ("action_executor", corrected_draft),
                ("action_evaluator", {"grade": "pass", "comment": "The action and clue are grounded."}),
            ],
        )
        self.assertEqual(draft_tools, [
            "intent_classifier", "story_agent", "action_executor", "action_evaluator",
            "action_executor", "action_evaluator",
        ])
        pending = pending_response["result"]["data"]
        self.assertEqual(pending["intent"], "ACTION")
        self.assertIn("action_evaluator", [item["agent"] for item in pending["trace"]])
        self.assertEqual(created["turn"], 0)
        self.assertEqual(len(created["events"]), 1)

        rejected = self.app.call("reject", "invoke", {
            "tool": "resolve_turn",
            "arguments": {"campaign": created, "draft": pending, "approved": False},
        })["result"]["data"]
        self.assertEqual(rejected["turn"], 0)
        self.assertEqual(len(rejected["events"]), 1)
        self.assertIsNone(rejected["pending"])

        # A second draft can start from the unchanged saved campaign after rejection.
        resume_response, _ = self.app.invoke_with_models(
            "resume-draft",
            "draft_turn",
            {"campaign": rejected, "action": "Ask Syndra about the death curse"},
            "invoke-resume",
            [
                ("intent_classifier", {"intent": "NPC_DIALOGUE"}),
                ("story_agent", story),
                ("npc_executor", {
                    "narrative": "Syndra studies the party before answering.",
                    "scene_summary": "Syndra's Study",
                    "npc_name": "Syndra Silvane",
                    "dialogue": [{
                        "speaker": "Syndra Silvane",
                        "text": "The curse reaches beyond this city. I need you to find its source.",
                        "emotion": "grave",
                    }],
                    "suggested_actions": ["Ask for a map", "Request more details"],
                    "state_changes": [],
                }),
                ("npc_evaluator", {"grade": "pass", "comment": "Fits the source and NPC profile."}),
            ],
        )
        resumed_draft = resume_response["result"]["data"]
        approved = self.app.call("approve", "invoke", {
            "tool": "resolve_turn",
            "arguments": {"campaign": rejected, "draft": resumed_draft, "approved": True},
        })["result"]["data"]
        self.assertEqual(approved["turn"], 1)
        self.assertEqual(approved["scene_title"], "Syndra's Study")
        narration_event = next(event for event in approved["events"] if event.get("kind") == "narration" and event.get("turn") == 1)
        self.assertEqual(narration_event["snapshot"]["dialogue"][0]["speaker"], "Syndra Silvane")
        self.assertIn("dialogue", [event.get("kind") for event in approved["events"]])
        self.assertEqual(approved["state_notes"], [])

        # Reload/resume from the approved campaign object and verify its state is carried forward.
        resumed_response, _ = self.app.invoke_with_models(
            "next-turn",
            "draft_turn",
            {"campaign": approved, "action": "Continue toward the inland trail"},
            "invoke-next",
            [
                ("intent_classifier", {"intent": "CAMPAIGN"}),
                ("story_agent", story),
                ("campaign_executor", {
                    "narrative": "The party follows the trail toward the jungle edge.",
                    "scene_summary": "The Inland Trail",
                    "suggested_actions": ["Follow the tracks", "Look for a guide"],
                    "state_changes": [{"kind": "quest", "text": "The party set out from Port Nyanzaru."}],
                }),
                ("campaign_evaluator", {"grade": "pass", "comment": "Advances from the saved scene."}),
            ],
        )
        next_draft = resumed_response["result"]["data"]
        self.assertEqual(next_draft["intent"], "CAMPAIGN")
        self.assertEqual(next_draft["scene_title"], "The Inland Trail")

    def test_voice_tokens_lock_distinct_transcription_and_speech_configs(self):
        class FakeResponse:
            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

            def read(self):
                return b'{"name":"authTokens/short-lived-token"}'

        with patch.object(executa_module.urllib.request, "urlopen", return_value=FakeResponse()) as urlopen:
            result = executa_module._invoke({
                "tool": "voice_token",
                "arguments": {"type": "audio", "emotion": "curious", "voice_name": "Kore"},
                "context": {"credentials": {"GEMINI_API_KEY": "unit-test-secret"}},
            })

        request = urlopen.call_args.args[0]
        body = json.loads(request.data)
        self.assertEqual(request.get_header("X-goog-api-key"), "unit-test-secret")
        self.assertEqual(result["data"]["token"], "authTokens/short-lived-token")
        self.assertEqual(result["data"]["model"], "gemini-3.8-live")
        self.assertEqual(body["liveConnectConstraints"]["model"], "models/gemini-3.8-live")
        self.assertEqual(body["liveConnectConstraints"]["config"]["responseModalities"], ["AUDIO"])
        self.assertEqual(
            body["liveConnectConstraints"]["config"]["speechConfig"]["voiceConfig"]["prebuiltVoiceConfig"]["voiceName"],
            "Kore",
        )
        self.assertIn("curious", body["liveConnectConstraints"]["config"]["systemInstruction"]["parts"][0]["text"])
        self.assertNotIn("unit-test-secret", json.dumps(result))

        with patch.object(executa_module.urllib.request, "urlopen", return_value=FakeResponse()) as urlopen:
            result = executa_module._invoke({
                "tool": "voice_token",
                "arguments": {"type": "text"},
                "context": {"credentials": {"GEMINI_API_KEY": "unit-test-secret"}},
            })
        body = json.loads(urlopen.call_args.args[0].data)
        self.assertEqual(result["data"]["model"], "gemini-3.5-transcribe-live")
        self.assertEqual(body["liveConnectConstraints"]["model"], "models/gemini-3.5-transcribe-live")
        self.assertEqual(body["liveConnectConstraints"]["config"]["responseModalities"], ["TEXT"])
        self.assertIn("inputAudioTranscription", body["liveConnectConstraints"]["config"])

    def test_setup_retries_schema_errors_and_never_persists_not_ready_campaigns(self):
        story = {
            "found": True,
            "chapter": "Preface",
            "section": "Starting the Adventure",
            "content": "Syndra recruits adventurers in Port Nyanzaru.",
        }
        opening = {
            "ready": True,
            "message": "Ready to play.",
            "narrative": "The harbor air is thick with heat as the party reaches Port Nyanzaru.",
            "scene_summary": "Port Nyanzaru",
            "suggested_actions": ["Meet Syndra", "Find a guide"],
            "next_scene_suggestions": ["Hear the rumor", "Explore the docks"],
            "progress": 0.1,
        }
        args = {
            "name": "Review Campaign",
            "campaign_id": "setup-retry",
            "game_id": "tomb-of-annihilation",
            "premise": "A hopeful expedition.",
            "party": [{"name": "Mira", "class": "Ranger", "role": "Trail Guide"}],
        }
        response, sampled = self.app.invoke_with_models(
            "retry-setup",
            "create_campaign",
            args,
            "invoke-retry-setup",
            [
                ("story_agent", story),
                ("setup_executor", {**opening, "suggested_actions": "not an array"}),
                ("setup_executor", opening),
            ],
        )
        self.assertEqual(sampled, ["story_agent", "setup_executor", "setup_executor"])
        self.assertEqual(response["result"]["data"]["id"], "setup-retry")
        self.assertEqual(
            [event["iteration"] for event in response["result"]["data"]["trace"] if event["agent"] == "setup_checker"],
            [1, 2],
        )

        not_ready = {**opening, "ready": False, "message": "Choose a class for every adventurer."}
        response, sampled = self.app.invoke_with_models(
            "blocked-setup",
            "create_campaign",
            {**args, "campaign_id": "not-ready-campaign"},
            "invoke-not-ready",
            [("story_agent", story), ("setup_executor", not_ready)],
        )
        self.assertEqual(sampled, ["story_agent", "setup_executor"])
        self.assertIn("Choose a class", response["error"]["message"])

    def test_natural_npc_name_and_open5e_spell_lookup(self):
        tool_results, tools_fired = gather_tool_results(
            "Ask Syndra about Fireball", {"id": "campaign-1", "party": [], "events": []}, "NPC_DIALOGUE"
        )
        self.assertIn("lookup_character", tools_fired)
        self.assertIn("lookup_character_resource", tools_fired)
        self.assertTrue(any(item.get("Name") == "Syndra Silvane" for item in tool_results["characters"]))
        self.assertTrue(any(item.get("name", "").casefold() == "fireball" for item in tool_results["resources"].get("spells", [])))

    def test_local_env_accepts_original_google_key_name_without_loading_other_settings(self):
        original_read_text = Path.read_text

        def fake_read_text(path, *args, **kwargs):
            if path == ROOT / ".env":
                return 'export GOOGLE_API_KEY="unit-test-secret"\nGOOGLE_MODEL=ignored-model\n'
            return original_read_text(path, *args, **kwargs)

        with patch.dict(os.environ, {}, clear=False):
            os.environ.pop("GEMINI_API_KEY", None)
            os.environ.pop("GOOGLE_API_KEY", None)
            with patch.object(Path, "read_text", new=fake_read_text):
                self.assertEqual(executa_module._voice_api_key({}), "unit-test-secret")

    def test_voice_missing_key_and_invalid_game_state_are_actionable(self):
        voice = self.app.call("voice", "invoke", {"tool": "voice_token", "arguments": {}, "context": {}})
        self.assertIn("GEMINI_API_KEY", voice["error"]["message"])
        invalid = self.app.call("empty-action", "invoke", {
            "tool": "draft_turn",
            "arguments": {"campaign": {"id": "campaign-1"}, "action": " "},
        })
        self.assertIn("Describe what the party wants to do", invalid["error"]["message"])


if __name__ == "__main__":
    unittest.main()
