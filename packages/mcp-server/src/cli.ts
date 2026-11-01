import { parseArgs, run } from './commands';
import { UsageError } from './errors';

async function main(): Promise<number> {
  let cmd;
  try {
    cmd = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`${err instanceof UsageError ? err.message : String(err)}\n`);
    return 2;
  }
  return run(cmd, {
    out: (s) => { process.stdout.write(s); },
    err: (s) => { process.stderr.write(s.endsWith('\n') ? s : `${s}\n`); },
    env: process.env,
  });
}

main().then(
  (code) => { process.exitCode = code; },
  (err) => { process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`); process.exitCode = 1; },
);
