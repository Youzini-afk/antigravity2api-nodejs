#!/usr/bin/env bash

echo "========================================"
echo "Antigravity2API 启动脚本"
echo "========================================"
echo

echo "[1/2] 安装依赖..."
npm install
if [ $? -ne 0 ]; then
    echo "安装依赖失败"
    exit 1
fi

echo
echo "[2/2] 启动服务..."
npm start
