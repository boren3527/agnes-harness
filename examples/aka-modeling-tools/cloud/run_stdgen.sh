#!/usr/bin/env bash
# run_stdgen.sh —— 在**有足够显存的机器**（云 GPU / 带卡的工作站）上跑完 StdGEN 并交付给 AGH。
#
# 为什么单独一个脚本：单图→网格这一段是"重、一次性、离线"的，不该和 AGH 那台机器绑定。
# 它唯一的产出契约是 MESH-PATH.md 里那份：<out>/<name>/{*.glb, source.json}。
#
# 用法：
#   NAME=kuson PHOTO=/data/photos/kuson.png bash run_stdgen.sh
#
# 前置（一次性，见 MESH-PATH.md §8）：
#   - Python 3.10/3.11 + **cu128 的 torch 2.7+**（不是 README 钉的 2.1.0+cu118：
#     那套轮子对 RTX 50 系 / sm_120 没有 kernel）
#   - StdGEN 仓库 + 权重 ./ckpt/ + sam_vit_h_4b8939.pth
set -euo pipefail

STDGEN_DIR="${STDGEN_DIR:-$HOME/StdGEN}"
NAME="${NAME:?set NAME=<case name>}"
PHOTO="${PHOTO:?set PHOTO=<absolute path to a FULL-BODY image>}"
SEED="${SEED:-0}"
OUT_ROOT="${OUT_ROOT:-$HOME/stdgen-deliver}"     # 交付给 AGH 的落点（之后同步回本地 .agnes/agh-ortho/meshes/）
OUTSIDE_RATIO="${OUTSIDE_RATIO:-0.20}"           # 头发遮罩可疑时调它（README 的 tip）
NO_DECOMPOSE="${NO_DECOMPOSE:-0}"                # 1 = 不分层（出 out_nodecomp.glb）

cd "$STDGEN_DIR"
WORK="$STDGEN_DIR/result/$NAME"
mkdir -p result/apose result/multiview result/slrm result/refined

echo "== stage 1.1: reference image -> A-pose =="
python infer_canonicalize.py --input_dir "$(dirname "$PHOTO")" --output_dir ./result/apose

echo "== stage 1.2: A-pose -> multi-view (decomposed) =="
python infer_multiview.py --input_dir ./result/apose --output_dir ./result/multiview

echo "== stage 2: S-LRM reconstruction =="
python infer_slrm.py --input_dir ./result/multiview --output_dir ./result/slrm

echo "== stage 3: multi-layer refinement =="
if [ "$NO_DECOMPOSE" = "1" ]; then
  python infer_refine.py --input_mv_dir result/multiview --input_obj_dir ./result/slrm \
    --output_dir ./result/refined --no_decompose
else
  python infer_refine.py --input_mv_dir result/multiview --input_obj_dir ./result/slrm \
    --output_dir ./result/refined --outside_ratio "$OUTSIDE_RATIO"
fi

echo "== collect =="
DEST="$OUT_ROOT/$NAME"
mkdir -p "$DEST"
shopt -s nullglob
GLBS=("./result/refined/$NAME"/*.glb)
if [ ${#GLBS[@]} -eq 0 ]; then echo "!! no .glb produced - check the stage logs"; exit 1; fi
for f in "${GLBS[@]}"; do cp -v "$f" "$DEST/"; done

# 语义层的编号：StdGEN 用 out_<level>.glb（decomposed，3 层）/ out_nodecomp.glb（单一网格）。
# **哪一层是身体/衣服/头发以实测为准**（顶点数/体积/目视），不在这里猜。

PHOTO_SHA=$(sha256sum "$PHOTO" | cut -d' ' -f1)
cat > "$DEST/source.json" <<JSON
{
  "generator": "StdGEN",
  "generatorRevision": "$(git -C "$STDGEN_DIR" rev-parse --short HEAD 2>/dev/null || echo unknown)",
  "stage": "refine",
  "model": "StdGEN-canonical + StdGEN-synthesis + slrm + refine",
  "weights": "hf:hyz317/StdGEN + sam_vit_h_4b8939.pth",
  "seed": $SEED,
  "inputImage": "$PHOTO",
  "inputImageSha256": "$PHOTO_SHA",
  "file": "$(basename "${GLBS[0]}")",
  "layers": [$(for f in "${GLBS[@]}"; do printf '"%s",' "$(basename "$f")"; done | sed 's/,$//')],
  "unit": "normalised",
  "upAxis": "Z",
  "forwardAxis": "-Y",
  "declaredHeight": 1.0,
  "declaredHeightKind": "normalised",
  "notes": "unit/upAxis/declaredHeight 是声明：AGH 侧会用包围盒测量复核，不符即 blocking。分层编号以实测为准（MESH-PATH.md §2/§4）。"
}
JSON

echo
echo "交付落点: $DEST"
ls -la "$DEST"
echo
echo "下一步：把这个目录同步到本地 <workspace>/.agnes/agh-ortho/meshes/$NAME/（或直接把 $DEST 同步到该路径），"
echo "        然后把路径告我，AGH 侧用 .agnes/work/measure-mesh.mjs 量一遍再定 unit/declaredHeight 的真值。"
