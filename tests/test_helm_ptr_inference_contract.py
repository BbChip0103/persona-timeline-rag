import re
import subprocess
import unittest
from pathlib import Path

import yaml

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


def parsed_document(rendered: str, kind: str, name: str) -> dict:
    return yaml.safe_load(document(rendered, kind, name))


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
        self.assertNotRegex(deployment, r"(?m)^  replicas:")

    def test_prod_vllm_requires_existing_model_claim(self) -> None:
        result = helm_template("prod", "--set", "inference.engine.weights.existingClaim=")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn(
            "inference.engine.weights.existingClaim is required when inference.engine.kind=vllm",
            result.stderr,
        )

    def test_kind_autoscaling_and_monitors_match_k5_contract(self) -> None:
        result = helm_template("kind")
        self.assertEqual(result.returncode, 0, result.stderr)
        worker = document(result.stdout, "ScaledObject", "ptr-worker")
        engine = document(result.stdout, "ScaledObject", "ptr-sim")
        trigger_auth = document(result.stdout, "TriggerAuthentication", "ptr-worker-redis")
        api_hpa = document(result.stdout, "HorizontalPodAutoscaler", "ptr-api")
        engine_monitor = document(result.stdout, "ServiceMonitor", "ptr-engine")
        api_service = document(result.stdout, "Service", "ptr-api")
        engine_service = document(result.stdout, "Service", "ptr-engine-metrics")

        for field in (
            "minReplicaCount: 2",
            "maxReplicaCount: 6",
            "failureThreshold: 3",
            "replicas: 4",
            'listName: "ptr:turns:wait"',
            'listLength: "8"',
            'activationListLength: "1"',
            'listName: "ptr:turns:active"',
            'listLength: "4"',
        ):
            self.assertIn(field, worker)
        self.assertIn("key: REDIS_ADDRESS", trigger_auth)
        self.assertIn("key: REDIS_USERNAME", trigger_auth)
        self.assertIn("key: REDIS_PASSWORD", trigger_auth)
        self.assertNotIn("ptr-api", trigger_auth)
        self.assertIn("averageUtilization: 70", api_hpa)
        self.assertIn("maxReplicas: 4", api_hpa)
        for field in (
            "minReplicaCount: 1",
            "maxReplicaCount: 2",
            "stabilizationWindowSeconds: 60",
            "metricType: Value",
            "query: sum(llm_d_epp_flow_control_queue_size)",
            'threshold: "4"',
            'query: "avg(vllm:kv_cache_usage_perc{pool=\\"chat-primary\\"})"',
            'threshold: "0.8"',
        ):
            self.assertIn(field, engine)
        self.assertEqual(engine.count("metricType: Value"), 1)
        self.assertEqual(
            [trigger.get("metricType", "AverageValue") for trigger in
             parsed_document(result.stdout, "ScaledObject", "ptr-sim")["spec"]["triggers"]],
            ["AverageValue", "Value"],
        )
        self.assertIn('ptr.io/monitoring: "true"', api_service)
        self.assertIn('ptr.io/monitoring: "true"', engine_service)
        self.assertIn("targetLabel: pool", engine_monitor)
        self.assertIn('replacement: "chat-primary"', engine_monitor)
        self.assertNotIn("kind: PodDisruptionBudget\nmetadata:\n  name: ptr-sim", result.stdout)

    def test_prod_autoscaling_limits_and_engine_pdb_match_k5_contract(self) -> None:
        result = helm_template("prod")
        self.assertEqual(result.returncode, 0, result.stderr)
        worker = document(result.stdout, "ScaledObject", "ptr-worker")
        engine = document(result.stdout, "ScaledObject", "ptr-vllm")
        engine_pdb = document(result.stdout, "PodDisruptionBudget", "ptr-vllm")
        litellm_hpa = document(result.stdout, "HorizontalPodAutoscaler", "ptr-litellm")
        bootstrap = document(result.stdout, "Job", "ptr-litellm-bootstrap-app-key")
        prod_values = (CHART / "values-prod.yaml").read_text()

        self.assertIn("maxReplicaCount: 40", worker)
        self.assertIn("minReplicaCount: 2", worker)
        self.assertNotIn("enableTLS", worker)
        self.assertNotIn("unsafeSsl", worker)
        trigger_auth = document(result.stdout, "TriggerAuthentication", "ptr-worker-redis")
        self.assertIn("parameter: tls", trigger_auth)
        self.assertIn("key: REDIS_TLS_MODE", trigger_auth)
        self.assertIn("parameter: ca", trigger_auth)
        self.assertIn("key: REDIS_CA", trigger_auth)
        self.assertIn("maxReplicaCount: 32", engine)
        self.assertEqual(
            [trigger.get("metricType", "AverageValue") for trigger in
             parsed_document(result.stdout, "ScaledObject", "ptr-vllm")["spec"]["triggers"]],
            ["AverageValue", "Value"],
        )
        self.assertIn("stabilizationWindowSeconds: 600", engine)
        self.assertIn("maxUnavailable: 1", engine_pdb)
        self.assertIn("maxReplicas: 6", litellm_hpa)
        self.assertIn('value: "5000"', bootstrap)
        self.assertIn(
            "Minimum floor: 40 max workers * 4 concurrent turns * 1.25 headroom = 200.",
            prod_values,
        )

    def test_kind_worker_redis_scaler_does_not_enable_tls_for_plain_redis(self) -> None:
        result = helm_template("kind")
        self.assertEqual(result.returncode, 0, result.stderr)
        worker = document(result.stdout, "ScaledObject", "ptr-worker")
        trigger_auth = document(result.stdout, "TriggerAuthentication", "ptr-worker-redis")
        self.assertNotIn("enableTLS", worker)
        self.assertNotIn("parameter: ca", trigger_auth)

    def test_rediss_without_custom_ca_uses_scaledobject_tls(self) -> None:
        result = helm_template("prod", "--set", "autoscaling.worker.redis.caKey=")
        self.assertEqual(result.returncode, 0, result.stderr)
        worker = document(result.stdout, "ScaledObject", "ptr-worker")
        trigger_auth = document(result.stdout, "TriggerAuthentication", "ptr-worker-redis")
        self.assertEqual(2, worker.count('enableTLS: "true"'))
        self.assertNotIn("parameter: tls", trigger_auth)
        self.assertNotIn("parameter: ca", trigger_auth)

    def test_autoscaled_deployments_leave_replica_ownership_to_hpa(self) -> None:
        result = helm_template("kind")
        self.assertEqual(result.returncode, 0, result.stderr)
        for name in ("ptr-api", "ptr-web", "ptr-worker", "ptr-litellm", "ptr-sim"):
            self.assertNotRegex(document(result.stdout, "Deployment", name), r"(?m)^  replicas:")

        result = helm_template(
            "kind", "--set", "autoscaling.hpa.enabled=false",
            "--set", "autoscaling.worker.enabled=false",
            "--set", "autoscaling.engine.enabled=false",
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        for name in ("ptr-api", "ptr-web", "ptr-worker", "ptr-litellm", "ptr-sim"):
            self.assertRegex(document(result.stdout, "Deployment", name), r"(?m)^  replicas: [12]$")

    def test_api_server_egress_port_is_value_driven(self) -> None:
        result = helm_template("prod", "--set", "inference.apiServerPort=6443")
        self.assertEqual(result.returncode, 0, result.stderr)
        policy = document(result.stdout, "NetworkPolicy", "ptr-inference-router-egress")
        self.assertIn("cidr: \"192.0.2.1/32\"", policy)
        self.assertIn("port: 6443", policy)

    def test_k5_network_policies_cover_metrics_scalers_and_maintenance(self) -> None:
        result = helm_template("kind")
        self.assertEqual(result.returncode, 0, result.stderr)
        for name, port in (
            ("ptr-api-monitoring-ingress", 56441),
            ("ptr-litellm-monitoring-ingress", 4000),
            ("ptr-inference-monitoring-ingress", 8000),
            ("ptr-epp-monitoring-ingress", 9090),
            ("ptr-keda-redis-ingress", 6379),
            ("ptr-prometheus-keda-ingress", 9090),
            ("ptr-maintenance-to-data", 5432),
            ("ptr-maintenance-data-ingress", 5432),
            ("ptr-keda-operator-egress", 6379),
            ("ptr-prometheus-egress", 56441),
        ):
            policy = document(result.stdout, "NetworkPolicy", name)
            self.assertIn(f"port: {port}", policy)
        for name in (
            "ptr-api-monitoring-ingress",
            "ptr-litellm-monitoring-ingress",
            "ptr-inference-monitoring-ingress",
            "ptr-epp-monitoring-ingress",
        ):
            policy = document(result.stdout, "NetworkPolicy", name)
            self.assertIn("podSelector:", policy)
            self.assertIn("app.kubernetes.io/name: prometheus", policy)

        prod = helm_template("prod")
        self.assertEqual(prod.returncode, 0, prod.stderr)
        managed = document(prod.stdout, "NetworkPolicy", "ptr-keda-operator-egress")
        self.assertIn('cidr: "198.51.100.0/24"', managed)

    def test_keda_grpc_and_webhook_flows_are_scoped(self) -> None:
        result = helm_template("kind")
        self.assertEqual(result.returncode, 0, result.stderr)
        operator_ingress = parsed_document(
            result.stdout, "NetworkPolicy", "ptr-keda-operator-grpc-ingress"
        )
        metrics_egress = parsed_document(
            result.stdout, "NetworkPolicy", "ptr-keda-metrics-grpc-egress"
        )
        [ingress] = operator_ingress["spec"]["ingress"]
        [egress] = metrics_egress["spec"]["egress"]
        operator = {"app.kubernetes.io/name": "keda-operator"}
        metrics = {"app.kubernetes.io/name": "keda-operator-metrics-apiserver"}
        self.assertEqual(operator_ingress["spec"]["podSelector"]["matchLabels"], operator)
        self.assertEqual(metrics_egress["spec"]["podSelector"]["matchLabels"], metrics)
        self.assertEqual(ingress["from"], [{"podSelector": {"matchLabels": metrics}}])
        self.assertEqual(egress["to"], [{"podSelector": {"matchLabels": operator}}])
        self.assertEqual(ingress["ports"], [{"protocol": "TCP", "port": 9666}])
        self.assertEqual(egress["ports"], ingress["ports"])

        operator_egress = parsed_document(
            result.stdout, "NetworkPolicy", "ptr-keda-operator-egress"
        )
        api_ingress = parsed_document(result.stdout, "NetworkPolicy", "ptr-keda-apiserver-ingress")
        grpc_port = [{"protocol": "TCP", "port": 6443}]
        self.assertIn(
            {"to": [{"podSelector": {"matchLabels": metrics}}], "ports": grpc_port},
            operator_egress["spec"]["egress"],
        )
        self.assertIn(
            {"from": [{"podSelector": {"matchLabels": operator}}], "ports": grpc_port},
            api_ingress["spec"]["ingress"],
        )
        webhook_ports = [{"protocol": "TCP", "port": 9443}, *grpc_port]
        self.assertTrue(
            any(rule["ports"] == webhook_ports for rule in api_ingress["spec"]["ingress"])
        )

    def test_litellm_service_monitor_does_not_copy_master_key_to_prometheus(self) -> None:
        result = helm_template("kind")
        self.assertEqual(result.returncode, 0, result.stderr)
        monitor = document(result.stdout, "ServiceMonitor", "ptr-litellm")
        config = document(result.stdout, "ConfigMap", "ptr-litellm-files")
        self.assertNotIn("authorization:", monitor)
        self.assertNotIn("PTR_LITELLM_MASTER_KEY", monitor)
        self.assertIn("require_auth_for_metrics_endpoint: false", config)

    def test_k5_monitoring_and_keda_namespaces_are_default_deny(self) -> None:
        result = helm_template("kind")
        self.assertEqual(result.returncode, 0, result.stderr)

        for name in ("ptr-monitoring-default-deny", "ptr-keda-default-deny"):
            policy = document(result.stdout, "NetworkPolicy", name)
            self.assertIn("podSelector: {}", policy)
            self.assertIn("policyTypes: [Ingress, Egress]", policy)
            self.assertNotIn("ingress:", policy)
            self.assertNotIn("egress:", policy)

    def test_k5_monitoring_ingress_requires_prometheus_pods_on_metrics_ports(self) -> None:
        result = helm_template("kind")
        self.assertEqual(result.returncode, 0, result.stderr)

        for name, port in (
            ("ptr-api-monitoring-ingress", 56441),
            ("ptr-litellm-monitoring-ingress", 4000),
            ("ptr-inference-monitoring-ingress", 8000),
            ("ptr-epp-monitoring-ingress", 9090),
        ):
            policy = document(result.stdout, "NetworkPolicy", name)
            self.assertIn("matchLabels: {kubernetes.io/metadata.name: ptr-monitoring}", policy)
            self.assertIn("matchLabels: {app.kubernetes.io/name: prometheus}", policy)
            self.assertIn(f"ports: [{{protocol: TCP, port: {port}}}]", policy)

    def test_k5_monitoring_and_keda_egress_is_scoped(self) -> None:
        result = helm_template("kind")
        self.assertEqual(result.returncode, 0, result.stderr)
        prometheus = document(result.stdout, "NetworkPolicy", "ptr-prometheus-egress")
        keda = document(result.stdout, "NetworkPolicy", "ptr-keda-operator-egress")
        keda_control = document(result.stdout, "NetworkPolicy", "ptr-keda-control-plane-egress")
        prometheus_operator = document(
            result.stdout, "NetworkPolicy", "ptr-prometheus-operator-egress"
        )

        for policy in (prometheus, keda_control, prometheus_operator):
            self.assertIn("port: 53", policy)
            self.assertIn('cidr: "10.96.0.1/32"', policy)
            self.assertIn("port: 443", policy)

        for allowed in (
            "app.kubernetes.io/component: api",
            "app.kubernetes.io/component: litellm",
            "app.kubernetes.io/component: inference-engine",
            "llm-d-router-standalone: chat-primary-epp",
        ):
            self.assertIn(allowed, prometheus)
        self.assertIn("app.kubernetes.io/component: prometheus-operator", prometheus_operator)
        self.assertIn("app.kubernetes.io/component: redis", keda)
        self.assertIn("app.kubernetes.io/name: prometheus", keda)
        self.assertNotIn("- podSelector: {}", prometheus)
        self.assertNotIn("- podSelector: {}", keda)

    def test_monitoring_ingress_only_admits_prometheus_pods_on_metrics_ports(self) -> None:
        result = helm_template("kind")
        self.assertEqual(result.returncode, 0, result.stderr)

        expected = {
            "ptr-api-monitoring-ingress": 56441,
            "ptr-litellm-monitoring-ingress": 4000,
            "ptr-inference-monitoring-ingress": 8000,
            "ptr-epp-monitoring-ingress": 9090,
        }
        for name, port in expected.items():
            policy = parsed_document(result.stdout, "NetworkPolicy", name)
            [rule] = policy["spec"]["ingress"]
            [source] = rule["from"]
            self.assertEqual(
                {"kubernetes.io/metadata.name": "ptr-monitoring"},
                source["namespaceSelector"]["matchLabels"],
            )
            self.assertEqual(
                {"app.kubernetes.io/name": "prometheus"},
                source["podSelector"]["matchLabels"],
            )
            self.assertEqual([{"protocol": "TCP", "port": port}], rule["ports"])

    def test_addon_namespaces_have_default_deny_and_minimal_egress(self) -> None:
        result = helm_template("kind")
        self.assertEqual(result.returncode, 0, result.stderr)

        for name, namespace in (
            ("ptr-monitoring-default-deny", "ptr-monitoring"),
            ("ptr-keda-default-deny", "ptr-keda"),
        ):
            policy = parsed_document(result.stdout, "NetworkPolicy", name)
            self.assertEqual(namespace, policy["metadata"]["namespace"])
            self.assertEqual({}, policy["spec"]["podSelector"])
            self.assertEqual(["Ingress", "Egress"], policy["spec"]["policyTypes"])
            self.assertNotIn("ingress", policy["spec"])
            self.assertNotIn("egress", policy["spec"])

        for name in ("ptr-prometheus-egress", "ptr-keda-operator-egress"):
            policy = parsed_document(result.stdout, "NetworkPolicy", name)
            for rule in policy["spec"]["egress"]:
                for peer in rule.get("to", []):
                    self.assertNotEqual({}, peer.get("podSelector"))

    def test_litellm_servicemonitor_does_not_copy_master_key_to_prometheus(self) -> None:
        result = helm_template("kind")
        self.assertEqual(result.returncode, 0, result.stderr)
        monitor = document(result.stdout, "ServiceMonitor", "ptr-litellm")

        self.assertNotIn("authorization:", monitor)
        self.assertNotIn("PTR_LITELLM_MASTER_KEY", monitor)

    def test_maintenance_cronjobs_are_split_and_secret_backed(self) -> None:
        result = helm_template("kind")
        self.assertEqual(result.returncode, 0, result.stderr)
        expected = {
            "ptr-maintenance-daily-split-retention": ("ptr-worker:k2", "daily-split-retention"),
            "ptr-maintenance-daily-framework-retention": (
                "ptr-backend:k2",
                "daily-framework-retention",
            ),
            "ptr-maintenance-weekly-review-sample": ("ptr-backend:k2", "weekly-review-sample"),
            "ptr-maintenance-weekly-production-review": (
                "ptr-backend:k2",
                "weekly-production-review",
            ),
        }
        for name, (image, operation) in expected.items():
            cronjob = document(result.stdout, "CronJob", name)
            self.assertIn("timeZone: \"Asia/Seoul\"", cronjob)
            self.assertIn("concurrencyPolicy: Forbid", cronjob)
            self.assertIn("backoffLimit: 0", cronjob)
            self.assertIn("automountServiceAccountToken: false", cronjob)
            self.assertIn("activeDeadlineSeconds: 310", cronjob)
            self.assertIn("startingDeadlineSeconds: 600", cronjob)
            self.assertIn("app.kubernetes.io/component: maintenance", cronjob)
            self.assertIn(f"image: {image}", cronjob)
            self.assertIn("command: [\"python3\", \"scripts/split-maintenance.py\"]", cronjob)
            self.assertIn(f'args: ["--k8s", "--operation", "{operation}"]', cronjob)
            self.assertIn("key: PTR_LLM_MAINTENANCE_DATABASE_URL", cronjob)
            self.assertIn("key: PTR_MAINTENANCE_APPLY", cronjob)
            self.assertIn("name: PTR_MAINTENANCE_REVIEW_STATE_DIR", cronjob)
            self.assertIn("value: \"/tmp/ptr-maintenance-review-state\"", cronjob)
            self.assertIn("mountPath: /tmp", cronjob)
            if operation.startswith("weekly-"):
                self.assertIn('ptr.io/synthetic-smoke: "true"', cronjob)
                self.assertIn('ptr.io/host-only-production-step: "true"', cronjob)
            else:
                self.assertNotIn("ptr.io/synthetic-smoke", cronjob)
                self.assertNotIn("ptr.io/host-only-production-step", cronjob)

    def test_prometheus_address_and_gateway_rpm_are_value_driven(self) -> None:
        result = helm_template(
            "kind",
            "--set",
            "monitoring.prometheus.releaseName=custom-mon",
            "--set",
            "monitoring.prometheus.namespace=custom-monitoring",
            "--set",
            "gateway.bootstrap.rpm=777",
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        engine = document(result.stdout, "ScaledObject", "ptr-sim")
        bootstrap = document(result.stdout, "Job", "ptr-litellm-bootstrap-app-key")
        self.assertIn(
            'serverAddress: "http://custom-mon-kube-promet-prometheus.custom-monitoring.svc:9090"',
            engine,
        )
        self.assertIn('value: "777"', bootstrap)

    def test_kind_worker_load_stays_within_engine_flow_capacity(self) -> None:
        kind = helm_template("kind")
        self.assertEqual(kind.returncode, 0, kind.stderr)
        worker = document(kind.stdout, "Deployment", "ptr-worker")
        self.assertIn('name: PTR_LLM_CONCURRENCY\n              value: "4"', worker)
        prod = helm_template("prod")
        self.assertEqual(prod.returncode, 0, prod.stderr)
        prod_worker = document(prod.stdout, "Deployment", "ptr-worker")
        self.assertIn('name: PTR_LLM_CONCURRENCY\n              value: "4"', prod_worker)

    def test_active_list_threshold_tracks_worker_concurrency(self) -> None:
        result = helm_template("kind", "--set", "app.worker.concurrency=7")
        self.assertEqual(result.returncode, 0, result.stderr)
        worker = parsed_document(result.stdout, "ScaledObject", "ptr-worker")
        active = next(
            trigger for trigger in worker["spec"]["triggers"] if trigger["name"] == "active-list"
        )
        self.assertEqual(active["metadata"]["listLength"], "7")

    def test_kind_v5_queue_wait_and_engine_scale_match_synthetic_capacity(self) -> None:
        kind = helm_template("kind")
        self.assertEqual(kind.returncode, 0, kind.stderr)
        api = document(kind.stdout, "Deployment", "ptr-api")
        self.assertIn('name: PTR_TURN_MAX_QUEUE_MS\n              value: "600000"', api)

        overlay = ROOT / "deploy/kind/k5-worker-values.yaml"
        overlay_values = yaml.safe_load(overlay.read_text())
        self.assertEqual(2, overlay_values["autoscaling"]["engine"]["minReplicaCount"])
        worker_load = helm_template("kind", "-f", str(overlay))
        self.assertEqual(worker_load.returncode, 0, worker_load.stderr)
        engine = document(worker_load.stdout, "ScaledObject", "ptr-sim")
        self.assertIn("minReplicaCount: 2", engine)
        self.assertIn("maxReplicaCount: 2", engine)

        prod = helm_template("prod")
        self.assertEqual(prod.returncode, 0, prod.stderr)
        prod_api = document(prod.stdout, "Deployment", "ptr-api")
        self.assertIn('name: PTR_TURN_MAX_QUEUE_MS\n              value: "60000"', prod_api)

    def test_prod_renders_only_retention_maintenance_cronjobs(self) -> None:
        result = helm_template("prod")
        self.assertEqual(result.returncode, 0, result.stderr)
        for name in (
            "ptr-maintenance-daily-split-retention",
            "ptr-maintenance-daily-framework-retention",
        ):
            cronjob = document(result.stdout, "CronJob", name)
            self.assertIn("name: ptr-maintenance", cronjob)
            self.assertIn("app.kubernetes.io/component: maintenance", cronjob)
            self.assertNotIn("ptr.io/synthetic-smoke", cronjob)
        for name in (
            "ptr-maintenance-weekly-review-sample",
            "ptr-maintenance-weekly-production-review",
        ):
            with self.assertRaises(AssertionError):
                document(result.stdout, "CronJob", name)

    def test_kind_up_labels_inference_namespace_like_chart(self) -> None:
        up_script = (ROOT / "deploy/kind/up.sh").read_text()
        self.assertIn("ptr.io/namespace=inference", up_script)


if __name__ == "__main__":
    unittest.main()
