#!/bin/bash
# Curation Bench GPU step: embed the desktop chunks + queries for each arm on one spot GPU, upload, shut down.
#   metadata: bench=gs://.../curation_bench/<run>   arms="v10_int8 v11_pt"
exec >> /var/log/cb.log 2>&1; set -x
md() { curl -sf -H 'Metadata-Flavor: Google' "http://metadata.google.internal/computeMetadata/v1/instance/attributes/$1"; }
B=$(md bench); ARMS=$(md arms); W=/opt/cb; mkdir -p $W/m $W/out && cd $W
up() { gcloud storage cp -q /var/log/cb.log $B/logs/cb.log; gcloud storage rsync -q -r $W/out $B/out; }
trap up EXIT
for i in $(seq 1 90); do nvidia-smi >/dev/null 2>&1 && break; sleep 10; done
gcloud storage cp -q -r "$B/data" "$B/code" $W/
gcloud storage rsync -q -r "$B/out" $W/out 2>/dev/null || true  # resume after a spot preemption
command -v uv >/dev/null || { curl -LsSf https://astral.sh/uv/install.sh | env UV_INSTALL_DIR=/usr/local/bin sh; }
# A spot stop mid-install leaves a venv without packages: trust only the .ok marker written after a full install.
[ -f $W/py/.ok ] || { rm -rf $W/py && uv venv -q -p 3.12 $W/py && VIRTUAL_ENV=$W/py uv pip install -q torch "transformers>=4.51" "onnxruntime-gpu>=1.23" numpy tokenizers huggingface_hub && touch $W/py/.ok; }
PY=$W/py/bin/python
$PY -c "from huggingface_hub import hf_hub_download as d; [print(d('papr-ai/papr-embed-code-1-0.6b',f,revision='4596a3478f5bc1898d9fae1afad200201ca741e1',local_dir='m')) for f in ('onnx/model_quantized.onnx','tokenizer.json')]"
for arm in $ARMS; do
  [ -f out/$arm/DONE ] && continue
  case $arm in
    v10_int8) A="--onnx m/onnx/model_quantized.onnx";;
    v11_pt) gcloud storage cp -q gs://papr-hne-artifacts/stage_b/b20r/i0_ckpt/anchor_replay_w4_trim_10_l1.0/trunk.pt m/v11.pt; A="--trunk m/v11.pt";;
    v10_pt) gcloud storage cp -q gs://papr-hne-artifacts/release/papr-embed-v2/0.6b-b16-trim10/trunk.pt m/v10.pt; A="--trunk m/v10.pt";;
  esac
  $PY code/embed_chunks.py data out/$arm --tokenizer m/tokenizer.json $A --on-shard "gcloud storage rsync -q -r $W/out/$arm/parts $B/out/$arm/parts" >> out/embed_$arm.log 2>&1 && touch out/$arm/DONE; up
done
# ALL_DONE only when every arm finished; otherwise FAILED, so the launcher stops waiting and reports it.
ok=1; for arm in $ARMS; do [ -f out/$arm/DONE ] || ok=0; done
if [ $ok = 1 ]; then echo ALL_DONE > out/ALL_DONE; else echo FAILED > out/FAILED; fi; up
[ "$(md keep)" = 1 ] || shutdown -h now
