FROM node:20-alpine

ARG TARGETARCH
ARG MIHOMO_VERSION=v1.19.25
ARG MIHOMO_AMD64_COMPATIBLE=false

WORKDIR /app

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8045 \
    CONFIG_DIR=/app/data \
    DATA_DIR=/app/data \
    IMAGE_DIR=/app/public/images

# 安装运行时工具
RUN apk add --no-cache ca-certificates curl gzip

# 复制 package.json 和 package-lock.json
COPY package*.json ./

# 安装依赖
RUN npm ci --omit=dev

# 复制源代码
COPY . .

# 下载 Mihomo 内核（Zeabur/Docker 默认可直接使用内置代理）
RUN mkdir -p /app/src/bin && \
    arch="${TARGETARCH:-amd64}" && \
    version_no_v="${MIHOMO_VERSION#v}" && \
    case "$arch" in \
      amd64) \
        if [ "$MIHOMO_AMD64_COMPATIBLE" = "true" ]; then \
          asset="mihomo-linux-amd64-compatible-v${version_no_v}.gz"; \
        else \
          asset="mihomo-linux-amd64-v${version_no_v}.gz"; \
        fi; \
        out="mihomo-linux-amd64" ;; \
      arm64) \
        asset="mihomo-linux-arm64-v${version_no_v}.gz"; \
        out="mihomo-linux-arm64" ;; \
      *) echo "Unsupported Docker architecture for Mihomo: $arch" && exit 1 ;; \
    esac && \
    url="https://github.com/MetaCubeX/mihomo/releases/download/${MIHOMO_VERSION}/${asset}" && \
    echo "Downloading Mihomo: $url" && \
    curl -fsSL "$url" -o /tmp/mihomo.gz && \
    gzip -d -c /tmp/mihomo.gz > "/app/src/bin/${out}" && \
    chmod +x "/app/src/bin/${out}" && \
    rm -f /tmp/mihomo.gz

# 创建数据和图片目录
RUN mkdir -p data public/images

# 暴露端口
EXPOSE 8045

# 启动应用
CMD ["npm", "start"]
