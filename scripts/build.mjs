// Builds both halves of AgentLink:
//   dist/            the Firefox/Zen extension (this is what web-ext loads and lints)
//   dist-companion/  the local companion service that holds the Gemini key
import { build } from 'esbuild';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const at = (...parts) => join(root, ...parts);
const pkg = JSON.parse(readFileSync(at('package.json'), 'utf8'));

const EXT = at('dist');
const COMPANION = at('dist-companion');
const BROWSER_TARGET = ['firefox140'];

const FONTS = [
  ['@fontsource/ibm-plex-sans', 'ibm-plex-sans-latin-400-normal.woff2'],
  ['@fontsource/ibm-plex-sans', 'ibm-plex-sans-latin-500-normal.woff2'],
  ['@fontsource/ibm-plex-sans', 'ibm-plex-sans-latin-600-normal.woff2'],
  ['@fontsource/ibm-plex-mono', 'ibm-plex-mono-latin-400-normal.woff2'],
  ['@fontsource/ibm-plex-mono', 'ibm-plex-mono-latin-500-normal.woff2'],
];

function copyFonts(targetDir) {
  mkdirSync(targetDir, { recursive: true });
  for (const [pkgName, file] of FONTS) {
    cpSync(at('node_modules', pkgName, 'files', file), join(targetDir, file));
  }
  // Both families are SIL Open Font License 1.1; ship the licence next to them.
  cpSync(at('node_modules', '@fontsource/ibm-plex-sans', 'LICENSE'), join(targetDir, 'LICENSE.txt'));
}

const common = {
  bundle: true,
  logLevel: 'warning',
  legalComments: 'none',
  define: { __AGENTLINK_VERSION__: JSON.stringify(pkg.version) },
};

const browserScript = (entry, outfile) =>
  build({
    ...common,
    entryPoints: [at(entry)],
    outfile,
    platform: 'browser',
    format: 'iife',
    target: BROWSER_TARGET,
    jsx: 'automatic',
    jsxImportSource: 'preact',
    minify: false, // Kept readable: add-on reviewers and users can inspect what runs in the browser.
  });

const stylesheet = (entry, outfile) =>
  build({
    ...common,
    entryPoints: [at(entry)],
    outfile,
    target: BROWSER_TARGET,
    external: ['*.woff2'],
  });

async function buildCompanion() {
  await build({
    ...common,
    entryPoints: [at('src/companion/main.ts')],
    outfile: join(COMPANION, 'main.js'),
    platform: 'node',
    format: 'esm',
    target: ['node20'],
    packages: 'external',
  });
  const web = join(COMPANION, 'web');
  await browserScript('src/companion/web/settings.ts', join(web, 'settings.js'));
  await stylesheet('src/companion/web/settings.css', join(web, 'settings.css'));
  cpSync(at('src/companion/web/settings.html'), join(web, 'settings.html'));
  copyFonts(join(web, 'fonts'));
}

async function buildExtension() {
  await browserScript('src/extension/background/index.ts', join(EXT, 'background.js'));
  await browserScript('src/extension/content/arena.ts', join(EXT, 'content', 'arena.js'));
  await browserScript('src/extension/ui/main.tsx', join(EXT, 'ui', 'app.js'));
  await stylesheet('src/extension/ui/styles/app.css', join(EXT, 'ui', 'app.css'));
  cpSync(at('src/extension/ui/index.html'), join(EXT, 'ui', 'index.html'));
  cpSync(at('src/extension/icons'), join(EXT, 'icons'), { recursive: true });
  copyFonts(join(EXT, 'ui', 'fonts'));

  const manifest = JSON.parse(readFileSync(at('src/extension/manifest.json'), 'utf8'));
  manifest.version = pkg.version;
  writeFileSync(join(EXT, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
}

rmSync(EXT, { recursive: true, force: true });
rmSync(COMPANION, { recursive: true, force: true });
await Promise.all([buildCompanion(), buildExtension()]);
console.log(`Built AgentLink ${pkg.version}\n  extension  → dist/\n  companion  → dist-companion/main.js`);
