#!/bin/bash
# Sequential engine x precision sweep. A failed target is recorded and the next one still runs.
RUN=${1:?run-id}; shift
for T in "$@"; do "${PTR_GPU_ROOT:?set PTR_GPU_ROOT to the engine directory on the GPU host}"/bench.sh $T $RUN; echo "TARGET_DONE $T rc=$?"; done
echo RUN_ALL_DONE
