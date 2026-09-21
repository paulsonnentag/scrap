// Bundles the extension with esbuild into dist/ (Chrome) or dist-firefox/ (Firefox).
//   node scripts/build.mjs [--watch] [--target=chrome|firefox]
import * as esbuild from "esbuild";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = new Set(process.argv.slice(2));
const target = [...args].find((a) => a.startsWith("--target="))?.split("=")[1] ?? "chrome";
const watch = args.has("--watch");
const outdir = resolve(root, target === "firefox" ? "dist-firefox" : "dist");

rmSync(outdir, { recursive: true, force: true });
mkdirSync(outdir, { recursive: true });

// Stamped into every bundle so a debug report can reveal a stale content script
// still running in a tab that was not reloaded after a rebuild.
const buildId = `${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "")}-${Math.random().toString(36).slice(2, 6)}`;

const common = {
  bundle: true,
  target: ["chrome120", "firefox121"],
  sourcemap: watch ? "inline" : false,
  minify: !watch,
  logLevel: "info",
  define: {
    "process.env.NODE_ENV": JSON.stringify(watch ? "development" : "production"),
    __BUILD_ID__: JSON.stringify(buildId),
  },
  legalComments: "none",
};

const contexts = await Promise.all([
  // Module service worker (ESM allowed). No top-level await inside; wasm is loaded explicitly.
  esbuild.context({ ...common, entryPoints: [resolve(root, "src/background/index.ts")], outfile: resolve(outdir, "background.js"), format: "esm", platform: "browser" }),
  // Content script must be a classic script.
  esbuild.context({ ...common, entryPoints: [resolve(root, "src/content/index.ts")], outfile: resolve(outdir, "content.js"), format: "iife", platform: "browser" }),
  // Side panel.
  esbuild.context({ ...common, entryPoints: [resolve(root, "src/sidepanel/main.ts")], outfile: resolve(outdir, "sidepanel.js"), format: "iife", platform: "browser" }),
]);

function copyStatic() {
  cpSync(resolve(root, "src/sidepanel/index.html"), resolve(outdir, "sidepanel.html"));
  cpSync(resolve(root, "src/sidepanel/styles.css"), resolve(outdir, "sidepanel.css"));
  cpSync(resolve(root, "node_modules/@automerge/automerge/dist/automerge.wasm"), resolve(outdir, "automerge.wasm"));
  if (existsSync(resolve(root, "public"))) cpSync(resolve(root, "public"), outdir, { recursive: true });
  writeFileSync(resolve(outdir, "manifest.json"), JSON.stringify(buildManifest(target), null, 2));
}

function buildManifest(target) {
  const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
  const base = JSON.parse(readFileSync(resolve(root, "manifest.base.json"), "utf8"));
  base.version = pkg.version;
  if (target === "firefox") {
    base.permissions = base.permissions.filter((p) => p !== "sidePanel");
    delete base.side_panel;
    base.sidebar_action = { default_panel: "sidepanel.html", default_title: "Page Extractor", default_icon: base.action.default_icon };
    base.background = { scripts: ["background.js"], type: "module" };
    base.browser_specific_settings = { gecko: { id: "page-extractor@scrap.local", strict_min_version: "121.0" } };
  }
  return base;
}

if (watch) {
  copyStatic();
  await Promise.all(contexts.map((c) => c.watch()));
  console.log(`watching → ${outdir} (build ${buildId})`);
} else {
  await Promise.all(contexts.map((c) => c.rebuild()));
  copyStatic();
  await Promise.all(contexts.map((c) => c.dispose()));
  console.log(`built → ${outdir} (build ${buildId})`);
}
