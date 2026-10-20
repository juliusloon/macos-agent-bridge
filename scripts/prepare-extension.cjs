// Raycast CLI checks a workspace-local .bin/tsc even when npm hoists TypeScript.
const fs = require('node:fs'); const path = require('node:path');
const bin = path.resolve('raycast-extension/node_modules/.bin'); fs.mkdirSync(bin, { recursive: true });
const target = path.join(bin, 'tsc'); if (!fs.existsSync(target)) fs.symlinkSync(path.relative(bin, require.resolve('typescript/bin/tsc')), target);
