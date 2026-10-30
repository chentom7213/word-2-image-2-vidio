import mysql from 'mysql2/promise';
import bcrypt from 'bcryptjs';
import { randomUUID } from 'node:crypto';
import { env } from '../env.js';
import { migrate as migrateSchema } from './migrate.js';
import { applyUtcSession } from './session-tz.js';

type SeedModel = {
  id: string;
  name: string;
  price: string;
  kind: 'image' | 'video';
  provider: string;
  refs?: ('image' | 'video' | 'audio')[];
  durations?: number[];
  tag?: string;
};

/**
 * Canonical catalogue. `price` strings mirror the marketing copy; the numeric
 * billing truth is priceAmount/priceUnit which the API hands to the client so
 * the estimate shown in the UI always equals what the server charges.
 */
const VIDEO_CATALOGUE: SeedModel[] = [
  { id: 'seedance-2', name: 'Seedance 2.0', price: '55积分/秒起', kind: 'video', provider: 'seedance', refs: ['image'], durations: [3, 4, 5, 6, 8, 10, 12] },
  { id: 'seedance-mini', name: 'Seedance Mini', price: '28积分/秒起', kind: 'video', provider: 'seedance', refs: ['image'], durations: [3, 4, 5, 6, 8, 10] },
  { id: 'seedance-fast', name: 'Seedance Fast', price: '44积分/秒起', kind: 'video', provider: 'seedance', refs: ['image'], durations: [3, 4, 5, 6, 8] },
  { id: 'seedance-2-5', name: 'Seedance 2.5', price: '84积分/秒起', kind: 'video', provider: 'seedance', refs: ['image', 'video'], durations: [3, 4, 5, 6, 8, 10, 12] },
  { id: 'minimax', name: 'MiniMax', price: '80积分/秒起', kind: 'video', provider: 'minimax', refs: ['image'], durations: [3, 5, 6, 8, 10] },
  { id: 'wanxiang', name: '万相', price: '43积分/秒起', kind: 'video', provider: 'wanxiang', refs: ['image'], durations: [3, 4, 5, 6, 8] },
  { id: 'omni-video', name: '全能视频模型', price: '100积分/次', kind: 'video', provider: 'omni', refs: ['image', 'video', 'audio'], durations: [5, 6, 8, 10] },
  { id: 'seedance-mini-sale', name: '特价 Seedance Mini【不卡人脸】', price: '200积分/次', kind: 'video', provider: 'seedance', refs: ['image'], durations: [5] },
  { id: 'seedance-mini-720', name: 'Seedance Mini 720p【不卡人脸】', price: '62积分/秒', kind: 'video', provider: 'seedance', refs: ['image'], durations: [3, 5, 6, 8] },
  { id: 'seedance-mini-480', name: 'Seedance Mini 480p【不卡人脸】', price: '28积分/秒', kind: 'video', provider: 'seedance', refs: ['image'], durations: [3, 5, 6] },
  { id: 'wanxiang-3', name: '万相3.0', price: '750积分/次', kind: 'video', provider: 'wanxiang', refs: ['image', 'video'], durations: [5, 8] },
  { id: 'minimax-h3', name: 'MiniMax H3', price: '5积分/秒', kind: 'video', provider: 'minimax', refs: ['image', 'video'], durations: [4, 5, 6] },
  { id: 'omni-video-2', name: '全能生视频2', price: '150积分/次', kind: 'video', provider: 'omni', refs: ['image', 'video', 'audio'], durations: [5, 8] },
  { id: 'seedance-fast-480', name: 'Seedance Fast 480p【不卡人脸】', price: '44积分/秒', kind: 'video', provider: 'seedance', refs: ['image'], durations: [3, 5, 6] },
  { id: 'seedance-fast-720', name: 'Seedance Fast 720p【不卡人脸】', price: '100积分/秒', kind: 'video', provider: 'seedance', refs: ['image'], durations: [3, 5, 6, 8] },
  { id: 'seedance-2-pro', name: 'Seedance 2.0 Pro【不卡人脸】', price: '55积分/秒起', kind: 'video', provider: 'seedance', refs: ['image', 'video'], durations: [3, 5, 6, 8, 10] },
  { id: 'seedance-2-5-pro', name: 'Seedance 2.5 Pro【不卡人脸】', price: '84积分/秒起', kind: 'video', provider: 'seedance', refs: ['image', 'video'], durations: [3, 5, 6, 8, 10] },
];

const IMAGE_CATALOGUE: SeedModel[] = [
  { id: 'nano-banana', name: 'Nano Banana', price: '30积分/次', kind: 'image', provider: 'nano-banana', refs: ['image'] },
  { id: 'gpt-image', name: 'GPT-Image', price: '45积分/次', kind: 'image', provider: 'openai', refs: ['image'] },
  { id: 'seedream-4', name: 'Seedream 4.0', price: '25积分/次', kind: 'image', provider: 'seedance', refs: ['image'] },
  { id: 'flux-kontext', name: 'FLUX.1 Kontext', price: '35积分/次', kind: 'image', provider: 'flux', refs: ['image'] },
  { id: 'midjourney', name: 'Midjourney', price: '40积分/次', kind: 'image', provider: 'midjourney' },
];

/** `55积分/秒起` → per_second; `100积分/次` → per_call. */
function parsePrice(model: SeedModel) {
  const amount = parseInt(model.price.replace(/[^\d]/g, ''), 10) || 0;
  const unit: 'per_second' | 'per_call' = /秒/.test(model.price) ? 'per_second' : 'per_call';
  return { amount, unit };
}

export const CATALOGUE = [...VIDEO_CATALOGUE, ...IMAGE_CATALOGUE];

/**
 * 套餐与充值包。价格以**分**为单位存储，避免浮点误差。
 * 这里是唯一的定价权威源：客户端只能传 sku id，金额一律由服务端读出后快照进订单。
 */
const PLAN_SEED = [
  {
    id: 'free',
    name: '免费版',
    priceCents: 0,
    monthlyCredits: 1000,
    maxConcurrent: 1,
    maxDuration: 5,
    rpm: 20,
    features: { models: 'standard', watermark: true, support: 'community' },
    sortWeight: 0,
  },
  {
    id: 'pro',
    name: '专业版',
    priceCents: 9900, // ¥99/月
    monthlyCredits: 20000,
    maxConcurrent: 4,
    maxDuration: 10,
    rpm: 120,
    features: { models: 'all', watermark: false, support: 'email' },
    sortWeight: 10,
  },
  {
    id: 'enterprise',
    name: '企业版',
    priceCents: 99900, // ¥999/月
    monthlyCredits: 300000,
    maxConcurrent: 32,
    maxDuration: 12,
    rpm: 600,
    features: { models: 'all', watermark: false, support: 'dedicated', sso: true },
    sortWeight: 20,
  },
];

const PACK_SEED = [
  { id: 'pack-1000', name: '体验包', credits: 1000, priceCents: 900, bonus: 0, sortWeight: 0 },
  { id: 'pack-5000', name: '创作包', credits: 5000, priceCents: 3900, bonus: 500, sortWeight: 10 },
  { id: 'pack-20000', name: '专业包', credits: 20000, priceCents: 12900, bonus: 3000, sortWeight: 20 },
  { id: 'pack-100000', name: '企业包', credits: 100000, priceCents: 49900, bonus: 20000, sortWeight: 30 },
];

async function seedBillingCatalogue(conn: mysql.Connection) {
  for (const p of PLAN_SEED) {
    await conn.query(
      `INSERT INTO plans (id, name, price_cents, monthly_credits, max_concurrent, max_duration, rpm, features, enabled, sort_weight)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
       ON DUPLICATE KEY UPDATE
         name = VALUES(name),
         price_cents = VALUES(price_cents),
         monthly_credits = VALUES(monthly_credits),
         max_concurrent = VALUES(max_concurrent),
         max_duration = VALUES(max_duration),
         rpm = VALUES(rpm),
         features = VALUES(features),
         sort_weight = VALUES(sort_weight)`,
      [
        p.id,
        p.name,
        p.priceCents,
        p.monthlyCredits,
        p.maxConcurrent,
        p.maxDuration,
        p.rpm,
        JSON.stringify(p.features),
        p.sortWeight,
      ],
    );
  }

  for (const p of PACK_SEED) {
    await conn.query(
      `INSERT INTO credit_packs (id, name, credits, price_cents, bonus, enabled, sort_weight)
       VALUES (?, ?, ?, ?, ?, 1, ?)
       ON DUPLICATE KEY UPDATE
         name = VALUES(name),
         credits = VALUES(credits),
         price_cents = VALUES(price_cents),
         bonus = VALUES(bonus),
         sort_weight = VALUES(sort_weight)`,
      [p.id, p.name, p.credits, p.priceCents, p.bonus, p.sortWeight],
    );
  }

  console.log(`✔ 套餐/充值包已同步: ${PLAN_SEED.length} 套 / ${PACK_SEED.length} 包`);
}

async function seedModelRegistry(conn: mysql.Connection) {
  let inserted = 0;
  for (let i = 0; i < CATALOGUE.length; i++) {
    const m = CATALOGUE[i];
    const { amount, unit } = parsePrice(m);
    const capabilities = {
      refs: m.refs ?? [],
      durations: m.durations ?? [],
      tag: m.tag ?? null,
      priceLabel: m.price,
    };
    // Upsert keeps a re-run of `db:init` authoritative over manual DB edits.
    await conn.query(
      `INSERT INTO model_registry
        (id, provider, display_name, kind, price_unit, price_amount, max_duration, resolutions, capabilities, provider_model, enabled, sort_weight)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
       ON DUPLICATE KEY UPDATE
         provider = VALUES(provider),
         display_name = VALUES(display_name),
         kind = VALUES(kind),
         price_unit = VALUES(price_unit),
         price_amount = VALUES(price_amount),
         max_duration = VALUES(max_duration),
         resolutions = VALUES(resolutions),
         capabilities = VALUES(capabilities),
         provider_model = VALUES(provider_model),
         sort_weight = VALUES(sort_weight)`,
      [
        m.id,
        m.provider,
        m.name,
        m.kind,
        unit,
        amount,
        m.durations ? Math.max(...m.durations) : null,
        JSON.stringify(m.kind === 'video' ? ['1080p', '720p', '480p'] : []),
        JSON.stringify(capabilities),
        m.id,
        i,
      ],
    );
    inserted++;
  }
  console.log(`✔ 模型注册表已同步: ${inserted} 条`);
}

async function main() {
  console.log('▶ 初始化数据库:', env.db.database, `@${env.db.host}:${env.db.port}`);

  const root = await mysql.createConnection({
    host: env.db.host,
    port: env.db.port,
    user: env.db.user,
    password: env.db.password,
    multipleStatements: true,
  });
  await applyUtcSession(root);
  await root.query(
    `CREATE DATABASE IF NOT EXISTS \`${env.db.database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;`,
  );
  await root.end();

  // Schema comes from the versioned migrations, never from a raw dump: that is
  // what makes "which schema is this environment on?" answerable.
  await migrateSchema();

  const conn = await mysql.createConnection({
    host: env.db.host,
    port: env.db.port,
    user: env.db.user,
    password: env.db.password,
    database: env.db.database,
    multipleStatements: true,
  });
  await applyUtcSession(conn);
  await seedModelRegistry(conn);
  await seedBillingCatalogue(conn);
  console.log('✔ 表结构已就绪（版本化迁移已全部应用）');

  const [rows] = await conn.query<any[]>('SELECT id FROM users WHERE email = ? LIMIT 1', [env.seed.email]);
  if (rows.length === 0) {
    const id = randomUUID();
    const hash = await bcrypt.hash(env.seed.password, 12);
    await conn.query(
      'INSERT INTO users (id, email, password_hash, display_name, credits) VALUES (?, ?, ?, ?, ?)',
      [id, env.seed.email, hash, '演示账号', 5000],
    );
    await conn.query(
      'INSERT INTO credit_transactions (id, user_id, delta, balance_after, reason) VALUES (?, ?, ?, ?, ?)',
      [randomUUID(), id, 5000, 5000, '注册赠送'],
    );
    console.log(`✔ 已创建演示账号: ${env.seed.email} / ${env.seed.password}（5000 积分）`);
  } else {
    console.log(`• 演示账号已存在: ${env.seed.email}`);
  }

  await conn.end();
  console.log('✅ 数据库初始化完成');
}
main().catch((e) => {
  console.error('❌ 初始化失败:', e);
  process.exit(1);
});
