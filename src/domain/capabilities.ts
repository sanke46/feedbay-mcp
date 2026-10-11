/**
 * Чего продукт не умеет — в одном месте и под присмотром теста.
 *
 * ПОЧЕМУ ЭТОТ ФАЙЛ СУЩЕСТВУЕТ. Правило «не обещай того, чего нет» в
 * системном промпте держалось на списке, вписанном прямо в текст промпта.
 * Такой список не стареет громко: он стареет молча. Фича выходит, а
 * ассистент продолжает говорить «продукт так не умеет» — и человек, которому
 * это сказали, уходит искать замену тому, что у него уже есть.
 *
 * Здесь список стал данными, и у каждой строки появился `keyword`. Тест
 * `capabilities.test.ts` ищет это слово в именах, описаниях и схемах ВСЕХ
 * инструментов: появился инструмент про расписание — тест краснеет и
 * заставляет поправить обещание. Это ловит не всё (фича может приехать
 * мимо инструментов, как настройка в рендерере), но ловит самый частый
 * случай и стоит одного теста.
 */

export interface ProductLimitation {
  /** Стабильный идентификатор — по нему удобно удалять строку в коммите. */
  id: string;
  /** Как это называется в разговоре с человеком. */
  text: string;
  /**
   * Слово, по которому тест ищет признаки того, что ограничение отпало.
   * Достаточно узкое, чтобы не срабатывать на соседних смыслах.
   */
  keyword: string;
}

export const PRODUCT_LIMITATIONS: readonly ProductLimitation[] = [
  { id: "branching", text: "question branching", keyword: "branching" },
  { id: "device_targeting", text: "URL or device targeting", keyword: "device targeting" },
  { id: "scheduling", text: "scheduling", keyword: "scheduling" },
  { id: "redirect", text: "post-completion redirects", keyword: "redirect" },
  { id: "translation", text: "survey translation", keyword: "translation" },
  { id: "alerts", text: "email alerts on new responses", keyword: "email alerts" },
];

/** Перечисление для промпта: «— A, B и C». */
export function limitationsSentence(): string {
  return PRODUCT_LIMITATIONS.map((l) => l.text).join(", ");
}
