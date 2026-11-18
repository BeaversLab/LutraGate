# LutraGate Server 形态镜像（ticket 12）。
# 构建上下文必须是仓库根目录：
#   docker build -f packages/server/Dockerfile -t lutragate .

# ---- 依赖与构建：node + pnpm（lockfile 精确安装）----
FROM node:22-slim AS build
ENV CI=1
RUN corepack enable
WORKDIR /app
# 先只 copy manifests 以命中依赖缓存层。
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/core/package.json packages/core/
COPY packages/server/package.json packages/server/
COPY packages/worker/package.json packages/worker/
COPY packages/admin-ui/package.json packages/admin-ui/
# 只安装 server 链路（shared/core/server）的依赖。
RUN pnpm install --frozen-lockfile \
      --filter @lutragate/shared --filter @lutragate/core --filter @lutragate/server

COPY packages/shared packages/shared
COPY packages/core packages/core
COPY packages/server packages/server
RUN pnpm --filter @lutragate/shared --filter @lutragate/core run build

# ---- 运行：Bun（bun:sqlite）----
FROM oven/bun:1.2-slim
WORKDIR /app
COPY --from=build /app ./
# 运行镜像不携带测试文件。
RUN find /app/packages -name "*.test.ts" -delete
RUN mkdir -p /data && chown -R bun:bun /data /app
USER bun
ENV NODE_ENV=production \
    DB_PATH=/data/lutragate.db \
    PORT=8787
VOLUME /data
EXPOSE 8787
# oven/bun:slim 没有 curl，用 bun 自身做健康检查。TCP 连接级探测：http 与自签名
# TLS 形态通用（http fetch 探针在 TLS 监听上必失败，自签名证书也过不了校验）。
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD bun -e "Bun.connect({hostname:'127.0.0.1',port:Number(process.env.PORT||8787),socket:{data(){},error(){}}}).then(s=>{s.end();process.exit(0)}).catch(()=>process.exit(1))"
CMD ["bun", "run", "packages/server/src/index.ts"]
