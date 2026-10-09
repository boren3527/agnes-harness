# 在那台 Windows 机器上把 StdGEN 跑起来（逐条照抄，2026-10-09）

> 目标：**只证明生成段能出网格** —— `result/refined/<名字>/out_{0,1,2}.glb`（或阶段 3 的 `.glb`）。
> 这一步**不需要 AGH、不需要装插件**、和本仓库无关。出了文件再谈别的。

## 0. 先认清这台机器的三个硬事实

| 事实 | 含义 |
|---|---|
| **RTX 5060 Laptop, 8 GB** | 是 **Blackwell（sm_120）** ⇒ README 钉的 `torch 2.1.0+cu118` **没有对应 kernel**，必须 **cu128 的 torch 2.7+** |
| 8 GB 显存偏紧 | `infer_multiview.py` 加 `--low_vram`；S-LRM/refine 有 OOM 风险（见 §5 的降级阶梯） |
| Python 3.11.9 已有、无 conda | 用 **venv** 就够，不必装 conda；别用 3.9（cu128 轮子对新版更友好） |

## 1. 环境

```powershell
cd D:\
python -m venv stdgen-venv
.\stdgen-venv\Scripts\activate
python -m pip install -U pip wheel setuptools
```

## 2. torch（**cu128**，不是 cu118）

```powershell
pip install torch torchvision --index-url https://download.pytorch.org/whl/cu128
python -c "import torch;print(torch.__version__, torch.cuda.is_available(), torch.cuda.get_device_name(0), torch.cuda.get_device_capability(0))"
```

**验收**：打印 `True` + 卡名 + `(12, 0)`。
若 `is_available()` 是 `False` ⇒ 驱动太旧（本机 592.01 ✓）；若报 "no kernel image" ⇒ 装错成 cu118 了。

## 3. 仓库 + 纯 Python 依赖

```powershell
cd D:\
git clone https://github.com/hyz317/StdGEN.git
cd StdGEN
pip install omegaconf rm_anime_bg "diffusers==0.27.2" "transformers==4.42.4" einops `
  "huggingface_hub==0.25.0" opencv-python accelerate matplotlib kornia imageio `
  imageio-ffmpeg xatlas trimesh rembg onnxruntime scikit-learn pygltflib pymeshlab pytorch_lightning
```

（`rm_anime_bg`、`rembg` 是去背景，首次运行会下模型。）

## 4. 三个 GPU 编译依赖 —— **本流程最脆的一环**

先装编译工具链（**一次**）：

```powershell
# 用 --override 才会把 C++ 负载带上；默认 winget 装的是"空壳"，cl.exe 不会出现
winget install -e --id Microsoft.VisualStudio.2022.BuildTools --override "--quiet --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
# 或走 GUI 安装器，勾 "使用 C++ 的桌面开发 / Desktop development with C++"
# CUDA Toolkit 12.8（必须和 cu128 对齐）：
#   https://developer.nvidia.com/cuda-12-8-0-download-archive  → Windows exe
```

每次开新终端都要先设这四个变量（把工具链"激活"出来）：

```powershell
$env:CUDA_HOME="C:\Program Files\NVIDIA GPU Computing Toolkit\CUDA\v12.8"
$env:PATH="$env:CUDA_HOME\bin;$env:PATH"
$env:FORCE_CUDA="1"
$env:DISTUTILS_USE_SDK="1"
$env:TORCH_CUDA_ARCH_LIST="12.0"        # ← Blackwell 必须显式指定，否则编译不出可用的 kernel
```

**装之前先验收这三条**（任何一条不过，先修它，别急着 pip）：

```powershell
cl.exe            # 打印编译器版本；不在 Native Tools 提示符里就先跑 vcvars64.bat
nvcc --version    # 必须显示 12.8
python -c "import torch; print(torch.utils.cpp_extension.CUDA_HOME)"
```

**为什么运行时也要工具链**：`nvdiffrast`（以及 flexicubes 那类）**第一次被调用时才编译光栅器**
（走 `torch.utils.cpp_extension`）⇒ 跑模型的那个终端里同样要有 `cl.exe`。
最稳的做法是直接在 **"x64 Native Tools Command Prompt for VS 2022"** 里激活 venv 再跑；
否则表现为"装成功了、一跑就说找不到 compiler"。

然后：

```powershell
pip install "git+https://github.com/facebookresearch/pytorch3d.git"
pip install "git+https://github.com/NVlabs/nvdiffrast.git"
pip install torch-scatter -f https://data.pyg.org/whl/torch-2.7.0+cu128.html
```

三个**实测会咬人**的点：

1. **`nvdiffrast` 是运行时编译的**：它第一次调用时才去编译光栅化插件 ⇒
   **跑模型的终端里也必须有 `cl.exe`**。最稳的做法是在
   **"x64 Native Tools Command Prompt for VS 2022"** 里启动 python（或在同一终端先跑
   `& "C:\Program Files\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat"`）。
   否则表现为"装好了、一跑就找不到 compiler / 报 CUDA 扩展编译失败"。
2. **`torch-scatter` 的轮子要和 `torch 2.7 + cu128` 精确匹配**；那个页面没有对应行时会退化成源码编译，
   同样的环境变量要生效。
3. **`pytorch3d` 在 Windows 上成功率最低**。它编不过时**不要死磕** —— 见下面的阶梯。

## 5. 降级阶梯（这是"能有效实现"的关键：门槛可以降）

| 阶梯 | 能拿到什么 | 代价 |
|---|---|---|
| **① 全四阶段** | 精修后的三层网格 `out_{0,1,2}.glb` | 需要 `pytorch3d` 编译成功（**最难的一个**） |
| **② 只跑到阶段 3（S-LRM）** | **就已经有网格**（`result/slrm/<名字>_*.obj/.glb`） | 少一道精修；避开 **`pytorch3d`**（但**躲不掉编译工具链**：flexicubes/S-LRM 也要编） |
| ③ WSL2（Ubuntu）跑 | 编译成功率高得多 | **A 段在哪跑不影响 AGH** —— 只要 `.glb` 落到 `D:\agnes-harness\.agnes\agh-ortho\meshes\` 就行（WSL 里 `/mnt/d/...` 就是同一块盘）。真要一键时我们那侧改成调 `wsl.exe python ...` 即可 |
| ④ 云 GPU | 最稳 | 花钱；但按小时租，跑完就关 |

**建议顺序**：装工具链（§4）→ **先跑到阶段 3 出网格**（避开 pytorch3d）→ 再回头攻 refine。

## 6. 权重

```powershell
huggingface-cli download hyz317/StdGEN --local-dir .\ckpt
Invoke-WebRequest -Uri "https://dl.fbaipublicfiles.com/segment_anything/sam_vit_h_4b8939.pth" -OutFile ".\ckpt\sam_vit_h_4b8939.pth"
```

## 7. 跑

输入图放进 `.\input_cases\`（**必须全身**；半身/缺脚效果差）。四阶段：

```powershell
python infer_canonicalize.py --input_dir .\input_cases --output_dir .\result\apose
python infer_multiview.py --input_dir .\result\apose --output_dir .\result\multiview --low_vram
python infer_slrm.py --input_dir .\result\multiview --output_dir .\result\slrm
python infer_refine.py --input_mv_dir .\result\multiview --input_obj_dir .\result\slrm --output_dir .\result\refined
```

（阶段 2–3 之间可以停下来看 `result/multiview/` 的多视图是否正常；seed 在脚本里是 `seed_everything(0)`。）

## 8. 交付给 AGH（约定在 `notes/MESH-PATH.md`）

```powershell
$name = "kuson"
$dest = "D:\agnes-harness\.agnes\agh-ortho\meshes\$name"
New-Item -ItemType Directory -Force -Path $dest | Out-Null
copy .\result\refined\$name\*.glb $dest\      # 走阶梯② 时改成 .\result\slrm\ 下的产物
```

再照 `meshes\README.md` 的模板写 `source.json`（`unit` / `upAxis` / `declaredHeight`）。
**不确定填什么就留空先跑** —— 我会用 `.agnes/work/measure-mesh.mjs` 量出真实值再定，
因为这三项是**声明**，而我们一律**测量复核**（不符即 blocking）。

## 9. 跑完把这两样发我

1. 盒子目录路径（`...\meshes\<名字>\`）
2. 三个阶段各自的**最后几行输出**（尤其有没有 OOM 或编译报错）

我量完就定 `unit`/`declaredHeight`/`upAxis` 的真值，然后提醒你发下游那三条请求。
