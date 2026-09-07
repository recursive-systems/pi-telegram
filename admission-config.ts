import { open, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

// Caller owns the profile lease and serializes config changes. A failure after
// rename is ambiguous: do not advance caller memory or continue intake.
export async function persistTelegramConfig(path: string, config: object): Promise<void> {
  const temporary = join(dirname(path), `.telegram-${randomUUID()}.tmp`);
  let created = false;
  try {
    const file = await open(temporary, 'wx', 0o600);
    created = true;
    try {
      await file.chmod(0o600);
      await file.writeFile(JSON.stringify(config, null, '\t') + '\n');
      await file.sync();
    } finally { await file.close(); }
    await rename(temporary, path);
    const directory = await open(dirname(path), 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  } catch { throw new Error('Telegram configuration persistence failed; operator repair required'); }
  finally { if (created) await unlink(temporary).catch(() => undefined); }
}
