import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Fails when a source file contains invalid UTF-8 or lost-CJK '?' runs.
 *
 * Kept as a repo script (not a temp helper) because the failure mode is
 * environmental: any tool that writes files using the console code page can
 * reintroduce it, and the damage is silent until something crashes at runtime.
 */
const ROOTS = ['src', 'scripts', 'tests'];
const EXT = /\.(ts|tsx|sql|mjs)$/;

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (EXT.test(name)) out.push(full);
  }
  return out;
}

let bad = 0;

for (const root of ROOTS) {
  for (const file of walk(root)) {
    const buf = readFileSync(file);
    let valid = true;
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(buf);
    } catch {
      valid = false;
    }

    // Runs of 2+ '?' inside quotes indicate CJK text destroyed by a wrong
    // code page. A single '?' is legitimate (ternaries, SQL placeholders).
    const text = buf.toString('utf8');
    const suspects = [...text.matchAll(/(['"`])[?]{2,}[^'"`\n]*\1/g)]
      .slice(0, 3)
      .map((m) => m[0]);

    if (!valid || suspects.length > 0) {
      bad++;
      console.log(`${file}: utf8=${valid ? 'ok' : 'INVALID'} suspects=${JSON.stringify(suspects)}`);
    }
  }
}

console.log(bad === 0 ? '[ok] no encoding damage found' : `[FAIL] ${bad} file(s) need repair`);
process.exit(bad === 0 ? 0 : 1);
