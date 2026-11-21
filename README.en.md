# LutraGate

English | [简体中文](README.md)

A self-hosted, OpenAI-compatible multi-provider LLM gateway: it aggregates official API keys from OpenAI / DeepSeek / Kimi / Groq and others behind a single endpoint, routes by weight with automatic failover, and ships with a built-in admin UI served from the gateway itself. Designed for personal and family self-hosting.

```
Client / Agent ──/v1/chat/completions──▶ LutraGate ──▶ Upstream providers (weighted multi-key routing, retry & failover)
Built-in admin UI (same-origin Web) ──/admin/*──▶ Config CRUD / log sync / audit
```

- **Two deployment forms**: Cloudflare Workers (D1) or any server (Bun + SQLite, one-command Docker) — the same core logic.
- **Fault tolerance**: weighted random channel selection; automatic channel failover on upstream 5xx / 429 / timeout / network errors; a channel cools down for 60 seconds after 3 consecutive failures and recovers lazily.
- **Multi-user**: two credential planes — `lgm_` management tokens and `lgk_` access keys — that are mutually exclusive. Administrators grant upstream keys per user; `/v1/models` and routing converge accordingly. Every log entry carries user and access-key attribution for per-scenario statistics.
- **Security**: keys are encrypted at rest with AES-GCM and decrypted only at forwarding time; credentials are stored as hashes and plaintext is shown only once; the admin plane authenticates with an explicit `X-Admin-Token` header (no cookies, no CSRF surface), restricts browser origins to same-origin/localhost/the desktop shell, and supports IP allowlists and Cloudflare Access.
- **Observability**: every proxy request is logged asynchronously (token usage, latency, status, attribution). The admin UI syncs logs incrementally into local IndexedDB and aggregates them into dashboards; the server also exposes a `/admin/usage` aggregation endpoint.

## Quick start (Server form, simplest)

Requires: Docker. Everything after the container start happens in the browser.

```bash
cp .env.example .env
# Edit .env: set ADMIN_TOKEN to your own value (bootstrap only), generate ENCRYPTION_KEY with: openssl rand -base64 32
docker compose up -d --build
```

Then open <http://localhost:8787>:

1. On the login page click "**First-time setup**", paste the `ADMIN_TOKEN` from `.env`, and create the first administrator;
2. The `lgm_` management token is **shown only once** — copy and save it (this is your login credential from now on);
3. After acknowledging you land straight in the admin UI: configure channels under Providers / Keys / Mappings, and create accounts for your family (role "user"), grants, and access keys under Users & Grants.

```bash
curl http://localhost:8787/health   # optional health check
# {"status":"ok","version":"1.0.0",...}
```

The database is a single SQLite file stored in the `lutragate-data` volume (`/data/lutragate.db`) and survives container rebuilds. To back it up, copy that file.

**Note**: `ENCRYPTION_KEY` cannot be changed once it is in use (otherwise stored keys can no longer be decrypted). Keep it safe.

### Without Docker (run directly with Bun)

```bash
pnpm install
pnpm build   # full build incl. admin-ui (the server serves it same-origin)

ADMIN_TOKEN=dev-admin-token \
ENCRYPTION_KEY="$(openssl rand -base64 32)" \
DB_PATH=./lutragate.db \
pnpm --filter @lutragate/server dev
```

It listens on `:8787` too (admin UI at the root); all following steps are identical to the Docker form. If you only work on the server and don't need the UI, `pnpm --filter @lutragate/shared --filter @lutragate/core build` suffices — the root then serves no UI; use `pnpm --filter @lutragate/admin-ui dev` for a vite dev server instead.

### Bootstrap semantics (the ADMIN_TOKEN lifecycle)

`ADMIN_TOKEN` is **for bootstrapping only**: when the system has no enabled administrator yet, use it to create the first administrator (browser "First-time setup" or the curl in the appendix). Once created it loses authentication power automatically (it does not become a long-term backdoor). All later logins use that administrator's `lgm_` management token. In the Worker form you can delete that Secret; in the Server form the environment variable must remain (required by startup validation), but it can no longer be used to log in. lgm_/lgk_ plaintext appears only once in creation/reset responses — save it immediately.

Changes take effect immediately (admin writes invalidate the 30-second config cache). Equivalent admin-API curl commands live in the [appendix](#appendix-admin-api-curl-cheat-sheet).

### Call it (OpenAI-compatible)

`/v1/*` authenticates with `lgk_` access keys (the multi-user system): a request is routed only to upstream keys granted to the key's owner, and `/v1/models` converges accordingly.

```bash
curl http://localhost:8787/v1/chat/completions \
  -H "Authorization: Bearer <lgk_ access key>" -H "content-type: application/json" \
  -d '{"model":"gpt-4o","messages":[{"role":"user","content":"hi"}]}'
```

Add `"stream": true` for streaming; SSE chunks are passed through as-is. Anthropic (`/v1/messages`), Responses (`/v1/responses`) and Gemini native formats are also supported.

## Release notes

LutraGate is a first open-source release; there is no migration from an older version (the static `GATEWAY_TOKEN`). Deploy it via "Quick start" and connect clients with the multi-user credential system (`lgm_` management token / `lgk_` access key).

## Quick start (Worker form)

Requires: a Cloudflare account, the [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/) (`npm i -g wrangler`), and your own domain (**required**, see below).

```bash
cd packages/worker

# 1. Create a D1 database and note the database_id in the output
wrangler d1 create lutragate
```

Put the database_id into `wrangler.jsonc` at `d1_databases[0].database_id` (replacing the `"local"` placeholder), **and only then run the next step**:

```bash
# 2. Create tables (run migrations against the remote D1)
wrangler d1 migrations apply lutragate --remote

# 3. Configure secrets (generate ENCRYPTION_KEY locally: openssl rand -base64 32)
wrangler secret put ADMIN_TOKEN        # bootstrap only; can be deleted after creating the administrator
wrangler secret put ENCRYPTION_KEY
```

Before the first deploy, finish the custom domain configuration below, then run `wrangler deploy`.

### Enable Cloudflare Access (recommended for admin-plane protection)

1. Cloudflare Zero Trust → Access → Applications: add a self-hosted application with the domain `https://<your gateway domain>/admin*`.
2. Add a policy allowing your own email (or family members).
3. Create a **Service Token** for that application (Access → Service Tokens) and configure the client id / secret on the Worker:
   ```bash
   wrangler secret put CF_ACCESS_CLIENT_ID
   wrangler secret put CF_ACCESS_CLIENT_SECRET
   ```
   Once configured, `X-Admin-Token` no longer works (Access takes precedence).

Without Access, `/admin/*` uses `X-Admin-Token` (the bootstrap `ADMIN_TOKEN` initially, then each user's `lgm_`). After deploying, the gateway domain root serves the admin UI; the "First-time setup" bootstrap flow is the same as the Server form (see above).

### Custom domain (strongly recommended)

**Do not rely on `*.workers.dev`**: from mainland China, workers.dev domains have high latency and are often unreachable. Bind your own domain:

> Prerequisite: the domain's DNS zone is hosted in the same Cloudflare account.

Add this at the top level of `wrangler.jsonc`:

```jsonc
"routes": [{ "pattern": "gw.example.com", "custom_domain": true }]
```

Then run `wrangler deploy`; the output confirms the domain binding.

### Mainland access optimization (ideas)

- A custom domain goes through Cloudflare's CDN, so reachability on most routes is far better than workers.dev.
- If latency is still unsatisfactory, use "preferred IPs": resolve your custom domain to lower-latency Cloudflare edge IPs via local hosts entries or your own DNS (community-maintained preferred-IP lists are easy to find). The SNI remains your domain, so the certificate is unaffected.
- The admin plane (Web) is not latency-sensitive and needs no optimization.

## Admin UI

**Built-in form (default)**: the admin UI is served same-origin by the gateway itself — baked into the Docker image in the Server form, and served from Cloudflare's edge with `wrangler deploy` in the Worker form. Open the gateway root URL and log in with an `lgm_` token (the address is pre-filled for same-origin use). Features:

- **administrator**:
  - **Dashboard**: request volume, success rate, token usage, per-provider latency percentiles, timeline. Logs sync incrementally into local IndexedDB every 5 minutes (manual sync is also available).
  - **Providers / Keys / Mappings**: create, update, delete, enable/disable, adjust weights; keys show only their last four characters.
  - **Users & grants**: user list with enable/disable/delete (guarded so the last administrator cannot be removed), create users and reset tokens (`lgm_` shown once), and a grouped authorization checkbox editor by provider (saved as a whole set).
  - **Connectivity test**: send one minimal chat request directly to any provider (without going through the gateway) and show latency and failure reason. See [provider verification and feedback](PROVIDERS.md).
- **user**: only three personal panels — My Keys (create/enable/revoke `lgk_`), My Usage (aggregated by key = scenario), Available Models (read-only list converged by grants).

**Development mode (when working on the UI)**:

```bash
pnpm install
pnpm build                       # admin-ui depends on shared/core dist; build once first
pnpm --filter @lutragate/admin-ui dev
# Open http://localhost:5173, enter the gateway URL (e.g. http://localhost:8787) and lgm_ on first use
```

## Development

```bash
pnpm install
pnpm build       # build shared/core dist first; test/typecheck depend on it (required for a fresh clone)
pnpm test        # all tests (shared / core / worker(D1) / server(bun) / admin-ui)
pnpm typecheck
```

| Package | Description |
| :--- | :--- |
| `packages/shared` | Zod schemas, error codes, version (single contract source) |
| `packages/core` | Pure routing/retry/cooldown logic + runtime-agnostic Web layer (gateway/admin) |
| `packages/worker` | Cloudflare Workers adapter (D1, Secrets, waitUntil) |
| `packages/server` | Bun + Hono + SQLite adapter (Docker) |
| `packages/admin-ui` | Vite + React admin UI (served same-origin by the gateway / shared with the desktop shell) |

## License

- The repository root is licensed under **AGPL-3.0** (covering the `server` / `worker` / `admin-ui` application layer).
- `packages/shared` and `packages/core` are **MIT** (separately permissive for reuse).
- See `LICENSE`, `packages/shared/LICENSE`, `packages/core/LICENSE`.

## API overview

| Method | Path | Auth | Description |
| :--- | :--- | :--- | :--- |
| POST | `/v1/chat/completions` | `Authorization: Bearer <lgk_ access key>` | OpenAI-compatible proxy (streaming / non-streaming) |
| GET | `/v1/models` | same | Available model list |
| GET | `/health` | none | Version and uptime |
| GET | `/version` | none | Release tag / commit / gateway version (fields are null when not injected) |
| GET/POST/PUT/DELETE | `/admin/providers\|keys\|mappings` | `X-Admin-Token: <lgm_>` (or Access) | Config CRUD |
| GET/POST/PUT/DELETE | `/admin/users`, `POST /admin/users/:id/token\|access-keys` | same (administrator) | Users, `lgm_` reset, create `lgk_` on behalf |
| GET/POST/PUT/DELETE | `/admin/access-keys` | same (user: own only) | Self-service `lgk_` access keys |
| GET/PUT | `/admin/users/:id/grants` | same (administrator) | Upstream key grants (whole-set replace) |
| GET | `/admin/me`, `/admin/me/grants` | same | Identity, own grants and reachable models |
| GET | `/admin/usage?from=&to=&user_id=&access_key_id=&group_by=key\|model` | same (user: own only) | Usage aggregation |
| GET | `/admin/logs?from=&to=&model=&provider=&cursor=&limit=` | same (administrator) | Cursor-paginated logs |
| GET | `/admin/audit`, `/admin/export` | same | Audit and redacted export |

Errors are uniformly `{"error":{"code":"...","message":"..."}}`; upstream 4xx responses are passed through unchanged and are not retried.
## Appendix: admin API curl cheat sheet

The browser is the regular path; for scripting you can call the admin API directly (an administrator's `lgm_` goes in the `x-admin-token` header). Each command below is equivalent to a browser step above.

```bash
# 0. Bootstrap: create the first administrator with the ADMIN_TOKEN (the plaintext lgm_ appears only in this response — save it immediately)
curl -X POST http://localhost:8787/admin/users \
  -H "x-admin-token: <ADMIN_TOKEN>" -H "content-type: application/json" \
  -d '{"name":"root","role":"administrator"}'
# → {"id":"...","management_token":"lgm_...","token_hint":"..."}

# 1. Add a provider (type = a preset provider id or "custom"; endpoints gives upstream base URLs per protocol)
curl -X POST http://localhost:8787/admin/providers \
  -H "x-admin-token: <lgm_ management token>" -H "content-type: application/json" \
  -d '{"name":"deepseek","type":"deepseek","endpoints":{"openai":"https://api.deepseek.com"}}'
# → {"id":"<PROVIDER_ID>",...}

# 2. Add a key (plaintext appears only this once; the server encrypts it at rest)
curl -X POST http://localhost:8787/admin/keys \
  -H "x-admin-token: <lgm_ management token>" -H "content-type: application/json" \
  -d '{"provider_id":"<PROVIDER_ID>","api_key":"sk-..."}'

# 3. Map a client model → upstream model
curl -X POST http://localhost:8787/admin/mappings \
  -H "x-admin-token: <lgm_ management token>" -H "content-type: application/json" \
  -d '{"client_model":"gpt-4o","provider_id":"<PROVIDER_ID>","upstream_model":"deepseek-chat"}'

# 4. Create a user (role "user")
curl -X POST http://localhost:8787/admin/users \
  -H "x-admin-token: <lgm_ management token>" -H "content-type: application/json" \
  -d '{"name":"alice","role":"user"}'

# 5. Grant: assign provider keys to that user (the whole set is replaced)
curl -X PUT http://localhost:8787/admin/users/<USER_ID>/grants \
  -H "x-admin-token: <lgm_ management token>" -H "content-type: application/json" \
  -d '{"provider_key_ids":["<PROVIDER_KEY_ID>"]}'

# 6. Create an access key on the user's behalf (the user can also call POST /admin/access-keys with their own lgm_)
curl -X POST http://localhost:8787/admin/users/<USER_ID>/access-keys \
  -H "x-admin-token: <lgm_ management token>" -H "content-type: application/json" \
  -d '{"name":"support-bot"}'
# → {"id":"...","access_key":"lgk_...","key_hint":"..."} (plaintext appears only in this creation response)
```
