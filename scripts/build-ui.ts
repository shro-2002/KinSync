// Bundles the MCP App view into one self-contained HTML file (the resource body).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

import { build } from 'esbuild';

const OUT = 'dist/ui/dashboard.html';

const result = await build({
    entryPoints: ['src/ui/dashboard.ts'],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    minify: true,
    write: false
});
const js = result.outputFiles[0]!.text.replaceAll('</script', '<\\/script');
const html = readFileSync('src/ui/dashboard.html', 'utf8').replace('/*__BUNDLE__*/', () => js);

mkdirSync('dist/ui', { recursive: true });
writeFileSync(OUT, html);
console.error(`[build-ui] wrote ${OUT} (${(html.length / 1024).toFixed(1)} KiB)`);
