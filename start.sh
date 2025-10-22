#!/bin/bash

# 简化版本 - 一键检测和启动
SSH_CMD="ssh -p 10007 -CNg -L 8189:127.0.0.1:8188 root@117.50.75.22"

# 清理8000端口
echo "清理端口8000..."
pkill -f "uvicorn.*8000"
lsof -ti:8000 | xargs kill -9

# 检测SSH隧道
if pgrep -f "ssh.*-L 8189:127.0.0.1:8188" > /dev/null; then
    echo "✅ SSH隧道已运行"
else
    echo "启动SSH隧道..."
    nohup $SSH_CMD > /dev/null 2>&1 &
    echo "✅ SSH隧道已启动 (PID: $!)"
fi

uvicorn webapp.app:app --host 0.0.0.0 --port 8000 --reload