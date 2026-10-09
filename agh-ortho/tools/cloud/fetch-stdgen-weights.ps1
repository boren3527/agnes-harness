# fetch-stdgen-weights.ps1 —— 从镜像直抓 StdGEN 权重（绕开 huggingface_hub 的元数据校验）
# 用法： powershell -ExecutionPolicy Bypass -File D:\agnes-harness\agh-ortho\tools\cloud\fetch-stdgen-weights.ps1
# 可反复重跑：已完整（字节数相符）的文件会跳过，残缺的用 curl -C - 续传。
$dest = 'D:\cod\StdGEN\ckpt'
$base = 'https://hf-mirror.com/hyz317/StdGEN/resolve/main/'

$list = @'
1389|README.md
342|StdGEN-canonicalize-1024/feature_extractor/preprocessor_config.json
560|StdGEN-canonicalize-1024/image_encoder/config.json
2528481905|StdGEN-canonicalize-1024/image_encoder/pytorch_model.bin
543|StdGEN-canonicalize-1024/model_index.json
911|StdGEN-canonicalize-1024/ref_unet/config.json
3476967656|StdGEN-canonicalize-1024/ref_unet/diffusion_pytorch_model.safetensors
379|StdGEN-canonicalize-1024/scheduler-zerosnr/scheduler_config.json
613|StdGEN-canonicalize-1024/text_encoder/config.json
680821096|StdGEN-canonicalize-1024/text_encoder/model.fp16.safetensors
1361597018|StdGEN-canonicalize-1024/text_encoder/model.safetensors
1361671895|StdGEN-canonicalize-1024/text_encoder/pytorch_model.bin
680900852|StdGEN-canonicalize-1024/text_encoder/pytorch_model.fp16.bin
524619|StdGEN-canonicalize-1024/tokenizer/merges.txt
460|StdGEN-canonicalize-1024/tokenizer/special_tokens_map.json
807|StdGEN-canonicalize-1024/tokenizer/tokenizer_config.json
1059962|StdGEN-canonicalize-1024/tokenizer/vocab.json
911|StdGEN-canonicalize-1024/unet/config.json
3476967656|StdGEN-canonicalize-1024/unet/diffusion_pytorch_model.safetensors
553|StdGEN-canonicalize-1024/vae/config.json
334707217|StdGEN-canonicalize-1024/vae/diffusion_pytorch_model.bin
167405651|StdGEN-canonicalize-1024/vae/diffusion_pytorch_model.fp16.bin
167335342|StdGEN-canonicalize-1024/vae/diffusion_pytorch_model.fp16.safetensors
334643276|StdGEN-canonicalize-1024/vae/diffusion_pytorch_model.safetensors
1628189934|StdGEN-mesh-slrm.pth
1519|StdGEN-multiview-1024/.gitattributes
31|StdGEN-multiview-1024/README.md
466|StdGEN-multiview-1024/feature_extractor/preprocessor_config.json
579|StdGEN-multiview-1024/image_encoder/config.json
1264217240|StdGEN-multiview-1024/image_encoder/model.safetensors
513|StdGEN-multiview-1024/image_noising_scheduler/scheduler_config.json
177|StdGEN-multiview-1024/image_normalizer/config.json
4272|StdGEN-multiview-1024/image_normalizer/diffusion_pytorch_model.safetensors
736|StdGEN-multiview-1024/model_index.json
531|StdGEN-multiview-1024/scheduler/scheduler_config.json
617|StdGEN-multiview-1024/text_encoder/config.json
680820392|StdGEN-multiview-1024/text_encoder/model.safetensors
524619|StdGEN-multiview-1024/tokenizer/merges.txt
460|StdGEN-multiview-1024/tokenizer/special_tokens_map.json
855|StdGEN-multiview-1024/tokenizer/tokenizer_config.json
1059962|StdGEN-multiview-1024/tokenizer/vocab.json
2550|StdGEN-multiview-1024/unet-old/config.json
1895432652|StdGEN-multiview-1024/unet-old/diffusion_pytorch_model.safetensors
2472|StdGEN-multiview-1024/unet/config.json
1895432652|StdGEN-multiview-1024/unet/diffusion_pytorch_model.safetensors
668|StdGEN-multiview-1024/vae/config.json
167335342|StdGEN-multiview-1024/vae/diffusion_pytorch_model.safetensors
'@ -split "`n" | Where-Object { $_.Trim() -ne '' }

$new = 0; $skip = 0; $bad = @(); $i = 0
foreach ($line in $list) {
  $i++
  $parts = $line.Trim() -split '\|', 2
  $size = [int64]$parts[0]
  $name = $parts[1].Trim()
  $target = Join-Path $dest ($name -replace '/', '\')
  $dir = Split-Path $target -Parent
  if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
  if ((Test-Path $target) -and ((Get-Item $target).Length -eq $size)) { $skip++; continue }
  Write-Host ("[{0}/{1}] {2}  ({3} MB)" -f $i, $list.Count, $name, [Math]::Round($size / 1MB, 1))
  curl.exe -L -C - --retry 5 --retry-delay 3 --retry-all-errors -o "$target" "$base$name"
  if ((Test-Path $target) -and ((Get-Item $target).Length -eq $size)) { $new++ } else { $bad += $name }
}

Write-Host ("done: downloaded={0} already-had={1} failed={2}" -f $new, $skip, $bad.Count)
if ($bad.Count) { Write-Host 'FAILED (重跑本脚本可续传):'; $bad | ForEach-Object { Write-Host "  $_" } }
