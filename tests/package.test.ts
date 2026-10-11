/**
 * Публикуемый пакет: то, что ломается молча при релизе.
 *
 * Манифест установщика Claude Desktop и package.json живут в двух файлах, а
 * версия у релиза одна. Публичный пакет не может зависеть от приватного
 * `@feedbay/assistant`: в npm его нет, и установка у человека упала бы.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url));
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? sourceFiles(join(dir, entry.name)) : [join(dir, entry.name)],
  );
}

describe("публикуемый пакет", () => {
  it("версия манифеста совпадает с версией пакета", () => {
    expect(manifest.version).toBe(pkg.version);
  });

  it("установщик спрашивает ключ как секрет и отдаёт его серверу", () => {
    expect(manifest.user_config.api_key).toMatchObject({ type: "string", sensitive: true, required: true });
    expect(manifest.server.mcp_config.env.FEEDBAY_API_KEY).toBe("${user_config.api_key}");
    expect(manifest.server.entry_point).toBe(pkg.bin["feedbay-mcp"].replace(/^\.\//, ""));
  });

  it("исходники не тянут приватный ассистент и не прячут его у себя", () => {
    const files = sourceFiles(join(root, "src"));
    expect(files.some((file) => file.includes(`${join("src", "agent")}`))).toBe(false);
    for (const file of files) {
      expect(readFileSync(file, "utf8"), file).not.toMatch(/from\s+["']@feedbay\/assistant/);
    }
    expect(Object.keys(pkg.dependencies)).not.toContain("@feedbay/assistant");
  });

  it("публичный сервер не зовёт ни одной модели: думает модель клиента на его токенах", () => {
    for (const file of sourceFiles(join(root, "src"))) {
      expect(readFileSync(file, "utf8"), file).not.toMatch(/openrouter\.ai|api\.openai\.com|api\.anthropic\.com/);
    }
  });

  it("пакет не помечен приватным и публикуется открыто", () => {
    expect(pkg.private).toBeUndefined();
    expect(pkg.publishConfig).toEqual({ access: "public" });
    expect(pkg.license).toBe("MIT");
  });
});
