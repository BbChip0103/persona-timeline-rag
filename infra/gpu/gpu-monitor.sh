#!/bin/bash
# usage: gpu-monitor.sh <run-tag>  -> logs/gpu-<tag>.csv, 1s samples until killed.
# util.gpu alone hides memory-bound vs compute-bound; record memory-bandwidth util, power and clocks too.
TAG=${1:?tag}; OUT=${PTR_GPU_ROOT:?set PTR_GPU_ROOT to the engine directory on the GPU host}/logs/gpu-$TAG.csv
exec nvidia-smi --query-gpu=timestamp,utilization.gpu,utilization.memory,power.draw,clocks.sm,clocks.mem,memory.used,temperature.gpu --format=csv,nounits -l 1 > $OUT
