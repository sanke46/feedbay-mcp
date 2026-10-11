#!/usr/bin/env node
/**
 * Установщик для Claude Desktop: `feedbay-<версия>.mcpb`.
 *
 * Это zip с собранным сервером, его production-зависимостями и манифестом.
 * Claude Desktop запускает его своим Node, поэтому node_modules едут внутри:
 * ставить что-то руками человеку не придётся.
 *
 *   npm run build && npm run pack:mcpb        → out/feedbay-0.2.0.mcpb
 *
 * Сборка идёт во временном каталоге, а не внутри монорепо: npm, запущенный в
 * подкаталоге воркспейса, норовит ставить зависимости в корень.
 */

import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const MCPB_CLI = "@anthropic-ai/mcpb@2.1.2";

const root = fileURLToPath(new URL("..", import.meta.url));
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));

if (!existsSync(join(root, "dist/bin/stdio.js"))) {
  console.error("dist/ is missing: run `npm run build` first.");
  process.exit(1);
}

const stage = mkdtempSync(join(tmpdir(), "feedbay-mcpb-"));
try {
  cpSync(join(root, "dist"), join(stage, "dist"), {
    recursive: true,
    filter: (source) => !source.endsWith(".map"),
  });
  for (const file of ["icon.png", "README.md", "LICENSE"]) {
    cpSync(join(root, file), join(stage, file));
  }

  // Версия одна — из package.json; манифест в репозитории сверяется с ней тестом.
  writeFileSync(join(stage, "manifest.json"), `${JSON.stringify({ ...manifest, version: pkg.version }, null, 2)}\n`);

  // Только то, что нужно для запуска: без скриптов сборки и dev-зависимостей.
  const runtime = {
    name: pkg.name,
    version: pkg.version,
    type: pkg.type,
    license: pkg.license,
    dependencies: pkg.dependencies,
  };
  writeFileSync(join(stage, "package.json"), `${JSON.stringify(runtime, null, 2)}\n`);

  const run = (command, args, cwd) => execFileSync(command, args, { cwd, stdio: "inherit" });
  run("npm", ["install", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund", "--no-package-lock"], stage);
  run("npx", ["-y", MCPB_CLI, "validate", join(stage, "manifest.json")], stage);

  const outDir = join(root, "out");
  mkdirSync(outDir, { recursive: true });
  const output = join(outDir, `feedbay-${pkg.version}.mcpb`);
  run("npx", ["-y", MCPB_CLI, "pack", stage, output], stage);
  console.log(`\n${output}`);
} finally {
  rmSync(stage, { recursive: true, force: true });
}
