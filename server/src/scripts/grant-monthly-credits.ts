import { pool } from '../db/pool.js';
import { grantDueMonthlyCredits } from '../services/monthlyCredits.js';

async function main() {
  const result = await grantDueMonthlyCredits();
  console.log(`[monthly-credits] granted=${result.granted} skipped=${result.skipped} failed=${result.failed}`);
  if (result.failed) process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error('[monthly-credits] fatal', err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
