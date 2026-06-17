#!/bin/bash
# 批量将视频文件的 MOOV atom 移到开头，使其支持流式播放/Seek
# 用法: ./faststart.sh [目录路径]  — 默认当前目录

TARGET="${1:-.}"
cd "$TARGET" || { echo "无法进入目录: $TARGET"; exit 1; }

# 检查 ffmpeg
if ! command -v ffmpeg &>/dev/null; then
    echo "错误: 未安装 ffmpeg，请先安装: apt install ffmpeg"
    exit 1
fi

shopt -s nullglob 2>/dev/null || true
exts=("mp4" "mkv" "avi" "mov" "webm" "MP4" "MKV" "AVI" "MOV" "WEBM")
videos=()
for ext in "${exts[@]}"; do
    for f in *."$ext"; do
        [[ -f "$f" ]] && videos+=("$f")
    done
done

if [[ ${#videos[@]} -eq 0 ]]; then
    echo "未找到视频文件"
    exit 1
fi

echo "找到 ${#videos[@]} 个视频文件，开始处理..."
echo "============================================"

success=0
failed=0
total=${#videos[@]}
current=0

for f in "${videos[@]}"; do
    ((current++))
    echo "[$current/$total] $f  ..."

    tmp="${f}.faststart_tmp.mp4"

    if ffmpeg -v error -i "$f" -c copy -movflags +faststart -y "$tmp" 2>/dev/null; then
        mv "$tmp" "$f"
        ((success++))
        echo "  -> OK"
    else
        rm -f "$tmp"
        ((failed++))
        echo "  -> FAILED"
    fi
    echo ""
done

echo "============================================"
echo "完成: 成功 $success, 失败 $failed, 共 $total"
