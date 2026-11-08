# 番剧记忆力测试（Cloudflare Workers + D1）

写下你记得的番剧，自动核对、去重并计数。

- **本地题库 296 部**秒认中文名、日文名、英文名、缩写、拼音首字母、错字和季数后缀。
- **Bangumi 在线检索**：题库外的名字实时查 Bangumi，支持中文、日文、英文和别名。
- **多用户**：游客 / 注册用户，进度实时写 D1，关掉网页再打开继续。
- **排行榜**：按当前记住的数量实时排名，游客和注册用户都能上榜。
- **历史结果**：每次“保存这一轮”生成一条快照，登录后跨设备可见。

## 身份与多用户

| 场景 | 行为 |
|---|---|
| 首次打开 | 服务器自动创建一个游客身份，展示为 `游客xxxxx`（5 位随机字符，数据库唯一）。cookie 存在浏览器里，不同浏览器互不冲突。 |
| 游客注册 | 当前游客身份原地升级成账号，不改 id，已有进度、历史、排行榜记录都保留。 |
| 游客登录 | 当前游客的进度会合并进目标账号（按作品 key 去重），然后切换到账号会话。 |
| 退出登录 | 删除当前会话并创建一个全新的游客身份；账号里的数据仍保存在服务器上。 |
| 换设备 | 在另一台浏览器直接登录账号，就能读到之前的进度和历史。 |
| 清除 cookie | 游客身份会丢失（游客本来就是“这台浏览器”的）；注册用户重新登录即可找回。 |

进度不是定时上传：每次新增、删除、清空都会立刻请求 D1。客户端另外维护一个按身份隔离的 localStorage 重试队列，网络断开时先记在本地，恢复后按顺序补写。

## 匹配

1. 先查本地 296 部（精确、别名、拼音首字母、编辑距离容错），命中直接计数。
2. 没命中 → `POST /api/match` → Worker 请求 Bangumi `/v0/search/subjects`，取前 10 条。
3. 对 `name_cn`、日文名、infobox 别名打分；≥0.9 且明显领先才自动计入，否则给候选让你确认。
4. 按 `bgm:id` / `local:id` / 归一化标题去重；例如「地狱乐」和 `Hell's Paradise` 只算一部。

匹配结果写入 D1 `match_cache`，30 天缓存；Bangumi 请求带 UA、429 自动重试。

## 架构

```
浏览器（cookie: am_session）
  ├─ 本地 296 部题库 —— 命中即记
  ├─ /api/auth/*     —— 游客 / 注册 / 登录 / 退出
  ├─ /api/entries    —— 实时进度（D1 entries）
  ├─ /api/rounds     —— 历史结果快照（D1 rounds）
  ├─ /api/leaderboard—— 实时排行榜
  ├─ /api/match      —— Bangumi 在线检索（D1 match_cache 缓存）
  └─ /api/stats      —— 全站统计
```

## 数据库

`migrations/0001_init.sql`：

- `identities`：游客 / 用户；用户存 PBKDF2 密码哈希、salt、迭代次数；游客展示名唯一。
- `sessions`：cookie token 的 SHA-256 哈希、身份、过期时间（一年）。
- `entries`：`identity_id + key` 主键，实时进度。
- `rounds`：每次保存的历史快照（标题数组、数量、起止时间）。
- `match_cache`：Bangumi 查询缓存，30 天 TTL。

## 本地开发

需要 Node 18+。

```bash
npm install
npm run db:migrate      # 建本地 D1 表
npm run dev             # http://127.0.0.1:8787
```

如果之前跑过旧版本，本地 D1 结构变了：停掉 dev，删 `.wrangler/state/v3/d1`，再执行 `npm run db:migrate`。部署过旧版本的话，需要新建 D1 或自己写迁移。

可选：`npm run preview` 在 8790 起一个静态 + API 反代（转发到 8787），方便在不会自动附加已运行服务的内嵌浏览器里预览。

### 本地测 Turnstile

复制 `.dev.vars.example` 为 `.dev.vars`，使用 Cloudflare 官方测试密钥（永远通过）：

```
TURNSTILE_SITE_KEY=1x00000000000000000000AA
TURNSTILE_SECRET=1x0000000000000000000000000000000AA
```

重启 `npm run dev`，打开登录/注册弹窗就能看到人机验证组件。

注意：内嵌的 Browser 预览面板可能因为 postMessage/iframe 限制不渲染 Turnstile 组件（控制台会出现 target origin 警告）；用普通浏览器打开 `http://127.0.0.1:8787` 或部署后再确认组件显示。服务端校验逻辑已用 Cloudflare 官方测试密钥验证过。

## 部署到 Cloudflare

```bash
npx wrangler login
```

```bash
npx wrangler d1 create anime-memory
```

把输出的 `database_id` 填进 `wrangler.toml`：

```bash
npm run db:migrate:remote
```

同时把 `wrangler.toml` 里的 `BGM_UA` 改成你自己的域名或仓库（Bangumi 用它识别应用）。如果启用人机验证，先到 Cloudflare Turnstile 创建站点，把 site key 填进 `TURNSTILE_SITE_KEY`。

设置生产 key（可选但推荐）：

```bash
npx wrangler secret put PASSWORD_PEPPER
```

```bash
npx wrangler secret put TURNSTILE_SECRET
```

```bash
npm run deploy
```

### 人机验证

- `wrangler.toml` 的 `TURNSTILE_SITE_KEY` 是公开的 site key；`TURNSTILE_SECRET` 用 `wrangler secret put`。
- 只配 site key 不配 secret：前端显示组件，但服务端不校验。
- 只配 secret 不配 site key：前端没有组件，服务端会要求 token，登录/注册会失败。两个一起配。
- 不需要人机验证时把两者都留空即可。
- Cloudflare Turnstile 免费，建议在 Dashboard 里把 Workers 域名加入允许列表。

### 密码与会话

- PBKDF2-HMAC-SHA-256，随机 salt，默认 25000 次迭代，可由 `PBKDF2_ITERATIONS` 调整（上限 200000）。
- 可选 `PASSWORD_PEPPER` 服务端 pepper；设置后不要更改，否则已有账号无法登录。
- 会话 token 是 32 字节随机值，只以 SHA-256 哈希存在 D1；cookie 为 `HttpOnly; SameSite=Lax`，HTTPS 下自动加 `Secure`。
- 没有邮箱/手机号找回；用户名不区分大小写，密码 6–64 字符。
- 注册/登录有简单的按 IP 限流（每个 Worker 实例 10 分钟 20 次）。公开部署建议再加 Cloudflare Rate Limiting 规则。

## API

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/auth/me` | 当前身份；没有 cookie 返回 401 |
| POST | `/api/auth/guest` | 创建游客（已有有效身份则原样返回） |
| POST | `/api/auth/register` | `{username, password, turnstileToken?}` |
| POST | `/api/auth/login` | `{username, password, turnstileToken?}`，会合并当前游客进度 |
| POST | `/api/auth/logout` | 删除当前会话并返回新的游客身份 |
| GET/POST/DELETE | `/api/entries` | 当前身份的进度；DELETE 不带 key 清空 |
| GET/POST | `/api/rounds` | 历史结果；POST 快照当前进度 |
| GET | `/api/leaderboard?scope=all\|users` | 前 20 名 + 自己的排名 |
| POST | `/api/match` | `{names:[...]}`，最多 5 个 |
| GET | `/api/config` | Turnstile site key |
| GET | `/api/stats` | 全站去重作品数 / 活跃身份数 |
| GET | `/api/health` | 健康检查 |

所有身份相关接口都依赖 `am_session` cookie，不再使用 `X-Session`。

## 测试

```bash
npm run test:auth
```

会创建 `test_` 开头的测试账号，验证：游客创建与唯一性、注册升级、登录合并、进度/历史保留、退出、排行榜、大小写用户名、重复用户名、错误密码。需要 `npm run dev` 正在运行。

```bash
npm run test:live
```

抽查 Bangumi 在线匹配（会创建约 30 个真实请求，注意速率）。

## 文件

```
anime-memory/
├─ public/index.html     前端
├─ public/data.js        本地 296 部题库
├─ src/worker.js         路由 / Bangumi / 进度 / 排行榜
├─ src/auth.js           身份、session、PBKDF2、Turnstile
├─ src/lib.js            归一化、相似度、候选择优
├─ migrations/           D1 迁移
├─ tools/auth-check.mjs  多用户冒烟测试
├─ tools/live-check.mjs  Bangumi 匹配抽查
├─ tools/preview.mjs     本地 8790 反代
├─ wrangler.toml
└─ package.json
```

## 已知边界

- 游客身份绑定 cookie；无痕窗口/清 cookie 会变成新游客，旧游客数据仍在 D1，但无法再访问。
- 排行榜按“当前记住的数量”，不是历史最佳；历史最佳在成绩单里。游客默认也在榜上，可切换到“注册用户”。
- 拼音首字母只覆盖本地 296 部；Bangumi 不认 `gmdzr` 这类写法，题库外作品请写全名或别名。
- Bangumi 把每一季作为独立条目，在线匹配会分别计数；本地题库按系列合并。
- Bangumi 限流：已加 30 天缓存、每请求最多 5 个名字、429 重试；流量大时建议申请 API 权限或自建镜像。
- 公开部署建议给 `/api/match` 和 `/api/auth/*` 加 Cloudflare Rate Limiting 规则。
- 如果要放 Vercel：`src/lib.js` 可原样复用，`src/auth.js` 的 Web Crypto 逻辑也能用；把 Worker 路由改成 `api/*.ts`，D1 换成 Neon/Postgres，表结构照搬即可。
