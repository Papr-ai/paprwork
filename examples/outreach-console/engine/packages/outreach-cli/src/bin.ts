import { main } from './main';

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(`fatal: ${(error as Error).stack ?? String(error)}\n`);
    process.exitCode = 1;
  },
);
