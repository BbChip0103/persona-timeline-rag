"""Synthetic lifecycle diagnostic, not the frozen full-runtime acceptance gate."""

import json
from statistics import median
from time import perf_counter

from policy import CATEGORIES
from validators import Guard, PersonaOutput, RulesInput, validate_input, validate_output

INPUT = {
    "classification": "rules-only",
    "probabilities": {},
    "thresholds": dict.fromkeys(CATEGORIES, 0.5),
    "categories": list(CATEGORIES),
}
OUTPUT = {"utterance": "hello", "realPerson": False, "language": "en", "level": "polite"}


def fresh(validator, on_fail, text, metadata):
    guard = Guard(use_server=False).use(validator(on_fail=on_fail))
    guard.configure(allow_metrics_collection=False)
    try:
        return guard.validate(text, metadata=metadata, num_reasks=0)
    finally:
        guard.history.clear()


def measure(task, count=200):
    for _ in range(5):
        task()
    values = []
    for _ in range(count):
        start = perf_counter()
        task()
        values.append((perf_counter() - start) * 1000)
    values.sort()
    return {
        "samples": count,
        "p50ms": round(median(values), 3),
        "p95ms": round(values[int(count * 0.95) - 1], 3),
    }


def main():
    cases = {
        "fresh-input": lambda: fresh(RulesInput, "noop", "hello synthetic", INPUT),
        "fresh-output": lambda: fresh(
            PersonaOutput, "fix", "A cheerful fictional painting.", OUTPUT
        ),
        "thread-local-input": lambda: validate_input("hello synthetic", INPUT),
        "thread-local-output": lambda: validate_output("A cheerful fictional painting.", OUTPUT),
    }
    print(
        json.dumps(
            {
                "scope": "synthetic-lifecycle-only",
                "timings": {name: measure(task) for name, task in cases.items()},
            },
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
