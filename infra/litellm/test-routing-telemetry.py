#!/usr/bin/env python3
"""Routing telemetry parser contracts, using synthetic strings and no IO."""

import importlib.util
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location(
    "routing_telemetry", Path(__file__).with_name("routing_telemetry.py")
)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
parse_metrics = module.parse_metrics
metrics_url = module.metrics_url


class ParseMetricsTests(unittest.TestCase):
    def test_capacity_running_sum_invalid_family_and_legacy_tuple(self):
        text = 'vllm:num_requests_running{engine="a"} 4\nvllm:num_requests_running{engine="b"} 4\n'
        self.assertEqual(module.parse_capacity_metrics(text), (None, None, None, 8))
        self.assertEqual(parse_metrics(text), (None, None, None))
        self.assertEqual(
            module.parse_capacity_metrics(text + "vllm:num_requests_running NaN")[3], None
        )

    def test_modern_kv_max_waiting_sum_and_start(self):
        self.assertEqual(
            parse_metrics(
                'vllm:kv_cache_usage_perc{engine="a"} 0.2\n'
                'vllm:kv_cache_usage_perc{engine="b"} 0.9\n'
                'vllm:num_requests_waiting{engine="a"} 2\n'
                'vllm:num_requests_waiting{engine="b"} 3\n'
                "process_start_time_seconds 100\n"
            ),
            (0.9, 5.0, 100.0),
        )

    def test_old_and_modern_kv_names_share_maximum(self):
        self.assertEqual(
            parse_metrics("vllm:gpu_cache_usage_perc 0.8\nvllm:kv_cache_usage_perc 0.4\n"),
            (0.8, None, None),
        )

    def test_zero_and_upper_kv_boundary_are_valid(self):
        self.assertEqual(
            parse_metrics(
                "vllm:kv_cache_usage_perc 1\n"
                "vllm:num_requests_waiting 0\n"
                "process_start_time_seconds 0\n"
            ),
            (1.0, 0.0, 0.0),
        )
        self.assertEqual(parse_metrics("vllm:gpu_cache_usage_perc 0"), (0.0, None, None))

    def test_quoted_braces_escaped_quotes_and_backslashes(self):
        self.assertEqual(
            parse_metrics(
                r'vllm:num_requests_waiting{label="brace} quote\" slash\\"} 2' + "\n"
                r'vllm:kv_cache_usage_perc{label="{nested}"} 0.7'
            ),
            (0.7, 2.0, None),
        )

    def test_comments_unknown_names_timestamp_and_exemplar_are_ignored(self):
        self.assertEqual(
            parse_metrics(
                "# HELP vllm:num_requests_waiting queues\n"
                "# TYPE vllm:kv_cache_usage_perc gauge\n\n"
                "unrelated_metric 999\n"
                "vllm:num_requests_waiting 3 123456\n"
                'vllm:kv_cache_usage_perc 0.5 # {trace_id="synthetic"} 1\n'
            ),
            (0.5, 3.0, None),
        )

    def test_nonfinite_samples_invalidate_entire_family(self):
        for bad in ("NaN", "+Inf", "-Inf", "1e999"):
            with self.subTest(bad=bad):
                self.assertEqual(
                    parse_metrics(
                        f"vllm:kv_cache_usage_perc 0.9\nvllm:gpu_cache_usage_perc {bad}\n"
                        f"vllm:num_requests_waiting 3\nvllm:num_requests_waiting {bad}\n"
                        f"process_start_time_seconds 100\nprocess_start_time_seconds {bad}\n"
                    ),
                    (None, None, None),
                )

    def test_out_of_range_kv_is_not_partial_maximum(self):
        for bad in ("-0.01", "1.01"):
            with self.subTest(bad=bad):
                self.assertEqual(
                    parse_metrics(
                        f"vllm:kv_cache_usage_perc 0.8\nvllm:gpu_cache_usage_perc {bad}\n"
                        "vllm:num_requests_waiting 4"
                    ),
                    (None, 4.0, None),
                )

    def test_negative_waiting_is_not_partial_sum(self):
        self.assertEqual(
            parse_metrics(
                'vllm:num_requests_waiting{engine="a"} 3\n'
                'vllm:num_requests_waiting{engine="b"} -1\n'
                "vllm:kv_cache_usage_perc 0.8"
            ),
            (0.8, None, None),
        )

    def test_overflowed_waiting_sum_is_unknown(self):
        self.assertEqual(
            parse_metrics(
                'vllm:num_requests_waiting{engine="a"} 1e308\n'
                'vllm:num_requests_waiting{engine="b"} 1e308'
            ),
            (None, None, None),
        )

    def test_process_start_requires_one_unique_value(self):
        same = 'process_start_time_seconds{pid="a"} 100\nprocess_start_time_seconds{pid="b"} 100'
        self.assertEqual(parse_metrics(same), (None, None, 100.0))
        self.assertEqual(
            parse_metrics(same.replace('pid="b"} 100', 'pid="b"} 200')), (None, None, None)
        )

    def test_malformed_samples_do_not_leave_partial_family(self):
        for suffix in (" nonsense", "", '{label="unterminated} 2', '{label="x"}2', '{label="x"}'):
            with self.subTest(suffix=suffix):
                self.assertEqual(
                    parse_metrics(
                        "vllm:num_requests_waiting 4\nvllm:num_requests_waiting" + suffix
                    ),
                    (None, None, None),
                )

    def test_empty_unknown_and_partial_metrics(self):
        self.assertEqual(parse_metrics(""), (None, None, None))
        self.assertEqual(parse_metrics("unknown 1\n# synthetic comment"), (None, None, None))
        self.assertEqual(parse_metrics("vllm:num_requests_waiting 2.5"), (None, 2.5, None))
        self.assertEqual(parse_metrics("process_start_time_seconds -1"), (None, None, None))


class MetricsUrlTests(unittest.TestCase):
    def test_api_path_is_replaced_not_appended(self):
        self.assertEqual(metrics_url("http://127.0.0.1:18000/v1"), "http://127.0.0.1:18000/metrics")
        self.assertEqual(
            metrics_url("https://engine.example/v1/"), "https://engine.example/metrics"
        )

    def test_ipv6_origin_is_preserved(self):
        self.assertEqual(metrics_url("http://[::1]:18000/v1"), "http://[::1]:18000/metrics")

    def test_unsafe_or_ambiguous_urls_rejected_without_echo(self):
        for origin in (
            "",
            "/v1",
            "ftp://engine.example/v1",
            "http:///v1",
            "http://user:secret@engine.example/v1",
            "http://engine.example/v1?token=secret",
            "http://engine.example/v1#fragment",
            "http://engine.example:99999/v1",
            "http://engine.example:0/v1",
            "http://engine.example:not-a-port/v1",
            "http://engine.example/\\other",
            "http://engine.example/\npath",
            " http://engine.example/v1",
            "http://engine.example/ path",
        ):
            with self.subTest(origin=origin):
                with self.assertRaisesRegex(ValueError, "^INVALID_METRICS_ORIGIN$"):
                    metrics_url(origin)


if __name__ == "__main__":
    unittest.main()
