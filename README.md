# 星绘 AI · 文生图 / 图生视频平台

企业级 AI 内容生成平台：React 19 前端 + Fastify 5 后端 + MySQL 8 + Redis 7。

- 前端：React 19 · Vite 7 · TypeScript · Tailwind v4（oklch 双主题）
- 后端：Fastify 5 · mysql2 · zod · JWT（access + refresh 轮换）
- 基础设施：MySQL 8 · Redis Streams 队列 · Prometheus 指标 · Docker / K8s

架构与演进方案见 [`方案架构梳理实现.md`](./方案架构梳理实现.md)，运维手册见 [`deploy/README.md`](./deploy/README.md)。

---

## 一键启动

```bash
npm install
npm run server:install         # 后端依赖
npm run db:start -- --init     # 独立 MySQL(:3307) + 建表 + 演示账号
npm run dev:all                # MySQL → API(:4000) → 前端(:5183)
```

| 服务       | 地址                              |
| ---------- | --------------------------------- |
| 前端       | http://127.0.0.1:5183/video       |
| API        | http://127.0.0.1:4000/api/health  |
| 套餐与充值 | http://127.0.0.1:5183/billing     |
| 运营看板   | http://127.0.0.1:5183/admin       |
| 指标       | http://127.0.0.1:4000/api/metrics |

演示账号：**demo@benchu.art / demo1234**

> Redis 未启动时会自动降级到 DB 轮询模式，功能不中断（吞吐下降）。

### 单机 Docker 测试部署

```bash
copy .env.example .env        # Windows；Linux/macOS 使用 cp
# 编辑 .env，把 SERVER_IP 和测试机密钥占位值换掉
npm run deploy:preflight      # 校验 Docker、配置、密钥、磁盘、端口和运行状态
npm run deploy:up             # 会再次执行 preflight，然后构建、迁移并启动
npm run deploy:smoke          # 注册 → 生成真实 MP4 → Range 读取产物
```

启动后访问 `http://SERVER_IP:8080/video`。默认拓扑只有 Web、API（内嵌 Worker）、MySQL、Redis；
生成产物、上传文件、数据库和队列均落在 Docker named volume，容器重建不会清空数据。
API 与 ffmpeg 以非 root 用户运行；一次性 `storage-init` 会在启动前兼容修正新卷、旧卷和恢复卷权限。
查看日志用 `npm run deploy:logs`，停止服务用 `npm run deploy:down`（不会删除数据卷）。
Compose 默认把每个容器的 stdout/stderr 限制为 `20m × 5` 份轮转文件，避免长期测试写满系统盘；
可在 `.env` 通过 `CONTAINER_LOG_MAX_SIZE` 和 `CONTAINER_LOG_MAX_FILES` 调整。
日常运维使用 `npm run deploy:backup` 生成带校验和的数据库/产物备份，使用
`npm run deploy:restore -- backups/<时间戳>` 在停机状态校验并恢复数据库与产物，使用
`npm run deploy:cleanup` 预览孤儿文件；确认清单后追加 `-- --apply` 执行清理。

---

## 质量门禁

```bash
cd server
npm run typecheck      # 后端类型检查
npm test               # 80 个单元测试（无外部依赖）
npm run e2e            # 22 项端到端（需 API 已启动，含画布持久化）
npm run drill:reaper   # 混沌演练：Worker 中途被杀 → 接管 + 退款
npm run drill:billing  # 支付演练：篡改价格 / 签名 / webhook 重放 / 并发配额
cd ..
npx tsc --noEmit -p tsconfig.app.json && npm run build
```

CI 见 `.github/workflows/ci.yml`：起真实 MySQL 8.4 + Redis 7 service 跑完整 E2E 与混沌演练。

---

## 核心能力

| 领域           | 实现                                                                                                                              |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| **计费**       | 事务内 `FOR UPDATE` 扣减 + 只追加流水 + `uk_idem` 幂等 + 死锁退避重试 + 三向对账（余额=流水/无重复扣费/无漏退款）                 |
| **商业化**     | 三档套餐 + 四个充值包 + 订单 + 支付 webhook（验签 + 幂等 + 金额服务端快照）+ 并发配额（free 1 / pro 4 / ent 32）+ 营收对账        |
| **任务流水线** | Redis Streams 消费组 + DB 轮询降级 + PEL 认领 + 心跳 + 僵尸回收（失败且退款，幂等）+ 优先级 + 尝试次数                            |
| **鉴权**       | bcrypt(12) + access 15min（带 `jti`）+ refresh 7d（httpOnly cookie，**旋转 + 重放检测 + family 撤销**）                           |
| **多租户**     | organizations / memberships / RBAC(owner·admin·editor·viewer) / X-Org-Id 切换 / Redis 角色缓存即时失效                            |
| **API Key**    | `bk_live_*`，sha256 存库，scopes + rpm 限流                                                                                       |
| **限流**       | Redis 滑窗：生成 60/min·用户，上传 60/min，登录 5/min + 15min 锁定                                                                |
| **存储**       | S3 式 key 布局 + HMAC 签名 URL（TTL）+ Range 请求 + 路径穿越防护                                                                  |
| **内容合规**   | 输入审核（扣费前拦截）+ **输出审核（管线强制，未配置分类器时对远程 Provider fail-closed）** + AI 生成水印 + 全量审计（含 org_id） |
| **可观测**     | JSON 日志 + `traceId` 全链路 + Prometheus（QPS/延迟分位/吞吐/队列/账务异常）+ `/api/live` `/api/ready`                            |
| **运维**       | Dockerfile×3 + compose + nginx（SSE 不缓冲）+ K8s（HPA/PDB/Ingress） + Grafana 看板 + 告警规则                                    |

---

## 目录结构

```
├── src/                        # 前端
│   ├── components/             # 外壳、顶栏、侧栏、Agent、登录/账户弹窗、播放器
│   ├── pages/                  # 创作台 / 画布 / 团队 / 运营看板 / 工具页
│   └── lib/
│       ├── api.ts              # fetch 封装 + 401 自动刷新 + DTO 映射
│       ├── auth.tsx            # 登录态 + 静默续期调度
│       └── generation.tsx      # 任务 Context（SSE + 轮询兜底）
├── server/
│   ├── src/
│   │   ├── index.ts            # 入口：探针/指标/错误契约/优雅退出
│   │   ├── worker.ts           # 独立 Worker 入口
│   │   ├── routes/             # auth · generations · assets · credits · models · media · tenants · apiKeys · admin
│   │   ├── services/           # credits · pipeline · queue · runner · sessions · ratelimit · moderation · storage · audit
│   │   ├── middleware/         # JWT / API Key / RBAC
│   │   └── db/                 # pool(死锁重试) · 版本化 migrations · init/seed
│   ├── tests/                  # vitest 单测
│   └── scripts/                # e2e · reaper-drill · render-smoke
├── deploy/                     # k8s · prometheus(含告警) · grafana
└── .github/workflows/ci.yml
```

---

## 关键设计取舍

**为什么错误处理器必须在路由注册之前挂载？**
Fastify 的封装机制会在注册子上下文时拷贝错误处理器。若 `setErrorHandler` 在路由插件之后调用，已注册的路由仍走默认处理器，返回 `{statusCode, error, message}` 而非契约要求的 `{error, message, traceId}`。这个问题实测中被发现并修复。

**为什么队列深度不用 `XLEN`？**
Redis Stream 会保留已 ACK 的条目，`XLEN` 只增不减，用它做积压告警会永久误报。实现改成 `XINFO GROUPS.lag` + `XPENDING`（未投递 + 已投递未 ACK），并周期 `XTRIM` 控制流长度。

**为什么 liveness 不探 DB？**
数据库抖动时重启 API Pod 只会放大故障。`/api/live` 不碰依赖，`/api/ready` 才查 DB（摘流量而不重启）。

**为什么 SSE 优先用 cookie，仍接受 `?token=`？**
浏览器优先用 httpOnly cookie（`EventSource({ withCredentials: true })`）。接口仍接受 `?token`，因为 `EventSource` 不能自定义请求头。访问日志会把 token 脱敏。

---

## 已知欠账

| 项                | 现状                                                                                        | 影响                                               |
| ----------------- | ------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| 真实模型 Provider   | 通用 HTTP Provider 已存在。没有配置 `PROVIDER_HTTP_BASE_URL` 时仍用 `builtinProvider` 产出真实 PNG 和 H.264 MP4 | 各厂商字段映射和密钥还没有                         |
| 真实支付网关        | Stripe、支付宝、微信适配器已存在，默认仍是 mock。选了某个网关但秘密为空时不注册，也不退回 mock           | 真实收款还要商户密钥和公网回调                     |
| 输出审核分类器      | 管线已强制接入并 fail-closed，但需配置 `MODERATION_OUTPUT_URL` 指向内部分类服务才会实际判定             | 未配置时远程 Provider 产物会被拒绝（安全但不可用） |
| 对象存储            | 双驱动。默认本地目录。`STORAGE_DRIVER=s3` 时走自研 SigV4，缺密钥会在启动时失败，不会静默退回本地目录   | 多节点仍需要真实桶、密钥和浏览器 CORS              |
| 企业 SSO            | 已是 Authorization Code + PKCE，待配置企业 IdP                                                          | 大客户接入                                         |
| 超大表分区/归档     | 迁移已到 `0016_task_next_attempt_at.sql`，一共 16 个。任务、订单、积分流水仍有外键，所以不做月分区。`audit_logs` 可用 `npm run audit:archive` 冷归档，默认只预览 | 亿级任务后需要冷热分层；月分区未做                 |
| 可选 MySQL 只读副本 | 已存在，默认不启用，没有自动切换                                                                        | 主库故障不会自动切到副本                           |
| 密钥                | 仍在环境变量，没有接 KMS                                                                                | 生产密钥未托管                                     |

---

## 注意

- `server/.env` 已在 `.gitignore` 中。`JWT_SECRET` / `STORAGE_SIGN_SECRET` 仍在环境变量，没有接 KMS。
- 生产必须设 `EMBEDDED_WORKER=false`（API 不消费队列，滚动发布才不会带走渲染任务）与 `REFRESH_COOKIE_SECURE=true`。
- `/api/metrics` 不应暴露公网；nginx 已 403，K8s 场景用 `METRICS_TOKEN` 或 NetworkPolicy。
- 修复账务异常只允许**补记流水**，禁止直接改 `users.credits`。
