# 企业级部署与运维

本目录是把「能跑」变成「能交付」的运维产物。所有文件都与 `server/` 的实际实现对应，不是示意草图。

```
deploy/
├── k8s/api.yaml              # API + Worker + HPA + PDB + Ingress + PVC
├── prometheus/prometheus.yml # 抓取配置（含 METRICS_TOKEN 用法）
├── prometheus/alerts.yml     # 与架构文档 §9.2 一一对应的告警规则
├── grafana/dashboards/overview.json
├── mysql/replica-entrypoint.sh # 可选只读副本引导（见下文）
├── redis/sentinel-entrypoint.sh # 可选单机哨兵引导（见下文）
├── observability/            # 可选 Collector / Tempo 配置（见下文）
└── migrations.md             # 迁移与存储驱动手册（含踩坑记录）
```

---

## 0. 单机部署（当前阶段）

前期只有一台服务器时，不需要 K8s，也不需要对象存储。最省事的形态：

```
nginx (TLS, :443)
 ├── /            → 静态前端 (dist)
 ├── /api          → API :4000
 └── /media        → API :4000（签名产物，支持 Range）

同一个进程内：API + 内嵌 Worker（EMBEDDED_WORKER=true）
同机依赖：MySQL 8 · Redis 7 · Docker named volume 本地持久盘
```

仓库根目录的 `docker-compose.yml` 已按这个拓扑收口，不再默认启动重复的独立 Worker 或未使用的 MinIO：

```bash
cp .env.example .env
# 设置 PUBLIC_BASE_URL/CORS_ORIGIN 为测试机 IP 或域名，并替换所有密钥占位值
npm run deploy:preflight
docker compose up -d --build
npm run deploy:smoke
```

`deploy:preflight` 是只读检查：验证 Node/Docker/Compose、最终生效的 Compose 配置、密钥占位符、
URL/CORS/Cookie 策略、单机拓扑、日志轮转、停止宽限期、磁盘空间与端口；若栈已经启动，还会核对
容器健康状态和公网入口 `/api/ready`。生产配置可执行
`npm run deploy:preflight -- --mode production`；机器暂未启动 Docker daemon 时可用 `--offline`
只跑静态配置检查。`npm run deploy:up` 会自动先执行测试模式 preflight，任一失败项都不会开始构建。
失败项退出码为 1，参数错误或脚本内部错误为 2；`--json` 可供自动化解析。

`migrate` 一次性容器会先执行版本化迁移和种子，再放行 API；API 健康后才启动 Web。
镜像内含 ffmpeg 和 SQL 迁移文件。`app-storage` / `mysql-data` / `redis-data`
三个卷负责重建持久化。测试验收模式显式使用 `NODE_ENV=development + PAYMENT_PROVIDER=mock`；
接真实支付时再同时切换为生产模式和真实网关。

API、ffmpeg 和迁移进程均以镜像内的 `node` 用户（UID/GID 1000）运行。每次启动时，短生命周期
`storage-init` 容器会先修正 `app-storage` 权限，再放行 API，因此新卷、历史 root-owned 卷和恢复卷
都能由非 root 进程安全读写。

生产 Web 镜像会下发 CSP、`nosniff`、禁止 iframe、Referrer/Permissions Policy 等安全头；主题初始化
已从内联脚本移到同源静态文件。nginx 访问日志只记录 `$uri`，不会落盘媒体签名、SSE token 或其他
查询参数。SSE 单独关闭代理缓冲并保留 930 秒读取窗口，普通 API 恢复缓冲策略；上传请求关闭请求缓冲，
媒体继续透传 Range。API 只信任直接 nginx 一跳，并由 nginx 覆盖客户端传入的 X-Forwarded-For。

所有容器的 stdout/stderr 默认按 `20m × 5` 轮转，即单容器最多约 100 MB；可用
`CONTAINER_LOG_MAX_SIZE` / `CONTAINER_LOG_MAX_FILES` 调整。该上限只约束 Docker 日志，
不影响 MySQL、Redis 与生成产物三个持久卷。API 默认有 5 分钟停止宽限期
（`API_STOP_GRACE_PERIOD`），让内嵌 Worker 在容器关闭前完成或安全收口正在执行的 ffmpeg 任务。

默认资源边界面向 4 vCPU / 8 GiB 测试机：API `2.5 CPU / 3 GiB`、MySQL
`1.5 CPU / 1.5 GiB`、Redis `0.5 CPU / 512 MiB`，其他一次性/静态服务也有 CPU、内存和 PID 上限。
Redis `maxmemory` 默认为 384 MiB 且使用 `noeviction`，队列信号不会被静默淘汰；内嵌 Worker 默认
并发 1，每个 ffmpeg 最多 2 个编码线程。各限制均可在 `.env` 覆盖，preflight 会拒绝缺失或明显过小的边界。
2 vCPU / 4 GiB 主机建议至少设置 `API_CPU_LIMIT=1.5`、`API_MEMORY_LIMIT=2g`、
`MYSQL_CPU_LIMIT=1`、`MYSQL_MEMORY_LIMIT=1g`、`REDIS_MEMORY_LIMIT=256m`、
`REDIS_MAXMEMORY=192mb`、`FFMPEG_THREADS=1`，并保持 `WORKER_CONCURRENCY=1`。

### 可选追踪（Collector + Tempo）

默认单机测试保持追踪关闭。`docker compose up`、`npm run deploy:up` 和
`npm run deploy:preflight` 只读取 `docker-compose.yml`，因此不会创建 Collector 或 Tempo。
`OTEL_ENABLED` 默认为 `false`，`OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` 默认为空，API 不导出 span。

要在这台机器上看链路，把观测文件叠加上去。第二个文件会启动 `otel-collector` 和 `tempo`
（以及给 Tempo 数据卷改权限的一次性 `tempo-init`），并把 `api` 环境覆盖为：

- `OTEL_ENABLED=true`
- `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=http://otel-collector:4318/v1/traces`

该地址带 `/v1/traces`，与 `@opentelemetry/exporter-trace-otlp-proto` 的 `url` 一致。
Collector 在 4318 接收 OTLP/HTTP protobuf，再转发到 Tempo。Tempo 把 trace 写在本地卷
`tempo-data`（保留 24 小时），查询接口只绑定本机 `127.0.0.1:3200`。宿主机上的
OTLP 入口是 `127.0.0.1:4318`。

```bash
docker compose -f docker-compose.yml -f docker-compose.observability.yml up -d --build
curl -fsS http://127.0.0.1:3200/ready
curl -fsS http://127.0.0.1:3200/api/traces/<traceId>
```

停止时也带上这两个文件，Compose 才能看到 Collector 和 Tempo：

```bash
docker compose -f docker-compose.yml -f docker-compose.observability.yml down
```

### 可选 MySQL 只读副本

单机默认仍然只有一个 MySQL。需要只读副本时，把 `docker-compose.mysql-replica.yml` 和基础文件一起传入。`docker compose up`、`npm run deploy:up` 和 `npm run deploy:preflight` 只读取 `docker-compose.yml`，因此不会创建 `mysql-replica`。`npm run test:deploy` 也不使用这个叠加文件。

应用环境里的 `DB_HOST` 保持 `mysql`。API、`migrate` 和 `npm run deploy:backup` 继续使用主库。副本端口只给本机查看，不要把 `DB_HOST` 改成 `mysql-replica`。

```bash
docker compose -f docker-compose.yml -f docker-compose.mysql-replica.yml up -d --build
```

叠加后主库打开 GTID 和 binlog（`server-id=1`、`log-bin`、`gtid-mode=ON`）。`mysql-replica` 使用独立卷 `mysql-replica-data`，`server-id=2`，并打开 `read_only` 与 `super_read_only`。引导脚本 `deploy/mysql/replica-entrypoint.sh` 会在主库创建复制账号，用 clone 拷贝当前数据，再以 GTID（`SOURCE_AUTO_POSITION=1`）从 `mysql:3306` 持续复制。宿主机端口是 `127.0.0.1:3308`（`DB_REPLICA_FORWARD_PORT`），与主库的 `127.0.0.1:3307` 分开。

请在空的 `mysql-data` 卷上第一次就带上这个文件。已经用默认 Compose 初始化过的数据目录里 GTID 是关闭的，MySQL 不能直接改成 `gtid_mode=ON`，主库会拒绝启动；去掉第二个 `-f` 后仍按原来的方式启动，数据目录保留。

复制账号默认是 `repl`，密码默认 `repl_dev_pw`。对外使用前设置 `MYSQL_REPLICATION_USER` 和 `MYSQL_REPLICATION_PASSWORD`。主库 root 需要能从 Compose 网络登录（镜像默认 `MYSQL_ROOT_HOST=%`）。

停止时带上同样的两个文件，Compose 才能看到副本：

```bash
docker compose -f docker-compose.yml -f docker-compose.mysql-replica.yml down
```

副本默认限额是 1 CPU、1536 MiB、256 个 PID，共享内存 256 MiB，日志按与其他容器相同的 json 轮转（`CONTAINER_LOG_MAX_SIZE` / `CONTAINER_LOG_MAX_FILES`）。可用 `MYSQL_REPLICA_CPU_LIMIT`、`MYSQL_REPLICA_MEMORY_LIMIT`、`MYSQL_REPLICA_PIDS_LIMIT`、`MYSQL_REPLICA_SHM_SIZE` 调整。4 vCPU / 8 GiB 的默认预算没有包含这份副本，只在机器还有余量时打开。

这只提供只读副本，不包含自动故障切换。单机备份脚本仍然导出主库。

### 可选 Redis 哨兵

单机默认仍然只有一个 Redis，并且已经用 `--appendonly yes` 打开 AOF。需要只读副本和哨兵时，把 `docker-compose.redis-sentinel.yml` 和基础文件一起传入。`docker compose up`、`npm run deploy:up` 和 `npm run deploy:preflight` 只读取 `docker-compose.yml`，因此不会创建 `redis-replica` 或 `redis-sentinel`。`npm run test:deploy` 也不使用这个叠加文件。

应用环境里的 `REDIS_HOST` 保持 `redis`。API 继续连接原来的 Redis 服务。这份叠加不给 API 增加哨兵地址，应用代码也仍然只读 `REDIS_HOST`。

```bash
docker compose -f docker-compose.yml -f docker-compose.redis-sentinel.yml up -d
```

只使用 `docker-compose.yml` 时，服务仍是 `mysql`、`redis`、`storage-init`、`migrate`、`api`、`web`，Redis 命令也保持原来的 `appendonly`、`maxmemory` 和 `noeviction`。叠加上第二个文件后，主库命令在这些参数之外增加 `replica-announce-ip redis` 和 `replica-announce-port 6379`，AOF 仍然是 `--appendonly yes`。`redis-replica` 使用独立卷 `redis-replica-data`，从 `redis:6379` 复制，并打开 `replica-read-only`。它的 `replica-priority` 是 `0`，哨兵不会把这个副本提升成主库。宿主机查看端口是 `127.0.0.1:6380`（`REDIS_REPLICA_FORWARD_PORT`）。

`redis-sentinel` 由 `deploy/redis/sentinel-entrypoint.sh` 生成配置，监视的主库名字是 `redis`（地址 `redis`、端口 `6379`、法定人数 `1`）。哨兵端口只绑定本机 `127.0.0.1:26379`（`REDIS_SENTINEL_FORWARD_PORT`）。健康检查执行 `SENTINEL MASTER redis`，要通过就必须同时看到主库名字、端口 `6379`、`role-reported=master`、flags 为可达的 master，以及 `num-slaves` 至少为 1。

已有的 `redis-data` 可以继续使用。副本卷是新的，第一次启动会从主库做全量同步。去掉第二个 `-f` 后，主库回到原来的命令，数据目录保留。

停止时带上同样的两个文件，Compose 才能看到副本和哨兵：

```bash
docker compose -f docker-compose.yml -f docker-compose.redis-sentinel.yml down
```

副本默认限额是 0.5 CPU、512 MiB、128 个 PID；哨兵是 0.25 CPU、128 MiB、64 个 PID。日志按与其他容器相同的 json 轮转。可用 `REDIS_REPLICA_CPU_LIMIT`、`REDIS_REPLICA_MEMORY_LIMIT`、`REDIS_REPLICA_PIDS_LIMIT`、`REDIS_REPLICA_MAXMEMORY`、`REDIS_SENTINEL_CPU_LIMIT`、`REDIS_SENTINEL_MEMORY_LIMIT`、`REDIS_SENTINEL_PIDS_LIMIT` 调整。4 vCPU / 8 GiB 的默认预算没有包含这两个容器，只在机器还有余量时打开。

这是单机监视用的哨兵和只读副本。哨兵不会提升优先级为 0 的副本，应用也不会改连新地址。生产环境若要做哨兵或 Cluster 故障转移，需要单独的多节点拓扑和客户端发现，不在这个文件里。

单机必须做对的四件事：

| 项                      | 值                                                    | 为什么                                                    |
| ----------------------- | ----------------------------------------------------- | --------------------------------------------------------- |
| `STORAGE_DRIVER`        | `local`                                               | 单机用对象存储只是多一跳网络和一份账单                    |
| `EMBEDDED_WORKER`       | `true`                                                | 少一个进程要管；任务仍在 Redis Streams 里，重启时 DB 兜底 |
| `REFRESH_COOKIE_SECURE` | HTTP 测试为 `false`；启用 TLS 后必须为 `true`         | Secure cookie 在纯 HTTP 测试地址下不会回传                |
| 磁盘备份                | 每日归档 `benchu-canvas_app-storage` 卷 + `mysqldump` | **产物不打进对象存储时，备份就是唯一副本**                |

数据库迁移用 `npm run db:init`（迁移 + 种子）；Compose 已通过 `migrate` 服务自动执行，细节见 `migrations.md`。

> 什么时候该上 K8s/对象存储：需要多台应用服务器、或产物需要 CDN 分发时。
> 代码侧已经就绪 —— `STORAGE_DRIVER=s3` 一个变量切换，k8s 清单在 `deploy/k8s/`。

单机备份脚本会先检查 Compose、MySQL 和存储卷，短暂暂停 API 与内嵌 Worker 的写入，
在同一静止窗口内导出数据库和产物卷，随后自动恢复 API。脚本会把内容写入临时时间戳目录，
校验归档与 SHA-256 后再原子改名；已有同名目录时直接终止，不会覆盖旧备份；中途失败也会由 trap 恢复 API：

```bash
npm run deploy:backup
# 输出：backups/YYYYmmdd-HHMMSS/{mysql.sql,storage.tar.gz,metadata.txt,SHA256SUMS}
```

建议用 systemd timer 或 cron 每日调用，并把整个 `backups/` 同步到另一块磁盘或远端备份库；
只保存在同一台服务器上仍会受整机磁盘故障影响。脚本当前面向 Linux 测试机，运行时会按需拉取小型 `alpine:3.20` 镜像完成卷归档。

恢复必须显式指定一个备份目录，并在完整 Compose 停机后执行。脚本会先限制并校验
`SHA256SUMS` 清单、metadata、SQL 与 tar 路径，再恢复 MySQL 与 `app-storage`；目标卷非空时默认退出：

```bash
docker compose down
npm run deploy:restore -- backups/YYYYmmdd-HHMMSS
docker compose up -d
npm run deploy:smoke
```

确需覆盖非空卷时，必须同时给出精确项目名；覆盖前会创建临时回滚快照，恢复失败自动回滚：

```bash
npm run deploy:restore -- backups/YYYYmmdd-HHMMSS --force --confirm-project benchu-canvas
```

CI 的单机验收会实际执行一次「写入随机产物卷哨兵 → 备份 → 删除数据卷 → 恢复 → 哨兵 SHA-256 与用户数一致性校验 → 再跑生成冒烟」，
同时在生产 nginx 的 8080 入口运行浏览器测试，覆盖 SPA 深链、静态 chunk 与 `/api` 代理组合。

本地存储生命周期清理默认只预览。它会先从 `task_outputs`、`assets` 及历史任务 URL
收集全部引用，再扫描 `uploads/`、`outputs/` 和遗留临时文件；数据库不可用时直接终止，
不会把“查不到引用”误判成“没有引用”：

```bash
npm run deploy:cleanup                            # Compose 容器内 dry-run
npm run deploy:cleanup -- --json                  # 供监控/cron 解析
npm run deploy:cleanup -- --apply                 # 默认只删超过 24 小时的孤儿/临时文件
npm run deploy:cleanup -- --apply --max-delete 5000 --min-age-hours 48
```

源码开发环境也可用 `npm --prefix server run storage:lifecycle -- [参数]` 执行同一逻辑。

`--apply` 还受 `--max-delete`（默认 1000）硬上限保护。建议先每日 dry-run 告警，确认一周后再启用 apply。
此脚本只回收 DB 已无引用的对象；套餐到期保留策略需要先完成用户通知与恢复窗口设计，再单独启用。

---

## 1. 健康探针三分法

| 端点              | 用途      | 依赖          | 失败后果       |
| ----------------- | --------- | ------------- | -------------- |
| `GET /api/live`   | liveness  | 无            | 重启 Pod       |
| `GET /api/ready`  | readiness | MySQL         | 摘流量，不重启 |
| `GET /api/health` | 人工排障  | MySQL + Redis | 无（给人看）   |

这是刻意分开的：**数据库抖动时重启 API Pod 只会放大故障**。liveness 永远不碰外部依赖。

```bash
curl -s localhost:4000/api/live    # {"ok":true}
curl -s localhost:4000/api/ready   # {"ok":true} 或 503 {"ok":false,"error":"DB_UNAVAILABLE"}
curl -s localhost:4000/api/health  # 含队列深度与 worker 模式
```

---

## 2. 指标

`GET /api/metrics` 输出 Prometheus 文本格式，不依赖任何客户端库（镜像更小、冷启动更快）。

| 指标                                                 | 类型      | 含义                                 |
| ---------------------------------------------------- | --------- | ------------------------------------ |
| `benchu_http_requests_total{route,method,status}`    | counter   | 请求数，可算 QPS 与 5xx 比例         |
| `benchu_http_request_duration_ms_bucket{...}`        | histogram | 延迟分位（P50/P95/P99）              |
| `benchu_http_errors_total`                           | counter   | 5xx 总数                             |
| `benchu_tasks_total{model,outcome}`                  | counter   | 任务吞吐与成功率                     |
| `benchu_task_duration_ms_bucket{type,model,outcome}` | histogram | 渲染耗时（容量规划依据）             |
| `benchu_queue_depth`                                 | gauge     | **真实**积压 = 未投递 + 已投递未 ACK |
| `benchu_tasks_running_stale`                         | gauge     | 僵尸任务数（超心跳窗口）             |
| `benchu_reconcile_issues`                            | gauge     | **账务异常数，必须恒为 0**           |
| `benchu_provider_auth_total{model}`                  | counter   | 上游凭证被拒绝                       |
| `benchu_tasks_dead_letter_total{model}`              | counter   | 可重试错误用尽次数后的死信           |

> ⚠️ `benchu_queue_depth` 刻意不用 `XLEN`。Redis Stream 会保留已 ACK 的条目，`XLEN` 只增不减，用它做告警会永久误报。实现读的是 `XINFO GROUPS.lag` + `XPENDING` 之和，并配合 `XTRIM` 控制流长度。

生产环境请通过 `METRICS_TOKEN` 保护该端点（nginx 已额外 403 掉公网访问）：

```yaml
# prometheus.yml
scrape_configs:
  - job_name: benchu-canvas-api
    authorization:
      type: Bearer
      credentials_file: /etc/prometheus/metrics-token
```

---

## 3. 告警设计原则

告警规则见 `prometheus/alerts.yml`，分三档：

- **critical（钱）**：`benchu_reconcile_issues > 0` —— 余额与流水不一致、重复扣费、漏退款。这类问题不允许"观察一下"，必须立即人工介入。
- **warning（可用性）**：成功率 < 95%、队列积压 > 500、5xx > 1%、僵尸任务 > 20、单模型错误率 > 10%、上游凭证被拒绝、10 分钟内出现重试死信。
- **info（性能）**：API P95 > 800ms。

告警里每条都写了 `runbook`，值班同学不需要去读代码就知道第一步该做什么。

---

## 4. 对账（P0 能力）

```bash
TOKEN=<你的 access token>
curl -s -H "Authorization: Bearer $TOKEN" localhost:4000/api/admin/reconcile | jq
```

返回三类异常，任一非空即 `ok: false`：

```json
{
  "ok": false,
  "balanceDrift": [{ "userId": "...", "credits": 4670, "ledgerTotal": -330 }],
  "doubleCharged": [{ "taskId": "...", "rows": 2 }],
  "unrefundedFailures": [{ "taskId": "...", "cost": 30, "code": "RENDER_ERROR" }]
}
```

**修复铁律：只允许补记流水，禁止直接改 `users.credits`。**
直接改余额会让账本永久失真，之后再也没法用"余额 = 流水合计"这条不变量做自动校验。演练方式：

```bash
# 检出异常 → 补记一条 reason='对账修正 · ...' 的流水 → 再次调用应返回 ok: true
```

同一个检查也通过 `benchu_reconcile_issues` 指标暴露，因此可以接自动告警而不需要有人记得去跑脚本。

---

## 5. 扩容思路

| 瓶颈                 | 该扩什么                 | 不该扩什么                |
| -------------------- | ------------------------ | ------------------------- |
| API 延迟高、CPU 打满 | `benchu-api` 副本        | —                         |
| 队列积压增长         | **`benchu-worker` 副本** | 扩 API 无用，任务是异步的 |
| MySQL 连接数打满     | 连接池 + 只读副本        | 盲目加 API 副本会更快打满 |
| 对象存储带宽         | CDN 回源改造             | —                         |

`EMBEDDED_WORKER=false` 是生产必须：API Pod 一旦也消费队列，滚动发布时会把渲染任务带进重启，白白浪费已扣费的算力。

---

## 6. 发布前检查清单

- [ ] `REFRESH_COOKIE_SECURE=true`（否则 refresh cookie 会走明文）
- [ ] `JWT_SECRET` / `STORAGE_SIGN_SECRET` / `METRICS_TOKEN` 来自 KMS，不是仓库里的值
- [ ] `CORS_ORIGIN` 精确到域名，不用 `*`
- [ ] 使用 S3/OSS 时，桶 CORS 允许 Web 来源的 `PUT/GET/HEAD` 以及 `Content-Type`、`x-amz-content-sha256`
- [ ] `/api/metrics` 公网不可达（Ingress 或 nginx 层拦截）
- [ ] `npm run db:status` 显示 0 个待应用迁移
- [ ] `npm run typecheck && npm test && npm run e2e` 全绿
- [ ] `npm run drill:reaper` / `drill:billing` 全绿（改过计费或队列时必须跑）
- [ ] `node scripts/check-encoding.mjs` 通过
- [ ] 对账接口返回 `ok: true`
- [ ] `benchu_reconcile_issues` 已接入告警
- [ ] 单机部署：`benchu-canvas_app-storage` 卷与数据库都已进每日备份
- [ ] 已做过一次「kill -9 worker 中途杀进程」的恢复演练：任务应被 reaper 接管并退款
