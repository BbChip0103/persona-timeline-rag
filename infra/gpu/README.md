# GPU engine benchmark scripts (Goal2)

Run on a single-GPU host (validated: RTX 4090 24GB, driver 580 / CUDA 13.0) under the engine directory given by `PTR_GPU_ROOT` (every script requires it).
The host may be shared: check the GPU is free first.
No credentials or host details live here; reach the host over SSH and the engines only through an SSH tunnel.

| script | purpose |
|---|---|
| `setup.sh` | isolated venvs (`venv-vllm` nightly cu129, `venv-sglang` PyPI) + model downloads; never touches system Python or other workloads |
| `serve.sh <target>` | start one engine on 127.0.0.1 (vLLM :8000, SGLang :30000); refuses if another process holds >1GB of GPU memory |
| `bench.sh <target> <run>` | serve → same-client sweep (`vllm bench serve`): `chat` (1300 in/128 out, c=1..64), `prefix` (800 shared + 500 unique, 4 prefixes), `long` (6000/256) → synthetic quality probe → stop |
| `run_all.sh <run> <targets...>` | sequential targets; a failed target does not stop the rest |
| `gpu-monitor.sh <tag>` | 1 s nvidia-smi samples: util, memory-bandwidth util, power, clocks, VRAM |
| `quality_probe.py` | 12 synthetic Korean character prompts, temperature 0, strict-JSON/Korean-ratio check |
| `stop.sh` | stop only these benchmark processes (process-tree kill; never `pkill -f` patterns that match your own SSH shell) |

Targets: `vllm-e4b`, `vllm-e4b-fp8` (online FP8), `sglang-e4b` (default config), `sglang-e4b-lm` / `sglang-e4b-fp8`
(text-only `--language-model-only`, mem fraction 0.90 like vLLM), `vllm-26b-nvfp4` (Ada has no FP4 tensor cores:
vLLM uses Marlin weight-only kernels; SGLang requires sm100 for NVFP4).

Lessons: FlashInfer JIT needs the venv's `bin` (ninja/nvcc) on PATH; never edit a script while `bench.sh`/`run_all.sh`
is executing it (bash reads scripts incrementally — an in-place edit aborted one run with rc=2).

Summaries: copy `results/<run>` and `logs/gpu-<run>-*.csv` locally, then `python3 scripts/summarize_engine_bench.py <dir>`.
