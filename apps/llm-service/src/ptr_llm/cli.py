"""Independent service and domain-operation entrypoint; failures never print private data."""

from __future__ import annotations

import argparse
import asyncio
import importlib
import inspect
import json
import sys


def review(args: argparse.Namespace) -> int:
    from ptr_llm.evaluation.langfuse import load_approved_review, record_human_review
    from ptr_llm.telemetry import FrameworkTelemetry, TelemetryConfig

    request = load_approved_review(args.private_file, args.approval)
    config = TelemetryConfig.from_env()
    if not config.enabled:
        raise ValueError("Review requires explicitly enabled self-hosted Langfuse")
    telemetry = FrameworkTelemetry(config)
    try:
        record_human_review(
            telemetry.client,
            request.queueId,
            request.itemId,
            request.traceId,
            [score.model_dump(exclude_none=True) for score in request.scores],
        )
        print(
            json.dumps(
                {
                    "scores": len(request.scores),
                    "completed": True,
                    "source": request.source,
                    "humanReviewerImpersonated": False,
                }
            )
        )
        return 0
    finally:
        telemetry.shutdown()


def evaluate(args: argparse.Namespace) -> int:
    from ptr_llm.evaluation import domain
    from ptr_llm.evaluation.langfuse import (
        load_approved_migration,
        migrate_dataset,
        run_framework_experiment_async,
    )
    from ptr_llm.telemetry import FrameworkTelemetry, TelemetryConfig

    config = TelemetryConfig.from_env()
    if not config.enabled:
        raise ValueError("Evaluation requires explicitly enabled self-hosted Langfuse")
    telemetry = FrameworkTelemetry(config)
    client = telemetry.client
    try:
        migration = (
            load_approved_migration(args.private_file, args.approval)
            if (args.private_file)
            else domain.synthetic_domain_migration()
        )
        if args.existing_dataset and (not args.dataset or args.private_file):
            raise ValueError("Existing dataset mode requires dataset and no import")
        imported = (
            {"items": 0}
            if args.existing_dataset
            else migrate_dataset(client, args.dataset, migration)
        )
        if args.private_file and not args.task:
            print(json.dumps(imported))
            return 0

        task = domain.synthetic_domain_task(telemetry)
        evaluators = domain.evaluators
        policy = domain.SCORE_POLICY
        review_dimensions = None
        if args.task:
            module = importlib.import_module(args.task)
            if not callable(getattr(module, "setup", None)):
                task, evaluators, policy = module.task, module.evaluators, module.score_policy
            review_dimensions = getattr(module, "review_dimensions", None)

        async def execute():
            # Optional module lifecycle is created and closed on the same owning loop.
            selected_task, selected_evaluators, selected_policy = task, evaluators, policy
            dimensions = review_dimensions
            close = getattr(module, "close", None) if args.task else None
            if args.task and callable(getattr(module, "setup", None)):
                setup = module.setup()
                selected = await setup if inspect.isawaitable(setup) else setup
                selected_task = selected["task"]
                selected_evaluators = selected["evaluators"]
                selected_policy = selected["score_policy"]
                dimensions = selected.get("review_dimensions", dimensions)
                close = selected.get("close", close)
            try:
                return await run_framework_experiment_async(
                    client,
                    args.dataset,
                    args.run,
                    {
                        "code": config.release,
                        "cases": migration.revision,
                        "engine": "injected-app" if args.task else "native-core-boundary-no-model",
                    },
                    selected_task,
                    selected_evaluators,
                    selected_policy,
                    queue_name=args.review_queue,
                    telemetry=telemetry,
                    review_dimensions=dimensions,
                )
            finally:
                if close:
                    closed = close()
                    if inspect.isawaitable(closed):
                        await closed

        result = asyncio.run(execute())
        print(json.dumps({**imported, **result}))
        return int(
            bool(result["failedScores"] or result["missingScores"] or result["taskFailures"])
        )
    finally:
        telemetry.shutdown()


def main(argv: list[str] | None = None) -> int:
    argv = sys.argv[1:] if argv is None else argv
    # Lazy loading keeps domain CLI free of the runtime/queue connection side effects.
    if argv and argv[0] in {"worker", "serve"}:
        from ptr_llm.__main__ import run_process

        run_process(argv[0])
        return 0
    if argv and argv[0] == "ingest":
        from persona_timeline_rag.cli import main as ingest_main

        # No duplicate ingestion implementation; errors remain inside existing package.
        return ingest_main(argv[1:])
    parser = argparse.ArgumentParser(description="Python LLM service tools")
    commands = parser.add_subparsers(dest="command", required=True)
    evaluation = commands.add_parser("evaluate")
    evaluation.add_argument("--dataset", default="ptr-synthetic-domain-regression")
    evaluation.add_argument("--run", default="synthetic-python")
    evaluation.add_argument(
        "--task", help="Python module exporting task/evaluators/score_policy or async setup"
    )
    evaluation.add_argument("--existing-dataset", action="store_true")
    evaluation.add_argument("--private-file")
    evaluation.add_argument("--approval", default="")
    evaluation.add_argument("--review-queue")
    review_command = commands.add_parser("review")
    review_command.add_argument("--private-file", required=True)
    review_command.add_argument("--approval", default="")
    persona = commands.add_parser("persona")
    persona.add_argument("operation", choices=["validate", "publish", "restore"])
    persona.add_argument("file")
    persona.add_argument("--confirm", action="store_true")
    persona.add_argument(
        "--target", choices=["ptr_split_test", "ptr_split_research"], required=True
    )
    for flag in [
        "sources-doc",
        "split-file",
        "captions-file",
        "generated-list",
        "baseline",
        "authored-list",
        "publish-log",
    ]:
        persona.add_argument("--" + flag)
    args = parser.parse_args(argv)
    try:
        if args.command == "review":
            return review(args)
        if args.command == "persona":
            from ptr_llm.evaluation.persona_cli import run

            if args.operation != "restore" and not all(
                [args.sources_doc, args.split_file, args.captions_file]
            ):
                raise ValueError("Explicit validation source files required")
            if args.operation in {"publish", "restore"} and not all(
                [args.authored_list, args.publish_log]
            ):
                raise ValueError("Explicit publication artifact paths required")
            return asyncio.run(run(args))
        return evaluate(args)
    except Exception:
        print("LLM operation failed (private details withheld)", file=sys.stderr)
        return 1
