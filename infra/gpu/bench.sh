#!/bin/bash
# usage: bench.sh <serve-target> <run-id>
# Start one engine (serve.sh guard), sweep concurrency on two workloads with the SAME client (vllm bench serve),
# sample GPU metrics for the whole server lifetime, run the synthetic quality probe, then stop the server.
set -u
G=${PTR_GPU_ROOT:?set PTR_GPU_ROOT to the engine directory on the GPU host}; T=$1; RUN=$2; OUT=$G/results/$RUN/$T; mkdir -p $OUT
case $T in vllm-*) PORT=8000;; sglang-*) PORT=30000;; esac
case $T in *26b*) MODEL_DIR=$G/models/gemma-4-26B-A4B-it-NVFP4;; *) MODEL_DIR=$G/models/gemma-4-E4B-it;; esac
case $T in *e4b-fp8) NAME=gemma-4-e4b-fp8;; *e4b|*e4b-lm) NAME=gemma-4-e4b;; *26b*) NAME=gemma-4-26b-a4b-nvfp4;; esac
phase(){ echo "$(date +%s.%N) $*" >> $OUT/phases.log; echo "=== $(date +%T) $T $*"; }
phase server_start
$G/serve.sh $T > $OUT/server.log 2>&1 &
SP=$!
$G/gpu-monitor.sh $RUN-$T & MP=$!
ok=0; for i in $(seq 1 450); do
  if ! kill -0 $SP 2>/dev/null; then break; fi
  curl -sf localhost:$PORT/health >/dev/null && { ok=1; break; }; sleep 2; done
if [ $ok != 1 ]; then phase server_failed; kill $SP $MP 2>/dev/null; wait 2>/dev/null; tail -40 $OUT/server.log; exit 1; fi
phase server_ready
nvidia-smi --query-gpu=memory.used --format=csv,noheader,nounits > $OUT/vram_after_load_mib.txt
BENCH="$G/venv-vllm/bin/vllm bench serve --backend openai --base-url http://127.0.0.1:$PORT --endpoint /v1/completions \
  --model $NAME --tokenizer $MODEL_DIR --ignore-eos --temperature 0 --seed 7 --disable-tqdm \
  --percentile-metrics ttft,tpot,itl,e2el --metric-percentiles 50,95,99 --save-result --result-dir $OUT"
# warmup (excluded)
$BENCH --dataset-name random --random-input-len 512 --random-output-len 32 --num-prompts 4 --max-concurrency 2 --result-filename warmup.json > $OUT/warmup.log 2>&1
# Workloads shaped on Goal1 live Gemini 3 traces (77 fresh turns): prompt p50 1165 / p95 3786 tokens,
# completion p50 107 / p95 231. Fixed output (ignore-eos) keeps decode work identical across targets.
for c in 1 2 4 8 16 32 64; do
  n=$(( c*4 < 16 ? 16 : c*4 ))
  phase "chat c=$c start"
  $BENCH --dataset-name random --random-input-len 1300 --random-output-len 128 --random-range-ratio 0 \
    --num-prompts $n --max-concurrency $c --result-filename chat_c$c.json > $OUT/chat_c$c.log 2>&1
  phase "chat c=$c end rc=$?"
done
# Shared persona prefix (system + persona definition) with a distinct per-turn suffix: prefix-cache effect.
for c in 1 4 16 64; do
  n=$(( c*4 < 16 ? 16 : c*4 ))
  phase "prefix c=$c start"
  $BENCH --dataset-name prefix_repetition --prefix-repetition-prefix-len 800 --prefix-repetition-suffix-len 500 \
    --prefix-repetition-num-prefixes 4 --prefix-repetition-output-len 128 \
    --num-prompts $n --max-concurrency $c --result-filename prefix_c$c.json > $OUT/prefix_c$c.log 2>&1
  phase "prefix c=$c end rc=$?"
done
# Long-context stress beyond p95 prompts (KV-capacity bound).
for c in 1 8 32; do
  n=$(( c*4 < 8 ? 8 : c*4 ))
  phase "long c=$c start"
  $BENCH --dataset-name random --random-input-len 6000 --random-output-len 256 --random-range-ratio 0 \
    --num-prompts $n --max-concurrency $c --result-filename long_c$c.json > $OUT/long_c$c.log 2>&1
  phase "long c=$c end rc=$?"
done
phase quality_start
$G/venv-vllm/bin/python $G/quality_probe.py http://127.0.0.1:$PORT $NAME $OUT/quality.json > $OUT/quality.log 2>&1
phase "quality_end rc=$?"
kill $SP; wait $SP 2>/dev/null; kill $MP 2>/dev/null; wait $MP 2>/dev/null
phase server_stopped
# give the GPU back before the next target
for i in $(seq 1 60); do u=$(nvidia-smi --query-gpu=memory.used --format=csv,noheader,nounits); [ "$u" -lt 1024 ] && break; sleep 2; done
