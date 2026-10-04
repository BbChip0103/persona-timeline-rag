#!/bin/bash
# persona-timeline-rag Goal2 engine setup. Isolated from system Python and other workloads (shared GPU host; check the GPU is free first).
# No server launch / no GPU use here.
set -u
G=${PTR_GPU_ROOT:?set PTR_GPU_ROOT to the engine directory on the GPU host}; cd $G
step(){ echo "=== $(date +%F_%T) $*"; }

install_vllm(){
  step vllm venv
  uv venv $G/venv-vllm --python 3.12 -q &&
  VIRTUAL_ENV=$G/venv-vllm uv pip install -U vllm --pre \
    --extra-index-url https://wheels.vllm.ai/nightly/cu129 \
    --extra-index-url https://download.pytorch.org/whl/cu129 --index-strategy unsafe-best-match &&
  # unsafe-best-match pulls the PyPI (CUDA 13) torchcodec; align it with torch cu129 or vllm serve fails to import.
  VIRTUAL_ENV=$G/venv-vllm uv pip install --reinstall-package torchcodec torchcodec --index-url https://download.pytorch.org/whl/cu129 &&
  $G/venv-vllm/bin/python -c "import vllm,torch;print(\"VLLM_OK\",vllm.__version__,torch.__version__,torch.version.cuda,torch.cuda.is_available())"
  step "vllm exit $?"
}
install_sglang(){
  step sglang venv
  uv venv $G/venv-sglang --python 3.12 -q &&
  # git main needs a Rust toolchain (cargo) to build; the PyPI wheel already ships Gemma 4 support.
  VIRTUAL_ENV=$G/venv-sglang uv pip install -U sglang --prerelease=allow &&
  $G/venv-sglang/bin/python -c "import sglang,torch,transformers,importlib.util as u;print(\"SGLANG_OK\",getattr(sglang,\"__version__\",\"?\"),torch.__version__,torch.version.cuda,torch.cuda.is_available(),\"transformers\",transformers.__version__,\"gemma4\",u.find_spec(\"transformers.models.gemma4\") is not None)"
  step "sglang exit $?"
}
download(){
  export HF_HUB_ENABLE_HF_TRANSFER=1
  for m in google/gemma-4-E4B-it RedHatAI/gemma-4-26B-A4B-it-NVFP4; do
    step "download $m"
    uvx --from "huggingface_hub[cli,hf_transfer]" hf download $m --local-dir $G/models/${m#*/}
    step "download $m exit $?"
  done
}
install_vllm > logs/vllm.log 2>&1 &
install_sglang > logs/sglang.log 2>&1 &
download > logs/download.log 2>&1 &
wait
echo SETUP_DONE >> logs/download.log
