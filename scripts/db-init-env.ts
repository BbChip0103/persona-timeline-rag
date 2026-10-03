import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

async function main(): Promise<void> {
  // Exclusive create: never replace a password belonging to an existing volume.
  await mkdir(resolve('infra'), { recursive: true });
  const password = randomBytes(32).toString('hex');
  await writeFile(resolve('infra/.env.db'),
    `PTR_DB_PASSWORD=${password}\nPTR_DATABASE_URL=postgresql://ptr_researcher:${password}@127.0.0.1:56432/ptr_research\n`,
    { mode: 0o600, flag: 'wx' });
  console.log('Created private local database configuration; credentials are not printed.');
}
void main().catch(() => { console.error('Private database environment initialization failed; existing files are not overwritten.'); process.exitCode = 1; });
