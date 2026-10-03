import copy
import json
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from persona_timeline_rag import rewrite_image_intents as mod


def fixture(root, count=7):
    rows = []
    for index in range(count):
        hypotheses = (
            []
            if index == count - 1
            else [
                {
                    "hypothesis_ko": "가상의 대상을 소개하려는 사진일 수 있다.",
                    "visual_basis": ["가상의 대상이 강조되어 있다."],
                    "confidence": "low",
                    "uncertainty_ko": "실제 의도는 확인되지 않는다.",
                    "alternatives": ["다른 해석도 가능하다."],
                }
            ]
        )
        rows.append(
            {
                "visual": {
                    "imageId": f"img_{index:06d}",
                    "description_ko": "합성 검증용 장면이다.",
                    "observed_emphasis": {
                        "main_subjects": ["합성 대상"],
                        "visual_basis": ["가상의 대상이 강조되어 있다."],
                    },
                    "communicative_intent": {
                        "epistemic_status": "tentative_not_author_fact",
                        "hypotheses": hypotheses,
                    },
                },
                "source": {"files": [f"synthetic/{index}.jpg"], "associations": []},
                "caption_context": [{"synthetic_text": "본문 #태그\n유니코드\u2028구분자"}],
                "provenance": {"model": "synthetic-prior", "human_reviewed": False},
                "observed_at": "2026-01-01T00:00:00+00:00",
            }
        )
    path = root / mod.PRIOR
    mod.base.private_dir(path.parent)
    path.write_text("".join(json.dumps(row, ensure_ascii=False) + "\n" for row in rows))
    mod.base.atomic_json(
        root / "reports/image-description-v4_1/final-validation.json",
        {
            "all_validated": True,
            "validated_content_images": len(rows),
            "merged_results_sha256": mod.base.digest(path),
        },
    )
    return rows


def authority(root, contract):
    mod.base.atomic_json(
        root / mod.REPORTS / "corrective-authorization.json",
        {
            "contract": contract,
            "scope": "known_terminal_validation_only",
            "max_batches": 5,
            "max_attempts_per_batch": 1,
        },
    )


class RewriteTests(unittest.TestCase):
    def test_required_ids_and_completed_syntax_are_validation_not_repairs(self):
        items = [{"id": "hyp_000000"}, {"id": "hyp_000001"}]
        schema = mod.schema(items)
        self.assertEqual(
            schema["properties"]["rewrites"]["required"], [item["id"] for item in items]
        )
        values = {item["id"]: {"hypothesis_ko": "원래 대상을 소개한다."} for item in items}
        self.assertEqual(len(mod.validate({"rewrites": values}, items)), 2)
        for invalid in ["소개", "소개할 수 있다.", "소개한다.\n", "", "x" * 181 + "다."]:
            changed = copy.deepcopy(values)
            changed["hyp_000000"]["hypothesis_ko"] = invalid
            with self.assertRaises(ValueError):
                mod.validate({"rewrites": changed}, items)
        values.pop("hyp_000001")
        with self.assertRaises(ValueError):
            mod.validate({"rewrites": values}, items)
        self.assertIn("TEXT STYLE", mod.PROMPT)
        self.assertIn("untrusted DATA", mod.PROMPT)

    def test_parallel_bound_preservation_empty_hypotheses_and_stable_resume(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            rows = fixture(root)
            original = (root / mod.PRIOR).read_bytes()
            active = set()
            peak = 0
            seen = []
            lock = threading.Lock()
            first_wave = threading.Barrier(5)

            def fake(workspace, items, timeout, on_started):
                nonlocal peak
                lane = int(workspace.parent.parent.name.split("-")[1])
                with lock:
                    self.assertNotIn(lane, active)
                    active.add(lane)
                    peak = max(peak, len(active))
                    seen.extend(item["id"] for item in items)
                if items[0]["id"] < "hyp_000005":
                    first_wave.wait(timeout=10)
                time.sleep(0.04)
                with lock:
                    active.remove(lane)
                return {item["id"]: "가상의 대상을 소개한다." for item in items}, {
                    "input_tokens": 3
                }

            with patch.object(mod.base, "auth_preflight"), patch.object(mod, "execute", fake):
                summary = mod.run(root, batch_size=1, timeout=30)
                self.assertTrue(summary["all_validated"])
                self.assertEqual(peak, 5)
                saved = (root / mod.OUTPUT / "images.jsonl").read_bytes()
                mod.run(root, batch_size=1, timeout=30)
                self.assertEqual(saved, (root / mod.OUTPUT / "images.jsonl").read_bytes())
            self.assertEqual(len(seen), len(set(seen)))
            self.assertEqual(original, (root / mod.PRIOR).read_bytes())
            derived = [json.loads(line) for line in (root / mod.OUTPUT / "images.jsonl").open()]
            for before, after in zip(rows, derived, strict=True):
                metadata = after.pop("intent_style_derivation")
                self.assertEqual(metadata["hash"], mod.PROMPT_HASH)
                self.assertFalse(metadata["human_reviewed"])
                for number, hypothesis in enumerate(
                    before["visual"]["communicative_intent"]["hypotheses"]
                ):
                    after["visual"]["communicative_intent"]["hypotheses"][number][
                        "hypothesis_ko"
                    ] = hypothesis["hypothesis_ko"]
                self.assertEqual(before, after)

    def test_incompatible_prior_or_unknown_blocks_without_submitting(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            fixture(root)
            with patch.object(mod.base, "auth_preflight"), patch.object(mod, "execute") as execute:
                with self.assertRaises(ValueError):
                    execute.side_effect = ValueError("synthetic invalid")
                    mod.run(root, batch_size=1, limit=1, timeout=30)
                execute.reset_mock()
                with self.assertRaises(RuntimeError):
                    mod.run(root, batch_size=1, timeout=30)
                execute.assert_not_called()
                with (root / mod.PRIOR).open("a") as stream:
                    stream.write("{}\n")
                with self.assertRaises(ValueError):
                    mod.run(root, batch_size=1, timeout=30)
                execute.assert_not_called()

    def test_terminal_only_once_journal_preserves_failed_artifacts_and_usage(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            fixture(root, 2)

            def invalid(workspace, items, timeout, on_started):
                mod.base.private_dir(workspace)
                mod.base.atomic_json(workspace / "response.json", {"rewrites": {}})
                mod.base.atomic_json(workspace / "process.json", {"pid": 999999999})
                event = {"type": "turn.completed", "usage": {"input_tokens": 11}}
                (workspace / "events.jsonl").write_text(json.dumps(event) + "\n")
                mod.base.atomic_json(workspace / "usage.json", {"observed_usage": [event["usage"]]})
                raise ValueError("missing ID")

            with patch.object(mod.base, "auth_preflight"), patch.object(mod, "execute", invalid):
                with self.assertRaises(ValueError):
                    mod.run(root, batch_size=1, timeout=30)
            directory = mod.batch_path(root / mod.OUTPUT, 0)
            originals = {p: p.read_bytes() for p in directory.rglob("*") if p.is_file()}
            manifest = mod.base.load_json(root / mod.OUTPUT / "manifest.json")
            authority(root, manifest["contract"])

            def valid(workspace, items, timeout, on_started):
                return {item["id"]: "가상의 대상을 소개한다." for item in items}, {
                    "input_tokens": 7
                }

            with patch.object(mod.base, "auth_preflight"), patch.object(mod, "execute", valid):
                result = mod.run(root, batch_size=1, timeout=30, bounded_corrections=True)
            self.assertTrue(result["all_validated"])
            self.assertEqual(result["observed_codex_usage"]["input_tokens"], 18)
            for path, data in originals.items():
                self.assertEqual(path.read_bytes(), data)
            self.assertEqual(mod.base.load_json(directory / "state.json")["status"], "unknown")
            attempt = directory / "corrective-attempt-1/state.json"
            state = mod.base.load_json(attempt)
            state["status"] = "unknown"
            mod.base.atomic_json(attempt, state)
            with self.assertRaises(RuntimeError):
                mod.journal(root, [[mod.inventory(root)[1][0]]], manifest["contract"])

    def test_journal_rejects_uncertain_tools_and_total_cap(self):
        for case in ("uncertain", "tools", "cap"):
            with self.subTest(case=case), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                fixture(root, 2)
                items = mod.inventory(root)[1]
                directory = mod.batch_path(root / mod.OUTPUT, 0)
                workspace = directory / "workspace"
                mod.base.atomic_json(
                    directory / "state.json",
                    {"status": "unknown", "contract": "contract", "error_type": "ValueError"},
                )
                mod.base.atomic_json(workspace / "process.json", {"pid": 999999999})
                mod.base.atomic_json(workspace / "response.json", {"rewrites": {}})
                events = [{"type": "turn.completed", "usage": {"input_tokens": 11}}]
                if case == "uncertain":
                    events = [{"type": "turn.started"}]
                if case == "tools":
                    events.append({"type": "item.completed", "item": {"type": "command_execution"}})
                (workspace / "events.jsonl").write_text(
                    "".join(json.dumps(event) + "\n" for event in events)
                )
                mod.base.atomic_json(
                    workspace / "usage.json",
                    {
                        "observed_usage": [
                            e["usage"] for e in events if e["type"] == "turn.completed"
                        ]
                    },
                )
                authority(root, "contract")
                if case == "cap":
                    for number in range(100, 105):
                        mod.base.atomic_json(
                            mod.batch_path(root / mod.OUTPUT, number) / "recovery.json", {}
                        )
                with self.assertRaises(RuntimeError):
                    mod.journal(root, [items], "contract")

    def test_text_only_command_excludes_images_keys_and_tools(self):
        with patch.dict("os.environ", {"OPENAI_API_KEY": "synthetic-do-not-send"}):
            env = mod.base.child_environment()
        self.assertNotIn("OPENAI_API_KEY", env)
        cmd = mod.base.command(Path("/synthetic"), [], Path("/synthetic/response.json"))
        self.assertNotIn("--image", cmd)
        self.assertEqual(cmd[cmd.index("-m") + 1], "gpt-6-luna")
        self.assertIn('model_reasoning_effort="medium"', cmd)
        self.assertIn("features.shell_tool=false", cmd)


if __name__ == "__main__":
    unittest.main()
