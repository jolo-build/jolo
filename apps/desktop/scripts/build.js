// Bundle the renderer with Bun; Electron loads the static output from dist/.
import { cpSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
const root = path.resolve(import.meta.dir, "..");
const dist = path.join(root, "dist");
// The renderer bundle cannot catch syntax errors in Electron's unbundled main process.
const mainDir = path.join(root, "src/main");
const parser = new Bun.Transpiler({ loader: "js", target: "node" });
for (const file of readdirSync(mainDir).filter(file => file.endsWith('.mjs'))) {
  try { parser.transformSync(readFileSync(path.join(mainDir, file), 'utf8')); }
  catch (error) { console.error(`Invalid desktop main module: ${file}`, error); process.exit(1); }
}
mkdirSync(dist, { recursive: true });
const result = await Bun.build({
  entrypoints: [path.join(root, "src/renderer/main.jsx")],
  outdir: dist,
  target: "browser",
  splitting: true,
  minify: true,
  sourcemap: "none",
  define: { "process.env.NODE_ENV": '"production"' },
});
if (!result.success) {
  for (const log of result.logs) console.error(String(log));
  process.exit(1);
}
cpSync(path.join(root, "src/renderer/index.html"), path.join(dist, "index.html"));
cpSync(path.join(root, "src/renderer/styles.css"), path.join(dist, "styles.css"));
cpSync(path.join(root, "../../assets/brand"), dist, { recursive: true });
cpSync(path.join(root, "../../assets/fonts"), path.join(dist, "fonts"), { recursive: true }); // bundled typefaces and their licences
cpSync(path.join(root, "node_modules/@xterm/xterm/css/xterm.css"), path.join(dist, "xterm.css"));
console.log(`renderer bundled: ${result.outputs.map((o) => `${path.basename(o.path)} ${(o.size / 1024).toFixed(0)} KiB`).join(", ")}`);
