#!/bin/bash
# usage: serve.sh <vllm-e4b|vllm-e4b-fp8|sglang-e4b|sglang-e4b-lm|sglang-e4b-fp8|vllm-26b-nvfp4>
# Precision axis: *-fp8 = same BF16 checkpoint quantized to FP8 at load time (Ada has FP8 tensor cores).
# KV cache stays at the engine default (bf16) in every target so only weight precision varies.
# Binds to 127.0.0.1 only (reach via SSH tunnel). Refuses to start while another process holds the GPU.
set -eu
G=${PTR_GPU_ROOT:?set PTR_GPU_ROOT to the engine directory on the GPU host}; TARGET=${1:?target}
USED=$(nvidia-smi --query-gpu=memory.used --format=csv,noheader,nounits | head -1)
if [ "$USED" -gt 1024 ]; then echo "GPU busy (${USED} MiB used); not starting."; nvidia-smi --query-compute-apps=pid,process_name,used_memory --format=csv; exit 1; fi
# Same context budget for both engines (Goal1 live prompts: p50 1165 / p95 3786 tokens; long-context stress uses 6k).
CTX=16384
# JIT kernels (FlashInfer etc.) spawn ninja/nvcc from PATH: expose the target venv's bin.
case $TARGET in vllm-*) export PATH=$G/venv-vllm/bin:$PATH ;; sglang-*) export PATH=$G/venv-sglang/bin:$PATH ;; esac
case $TARGET in
  vllm-e4b)
    exec $G/venv-vllm/bin/vllm serve $G/models/gemma-4-E4B-it --served-model-name gemma-4-e4b \
      --host 127.0.0.1 --port 8000 --max-model-len $CTX --gpu-memory-utilization 0.90 \
      --reasoning-parser gemma4 --limit-mm-per-prompt "{\"image\":0,\"audio\":0}" --async-scheduling ;;
  vllm-e4b-fp8)
    exec $G/venv-vllm/bin/vllm serve $G/models/gemma-4-E4B-it --served-model-name gemma-4-e4b-fp8 --quantization fp8 \
      --host 127.0.0.1 --port 8000 --max-model-len $CTX --gpu-memory-utilization 0.90 \
      --reasoning-parser gemma4 --limit-mm-per-prompt "{\"image\":0,\"audio\":0}" --async-scheduling ;;
  sglang-e4b-fp8)
    # SGLang 0.5.21 online FP8 crashes building the Gemma 4 audio tower; --language-model-only rejects Gemma4,
    # so try --language-only (language-model weights only).
    exec $G/venv-sglang/bin/python -m sglang.launch_server --model-path $G/models/gemma-4-E4B-it --served-model-name gemma-4-e4b-fp8 --quantization fp8 \
      --host 127.0.0.1 --port 30000 --context-length $CTX --mem-fraction-static 0.90 --language-only \
      --reasoning-parser gemma4 --enable-metrics ;;
  sglang-e4b-lm)
    # Fairness re-run: same memory fraction as vLLM (0.90). (--language-model-only does not support Gemma4.)
    exec $G/venv-sglang/bin/python -m sglang.launch_server --model-path $G/models/gemma-4-E4B-it --served-model-name gemma-4-e4b \
      --host 127.0.0.1 --port 30000 --context-length $CTX --mem-fraction-static 0.90 \
      --reasoning-parser gemma4 --enable-metrics ;;
  sglang-e4b)
    exec $G/venv-sglang/bin/python -m sglang.launch_server --model-path $G/models/gemma-4-E4B-it --served-model-name gemma-4-e4b \
      --host 127.0.0.1 --port 30000 --context-length $CTX --mem-fraction-static 0.85 \
      --reasoning-parser gemma4 --enable-metrics ;;
  vllm-26b-nvfp4)
    # Ada (sm89) has no native FP4: vLLM uses Marlin weight-only kernels. SGLang requires sm100 for NVFP4.
    exec $G/venv-vllm/bin/vllm serve $G/models/gemma-4-26B-A4B-it-NVFP4 --served-model-name gemma-4-26b-a4b-nvfp4 \
      --host 127.0.0.1 --port 8000 --max-model-len $CTX --gpu-memory-utilization 0.90 \
      --reasoning-parser gemma4 --limit-mm-per-prompt "{\"image\":0}" --async-scheduling ;;
  *) echo "unknown target $TARGET"; exit 2 ;;
esac
