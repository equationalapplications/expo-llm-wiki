import { VERSION } from './version';

if (process.argv.includes('--version')) {
  process.stdout.write(`${VERSION}\n`);
} else {
  process.stderr.write('synapsetree-mcp: not implemented yet\n');
  process.exitCode = 2;
}
