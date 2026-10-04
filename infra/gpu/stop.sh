#!/bin/bash
# Stop only Goal2 benchmark processes (run_all -> bench -> engine/monitor), never other workloads.
G=${PTR_GPU_ROOT:?set PTR_GPU_ROOT to the engine directory on the GPU host}
kill_tree(){ for c in $(pgrep -P $1); do kill_tree $c; done; kill $1 2>/dev/null; }
for p in $(pgrep -f "^/bin/bash ./run_all.sh|^/bin/bash $G/run_all.sh"); do kill_tree $p; done
for p in $(pgrep -f "^/bin/bash $G/bench.sh"); do kill_tree $p; done
for p in $(pgrep -f "^$G/venv-(vllm|sglang)/bin/"); do kill_tree $p; done
for p in $(pgrep -f "^nvidia-smi --query-gpu=timestamp"); do kill $p; done
sleep 10
ps -eo pid,args | grep -E "^ *[0-9]+ ($G|/bin/bash ./run_all|nvidia-smi --query-gpu=timestamp)" | cut -c1-100
nvidia-smi --query-gpu=memory.used --format=csv,noheader
