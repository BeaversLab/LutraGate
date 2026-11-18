# LutraGate

[English](README.en.md) | 简体中文

自托管、OpenAI 兼容的多供应商 LLM 网关：把 OpenAI / DeepSeek / Kimi / Groq 等官方 API Key 聚合到一个入口，按权重路由、失败自动切换，配套本地管理端（配置管理 + 用量仪表盘）。个人与家庭自用设计。

```
客户端 / Agent ──/v1/chat/completions──▶ LutraGate 网关 ──▶ 上游供应商（多 Key 加权路由、重试切换）
本地管理端（Web）──/admin/*──▶ 配置 CRUD / 日志同步 / 审计
```

- **两种部署形态**：Cloudflare Workers（D1）或任意服务器（Bun + SQLite，Docker 一键起）——同一套核心逻辑。
- **容错**：渠道加权随机；上游 5xx / 429 / 超时 / 网络错误自动换渠道重试；连续失败 3 次冷却 60 秒并惰性恢复。
- **多用户**：lgm_ 管理 token / lgk_ 访问 key 两级凭证，两平面互斥；管理员按用户授权上游 key，`/v1/models` 与路由同步收敛；每条日志带用户与 key 归属，可按场景统计。
- **安全**：Key 以 AES-GCM 加密落库，仅在转发瞬间解密；凭证哈希存储、明文仅一次性展示；管理 API 限 CORS 本地来源。
- **可观测**：每次代理请求异步落日志（token 用量、延迟、状态、归属），管理端增量同步到本地 IndexedDB 聚合出仪表盘，服务端另有 /admin/usage 聚合端点。

## 快速开始（Server 形态，最简单）

需要：Docker。

```bash
cp .env.example .env
# 编辑 .env：ADMIN_TOKEN 自定（仅用于引导创建第一个管理员），ENCRYPTION_KEY 用 openssl rand -base64 32 生成
docker compose up -d --build

curl http://localhost:8787/health
# {"status":"ok","version":"1.0.0",...}
```

数据库是单个 SQLite 文件，存在 `lutragate-data` 数据卷（`/data/lutragate.db`），随容器重建保留。备份即拷贝该文件。

**注意**：`ENCRYPTION_KEY` 一旦投入使用不可更换（否则已存 Key 无法解密），请妥善保管。

### 不用 Docker（Bun 直跑）

```bash
pnpm install
pnpm --filter @lutragate/shared --filter @lutragate/core build   # 先构建 shared/core 的 dist

ADMIN_TOKEN=dev-admin-token \
ENCRYPTION_KEY="$(openssl rand -base64 32)" \
DB_PATH=./lutragate.db \
pnpm --filter @lutragate/server dev
```

同样监听 `:8787`，后续步骤与 Docker 形态完全一致。

### 引导创建管理员（首次必做）

`ADMIN_TOKEN` **仅用于引导**：当系统中还没有任何启用的 administrator 时，用它登录管理面创建第一个管理员；创建成功后它自动失效（不会成为长期后门），后续登录一律使用该管理员的 `lgm_` 管理 token。

```bash
# 用引导 ADMIN_TOKEN 创建第一个 administrator（lgm_ 明文只在这次响应中出现，立即保存）
curl -X POST http://localhost:8787/admin/users \
  -H "x-admin-token: <ADMIN_TOKEN>" -H "content-type: application/json" \
  -d '{"name":"root","role":"administrator"}'
# → {"id":"...","management_token":"lgm_...","token_hint":"..."}
```

创建成功后 ADMIN_TOKEN 自动失去认证效力。Worker 形态可删除该 Secret；Server 形态的环境变量保留（启动校验必需），但它已不能用于登录。

### 配置渠道

打开管理端（见下文，用 `lgm_` 登录），或在服务器上直接调管理 API（administrator 的 lgm_ 经 `x-admin-token` 头携带）：

```bash
# 1. 添加供应商（type 选预置供应商 id 或 "custom"，endpoints 按协议给上游根地址）
curl -X POST http://localhost:8787/admin/providers \
  -H "x-admin-token: <lgm_管理token>" -H "content-type: application/json" \
  -d '{"name":"deepseek","type":"deepseek","endpoints":{"openai":"https://api.deepseek.com"}}'
# → {"id":"<PROVIDER_ID>",...}

# 2. 录入 Key（明文只出现这一次，服务端加密落库）
curl -X POST http://localhost:8787/admin/keys \
  -H "x-admin-token: <lgm_管理token>" -H "content-type: application/json" \
  -d '{"provider_id":"<PROVIDER_ID>","api_key":"sk-..."}'

# 3. 映射客户端模型 → 上游模型
curl -X POST http://localhost:8787/admin/mappings \
  -H "x-admin-token: <lgm_管理token>" -H "content-type: application/json" \
  -d '{"client_model":"gpt-4o","provider_id":"<PROVIDER_ID>","upstream_model":"deepseek-chat"}'
```

配置即时生效（管理写入会失效 30 秒配置缓存）。

### 为接入方建用户 / 授权 / 访问 key

```bash
# 1. 管理员建用户（user 角色）
curl -X POST http://localhost:8787/admin/users \
  -H "x-admin-token: <lgm_管理token>" -H "content-type: application/json" \
  -d '{"name":"alice","role":"user"}'

# 2. 授权：把某几把上游 provider_key 分配给该用户（整组替换）
curl -X PUT http://localhost:8787/admin/users/<USER_ID>/grants \
  -H "x-admin-token: <lgm_管理token>" -H "content-type: application/json" \
  -d '{"provider_key_ids":["<PROVIDER_KEY_ID>"]}'

# 3. 管理员代建（用户本人用自己 lgm_ 调 POST /admin/access-keys 亦可）
curl -X POST http://localhost:8787/admin/users/<USER_ID>/access-keys \
  -H "x-admin-token: <lgm_管理token>" -H "content-type: application/json" \
  -d '{"name":"客服机器人"}'
# → {"id":"...","access_key":"lgk_...","key_hint":"..."}（明文只在创建响应中出现一次）
```

### 调用（OpenAI 兼容）

`/v1/*` 用 `lgk_` 访问 key 鉴权（多用户体系）：请求只路由到 key 所属用户被授权的上游 key，`/v1/models` 同步收敛。

```bash
curl http://localhost:8787/v1/chat/completions \
  -H "Authorization: Bearer <lgk_访问key>" -H "content-type: application/json" \
  -d '{"model":"gpt-4o","messages":[{"role":"user","content":"hi"}]}'
```

流式加 `"stream": true` 即可，SSE 逐 chunk 透传。Anthropic（`/v1/messages`）、Responses（`/v1/responses`）与 Gemini 原生格式同样直通。

## 版本说明

LutraGate 为首次发布的开源版本，不存在从旧版本（静态 `GATEWAY_TOKEN`）迁移的场景。直接按「快速开始」部署，并用多用户凭证体系（`lgm_` 管理 token / `lgk_` 访问 key）接入即可。

## 快速开始（Worker 形态）

需要：Cloudflare 账号、[Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/)（`npm i -g wrangler`）、一个自有域名（**必须**，见下文）。

```bash
cd packages/worker

# 1. 创建 D1 数据库，记下输出中的 database_id
wrangler d1 create lutragate
```

把 database_id 填入 `wrangler.jsonc` 的 `d1_databases[0].database_id`（替换占位值 `"local"`），**填好后再执行下一步**：

```bash
# 2. 建表（远程 D1 执行 migration）
wrangler d1 migrations apply lutragate --remote

# 3. 配置 Secret（ENCRYPTION_KEY 本地生成：openssl rand -base64 32）
wrangler secret put ADMIN_TOKEN        # 仅引导用，建好管理员后可删除
wrangler secret put ENCRYPTION_KEY
```

首次部署前，先完成下面的自定义域名配置，再 `wrangler deploy`。

### 开启 Cloudflare Access（管理面保护，推荐）

1. Cloudflare Zero Trust → Access → Applications，添加自托管应用，域名填 `https://<你的网关域名>/admin*`。
2. 策略放行自己的邮箱（或家庭组成员）。
3. 给该应用生成 **Service Token**（Access → Service Tokens），把 client id / secret 配到 Worker：
   ```bash
   wrangler secret put CF_ACCESS_CLIENT_ID
   wrangler secret put CF_ACCESS_CLIENT_SECRET
   ```
   配置后 `X-Admin-Token` 不再生效（Access 优先）。

不开 Access 时 `/admin/*` 使用 `X-Admin-Token`（引导期 `ADMIN_TOKEN`，此后为各用户的 lgm_）。引导流程与 Server 形态相同（见上文「引导创建管理员」）。

### 自定义域名（强烈要求）

**不要依赖 `*.workers.dev`**：大陆访问 workers.dev 域名延迟高且经常不可达。绑定自有域名：

> 前置条件：该域名的 DNS zone 托管在同一个 Cloudflare 账号。

`wrangler.jsonc` 顶部加：

```jsonc
"routes": [{ "pattern": "gw.example.com", "custom_domain": true }]
```

然后 `wrangler deploy`，输出会确认域名绑定。

### 大陆访问优化（思路）

- 自定义域名走 Cloudflare CDN，多数线路可达性远好于 workers.dev。
- 延迟仍不满意时可用「优选 IP」：本地 hosts 或自建 DNS 把自定义域名解析到延迟更低的 Cloudflare 边缘 IP（社区维护的优选 IP 列表自取），SNI 仍为你的域名、证书不受影响。
- 管理面（本地 Web）对延迟不敏感，无需优化。

## 本地管理端

```bash
pnpm install
pnpm build                       # admin-ui 依赖 shared/core 的 dist，首次先构建
pnpm --filter @lutragate/admin-ui dev
# 打开 http://localhost:5173
```

首次在顶部填网关地址（如 `http://localhost:8787`）与管理 Token（lgm_），保存在浏览器 localStorage；启动时自动调 `/admin/me` 按角色渲染视图。功能：

- **administrator**：
  - **仪表盘**：请求量、成功率、Token 用量、各供应商延迟分位数、时间线；日志每 5 分钟增量同步到本地 IndexedDB（也可手动触发）。
  - **供应商 / Key / 映射**：增删改、启停、权重调整；Key 只显示尾号。
  - **用户与授权**：用户列表与启停/删除（受最后管理员守卫约束）、创建用户与重置 token（lgm_ 一次性展示）、按供应商分组的授权勾选编辑器（整组保存）。
  - **连通性测试**：对任意供应商直发一次最小对话请求（不经网关），展示延迟与失败原因。
- **user**：仅三个自己的面板——我的 Key（自建/启停/吊销 lgk_）、我的用量（按 key=场景聚合）、可用模型（按授权收敛的只读列表）。

## 开发

```bash
pnpm install
pnpm build       # 先产 shared/core dist；test/typecheck 依赖它（全新克隆必需）
pnpm test        # 全部测试（shared / core / worker(D1) / server(bun) / admin-ui）
pnpm typecheck
```

| 包 | 说明 |
| :--- | :--- |
| `packages/shared` | Zod schema、错误码、版本号（单一契约源） |
| `packages/core` | 路由/重试/冷却纯逻辑 + 运行时无关 Web 层（gateway/admin） |
| `packages/worker` | Cloudflare Workers 适配器（D1、Secret、waitUntil） |
| `packages/server` | Bun + Hono + SQLite 适配器（Docker） |
| `packages/admin-ui` | Vite + React 本地管理端 |

## 许可

- 仓库根许可为 **AGPL-3.0**（覆盖 `server` / `worker` / `admin-ui` 应用层）。
- `packages/shared` 与 `packages/core` 为 **MIT**（独立宽松许可，便于复用）。
- 详见根目录 `LICENSE`、`packages/shared/LICENSE`、`packages/core/LICENSE`。

## API 一览

| 方法 | 路径 | 鉴权 | 说明 |
| :--- | :--- | :--- | :--- |
| POST | `/v1/chat/completions` | `Authorization: Bearer <lgk_ 访问 key>` | OpenAI 兼容代理（流式/非流式） |
| GET | `/v1/models` | 同上 | 可用模型列表 |
| GET | `/health` | 无 | 版本与 uptime |
| GET | `/version` | 无 | 发布标签 / commit / 网关版本（未注入时字段为 null） |
| GET/POST/PUT/DELETE | `/admin/providers\|keys\|mappings` | `X-Admin-Token: <lgm_>`（或 Access） | 配置 CRUD |
| GET/POST/PUT/DELETE | `/admin/users`、`POST /admin/users/:id/token\|access-keys` | 同上（administrator） | 用户、lgm_ 重置、代建 lgk_ |
| GET/POST/PUT/DELETE | `/admin/access-keys` | 同上（user 仅自己的） | lgk_ 访问 key 自助管理 |
| GET/PUT | `/admin/users/:id/grants` | 同上（administrator） | 上游 key 授权（整组替换） |
| GET | `/admin/me`、`/admin/me/grants` | 同上 | 身份、自己的授权与可达模型 |
| GET | `/admin/usage?from=&to=&user_id=&access_key_id=&group_by=key\|model` | 同上（user 仅自己的） | 用量聚合 |
| GET | `/admin/logs?from=&to=&model=&provider=&cursor=&limit=` | 同上（administrator） | 游标分页日志 |
| GET | `/admin/audit`、`/admin/export` | 同上 | 审计、脱敏导出 |

错误统一为 `{"error":{"code":"...","message":"..."}}`；上游 4xx 原样透传不重试。
