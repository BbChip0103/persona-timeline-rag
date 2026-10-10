import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import summarize_engine_bench as bench  # noqa: E402


def result(throughput: float) -> dict:
    keys = [
        "p50_ttft_ms",
        "p95_ttft_ms",
        "p50_tpot_ms",
        "p95_tpot_ms",
        "p50_e2el_ms",
        "p95_e2el_ms",
    ]
    return {
        "completed": 8,
        "failed": 0,
        "request_throughput": throughput,
        "output_throughput": throughput * 128,
        **{key: 10.0 for key in keys},
    }


class EngineBenchSummaryTest(unittest.TestCase):
    def test_runs_are_parsed_sorted_and_joined_with_gpu_samples_inside_the_phase_window(self):
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / "vllm-e4b"
            target.mkdir()
            (target / "chat_c8.json").write_text(json.dumps(result(4.0)))
            (target / "chat_c1.json").write_text(json.dumps(result(1.0)))
            (target / "warmup.json").write_text(json.dumps(result(9.0)))
            (target / "phases.log").write_text(
                "100.0 server_ready\n1791140000.0 chat c=1 start\n1791140002.0 chat c=1 end rc=0\n"
            )
            (target / "vram_after_load_mib.txt").write_text("22733\n")
            (target / "quality.json").write_text(
                json.dumps({"summary": {"n": 12, "strict_json": 12, "mean_korean_ratio": 0.9}})
            )
            gpu = Path(tmp) / "gpu-run-vllm-e4b.csv"
            # 1791140001 == 2026-10-04 18:53:21 UTC; the second row lies outside the window.
            gpu.write_text(
                "timestamp, util, mem, power, sm, memclk, vram, temp\n"
                "2026/10/04 18:53:21.000, 90, 40, 300.0, 2500, 10000, 20000, 60\n"
                "2026/10/04 18:59:00.000, 5, 1, 50.0, 300, 405, 20000, 40\n"
            )
            summary = bench.summarize_target(target, gpu)
        self.assertEqual([run["concurrency"] for run in summary["runs"]], [1, 8])
        self.assertEqual(
            summary["runs"][0]["gpu"],
            {
                "gpu_util": 90.0,
                "mem_bw_util": 40.0,
                "power_w": 300.0,
                "sm_mhz": 2500.0,
                "samples": 1,
            },
        )
        self.assertIsNone(summary["runs"][1]["gpu"])
        self.assertEqual(summary["vram_after_load_mib"], 22733)
        self.assertFalse(summary["failed_to_start"])
        self.assertIn("| vllm-e4b | 8 | 4.0 |", bench.markdown([summary]))

    def test_failed_start_is_reported(self):
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / "sglang-e4b"
            target.mkdir()
            (target / "phases.log").write_text("1.0 server_start\n2.0 server_failed\n")
            summary = bench.summarize_target(target, None)
        self.assertTrue(summary["failed_to_start"])
        self.assertEqual(summary["runs"], [])


if __name__ == "__main__":
    unittest.main()
