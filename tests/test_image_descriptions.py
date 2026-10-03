"""Only synthetic bytes/mappings/descriptions: never real research material."""

import copy
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from persona_timeline_rag import image_descriptions as mod


def synthetic(root):
    people = ["synthetic_a", "synthetic_b", "synthetic_c", "synthetic_d"]
    posts, sources, mapping = [], [], {}
    for index, person in enumerate(people):
        filename = f"{person}-{index}.jpg"
        relative = f"{person}/images/{filename}"
        path = root / "data/subsets/instagram" / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        # Two different files have identical content: preserve both associations.
        path.write_bytes(b"\xff\xd8\xff" + bytes([index // 2]))
        post = {"person_id": person, "post_id": str(index), "image_files": [relative],
                "source_file": f"{person}/metadata/{person}-{index}.info",
                "caption": "synthetic\u2028caption"}
        posts.append(post)
        sources.append({"id": f"{person}:{index}", "personId": person, "hash": str(index)})
        mapping[f"{person}-{index}.info"] = [filename]
    mod.atomic_json(root / "data/manifests/targets.json",
                    {"people": [{"username": person} for person in people]})
    mod.atomic_json(root / "data/manifests/image_mapping.json", mapping)
    mod.atomic_json(root / "data/research/sources.json", sources)
    path = root / "data/processed/target_posts.jsonl"
    path.parent.mkdir(parents=True)
    path.write_text("\n".join(json.dumps(post, ensure_ascii=False) for post in posts) + "\n")
    return posts


def rows_for(batch):
    return [{"imageId": image["imageId"], "description_ko": "합성 사물이 보인다.",
             **{field: [] for field in mod.DETAIL_FIELDS}} for image in batch]


class ImageDescriptionTests(unittest.TestCase):
    def test_inventory_sha_dedup_associations_unicode_and_orphan_exclusion(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            synthetic(root)
            (root / "data/subsets/instagram/orphan.jpg").write_bytes(b"not a JPEG")
            inv = mod.inventory(root)
            self.assertEqual(inv["posts"], 4)
            self.assertEqual(inv["referenced_files"], 4)
            self.assertEqual(len(inv["images"]), 2)
            self.assertEqual(sum(len(row["associations"]) for row in inv["images"]), 4)
            self.assertEqual(len(inv["images"][0]["sha256"]), 64)
            self.assertNotIn("caption", json.dumps(inv))

    def test_scope_mapping_source_and_path_guards(self):
        for mutation in ("person", "source", "path", "mapping", "missing"):
            with self.subTest(mutation=mutation), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                posts = synthetic(root)
                if mutation == "person":
                    posts[0]["person_id"] = "other_person"
                elif mutation == "source":
                    sources = mod.load_json(root / "data/research/sources.json")
                    sources.pop()
                    mod.atomic_json(root / "data/research/sources.json", sources)
                elif mutation == "path":
                    posts[0]["image_files"] = ["../../escape.jpg"]
                elif mutation == "mapping":
                    posts[0]["image_files"] = ["synthetic_a/images/orphan.jpg"]
                else:
                    (root / "data/subsets/instagram" / posts[0]["image_files"][0]).unlink()
                (root / "data/processed/target_posts.jsonl").write_text(
                    "\n".join(json.dumps(post) for post in posts))
                with self.assertRaises(ValueError):
                    mod.inventory(root)

    def test_changed_original_hash_blocks_resume(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            posts = synthetic(root)
            mod.run(root, 1, None, 30, status_only=True)
            original = root / "data/subsets/instagram" / posts[0]["image_files"][0]
            original.write_bytes(b"\xff\xd8\xffmodified_original")
            with self.assertRaises(ValueError):
                mod.run(root, 1, None, 30, status_only=True)

    def test_schema_count_order_text_length_extra_fields(self):
        batch = [{"imageId": "img_a"}, {"imageId": "img_b"}]
        rows = rows_for(batch)
        self.assertEqual(mod.validate_descriptions({"images": rows}, ["img_a", "img_b"]), rows)
        bad = [rows[:1], list(reversed(rows))]
        for field, value in (("description_ko", ""), ("visible_text", ["x" * 301]),
                             ("uncertainties", ["x"] * 21), ("extra", "x")):
            changed = copy.deepcopy(rows)
            changed[0][field] = value
            bad.append(changed)
        for value in bad:
            with self.assertRaises(ValueError):
                mod.validate_descriptions({"images": value}, ["img_a", "img_b"])

    def test_command_fixed_model_auth_disabled_tools_and_clean_env(self):
        args = mod.command(Path("/private"), [Path("/private/img_a.jpg")], Path("/output"))
        self.assertEqual(args[args.index("-m") + 1], "gpt-6.1-sol")
        self.assertIn('model_reasoning_effort="high"', args)
        self.assertIn('forced_login_method="chatgpt"', args)
        self.assertIn("features.shell_tool=false", args)
        self.assertIn("--ignore-user-config", args)
        self.assertIn("--ephemeral", args)
        with patch.dict(os.environ, {"OPENAI_API_KEY": "synthetic_not_a_secret",
                                    "CODEX_API_KEY": "synthetic_not_a_secret"}):
            self.assertNotIn("OPENAI_API_KEY", mod.child_environment())
            self.assertNotIn("CODEX_API_KEY", mod.child_environment())

    def test_resume_no_duplicate_submission_contract_and_hash_guards(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            synthetic(root)
            def fake_execute(workspace, batch, root, timeout):
                return {"descriptions": rows_for(batch),
                        "usage": {"input_tokens": 10, "cached_input_tokens": 2,
                                  "output_tokens": 5}}
            with patch.object(mod, "auth_preflight"), patch.object(
                    mod, "execute_batch", side_effect=fake_execute) as execute:
                first = mod.run(root, 1, 1, 30)
                self.assertEqual(first["validated_files"], 2)
                second = mod.run(root, 1, None, 30)
                self.assertTrue(second["all_validated"])
                self.assertEqual(execute.call_count, 2)
                self.assertEqual(second["observed_codex_usage"]["input_tokens"], 20)
                self.assertEqual(second["observed_codex_usage"]["cached_input_tokens"], 4)
                mod.run(root, 1, None, 30)
                self.assertEqual(execute.call_count, 2)
                with self.assertRaises(ValueError):
                    mod.run(root, 2, None, 30)
                result = root / "data/research/image_descriptions/batch-0000/result.json"
                value = mod.load_json(result)
                value["images"][0]["source"]["sha256"] = "tampered"
                mod.atomic_json(result, value)
                with self.assertRaises(ValueError):
                    mod.run(root, 1, None, 30)

    def test_failure_unknown_is_not_automatically_resubmitted(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            synthetic(root)
            with patch.object(mod, "auth_preflight"), patch.object(
                    mod, "execute_batch", side_effect=TimeoutError) as execute:
                with self.assertRaises(TimeoutError):
                    mod.run(root, 1, None, 30)
                with self.assertRaises(RuntimeError):
                    mod.run(root, 1, None, 30)
                self.assertEqual(execute.call_count, 1)
            state = mod.load_json(root / "data/research/image_descriptions/batch-0000/state.json")
            self.assertEqual(state["status"], "unknown")
            mod.ensure_resumable({"contract": "x", "status": "pending"}, "x")
            for status in ("submitted", "unknown", "failed"):
                with self.assertRaises(RuntimeError):
                    mod.ensure_resumable({"contract": "x", "status": status}, "x")

    def test_usage_preserves_reasoning_and_rejects_tools_after_recording(self):
        with tempfile.TemporaryDirectory() as temporary:
            workspace = Path(temporary)
            event = {"type": "turn.completed", "usage": {
                "input_tokens": 10, "cached_input_tokens": 2,
                "output_tokens": 5, "reasoning_output_tokens": 3}}
            path = workspace / "events.jsonl"
            path.write_text(json.dumps(event) + "\n")
            self.assertEqual(mod.record_usage(workspace), [event["usage"]])
            with path.open("a") as stream:
                stream.write(json.dumps({"type": "item.completed",
                                         "item": {"type": "command_execution"}}) + "\n")
            with self.assertRaises(RuntimeError):
                mod.record_usage(workspace)
            self.assertEqual(mod.load_json(workspace / "usage.json")["observed_usage"],
                             [event["usage"]])

    def test_reconcile_rejects_incompatible_state_before_mutation(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            synthetic(root)
            with patch.object(mod, "auth_preflight"), patch.object(
                    mod, "execute_batch", side_effect=TimeoutError):
                with self.assertRaises(TimeoutError):
                    mod.run(root, 1, None, 30)
                state_path = root / "data/research/image_descriptions/batch-0000/state.json"
                state = mod.load_json(state_path)
                state["contract"] = "wrong_contract"
                mod.atomic_json(state_path, state)
                before = state_path.read_bytes()
                with self.assertRaises(ValueError):
                    mod.run(root, 1, None, 30, reconcile=True)
                self.assertEqual(state_path.read_bytes(), before)

    def test_result_provenance_private_modes_and_single_writer_lock(self):
        import fcntl
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            synthetic(root)
            output = root / "data/research/image_descriptions"
            mod.private_dir(output)
            with (output / "runner.lock").open("a") as lock:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                with self.assertRaises(RuntimeError):
                    mod.run(root, 1, None, 30)
            inv = mod.inventory(root)
            batch = inv["images"][:1]
            result = mod.make_result(batch, rows_for(batch), {}, "synthetic_contract")
            path = output / "result.json"
            mod.atomic_json(path, result)
            mod.validate_result(path, batch, "synthetic_contract")
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            self.assertEqual(output.stat().st_mode & 0o777, 0o700)
            result["images"][0]["provenance"]["human_reviewed"] = True
            mod.atomic_json(path, result)
            with self.assertRaises(ValueError):
                mod.validate_result(path, batch, "synthetic_contract")


if __name__ == "__main__":
    unittest.main()
