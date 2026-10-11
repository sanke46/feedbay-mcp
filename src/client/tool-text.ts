/**
 * Откуда двери берут переопределения текста инструментов.
 *
 * ПО СЕТИ ЕДЕТ ТОЛЬКО ДЕЛЬТА. Дефолты у каждой двери свои — из кода, из этого
 * же пакета. Это и делает деградацию тривиальной: не доехало — работаем ровно
 * как сегодня, а не как «сегодня, но без описаний».
 *
 * ЭТОТ КЛАСС НЕ БРОСАЕТ. Ни разу, ни при какой ошибке. Недоступность нашего
 * API не имеет права выключить чужой Claude Desktop и не имеет права уронить
 * ход чата: описание инструментов — настройка, а не продукт. На это есть
 * отдельный тест.
 *
 * ПОЧЕМУ СВОЙ FETCH, А НЕ `rawRequest`. Тот трижды повторяет запрос со сном
 * между попытками — разумно для вызова, ради которого человек ждёт, и
 * недопустимо здесь: бюджет чата на весь поход — одна секунда.
 */

import type { ToolTextCatalogue, ToolTextOverride } from "../tools/text-overrides.js";
import { TOOL_TEXT_LIMITS, sanitizeToolText } from "../tools/text-overrides.js";

/** Что отдаёт `GET /api/v1/agent/tool-text`. */
export interface ToolTextSnapshot {
  /** Номер ревизии. Он же едет в журнал вызовов и в ETag. */
  revision: number;
  /** Рубильник `overrides_enabled`. Выключен — каталог приезжает пустым. */
  enabled: boolean;
  tools: ToolTextCatalogue;
  /** Когда снимок снят, мс эпохи. */
  fetchedAt: number;
}

export interface ToolTextSourceOptions {
  /** Origin бэкенда, без префикса /api/v1. */
  apiUrl: string;
  /** Как запрос представляется. Пусто — идём без заголовка Authorization. */
  token?: () => string | null | Promise<string | null>;
  /** Сколько снимок считается свежим. */
  ttlMs?: number;
  /** Потолок одного похода в сеть. */
  timeoutMs?: number;
  /** Позвать, когда обновление принесло ДРУГУЮ ревизию. Здесь живёт `sendToolListChanged`. */
  onChange?: (snapshot: ToolTextSnapshot) => void;
  /** Куда жаловаться. У stdio это stderr и ровно одна строка. */
  warn?: (message: string) => void;
}

const DEFAULT_TTL_MS = 60_000;
const DEFAULT_TIMEOUT_MS = 2_000;

/**
 * Снимок старше суток отбрасывается.
 *
 * Долгоживущий процесс, у которого месяц не отвечает эндпоинт настроек, не
 * должен вечно кормить модель текстом неизвестной давности. Сутки — потому
 * что это заведомо больше любого разумного перерыва и заведомо меньше срока,
 * за который текст успевают переписать и забыть.
 */
const MAX_SNAPSHOT_AGE_MS = 24 * 60 * 60 * 1000;

/** Пустой каталог — он же «работаем по коду». */
const EMPTY: ToolTextCatalogue = Object.freeze({});

/**
 * Разбор ответа.
 *
 * Доверчиво читать сюда нельзя: тело приезжает из сети, а уезжает в промпт
 * модели. Берём только строки и только два поля — то же, что разрешено писать
 * на сервере, проверенное второй раз здесь.
 */
function readCatalogue(raw: unknown): ToolTextCatalogue {
  if (raw === null || typeof raw !== "object") return {};
  const catalogue: ToolTextCatalogue = {};
  let budget = TOOL_TEXT_LIMITS.total;

  /** Строка — только если это строка, она чистая и укладывается в предел. */
  const field = (value: unknown, limit: number): string | undefined => {
    if (typeof value !== "string") return undefined;
    // Очистка ДО проверки длины и ДО подсчёта бюджета: и предел, и цена — про
    // то, что уедет модели, а не про то, что лежит в базе.
    const clean = sanitizeToolText(value);
    return clean.length > 0 && clean.length <= limit ? clean : undefined;
  };

  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    if (value === null || typeof value !== "object") continue;
    const source = value as Record<string, unknown>;
    const override: ToolTextOverride = {};

    const title = field(source.title, TOOL_TEXT_LIMITS.title);
    const description = field(source.description, TOOL_TEXT_LIMITS.description);
    if (title !== undefined) override.title = title;
    if (description !== undefined) override.description = description;

    const cost = (override.title?.length ?? 0) + (override.description?.length ?? 0);
    if (cost === 0) continue;
    // Бюджет кончился — дальше не берём. Это потолок и цены, и размаха: блок
    // инструментов уезжает провайдеру в каждом из до двенадцати запросов хода.
    if (cost > budget) break;
    budget -= cost;

    catalogue[name] = override;
  }
  return catalogue;
}

export class ToolTextSource {
  private readonly apiUrl: string;
  private readonly ttlMs: number;
  private readonly timeoutMs: number;
  private readonly options: ToolTextSourceOptions;

  private snapshot: ToolTextSnapshot | null = null;
  private etag: string | null = null;
  private inFlight: Promise<void> | null = null;
  /** Жаловались ли на прошлую попытку — чтобы не повторять одну строку каждые десять минут. */
  private complained = false;

  constructor(options: ToolTextSourceOptions) {
    this.options = options;
    this.apiUrl = options.apiUrl.replace(/\/+$/, "");
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /**
   * Ревизия действующего снимка — то, что уезжает в журнал вызовов.
   *
   * `null`, пока снимка нет или он просрочен: именно это отличает «ассистент
   * бегал на ревизии 18» от «ассистент бегал на коде».
   */
  get revision(): number | null {
    if (!this.snapshot) return null;
    if (Date.now() - this.snapshot.fetchedAt > MAX_SNAPSHOT_AGE_MS) return null;
    return this.snapshot.revision;
  }

  /**
   * Последнее известное, синхронно и без похода в сеть.
   *
   * Просроченный снимок (сутки) не отдаётся: лучше код, чем текст неизвестной
   * давности.
   */
  current(): ToolTextCatalogue {
    if (!this.snapshot) return EMPTY;
    if (Date.now() - this.snapshot.fetchedAt > MAX_SNAPSHOT_AGE_MS) return EMPTY;
    return this.snapshot.tools;
  }

  /** Свеж ли снимок по TTL. */
  private get fresh(): boolean {
    return this.snapshot !== null && Date.now() - this.snapshot.fetchedAt < this.ttlMs;
  }


  /**
   * Каталог для ближайшего использования: stale-WHILE-revalidate.
   *
   * <p>ЖДЁМ РОВНО ОДИН РАЗ — на холодном старте, когда отдавать нечего вовсе.
   * Дальше протухший снимок отдаётся НЕМЕДЛЕННО, а обновление уходит в фон.
   *
   * <p>Разница не косметическая. Ожидание «раз в TTL» выглядит дешёвым, но в
   * живом диалоге это значит, что раз в минуту ход встаёт перед первым токеном
   * ответа — на секунду, из-за настройки, которая меняется дважды в месяц.
   * Это stale-THEN-revalidate под именем SWR, и ровно этот дефект уже нашли в
   * соседнем резолвере модели.
   */
  async get(waitMs = this.timeoutMs): Promise<ToolTextCatalogue> {
    if (this.fresh) return this.current();

    /**
     * Ждать имеет смысл, только когда отдавать НЕЧЕГО.
     *
     * Условие — `revision === null`, то есть снимка нет вовсе или он старше
     * суток. Именно так, а не «каталог пуст»: пустой каталог это законное
     * «переопределений нет», и путать его с «ничего не знаем» нельзя — второе
     * стоит ожидания, первое нет.
     *
     * Под это условие попадают старт stdio (≤ 3 с) и первый запрос
     * HTTP-транспорта; они ждут, как и задумано. Ход чата — никогда.
     */
    const nothingUsable = this.revision === null;

    // Обновление заказывается в обоих случаях — и когда ждём, и когда нет.
    const refresh = this.refresh();

    if (waitMs > 0 && nothingUsable) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        refresh,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, waitMs);
        }),
      ]);
      if (timer) clearTimeout(timer);
    }
    return this.current();
  }

  /**
   * Сходить за каталогом. Никогда не бросает.
   *
   * Параллельные вызовы разделяют один поход: на старте HTTP-транспорта
   * несколько сессий открываются одновременно, и сорок одинаковых запросов к
   * бэкенду были бы единственным их следствием.
   */
  refresh(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.fetchOnce().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async fetchOnce(): Promise<void> {
    try {
      const headers: Record<string, string> = { Accept: "application/json" };
      const token = await this.options.token?.();
      if (token) headers.Authorization = `Bearer ${token}`;
      // 304 экономит не байты, а разбор и мусор: тело каталога маленькое, а
      // ходят за ним три двери в цикле.
      if (this.etag) headers["If-None-Match"] = this.etag;

      const response = await fetch(`${this.apiUrl}/api/v1/agent/tool-text`, {
        method: "GET",
        headers,
        signal: AbortSignal.timeout(this.timeoutMs),
      });

      if (response.status === 304) {
        // Ничего не изменилось — снимок остаётся, но перестаёт считаться
        // протухшим: он только что подтверждён. 304 без снимка возможен только
        // при чужом кеширующем прокси; это не ошибка, просто ждём следующего
        // раза, а не жалуемся на здоровый ответ.
        if (this.snapshot) this.snapshot = { ...this.snapshot, fetchedAt: Date.now() };
        this.complained = false;
        return;
      }

      if (!response.ok) {
        this.complain(`tool text endpoint answered HTTP ${response.status}`);
        return;
      }

      const body = (await response.json()) as {
        success?: boolean;
        data?: { revision?: unknown; enabled?: unknown; tools?: unknown };
      };
      const data = body?.data;
      if (!body?.success || !data) {
        this.complain("tool text endpoint returned an unexpected body");
        return;
      }

      const previous = this.snapshot;
      const next: ToolTextSnapshot = {
        revision: typeof data.revision === "number" ? data.revision : 0,
        enabled: data.enabled !== false,
        // Рубильник выключен — каталог пуст. Сервер и так отдаёт пустой, но
        // решение «вернуть все двери к коду» не должно зависеть от того, что
        // именно он положил в тело.
        tools: data.enabled === false ? {} : readCatalogue(data.tools),
        fetchedAt: Date.now(),
      };

      this.snapshot = next;
      this.etag = response.headers.get("etag");
      this.complained = false;

      if (!previous || previous.revision !== next.revision) {
        this.options.onChange?.(next);
      }
    } catch (error) {
      this.complain((error as Error).message || "tool text could not be read");
    }
  }

  /** Одна строка на срыв, а не на каждую попытку. */
  private complain(reason: string): void {
    if (this.complained) return;
    this.complained = true;
    this.options.warn?.(
      `tool descriptions could not be read from ${this.apiUrl} (${reason}); ` +
        `using the descriptions built into this package`,
    );
  }
}
