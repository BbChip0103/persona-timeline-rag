import { registerWebConfig } from './lib/config';

/**
 * Next.js startup hook: refuse to serve with an invalid configuration. `next start` keeps listening when
 * register() throws ("Failed to prepare server"), so the process exits 1 after the `config_invalid` line.
 */
export async function register(exit:(code:number)=>void=code=>process.exit(code)):Promise<void> {
  try {registerWebConfig(process.env);} catch {exit(1);}
}
