import { describe, expect, it } from "vitest";
import { ALL_TOOLS } from "../src/server.js";
import { renderDescription } from "../src/tools/text-overrides.js";
import { PRODUCT_LIMITATIONS, limitationsSentence } from "../src/domain/capabilities.js";

/**
 * Обещания «продукт так не умеет» под присмотром.
 *
 * <p>ЭТОТ ТЕСТ ПРО УСТАРЕВАНИЕ, А НЕ ПРО ОПЕЧАТКИ. Список того, чего нет,
 * лежал строкой внутри системного промпта. Такой список стареет молча: фича
 * выходит, ассистент продолжает отказывать, и человек уходит искать замену
 * тому, что у него уже есть. Проверка ищет слово-признак в именах, описаниях
 * и схемах ВСЕХ инструментов: появился инструмент про расписание — значит
 * обещание пора убирать, и тест об этом скажет.
 */
function toolSurface(): string {
  return ALL_TOOLS.map((tool) =>
    // `renderDescription`, а не `tool.description`: часть текста переехала в
    // инварианты, и поиск по сырому полю перестал бы видеть половину
    // поверхности — то есть молча ослабил бы проверку на устаревание.
    [tool.name, tool.title ?? "", renderDescription(tool), JSON.stringify(tool.inputSchema ?? {})].join(" "),
  )
    .join("\n")
    .toLowerCase();
}

describe("чего продукт не умеет", () => {
  it.each(PRODUCT_LIMITATIONS)("«$text» всё ещё правда", (limitation) => {
    expect(
      toolSurface().includes(limitation.keyword.toLowerCase()),
      `Инструменты упоминают «${limitation.keyword}» — похоже, ограничение «${limitation.text}» ` +
        `отпало. Убери строку «${limitation.id}» из PRODUCT_LIMITATIONS, иначе ассистент будет ` +
        `отказывать в том, что продукт уже умеет.`,
    ).toBe(false);
  });

  it("перечисление собирается из списка, а не пишется руками", () => {
    const sentence = limitationsSentence();
    for (const limitation of PRODUCT_LIMITATIONS) {
      expect(sentence).toContain(limitation.text);
    }
  });
});
