import re
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CHART = ROOT / "deploy/helm/ptr"


def helm_template(profile: str, *extra: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["timeout", "30s", "helm", "template", "ptr", str(CHART),
         "--namespace", "ptr-system", "--values", str(CHART / f"values-{profile}.yaml"),
         *extra],
        check=False,
        text=True,
        capture_output=True,
    )


def document(rendered: str, kind: str, name: str) -> str:
    for item in rendered.split("\n---\n"):
        if re.search(rf"(?m)^kind: {kind}$", item) and re.search(
            rf"(?m)^  name: {re.escape(name)}$", item
        ):
            return item
    raise AssertionError(f"missing {kind}/{name}")


class InferenceChartContractTest(unittest.TestCase):
    def test_kind_simulator_has_fixed_ttft_without_kv_transfer(self) -> None:
        result = helm_template("kind")
        self.assertEqual(result.returncode, 0, result.stderr)
        deployment = document(result.stdout, "Deployment", "ptr-sim")

        for arg in (
            "--time-to-first-token=8s",
            "--time-to-first-token-std-dev=0s",
            "--inter-token-latency-std-dev=0s",
        ):
            self.assertIn(arg, deployment)
        self.assertNotIn("--kv-cache-transfer-latency", deployment)
        self.assertNotIn("--time-factor-under-load", deployment)

    def test_prod_vllm_is_pinned_offline_and_uses_local_weights(self) -> None:
        result = helm_template("prod")
        self.assertEqual(result.returncode, 0, result.stderr)
        deployment = document(result.stdout, "Deployment", "ptr-vllm")
        pdb = document(result.stdout, "PodDisruptionBudget", "ptr-vllm")

        expected_image = (
            "vllm/vllm-openai:v0.18.0@sha256:"
            "c32358ebfc115d56ade2acfdbcd00df5b115417dbd6006547c88f07e2b39de06"
        )
        self.assertIn(f"image: {expected_image}", deployment)
        for field in (
            "replicas: 2",
            "maxSurge: 1",
            "maxUnavailable: 0",
            "--model\n            - /models/qwen3-8b",
            "--max-num-seqs\n            - \"8\"",
            "--dtype\n            - \"bfloat16\"",
            "--enforce-eager",
            "--max-model-len\n            - \"16384\"",
            'name: HF_HUB_OFFLINE, value: "1"',
            'name: TRANSFORMERS_OFFLINE, value: "1"',
            "readOnly: true",
            "claimName: ptr-qwen3-8b",
            "mountPath: /dev/shm",
            "medium: Memory",
            "sizeLimit: 8Gi",
        ):
            self.assertIn(field, deployment)
        self.assertIn("maxUnavailable: 1", pdb)

    def test_prod_vllm_requires_existing_model_claim(self) -> None:
        result = helm_template("prod", "--set", "inference.engine.weights.existingClaim=")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn(
            "inference.engine.weights.existingClaim is required when inference.engine.kind=vllm",
            result.stderr,
        )

    def test_api_server_egress_port_is_value_driven(self) -> None:
        result = helm_template("prod", "--set", "inference.apiServerPort=6443")
        self.assertEqual(result.returncode, 0, result.stderr)
        policy = document(result.stdout, "NetworkPolicy", "ptr-inference-router-egress")
        self.assertIn("cidr: \"192.0.2.1/32\"", policy)
        self.assertIn("port: 6443", policy)

    def test_kind_up_labels_inference_namespace_like_chart(self) -> None:
        up_script = (ROOT / "deploy/kind/up.sh").read_text()
        self.assertIn("ptr.io/namespace=inference", up_script)


if __name__ == "__main__":
    unittest.main()
