# 数据库迁移与存储驱动

本文件记录两件「上了生产才知道疼」的事：迁移怎么跑、存储怎么切。

---

## 1. 迁移

### 1.1 目录与命令

```
server/src/db/migrations/
├── 0001_baseline.sql          # v1 全部表 + 增量列/索引（幂等）
├── 0002_plans_and_orders.sql  # 商业化四表 + users.plan_id
├── 0003_monthly_plan_credits.sql # 套餐月度积分发放账本
├── 0004_generation_visibility.sql # 组织共享任务显式可见性
└── 0005_oidc_identities.sql   # OIDC issuer + subject 身份绑定
```

```bash
cd server
npm run db:migrate                 # 应用全部待执行
npm run db:status                  # 已应用 / 待应用 / 是否漂移
npm run db:migrate -- --dry-run    # 只列出将执行什么
npm run db:migrate -- --to 0001    # 分批发布（灰度前置）
npm run db:init                    # 迁移 + 种子（模型/套餐/演示账号）
npm run drill:migrations           # 演练：空库/幂等/漂移/分步/采纳
```

`db:init` 内部就是 `migrate()` + 种子，所以 CI 和本地只有一条路径。

### 1.2 四条硬规则

**（1）每个 DDL 必须幂等。**
MySQL 的 DDL 会隐式提交，**不在事务里**。文件跑到一半失败时无法回滚，只能靠重跑补齐。
所以建表用 `CREATE TABLE IF NOT EXISTS`，加列/建索引用 `information_schema` + `PREPARE` 守卫。

**（2）已发布的迁移不许改。**
runner 会记录每个文件的 sha256。改动已应用的文件 → 下次启动直接报错：

```
迁移 0002_plans_and_orders.sql 已应用但文件内容被修改（checksum 不一致）
```

这是刻意的。没有这条，两个环境会静默分叉，几天后才发现某张表少一列。
修复方式永远是**新增一个迁移**。

**（3）不要写 `AFTER <column>`。**
列的位置与正确性无关，但 `AFTER error` 会让迁移依赖兄弟列存在 —— 在形状不同的遗留表上必然失败。
演练就是这么踩到的。

**（4）索引要检查列是否存在。**
只检查「索引名不存在」是不够的：遗留表可能没有被索引的列，`ADD INDEX` 会以
`Key column doesn't exist` 失败，然后阻塞整个发布。只为优化而建的索引跳过即可。

### 1.3 adoption：既有库怎么接入

迁移体系上线前创建的库有表、没有账本。runner 的判断逻辑：

```
账本为空 且 0001 创建的全部 12 张表都已存在  →  记为 adopted（execution_ms = 0），不重放
否则                                        →  正常执行 0001
```

「全部」是重点。早期版本只抽查 3 张表，结果一个只建了部分表的库被误判为已初始化，
剩下的表永远不会被创建，0002 随后在 `audit_logs` 上失败。演练里有专门一条用例守这个。

### 1.4 开发期改写迁移

刚写完迁移就发现要改，但本地库已经应用过了：

```bash
npx tsx scripts/reset-migration.ts 0002 --drop orders,credit_packs,payment_events
npm run db:init     # 重新应用迁移 + 重新种子
```

⚠️ `--drop` 会删表，**种子数据一起没**（套餐、充值包）。所以脚本会提醒再跑 `db:init`。
生产环境不要用这个脚本。

### 1.5 发布顺序

```
1) 先跑迁移（向前兼容：只加列/加表，不改不删）
2) 再发代码
3) 下一个版本再清理旧字段
```

因为加列/加表对旧代码无害，"先迁移后发版"天然安全。反过来（先发代码后迁移）会 500。

---

## 2. 存储驱动

### 2.1 两个驱动

| | `local`（默认） | `s3` |
|---|---|---|
| 适用范围 | 单台服务器 | 多节点 / 需要 CDN |
| 依赖 | 磁盘 | S3 兼容服务（AWS / MinIO / R2 / B2） |
| 下载 | `/media/{key}?e=&s=`（应用签名） | 桶预签名 URL 或 CDN |
| 直传 | `PUT /media/{key}?e=&s=` | 预签名 `PUT` 直连桶 |
| Range | 应用支持（视频拖动） | 桶原生 |

**单机阶段 local 严格更优**：没有网络跳数、没有按请求计费、没有凭证要轮换。
抽象驱动不是为了现在用 S3，而是为了「将来换存储不用改路由」。

切换只需一个环境变量：

```bash
STORAGE_DRIVER=s3
S3_ENDPOINT=https://oss-cn-hangzhou.aliyuncs.com
S3_REGION=oss-cn-hangzhou
S3_BUCKET=benchu-prod
S3_ACCESS_KEY_ID=...
S3_SECRET_ACCESS_KEY=...
S3_FORCE_PATH_STYLE=false      # AWS/OSS 用虚拟主机风格；MinIO 用 true
S3_PUBLIC_BASE_URL=https://cdn.example.com   # 可选，挂 CDN 时设
```

对象 key 布局完全一致，所以数据迁移就是 `mc mirror` / `aws s3 sync` 一次拷贝。

### 2.2 自研 SigV4 的两个理由

没有引入 `@aws-sdk/client-s3`（连同传递依赖约 30MB）：

1. 只需要 4 个 HTTP 动词（PUT / HEAD / DELETE / 预签名 GET|PUT）
2. 官方 SDK 的体积和初始化开销对单机部署没有收益

代价是必须自己保证签名正确 —— 所以：

- `tests/storage-driver.test.ts` 用 **AWS 官方文档的派生密钥测试向量**校对（`f4780e2d…`）
- `npm run drill:s3` 对**真实 MinIO** 跑 10 项端到端

### 2.3 已验证的行为

```
PUT / HEAD / size 一致
预签名 GET 可下载        篡改签名 → 403
路径被替换 → 403         预签名 PUT 直传 → 200
4MB 流式上传（stream + Content-Length）
DELETE 幂等（重复删除成功）
远程驱动下 localPath() → null（调用方不会误以为有本地文件）
```

> 踩坑记录：S3 拒绝没有 `Content-Length` 的流式 PUT（`MissingContentLength`）。
> 用 `fetch` 发 stream 时必须手动补这个头；Buffer body 由 fetch 自带。

---

## 3. 编码

Windows + 中文控制台有个隐蔽陷阱：`Set-Content` / `Add-Content` 默认按 ANSI 代码页（GBK）写文件，
会把 UTF-8 的中文变成一串 `?`，**不可恢复**。

本仓库因此提供一个扫描器：

```bash
cd server
node scripts/check-encoding.mjs
# [ok] no encoding damage found
```

它同时检查非法 UTF-8 字节和引号内成串的 `?`。建议放进 pre-commit 与 CI。
