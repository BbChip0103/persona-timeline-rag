import json

import pytest

from ptr_llm.billing import ProviderError
from ptr_llm.ingestion.summaries import (
    SUMMARY_PROMPT_REVISION,
    build_index,
    build_summary_messages,
    embedding_batches,
    exclusive_run,
    location_tags,
    summary_date,
    validate_summary,
)


def source(**changes):
    return {
        "id": "synthetic:1",
        "personId": "synthetic",
        "caption": "합성 호수 여행. 다시 방문하고 싶다.",
        "postedAt": "2026-10-11T00:00:00Z",
        "eventDate": None,
        "hash": "synthetic-hash",
        "unsafe": False,
        "imageAnnotations": [{"text": "Visual description: 청록색 호수가 보인다."}],
        **changes,
    }


def test_summary_date_uses_event_else_upload_without_changing_source():
    post = source()
    assert summary_date(post) == ("2026-10-11", "posted")
    assert post["eventDate"] is None
    assert summary_date(source(eventDate="2025-02-03")) == ("2025-02-03", "event")


def test_prompt_uses_caption_images_and_explicit_location_not_metadata_or_persona():
    post = source(secret="not for model", sourceUrl="https://example.invalid/post")
    messages = build_summary_messages(post, "합성호수")
    data = json.loads(messages[1]["content"])
    assert data["caption"] == post["caption"]
    assert data["image_descriptions"] == [post["imageAnnotations"][0]["text"]]
    assert data["location_tag"] == "합성호수"
    assert data["summary_date"] == "2026-10-11"
    assert "secret" not in data and "sourceUrl" not in data
    assert SUMMARY_PROMPT_REVISION in messages[0]["content"]


def test_summary_accepts_exactly_three_lines_and_includes_known_date_location():
    text = "2026년 10월 11일, 합성호수 여행.\n청록색 호수가 보인다.\n다시 방문하고 싶다고 한다."
    assert validate_summary(text, source(), "합성호수") == text


@pytest.mark.parametrize(
    "text",
    [
        "두 줄뿐이다.\n호수 풍경.",
        "2026년 10월 11일.\n호수 풍경.\n활동 날짜는 별도로 명시되지 않았다.",
        "2026년 10월 11일.\n호수 풍경.\n캡션으로 공유한다.",
        "2026년 10월 11일.\n호수 풍경.\n장소 미상.",
        "2026년 10월 11일.\n호수 풍경.\n" + "길다" * 1000,
        "2025년 1월 1일.\n호수 풍경.\n산이 보인다.",
    ],
)
def test_invalid_summary_is_not_silently_saved(text):
    with pytest.raises(ProviderError, match="INVALID_SUMMARY"):
        validate_summary(text, source())


def test_known_location_cannot_disappear_from_summary():
    with pytest.raises(ProviderError, match="INVALID_SUMMARY"):
        validate_summary("2026년 10월 11일.\n호수 풍경.\n산이 보인다.", source(), "합성호수")


def test_embedding_batches_stable_and_no_input_truncation():
    rows = [(str(i), "가" * 100) for i in range(70)]
    batches = embedding_batches(rows)
    assert [len(b) for b in batches] == [32, 32, 6]
    assert sum(batches, []) == rows
    with pytest.raises(ProviderError, match="INPUT_LIMIT"):
        embedding_batches([("oversize", "가" * 20000)])


def test_location_tags_read_only_explicit_name_and_handle_unicode_jsonl(tmp_path):
    raw = {
        "id": "1",
        "owner": {"username": "synthetic", "is_private": False},
        "edge_media_to_caption": {"edges": [{"node": {"text": "합성\u2028캡션"}}]},
        "location": {"name": "합성호수", "latitude": 42, "comments": "excluded"},
        "tagged_people": ["excluded"],
    }
    root = tmp_path / "metadata"
    root.mkdir()
    (root / "1.info").write_text(json.dumps(raw, ensure_ascii=False))
    processed = tmp_path / "posts.jsonl"
    processed.write_text(
        json.dumps(
            {
                "person_id": "synthetic",
                "post_id": "1",
                "caption": "합성\u2028캡션",
                "source_file": "1.info",
            },
            ensure_ascii=False,
        )
        + "\n"
    )
    assert location_tags(processed, root) == {"synthetic:1": "합성호수"}
    raw["owner"]["username"] = "different"
    (root / "1.info").write_text(json.dumps(raw))
    with pytest.raises(ProviderError, match="METADATA_SOURCE_MISMATCH"):
        location_tags(processed, root)


@pytest.mark.asyncio
async def test_live_builder_global_lock_blocks_second_process_and_releases():
    from contextlib import asynccontextmanager

    class Server:
        locked = False

    class Connection:
        async def execute(self, sql):
            if "try_advisory_lock" in sql:
                acquired = not Server.locked
                if acquired:
                    Server.locked = True
                self.row = {"acquired": acquired}
            else:
                Server.locked = False
            return self

        async def fetchone(self):
            return self.row

    class Pool:
        @asynccontextmanager
        async def connection(self):
            yield Connection()

    async with exclusive_run(Pool(), "run-a"):
        with pytest.raises(ProviderError, match="SUMMARY_BUILD_ALREADY_RUNNING"):
            async with exclusive_run(Pool(), "run-b"):
                pytest.fail("Second builder would bypass the additional cap")
    assert Server.locked is False
    async with exclusive_run(Pool(), "run-a"):
        assert Server.locked
    assert Server.locked is False


@pytest.mark.asyncio
async def test_all_summaries_stored_before_embedding_and_resume_avoids_paid_calls():
    events = []

    class Repo:
        saved = {}
        vectors = set()

        async def list_sources(self):
            return [source(id=f"synthetic:{i}") for i in range(5)]

        async def start_run(self, *args, **kwargs):
            events.append("start")

        async def fetch(self, sql, values):
            if "post_summaries" in sql:
                return [{"source_id": k, "summary": v} for k, v in self.saved.items()]
            return [{"source_id": k} for k in self.vectors]

        async def import_summary(self, run, post, summary, *args):
            self.saved[post["id"]] = summary
            events.append("save-summary")

        async def import_vector(self, run, source_id, *args):
            self.vectors.add(source_id)
            events.append("save-vector")

        async def activate_run(self, *args):
            assert len(self.saved) == len(self.vectors) == 5
            events.append("activate")

    class Client:
        model = "synthetic-model"

        async def generate(self, messages, **kwargs):
            events.append("generate")
            return "2026년 10월 11일, 호수 여행.\n청록색 호수가 보인다.\n다시 방문하고 싶다고 한다."

        async def embed(self, inputs):
            assert len(repo.saved) == 5
            events.append("embed")
            return [[1.0] * 1536 for _ in inputs]

    repo = Repo()
    result = await build_index(repo, Client(), run_id="synthetic-run", locations={}, activate=True)
    assert result["summaries"] == result["vectors"] == 5
    assert result["activated"] is True
    assert events.index("embed") > max(i for i, e in enumerate(events) if e == "save-summary")
    events.clear()
    resumed = await build_index(repo, Client(), run_id="synthetic-run", locations={}, activate=True)
    assert resumed["newSummaries"] == 0
    assert events == ["start", "activate"]


@pytest.mark.asyncio
async def test_summary_failure_never_embeds_or_activates():
    class Repo:
        async def list_sources(self):
            return [source()]

        async def start_run(self, *args, **kwargs):
            pass

        async def fetch(self, *args):
            return []

        async def import_summary(self, *args):
            pytest.fail("Invalid summary cannot be saved")

        async def activate_run(self, *args):
            pytest.fail("Incomplete index cannot activate")

    class Client:
        model = "synthetic-model"

        async def generate(self, *args, **kwargs):
            return "only one line"

        async def embed(self, inputs):
            pytest.fail("Incomplete summaries cannot embed")

    with pytest.raises(ProviderError, match="INVALID_SUMMARY"):
        await build_index(Repo(), Client(), run_id="synthetic-run", locations={}, activate=True)


def test_authored_file_requires_exact_private_source_and_annotation_bindings(tmp_path):
    from ptr_llm.ingestion.summaries import load_authored_summaries

    post = source(annotationRevision="synthetic-v1", annotationHash="annotation-hash")
    row = {
        "source_id": post["id"],
        "source_hash": post["hash"],
        "annotation_revision": post["annotationRevision"],
        "annotation_hash": post["annotationHash"],
        "summary": (
            "2026년 10월 11일, 합성호수 여행.\n청록색 호수가 보인다.\n다시 방문하고 싶다고 한다."
        ),
    }
    path = tmp_path / "summaries.jsonl"
    path.write_text(json.dumps(row) + "\n")
    path.chmod(0o600)
    assert load_authored_summaries(path, [post], {post["id"]: "합성호수"}) == {
        post["id"]: row["summary"]
    }
    row["annotation_hash"] = "stale"
    path.write_text(json.dumps(row) + "\n")
    with pytest.raises(ProviderError, match="AUTHORED_SUMMARY_SOURCE_MISMATCH"):
        load_authored_summaries(path, [post], {})
    path.write_text("")
    with pytest.raises(ProviderError, match="AUTHORED_SUMMARIES_INCOMPLETE"):
        load_authored_summaries(path, [post], {})
    path.chmod(0o644)
    with pytest.raises(ProviderError, match="PRIVATE_SUMMARY_FILE_REQUIRED"):
        load_authored_summaries(path, [post], {})


@pytest.mark.asyncio
async def test_authored_summaries_never_call_paid_generate_and_all_save_before_embed():
    from ptr_llm.ingestion.summaries import DIRECT_SUMMARY_MODEL

    posts = [source(id=f"synthetic:{i}") for i in range(2)]
    summary = "2026년 10월 11일, 호수 여행.\n청록색 호수가 보인다.\n다시 방문하고 싶다고 한다."
    events = []

    class Repo:
        saved = {}

        async def list_sources(self):
            return posts

        async def start_run(self, run, **kwargs):
            assert kwargs["summary_model"] == DIRECT_SUMMARY_MODEL

        async def fetch(self, sql, args):
            return []

        async def import_summary(self, run, post, text, model, revision):
            assert model == DIRECT_SUMMARY_MODEL
            self.saved[post["id"]] = text
            events.append("summary")

        async def import_vector(self, *args):
            events.append("vector")

        async def activate_run(self, *args):
            events.append("activate")

    class Client:
        model = "provider-model-is-not-summary-author"

        async def generate(self, *args, **kwargs):
            pytest.fail("Direct summaries must never call a paid summarizer")

        async def embed(self, texts):
            assert len(repo.saved) == len(posts)
            events.append("embed")
            return [[1.0] * 1536 for _ in texts]

    repo = Repo()
    result = await build_index(
        repo,
        Client(),
        run_id="direct",
        locations={},
        authored_summaries={p["id"]: summary for p in posts},
        activate=True,
    )
    assert result["summaries"] == result["vectors"] == 2
    assert events == ["summary", "summary", "embed", "vector", "vector", "activate"]
    with pytest.raises(ProviderError, match="AUTHORED_SUMMARIES_INCOMPLETE"):
        await build_index(repo, Client(), run_id="direct", locations={}, authored_summaries={})
