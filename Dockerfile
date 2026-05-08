FROM node:20-alpine

WORKDIR /app

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8045 \
    CONFIG_DIR=/app/data \
    DATA_DIR=/app/data \
    IMAGE_DIR=/app/public/images

# 复制 package.json 和 package-lock.json
COPY package*.json ./

# 安装依赖
RUN npm ci --omit=dev

# 复制源代码
COPY . .

# 复制 .env.example 为默认 .env
RUN cp .env.example .env

# 创建数据和图片目录
RUN mkdir -p data public/images

# 暴露端口
EXPOSE 8045

# 启动应用
CMD ["npm", "start"]
