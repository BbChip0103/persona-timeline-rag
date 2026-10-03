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
        sources.append({"id": f"{person}:{index}", "personId": person, "hash": str(index),
                        "caption": post["caption"], "unsafe": False})
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
             "observed_emphasis": {"main_subjects": [], "visual_basis": []},
             "communicative_intent": {"epistemic_status": mod.INTENT_STATUS,
                                      "hypotheses": []}} for image in batch]


def annotations_for(batch):
    rows = rows_for(batch)
    for row, image in zip(rows, batch, strict=True):
        row["context_interpretations"] = [
            {"contextId": context["contextId"], "claim_origin": mod.CONTEXT_ORIGIN,
             "caption_based_summary_ko": "", "contextual_interpretation_ko": "",
             "uncertainty_ko": ""} for context in image["contexts"]]
    return rows


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
            self.assertEqual(inv["images"][0]["imageId"], "img_000000")
            self.assertEqual(sum(len(row["contexts"]) for row in inv["images"]), 4)

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
        for field, value in (("description_ko", ""), ("description_ko", "x" * 501),
                             ("extra", "x")):

            changed = copy.deepcopy(rows)
            changed[0][field] = value
            bad.append(changed)
        for value in bad:
            with self.assertRaises(ValueError):
                mod.validate_descriptions({"images": value}, ["img_a", "img_b"])

    def test_v3_separates_observed_emphasis_and_tentative_intent(self):
        row = rows_for([{"imageId": "img_a"}])[0]
        row["observed_emphasis"] = {
            "main_subjects": ["합성 주요 대상"],
            "visual_basis": ["주요 대상과 주변의 관계가 선명하게 드러난다."]}
        hypothesis = {
            "hypothesis_ko": "주요 대상의 외관을 보여주는 구성일 가능성이 있다.",
            "visual_basis": row["observed_emphasis"]["visual_basis"].copy(),
            "confidence": "medium",
            "uncertainty_ko": "실제 촬영·게시 목적이나 광고 여부는 알 수 없다.",
            "alternatives": ["구성 자체를 기록한 사진일 수도 있다."]}
        row["communicative_intent"]["hypotheses"] = [hypothesis]
        mod.validate_descriptions({"images": [row]}, ["img_a"])
        self.assertEqual(row["description_ko"], "합성 사물이 보인다.")
        variants = []
        for field, value in (("confidence", "high"), ("confidence", 0.9),
                             ("kind", "paid_advertisement"), ("kind", "author_psychology"),
                             ("visual_basis", []), ("visual_basis", ["캡션에서 알 수 있다."]),
                             ("uncertainty_ko", ""), ("alternatives", [])):
            changed = copy.deepcopy(row)
            changed["communicative_intent"]["hypotheses"][0][field] = value
            variants.append(changed)
        changed = copy.deepcopy(row)
        changed["communicative_intent"]["epistemic_status"] = "actual_author_motive"
        variants.append(changed)
        changed = copy.deepcopy(row)
        changed["observed_emphasis"]["visual_basis"] = []
        variants.append(changed)
        changed = copy.deepcopy(row)
        changed["communicative_intent"]["hypotheses"] *= 3
        variants.append(changed)
        for variant in variants:
            with self.subTest(variant=variant), self.assertRaises(ValueError):
                mod.validate_descriptions({"images": [variant]}, ["img_a"])
        # Unclear intent remains valid, including completely ambiguous emphasis.
        mod.validate_descriptions({"images": rows_for([{"imageId": "img_a"}])}, ["img_a"])

    def test_concise_salience_bounds_allow_irrelevant_fields_empty(self):
        row = rows_for([{"imageId": "img_scenery"}])[0]
        row["description_ko"] = ("산과 호수가 넓게 펼쳐진 풍경이다. "
                                 "수면 반사와 산의 윤곽이 중심이다.")
        row["observed_emphasis"] = {
            "main_subjects": ["산과 호수 풍경"],
            "visual_basis": ["풍경이 화면 대부분을 차지하고 수면에 산이 비친다."]}
        mod.validate_descriptions({"images": [row]}, ["img_scenery"])
        self.assertNotIn("visible_objects", row)
        self.assertNotIn("colors", row)
        self.assertEqual(row["communicative_intent"]["hypotheses"], [])
        for field in ("main_subjects", "visual_basis"):
            for bad_strings in (["합성 정보"] * 4, ["x" * 121]):
                changed = copy.deepcopy(row)
                changed["observed_emphasis"][field] = bad_strings
                with self.assertRaises(ValueError):
                    mod.validate_descriptions({"images": [changed]}, ["img_scenery"])
        self.assertIn("Do not enumerate things merely", mod.PROMPT)
        self.assertIn("not a fixed object blacklist", mod.PROMPT)
        self.assertIn("Never invent intent for every photo", mod.PROMPT)
        self.assertIn("NOT human verification", mod.PROMPT)

    def test_v3_regenerates_all_targets_and_preserves_v1_v2_artifacts(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            synthetic(root)
            v1 = root / "data/research/image_descriptions"
            v1_report = root / "reports/image-description"
            mod.atomic_json(v1 / "manifest.json", {"contract": "synthetic_v1"})
            mod.atomic_json(v1 / "batch-0000/result.json", {"preserved": "v1 result and usage"})
            mod.atomic_json(v1_report / "summary.json", {"input_tokens": 99})
            v2 = root / "data/research/image_descriptions_v2"
            v2_report = root / "reports/image-description-v2"
            mod.atomic_json(v2 / "batch-0000/result.json", {"preserved": "synthetic v2 preflight"})
            mod.atomic_json(v2_report / "summary.json", {"input_tokens": 101})
            v3 = root / "data/research/image_descriptions_v3"
            mod.atomic_json(v3 / "batch-0000/result.json", {"preserved": "synthetic v3"})
            originals = {path: path.read_bytes() for directory in
                         (v1, v1_report, v2, v2_report, v3)
                         for path in directory.rglob("*") if path.is_file()}
            def fake_execute(workspace, batch, root, timeout, on_started=None):
                return {"descriptions": annotations_for(batch), "usage": {"input_tokens": 10}}
            with patch.object(mod, "auth_preflight"), patch.object(
                    mod, "execute_batch", side_effect=fake_execute) as execute:
                summary = mod.run(root, 1, None, 30)
                self.assertEqual(execute.call_count, 2)
                self.assertEqual(summary["validated_files"], 4)
                self.assertEqual(summary["prompt_version"], "original-image-ko-v3")
            for path, original in originals.items():
                self.assertEqual(path.read_bytes(), original)
            self.assertTrue((root / mod.OUTPUT_DIRECTORY / "manifest.json").exists())
            self.assertTrue((root / mod.REPORT_DIRECTORY / "summary.json").exists())
            old_row = rows_for([{"imageId": "img_a"}])[0]
            old_row.pop("observed_emphasis")
            old_row.pop("communicative_intent")
            with self.assertRaises(ValueError):
                mod.validate_descriptions({"images": [old_row]}, ["img_a"])

    def test_generic_policy_has_no_preselected_genres_subjects_or_intent_taxonomy(self):
        prompt = mod.PROMPT.lower()
        self.assertIn("central communicated content", prompt)
        self.assertIn("materially help understand, interpret or remember", prompt)
        self.assertIn("do not predetermine important subject categories", prompt)
        self.assertIn("does not automatically establish communicative significance", prompt)
        self.assertFalse(hasattr(mod, "INTENT_KINDS"))
        hypothesis_schema = mod.SCHEMA["properties"]["images"]["items"]["properties"][
            "communicative_intent"]["properties"]["hypotheses"]["items"]
        self.assertNotIn("kind", hypothesis_schema["properties"])
        self.assertFalse(hasattr(mod, "DETAIL_FIELDS"))
        self.assertEqual(mod.FIELDS, {"imageId", "description_ko", "observed_emphasis",
                                     "communicative_intent"})
        for domain_example in ("scenery", "landscape", "makeup", "cream", "product label",
                               "blue shirt", "pink cafe", "passerby"):
            self.assertNotIn(domain_example, prompt)
        self.assertEqual(mod.OUTPUT_DIRECTORY, "data/research/image_descriptions_v4")
        self.assertEqual(mod.REPORT_DIRECTORY, "reports/image-description-v4")

    def test_command_fixed_model_auth_disabled_tools_and_clean_env(self):
        args = mod.command(Path("/private"), [Path("/private/img_a.jpg")], Path("/output"))
        self.assertEqual(args[args.index("-m") + 1], "gpt-6-luna")
        self.assertIn('model_reasoning_effort="medium"', args)
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
            def fake_execute(workspace, batch, root, timeout, on_started=None):
                return {"descriptions": annotations_for(batch),
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
                result = root / "data/research/image_descriptions_v4/lane-0/batch-0000/result.json"
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
                    mod.run(root, 1, 1, 30)
                with self.assertRaises(RuntimeError):
                    mod.run(root, 1, None, 30)
                self.assertEqual(execute.call_count, 1)
            state = mod.load_json(root / mod.OUTPUT_DIRECTORY / "lane-0/batch-0000/state.json")
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
                    mod.run(root, 1, 1, 30)
                state_path = root / mod.OUTPUT_DIRECTORY / "lane-0/batch-0000/state.json"
                state = mod.load_json(state_path)
                state["contract"] = "wrong_contract"
                mod.atomic_json(state_path, state)
                before = state_path.read_bytes()
                with self.assertRaises(ValueError):
                    mod.run(root, 1, None, 30, reconcile=True)
                self.assertEqual(state_path.read_bytes(), before)

    def test_full_caption_hashtags_newlines_safe_and_unavailable_context(self):
        caption = "합성 본문 @synthetic\n#A #생일파티 🎉\n마지막 #해시태그"
        source = {"id": "synthetic_a:1", "hash": "synthetic_hash",
                  "personId": "synthetic_a", "caption": caption, "unsafe": False}
        context = mod.source_context(source, "synthetic_category", "ctx_0000")
        self.assertEqual(context["caption"], caption)
        batch = [{"imageId": "img_000000", "contexts": [context]}]
        transmitted = json.loads(mod.build_prompt(batch).split(mod.CONTEXT_ADAPTER)[1])
        self.assertEqual(transmitted[0]["contexts"][0]["caption"], caption)
        self.assertEqual(transmitted[0]["contexts"][0]["author_label"], "synthetic_a")
        self.assertNotIn("source_id", transmitted[0]["contexts"][0])
        self.assertIn("NOT any person depicted", mod.CONTEXT_ADAPTER)
        for changes, reason in (({"unsafe": True}, "source_flagged_unsafe"),
                                ({"caption": "x" * 4097}, "caption_exceeds_bound_not_truncated"),
                                ({"caption": "password=synthetic_dummy"},
                                 "credential_like_source_content")):
            unsafe = mod.source_context({**source, **changes}, "synthetic", "ctx_0000")
            self.assertIsNone(unsafe["caption"])
            self.assertEqual(unsafe["caption_unavailable_reason"], reason)
            annotated = annotations_for([{"imageId": "img_000000", "contexts": [unsafe]}])
            mod.validate_annotation({"images": annotated},
                                    [{"imageId": "img_000000", "contexts": [unsafe]}])
            annotated[0]["context_interpretations"][0]["caption_based_summary_ko"] = "invented"
            with self.assertRaises(ValueError):
                mod.validate_annotation({"images": annotated},
                                        [{"imageId": "img_000000", "contexts": [unsafe]}])

    def test_contexts_preserve_post_separation_and_reject_order_or_identity_fields(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            synthetic(root)
            batch = mod.inventory(root)["images"][:1]
            self.assertEqual(len(batch[0]["contexts"]), 2)
            self.assertEqual(len({x["source_id"] for x in batch[0]["contexts"]}), 2)
            annotated = annotations_for(batch)
            mod.validate_annotation({"images": annotated}, batch)
            for mutation in ("order", "origin", "identity"):
                changed = copy.deepcopy(annotated)
                if mutation == "order":
                    changed[0]["context_interpretations"].reverse()
                elif mutation == "origin":
                    changed[0]["context_interpretations"][0]["claim_origin"] = "verified_photo_fact"
                else:
                    changed[0]["context_interpretations"][0]["face_identity"] = "synthetic_a"
                with self.assertRaises(ValueError):
                    mod.validate_annotation({"images": changed}, batch)

    def test_partition_is_disjoint_exhaustive_exact_five_and_policy_unchanged(self):
        numbers = list(range(298))
        partitions = mod.partition_numbers(numbers)
        self.assertEqual(len(partitions), 5)
        self.assertEqual(sorted(number for lane in partitions for number in lane), numbers)
        for lane, partition in enumerate(partitions):
            self.assertTrue(all(number % 5 == lane for number in partition))
        for bad_numbers, lanes in (([0, 0], 5), ([-1], 5), ([0], 6)):
            with self.assertRaises(ValueError):
                mod.partition_numbers(bad_numbers, lanes)
        self.assertEqual(mod.PROMPT_HASH,
                         "81dc2ce6733134f908dbaa3292261a9c73ce33441110c9cc4e0f7e3fda72f3fa")
        self.assertEqual(mod.canonical_hash(mod.SCHEMA),
                         "38105d5e10359939e30e7b6c66a1c3b2e6306e1c03c627ed0afe006f73c11f60")
        self.assertEqual(mod.MODEL, "gpt-6-luna")
        self.assertEqual(mod.EFFORT, "medium")

    def test_five_independent_lanes_bound_no_overlap_and_atomic_progress(self):
        import threading
        import time
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            inv = {"persons": ["a", "b", "c", "d"], "posts": 15, "referenced_files": 15,
                   "images": [{"imageId": f"img_{index:06d}", "sha256": f"{index:064x}",
                               "files": [f"synthetic_{index}.jpg"], "associations": [],
                               "contexts": []} for index in range(15)]}
            barrier = threading.Barrier(5)
            mutex = threading.Lock()
            active, maximum, seen, active_lanes, reads = 0, 0, [], set(), []
            reader_errors = []
            done = threading.Event()
            def fake_execute(workspace, batch, root, timeout, on_started=None):
                nonlocal active, maximum
                number = int(workspace.parent.name.split("-")[1])
                lane = int(workspace.parent.parent.name.split("-")[1])
                with mutex:
                    self.assertNotIn(lane, active_lanes)
                    active_lanes.add(lane)
                    active += 1
                    maximum = max(maximum, active)
                    self.assertNotIn(number, seen)
                    seen.append(number)
                if number < 5:
                    barrier.wait(timeout=5)
                time.sleep(0.03)
                with mutex:
                    active -= 1
                    active_lanes.remove(lane)
                return {"descriptions": annotations_for(batch),
                        "usage": {"input_tokens": 10, "output_tokens": 2}}
            def read_progress():
                path = root / mod.OUTPUT_DIRECTORY / "progress.json"
                while not done.is_set():
                    if path.exists():
                        try:
                            reads.append(mod.load_json(path))
                        except Exception as error:
                            reader_errors.append(type(error).__name__)
                    time.sleep(0.001)
            reader = threading.Thread(target=read_progress)
            reader.start()
            try:
                with patch.object(mod, "inventory", return_value=inv), patch.object(
                        mod, "auth_preflight"), patch.object(mod, "execute_batch",
                                                             side_effect=fake_execute):
                    summary = mod.run(root, 1, None, 30)
            finally:
                done.set()
                reader.join(timeout=2)
            self.assertEqual(maximum, 5)
            self.assertEqual(sorted(seen), list(range(15)))
            self.assertTrue(reads)
            self.assertEqual(reader_errors, [])
            self.assertTrue(summary["all_validated"])
            self.assertEqual(summary["validated_files"], 15)
            self.assertEqual(summary["observed_codex_usage"]["input_tokens"], 150)
            self.assertEqual(summary["concurrency"], 5)
            self.assertEqual([lane["succeeded"] for lane in summary["lane_statistics"]], [3]*5)
            self.assertTrue(all(value["validated_files"] <= 15 for value in reads))

    def test_result_provenance_private_modes_and_single_writer_lock(self):
        import fcntl
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            synthetic(root)
            output = root / "data/research/image_descriptions_v4"
            mod.private_dir(output)
            with (output / "runner.lock").open("a") as lock:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                with self.assertRaises(RuntimeError):
                    mod.run(root, 1, None, 30)
            inv = mod.inventory(root)
            batch = inv["images"][:1]
            result = mod.make_result(batch, annotations_for(batch), {}, "synthetic_contract")
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
