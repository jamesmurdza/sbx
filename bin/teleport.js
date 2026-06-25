#!/usr/bin/env node
// Thin launcher: prefer the compiled output, fall back to tsx for `npm start` in dev.
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));
const compiled = join(here, '..', 'dist', 'cli.js');

if (!existsSync(compiled)) {
  console.error(
    'teleport: build output not found. Run `npm run build` first (or `npm install` if you have not).',
  );
  process.exit(1);
}

await import(compiled);
