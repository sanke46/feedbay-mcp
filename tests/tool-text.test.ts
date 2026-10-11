import { afterEach, describe, expect, it, vi } from "vitest";
import { ALL_TOOLS } from "../src/server.js";
import {
  TOOL_TEXT_LIMITS,
  applyToolText,
  catalogueSize,
  renderDescription,
  renderTitle,
  sanitizeToolText,
} from "../src/tools/text-overrides.js";
import { ToolTextSource } from "../src/client/tool-text.js";
import { updateRegisteredToolText, type ToolDefinition, type ToolHandles } from "../src/tools/shared.js";

/**
 * Текст инструментов, правимый из админки.
 *
 * <p>ЧТО ЗДЕСЬ СТОРОЖИТСЯ. Фича по построению снимает все обычные защиты:
 * описание меняется без ревью, без тестов и без деплоя — в этом её смысл.
 * Остаются ровно четыре опоры, и каждая проверяется ниже: закрытый список
 * полей, инварианты за кодом, безотказность доставки и рубильник, который
 * возвращает все три двери к коду одним движением.
 */

const overviewTool = ALL_TOOLS.find((t) => t.name === "results_overview")!;

afterEach(() => {
  vi.restoreAllMocks();
});

describe("applyToolText", () => {
  /**
   * НЕСУЩИЙ ТЕСТ. Глубокое сравнение всего, кроме двух полей, — сторож против
   * будущей правки «ну и флажок заодно». Имя инструмента это исполняемый ключ
   * трёх механизмов защиты (забор вокруг чужого текста, слепки отката, четыре
   * изъятых из чата инструмента), схема — контракт с обработчиком, флаги —
   * принуждение. Ни одно из этого не должно быть достижимо из админки.
   */
  it("меняет ровно два поля и ничего больше", () => {
    const hostile = Object.fromEntries(
      ALL_TOOLS.map((tool) => [
        tool.name,
        {
          title: "Renamed",
          description: "Rewritten.",
          // Всё, что кто-нибудь однажды попробует дописать в DTO.
          name: "survey_delete_permanent",
          readOnly: !tool.readOnly,
          destructive: true,
          idempotent: true,
          invariants: [],
          inputSchema: {},
          handler: () => undefined,
        },
      ]),
    ) as never;

    const applied = applyToolText(ALL_TOOLS, hostile);

    expect(applied).toHaveLength(ALL_TOOLS.length);
    applied.forEach((tool, index) => {
      const original = ALL_TOOLS[index]!;

      expect(tool.title).toBe("Renamed");
      expect(tool.description).toBe("Rewritten.");

      // Всё остальное — байт в байт исходное определение.
      const strip = (t: ToolDefinition) => {
        const { title: _title, description: _description, ...rest } = t;
        return rest;
      };
      expect(strip(tool)).toEqual(strip(original));
      // toEqual сравнивает по значению; обработчик и схема обязаны быть ТЕМИ ЖЕ.
      expect(tool.handler).toBe(original.handler);
      expect(tool.inputSchema).toBe(original.inputSchema);
      expect(tool.invariants).toBe(original.invariants);
    });
  });

  it("сироту игнорирует, а не роняет ход", () => {
    const applied = applyToolText(ALL_TOOLS, {
      tool_that_no_longer_exists: { description: "..." },
    });
    expect(applied.map((t) => t.description)).toEqual(ALL_TOOLS.map((t) => t.description));
  });

  /** Пустое поле — просьба вернуть дефолт, а не оставить инструмент без описания. */
  it("пустую строку трактует как «возьми из кода»", () => {
    const [tool] = applyToolText([overviewTool], {
      results_overview: { title: "   ", description: "" },
    });
    expect(tool.title).toBe(overviewTool.title);
    expect(tool.description).toBe(overviewTool.description);
  });

  /**
   * Пределы дублируют серверную проверку, и реакция здесь другая намеренно:
   * сервер отклоняет правку с внятным текстом, клиент молча берёт код.
   * Обрезать было бы хуже всего — модель получила бы фразу, оборванную на
   * половине условия.
   */
  it("текст длиннее предела отбрасывает целиком, а не режет", () => {
    const [tool] = applyToolText([overviewTool], {
      results_overview: { description: "x".repeat(TOOL_TEXT_LIMITS.description + 1) },
    });
    expect(tool.description).toBe(overviewTool.description);
  });

  /**
   * `base*` — снимок кода на момент правки. Он ездит в теле сохранения, лежит
   * в базе и кормит один бейдж на экране; до инструмента он не доходит
   * никогда.
   *
   * <p>ТЕСТ НУЖЕН ИМЕННО ПОТОМУ, ЧТО ПОЛЕ «НИ НА ЧТО НЕ ВЛИЯЕТ». Через год
   * кто-нибудь заметит, что в записи каталога уже лежит готовый текст, и
   * подставит его «как запасной». Это тихо вернёт в промпт формулировку,
   * которую в коде давно переписали.
   */
  it("base* и прочие поля записи до инструмента не доходят", () => {
    const [tool] = applyToolText([overviewTool], {
      results_overview: {
        ...({
          baseTitle: "Base title from code",
          baseDescription: "Base description from code",
          reason: "support complaint",
          status: "PUBLISHED",
          draftDescription: "Unpublished draft.",
        } as never),
      },
    });

    // Ни одно из этих полей не годится в описание, поэтому определение
    // осталось ровно таким, каким пришло из кода.
    expect(tool).toBe(overviewTool);
    expect(renderDescription(tool)).toBe(renderDescription(overviewTool));
    expect(renderDescription(tool)).not.toContain("Base description from code");
    expect(renderDescription(tool)).not.toContain("Unpublished draft.");
  });

  it("каталог без переопределений возвращает исходные определения", () => {
    expect(applyToolText(ALL_TOOLS, {})).toEqual([...ALL_TOOLS]);
    expect(applyToolText(ALL_TOOLS, null)).toEqual([...ALL_TOOLS]);
    expect(applyToolText(ALL_TOOLS)).toEqual([...ALL_TOOLS]);
  });
});

describe("инварианты за кодом", () => {
  it("у инструмента без инвариантов описание — ровно то, что написано", () => {
    const plain = ALL_TOOLS.find((t) => !t.invariants)!;
    expect(renderDescription(plain)).toBe(plain.description);
  });

  it("renderTitle и renderDescription принимают переопределение напрямую", () => {
    // Этим пользуется превью «What the model will receive» в админке: там
    // правка ещё не сохранена, накладывать её на набор инструментов негде.
    expect(renderTitle(overviewTool, { title: "Draft title" })).toBe("Draft title");
    expect(renderDescription(overviewTool, { description: "Draft." })).toContain("Draft.");
    expect(renderDescription(overviewTool, { description: "Draft." })).toContain("lower bound");
  });
});

/**
 * Текст обязан быть тем, чем выглядит — и на КЛИЕНТЕ тоже.
 *
 * <p>Сервер отклоняет плохую правку с внятным текстом. Но поддержка ходит в
 * базу руками — ради этого фича и делается, — и `UPDATE` мимо валидатора
 * никого не спросит. Это последний рубеж на пути в промпт модели, и стоять он
 * обязан независимо от того, КАК текст туда попал.
 */
describe("санация текста перед промптом", () => {
  it("режет невидимое, управляющее и ANSI, оставляя осмысленное", () => {
    const hostile =
      "Read this\u200B\u202Eand that\u0007 that\u001B[31m \u2014 carefully\u007F.";
    expect(sanitizeToolText(hostile)).toBe("Read thisand that that \u2014 carefully.");
  });

  it("приводит к NFC, оставляя букву буквой", () => {
    // «й» составным способом: и + краткая. После NFC — один символ.
    expect(sanitizeToolText("\u0438\u0306")).toBe("\u0439");
  });

  it("абзацы оставляет, вёрстку пустыми строками — нет", () => {
    expect(sanitizeToolText("First.\r\n\n\n\n\nSecond.")).toBe("First.\n\nSecond.");
  });

  /** Очистка стоит НА ПУТИ применения, а не рядом с ним. */
  it("применяется к переопределению, пришедшему любым путём", () => {
    const [tool] = applyToolText([overviewTool], {
      results_overview: { description: "Clean\u200B text\u001B[0m." },
    });
    expect(tool.description).toBe("Clean text.");
    expect(renderDescription(tool)).not.toMatch(/[\u200B\u001B]/);
  });

  /** Строка из одних невидимых символов — это пустая строка, то есть «возьми из кода». */
  it("текст из одних невидимых символов трактуется как пустой", () => {
    const [tool] = applyToolText([overviewTool], {
      results_overview: { description: "\u200B\u200B\u00AD" },
    });
    expect(tool.description).toBe(overviewTool.description);
  });
});

describe("бюджет каталога", () => {
  it("весь набор описаний из кода укладывается в потолок с запасом", () => {
    const sizeOfCode = ALL_TOOLS.reduce(
      (total, tool) => total + tool.title.length + renderDescription(tool).length,
      0,
    );
    // Потолок — это потолок и цены: блок инструментов уезжает провайдеру в
    // каждом из до двенадцати запросов хода. Если набор из кода к нему
    // подобрался, спорить надо не с админкой.
    expect(sizeOfCode).toBeLessThan(TOOL_TEXT_LIMITS.total);
  });

  it("считает вес каталога по обоим полям", () => {
    expect(catalogueSize({ a: { title: "ab", description: "cde" } })).toBe(5);
  });
});

/**
 * Живое обновление уже зарегистрированных инструментов.
 *
 * <p>Это механизм, которым правка вступает в силу БЕЗ перезапуска процесса:
 * `RegisteredTool.update()` меняет текст и сам шлёт `tools/list_changed`
 * подключённым клиентам. Без него «двери подхватывают за минуту» означало бы
 * «подхватывают при следующем запуске».
 */
describe("updateRegisteredToolText", () => {
  const fakeHandles = (): { handles: ToolHandles; updates: Map<string, unknown> } => {
    const updates = new Map<string, unknown>();
    const handles: ToolHandles = new Map(
      ALL_TOOLS.map((tool) => [
        tool.name,
        {
          title: tool.title,
          description: renderDescription(tool),
          annotations: { title: tool.title, readOnlyHint: tool.readOnly },
          update: (patch: unknown) => updates.set(tool.name, patch),
        } as never,
      ]),
    );
    return { handles, updates };
  };

  /**
   * Каждый `update()` шлёт клиенту уведомление. Сорок уведомлений ради двух
   * правок — это шум, по которому хост перестаёт перечитывать список, поэтому
   * трогаются только те, у кого текст ДЕЙСТВИТЕЛЬНО изменился.
   */
  it("трогает только изменившиеся инструменты", () => {
    const { handles, updates } = fakeHandles();

    const changed = updateRegisteredToolText(handles, ALL_TOOLS, {
      results_overview: { description: "Rewritten." },
    });

    expect(changed).toBe(1);
    expect([...updates.keys()]).toEqual(["results_overview"]);
  });

  it("обновляет заголовок в обоих местах — полем и в аннотациях", () => {
    const { handles, updates } = fakeHandles();

    updateRegisteredToolText(handles, ALL_TOOLS, {
      results_overview: { title: "Survey numbers", description: "Exact counts." },
    });

    const patch = updates.get("results_overview") as {
      title: string;
      description: string;
      annotations: { title: string; readOnlyHint: boolean };
    };
    expect(patch.title).toBe("Survey numbers");
    // Инварианты доезжают и сюда: живое обновление собирает текст тем же
    // renderDescription, что и первичная регистрация.
    expect(patch.description).toContain("Exact counts.");
    expect(patch.description).toContain("lower bound");
    // Заголовок едет дважды, и обновить половину значит показать человеку
    // старый заголовок рядом с новым описанием.
    expect(patch.annotations.title).toBe("Survey numbers");
    expect(patch.annotations.readOnlyHint).toBe(true);
  });

  /**
   * РУБИЛЬНИК НА ЖИВОМ СЕРВЕРЕ. Пустой каталог — это возврат к коду, и он
   * обязан доехать до уже открытых сессий так же, как доезжает правка.
   */
  it("пустой каталог возвращает живые инструменты к тексту из кода", () => {
    const { handles, updates } = fakeHandles();

    updateRegisteredToolText(handles, ALL_TOOLS, { results_overview: { title: "Survey numbers" } });
    expect(updates.size).toBe(1);

    // Тот же набор хендлов, но с уже переопределённым состоянием.
    handles.get("results_overview")!.title = "Survey numbers";
    updates.clear();

    const changed = updateRegisteredToolText(handles, ALL_TOOLS, {});
    expect(changed).toBe(1);
    expect((updates.get("results_overview") as { title: string }).title).toBe(overviewTool.title);
  });
});

/**
 * Доставка. Ни одна из проверок ниже не про «работает», все — про «не падает».
 */
describe("ToolTextSource", () => {
  const source = (extra: Record<string, unknown> = {}) =>
    new ToolTextSource({ apiUrl: "http://backend.invalid", timeoutMs: 50, ...extra });

  it("не бросает, когда сети нет", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));
    const s = source();
    await expect(s.get()).resolves.toEqual({});
    expect(s.revision).toBeNull();
  });

  it("не бросает на 500 и на теле не того вида", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("nope", { status: 500 })));
    await expect(source().get()).resolves.toEqual({});

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ success: true, data: { tools: "not an object" } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );
    await expect(source().get()).resolves.toEqual({});
  });

  it("жалуется ровно один раз на срыв, а не на каждую попытку", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("down")));
    const warn = vi.fn();
    const s = source({ warn });

    await s.refresh();
    await s.refresh();
    await s.refresh();

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toContain("descriptions built into this package");
  });

  it("читает каталог и запоминает ревизию", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            success: true,
            data: {
              revision: 18,
              enabled: true,
              tools: { results_overview: { title: "Results", description: "Summary." } },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json", ETag: 'W/"18"' } },
        ),
      ),
    );

    const s = source();
    await expect(s.get()).resolves.toEqual({
      results_overview: { title: "Results", description: "Summary." },
    });
    expect(s.revision).toBe(18);
  });

  /**
   * РУБИЛЬНИК. Самая ценная строка фичи: вопрос «это переопределения?» должен
   * занимать пять секунд, а возврат к коду — одно движение и ни одного
   * удаления.
   */
  it("выключенный рубильник возвращает каталог к коду, ничего не удаляя", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            success: true,
            data: {
              revision: 19,
              enabled: false,
              // Сервер уже отдал пусто, но даже если бы не отдал — клиент не
              // берёт переопределения при выключенном рубильнике.
              tools: { results_overview: { description: "Should not be used." } },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      ),
    );

    const s = source();
    expect(await s.get()).toEqual({});
    expect(applyToolText(ALL_TOOLS, await s.get())).toEqual([...ALL_TOOLS]);
  });

  it("не берёт из тела ничего, кроме title и description", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            success: true,
            data: {
              revision: 1,
              enabled: true,
              tools: {
                results_overview: {
                  title: "T",
                  description: "D",
                  name: "survey_delete_permanent",
                  readOnly: false,
                  invariants: [],
                },
              },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      ),
    );

    const catalogue = await source().get();
    expect(Object.keys(catalogue.results_overview!)).toEqual(["title", "description"]);
  });

  /**
   * СТОРОЖ ПРОТИВ stale-THEN-revalidate.
   *
   * Ожидание «раз в TTL» выглядит дешёвым и обходится дорого: в живом диалоге
   * это значит, что раз в минуту ход встаёт перед первым токеном ответа — из-за
   * настройки, которая меняется дважды в месяц. Протухший снимок обязан
   * отдаваться МГНОВЕННО, а обновление уходить в фон.
   */
  it("протухший снимок отдаётся мгновенно, обновление уходит в фон", async () => {
    const quick = new Response(
      JSON.stringify({
        success: true,
        data: { revision: 1, enabled: true, tools: { survey_get: { description: "First." } } },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
    const slow = () =>
      new Promise<Response>((resolve) => {
        setTimeout(() => resolve(new Response("{}", { status: 200 })), 5_000);
      });

    const fetchMock = vi.fn().mockResolvedValueOnce(quick).mockImplementation(slow);
    vi.stubGlobal("fetch", fetchMock);

    // ttl = 0, то есть снимок протухает мгновенно; ждать при этом всё равно
    // нельзя ни разу после первого.
    const s = source({ ttlMs: 0, timeoutMs: 1_000 });
    expect(await s.get()).toEqual({ survey_get: { description: "First." } });

    const started = Date.now();
    const stale = await s.get();
    expect(Date.now() - started).toBeLessThan(100);
    expect(stale).toEqual({ survey_get: { description: "First." } });
    // И обновление всё-таки было заказано, а не пропущено.
    expect(fetchMock.mock.calls.length).toBeGreaterThan(1);
  });

  /**
   * СТОРОЖ ПРОТИВ stale-THEN-revalidate, в формулировке из ревью: снимок
   * возрастом 61 секунда при висящей сети обязан вернуться СИНХРОННО ПО
   * ВРЕМЕНИ.
   *
   * <p>Ожидание «раз в TTL» выглядит дешёвым и обходится дорого: в живом
   * диалоге это секунда тишины примерно раз в минуту, из-за настройки, которая
   * меняется раз в месяц. В тестах на поведение этого не видно — видно только
   * по часам, поэтому здесь меряется время.
   */
  it("снимку 61 секунда, сеть висит — ход не ждёт", async () => {
    const first = new Response(
      JSON.stringify({
        success: true,
        data: { revision: 7, enabled: true, tools: { survey_get: { description: "Known." } } },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
    const hang = () => new Promise<Response>(() => {});

    const fetchMock = vi.fn().mockResolvedValueOnce(first).mockImplementation(hang);
    vi.stubGlobal("fetch", fetchMock);

    const s = source({ ttlMs: 60_000, timeoutMs: 1_000 });
    expect(await s.get()).toEqual({ survey_get: { description: "Known." } });

    // Снимку стало 61 секунда: TTL истёк, но снимок по-прежнему годен.
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 61_000);

    const started = performance.now();
    const stale = await s.get(1_000);
    const waited = performance.now() - started;

    expect(stale).toEqual({ survey_get: { description: "Known." } });
    expect(waited).toBeLessThan(50);
    // И обновление всё-таки заказано, а не пропущено.
    expect(fetchMock.mock.calls.length).toBeGreaterThan(1);
  });

  it("ход не ждёт настройку дольше отведённого", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            setTimeout(() => resolve(new Response("{}", { status: 200 })), 5_000);
          }),
      ),
    );

    const started = Date.now();
    await expect(source().get(60)).resolves.toEqual({});
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});
