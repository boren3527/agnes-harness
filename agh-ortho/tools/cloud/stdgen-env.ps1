# stdgen-env.ps1 —— 每次开工前 dot-source 它（**一行**，把工具链、venv、CUDA 全带上）：
#
#     . D:\agnes-harness\agh-ortho\tools\cloud\stdgen-env.ps1
#
# 为什么必须是 dot-source（前面的点）：脚本里改的是**当前会话**的环境变量。
# 直接运行（& 或 -File）会在子进程里跑完就丢掉，你会以为"设过了"其实没有。
#
# 为什么需要它：`cl.exe` 只有在 vcvars 之后才进 PATH，而 nvdiffrast / flexicubes 这类
# **运行时才编译**（torch.utils.cpp_extension）—— 所以"跑模型的那个终端"也必须有工具链，
# 光装好是不够的。

$vcvars = 'C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat'
if (-not (Test-Path $vcvars)) {
  $alt = Get-ChildItem 'C:\Program Files\Microsoft Visual Studio\2022','C:\Program Files (x86)\Microsoft Visual Studio\2022' -Recurse -Filter vcvars64.bat -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty FullName
  if ($alt) { $vcvars = $alt } else { throw "vcvars64.bat 找不到 —— 先装 VS 2022 Build Tools + C++ 工作负载" }
}
$cuda = 'C:\Program Files\NVIDIA GPU Computing Toolkit\CUDA\v12.8'
$venv = 'D:\stdgen-venv\Scripts\Activate.ps1'

# 把 vcvars 设好的环境变量导入当前会话（比手抄 PATH 可靠）
cmd /c "call `"$vcvars`" >nul 2>&1 && set" | ForEach-Object {
  if ($_ -match '^([^=]+)=(.*)$') { Set-Item -Path ('env:' + $matches[1]) -Value $matches[2] -ErrorAction SilentlyContinue }
}

if (Test-Path $cuda) {
  $env:CUDA_HOME = $cuda
  $env:PATH = "$cuda\bin;$env:PATH"
} else {
  Write-Host "!! 没装 CUDA Toolkit 12.8（$cuda 不存在）—— nvcc 会缺失，编 CUDA 扩展必失败" -ForegroundColor Yellow
}
$env:FORCE_CUDA = '1'
$env:DISTUTILS_USE_SDK = '1'
$env:TORCH_CUDA_ARCH_LIST = '12.0'   # Blackwell(sm_120)：不写这个编不出可用 kernel

if (Test-Path $venv) { . $venv } else { Write-Host "!! venv 不在 $venv" -ForegroundColor Yellow }

Write-Host '--- 验收 ---'
if (Get-Command cl.exe -ErrorAction SilentlyContinue) { (cmd /c "cl.exe 2>&1" | Select-Object -First 1) } else { Write-Host 'cl.exe: 缺' -ForegroundColor Yellow }
if (Get-Command nvcc -ErrorAction SilentlyContinue) { (nvcc --version 2>&1 | Select-Object -Last 2) } else { Write-Host 'nvcc: 缺（装 CUDA Toolkit 12.8）' -ForegroundColor Yellow }
python -c "import torch;print('torch',torch.__version__,'| cuda',torch.cuda.is_available(),'| cc',torch.cuda.get_device_capability(0))" 2>&1
