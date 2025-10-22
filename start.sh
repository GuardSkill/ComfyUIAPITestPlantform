#!/bin/bash

# 简化版本 - 一键检测和启动
SSH_CMD="ssh -p 10007 -CNg -L 8189:127.0.0.1:8188 root@117.50.75.22"

# 清理8000端口
echo "清理端口8000..."
pkill -f "uvicorn.*8000"

# 更安全的方式清理端口8000的进程
if lsof -ti:8000 > /dev/null 2>&1; then
    echo "发现占用端口8000的进程，正在清理..."
    lsof -ti:8000 | xargs kill -9
    echo "✅ 端口8000已清理"
else
    echo "✅ 端口8000未被占用"
fi

# 检测SSH隧道
if pgrep -f "ssh.*-L 8189:127.0.0.1:8188" > /dev/null; then
    echo "✅ SSH隧道已运行"
else
    echo "启动SSH隧道..."
    nohup $SSH_CMD > /dev/null 2>&1 &
    echo "✅ SSH隧道已启动 (PID: $!)"
fi

# 等待一小段时间确保端口清理完成
sleep 1

echo "启动Uvicorn服务器..."
uvicorn webapp.app:app --host 0.0.0.0 --port 8000 --reload