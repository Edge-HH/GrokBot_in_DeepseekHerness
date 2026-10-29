/**
 * Standalone tsdown build for the GrokBot pet bundle.
 *
 * Mirrors the client-bundle contract of the harness monorepo helper
 * (`packages/client/tsdown.client.ts`) so the emitted artifact is loadable by
 * the dsh web client loader exactly like an in-tree `dsh.client` package:
 *
 *  - the client half keeps platform modules external (resolved at runtime
 *    through the loader's frozen module table — react, cordis, ui-slots, …);
 *  - CSS Modules are compiled by lightningcss and inlined as a
 *    `<style data-plugin>` tag at factory execution;
 *  - the chunk registers itself via `window.__ModuleLoader__.load({id, factory})`.
 *
 * Two configs, one `tsdown` run:
 *  1. node half  → lib/index.js, lib/invariant.js (host loader mounts the
 *     package root before discovering the dsh.client browser entry);
 *  2. client half → lib/client.js (served by the client roster as
 *     /plugins/<row-id>/client.js).
 */
import { readFile } from 'node:fs/promises'
import { basename, dirname, resolve as resolvePath } from 'node:path'
import { transform } from 'lightningcss'
import type { UserConfig } from 'tsdown'

const PACKAGE_NAME = 'dsh-grokbot-pet'

/**
 * Browser platform modules the shell shares into its frozen module table;
 * must stay external so every plugin uses the single shared react/cordis
 * instances (kept in sync with the 0.1.x dsh-client-web platform table).
 *
 * 0.2.x shells (Web and Desktop) share a narrower table (`react`, `react-dom`,
 * `@deepseek-ai/cordis`, `@deepseek-ai/dsh-client-store`,
 * `@deepseek-ai/dsh-client-ui-slots`, `@deepseek-ai/dsh-client-ui-primitives`,
 * `@tanstack/react-virtual`, `zod`, `@deepseek-ai/dsh-client-ui-dockkit`).
 * This bundle only requires `react`, so the same artifact loads in both; the
 * remaining names stay listed for older shells.
 */
const PLATFORM_MODULES = [
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-web-react',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-attachment',
  '@deepseek-ai/dsh-client-schema-form',
] as const

/** Runtime store engine lives in dsh-client-runtime; documented exemption. */
const RUNTIME_STORE_EXEMPTION = '@deepseek-ai/dsh-client-runtime/client'

/** Specifiers resolved from the loader module table, never bundled. */
const CLIENT_EXTERNALS: readonly string[] = [...PLATFORM_MODULES, RUNTIME_STORE_EXEMPTION]

/**
 * Virtual-id wrapper keeping module CSS away from tsdown's own css pipeline
 * (which requires @tsdown/css). The suffix matters: tsdown's guard matches ids
 * ending in `.css`, so the virtual id must not.
 */
const CSS_VIRTUAL_PREFIX = '\0dsh-css:'
const CSS_VIRTUAL_SUFFIX = '.mjs'

const cssModuleInline = {
  name: 'dsh-css-modules-inline',
  resolveId(source: string, importer: string | undefined) {
    if (!source.endsWith('.module.css')) return null
    const abs = importer !== undefined ? resolvePath(dirname(importer), source) : source
    return CSS_VIRTUAL_PREFIX + abs + CSS_VIRTUAL_SUFFIX
  },
  async load(virtualId: string) {
    if (!virtualId.startsWith(CSS_VIRTUAL_PREFIX)) return null
    const fileId = virtualId.slice(CSS_VIRTUAL_PREFIX.length, -CSS_VIRTUAL_SUFFIX.length)
    if (typeof this.addWatchFile === 'function') this.addWatchFile(fileId)
    const source = await readFile(fileId)
    const { code, exports: cssExports } = transform({
      filename: fileId,
      code: source,
      cssModules: { pattern: '[hash]_[local]' },
      minify: true,
    })
    const classMap: Record<string, string> = {}
    for (const [local, exp] of Object.entries(cssExports ?? {})) classMap[local] = exp.name
    const tagId = `${PACKAGE_NAME}/${basename(fileId)}`
    return [
      `const css = ${JSON.stringify(code.toString())};`,
      `const tagId = ${JSON.stringify(tagId)};`,
      'if (typeof document !== \'undefined\' && document.querySelector(\'style[data-plugin-css=\' + JSON.stringify(tagId) + \']\') === null) {',
      '  const tag = document.createElement(\'style\');',
      `  tag.dataset.plugin = ${JSON.stringify(PACKAGE_NAME)};`,
      '  tag.dataset.pluginCss = tagId;',
      '  tag.textContent = css;',
      '  document.head.appendChild(tag);',
      '}',
      `export default ${JSON.stringify(classMap)};`,
    ].join('\n')
  },
} satisfies UserConfig['plugins'][number]

/** Node half: host-side plugin entry (no-op) + invariant companion. */
const nodeHalf: UserConfig = {
  name: PACKAGE_NAME,
  entry: { index: 'src/index.ts', invariant: 'src/invariant.ts' },
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  // tsdown cleans per-config by default; a clean here would wipe the sibling
  // half's output. Both halves must stay clean:false — wipe lib/ explicitly
  // (`pnpm clean`) when a stale artifact needs removal.
  clean: false,
}

/** Browser half: the dsh.client bundle registered with the web loader. */
const clientHalf: UserConfig = {
  name: `${PACKAGE_NAME}/client`,
  entry: { client: 'src/client/index.ts' },
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  target: 'es2024',
  dts: false,
  sourcemap: true,
  clean: false,
  external: CLIENT_EXTERNALS,
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
  },
  // The module table is the only external source: bundle everything else.
  noExternal: (id: string) => (CLIENT_EXTERNALS.includes(id) ? undefined : true),
  plugins: [cssModuleInline],
  outputOptions: {
    entryFileNames: 'client.js',
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(PACKAGE_NAME)}, factory: (require) => {`,
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
}

export default [nodeHalf, clientHalf]
