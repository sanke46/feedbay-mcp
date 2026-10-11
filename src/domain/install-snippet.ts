/**
 * Код установки виджета на сайт.
 *
 * Дублирует шаблон из `frontend/src/components/survey-share/share-panel.tsx`
 * по той же причине, что и словарь типов вопросов рядом: он собран внутри
 * React-компонента, а тянуть Next в серверный пакет нельзя. Дублирование
 * безопасно только при громком расхождении — за этим следит
 * `tests/contract.test.ts`, который читает оригинал.
 *
 * Без этого модуля агент обслуживает только канал LINK: он умеет создать опрос
 * с `channel: WEBSITE`, настроить триггеры и опубликовать, но не может отдать
 * пользователю то единственное, ради чего всё делалось, — строку для вставки
 * на сайт.
 */

/** Триггер показа, как его понимает виджет (widget/src/core/TriggerManager.ts). */
export interface WidgetTrigger {
  type?: string;
  delay?: number;
  scrollPercent?: number;
}

export interface InstallSnippetInput {
  /** Короткий публичный id опроса, не UUID. */
  publicId: string;
  /** Origin, с которого отдаётся виджет и публичная страница. */
  shareHostOrigin: string;
  /** Origin API; к нему дописывается /api/v1. */
  apiOrigin: string;
  /** `targeting` опроса — из него берётся триггер. */
  targeting?: Record<string, unknown> | null;
  /** Режим показа: у STANDARD виджет встраивается в свой контейнер. */
  displayMode?: string | null;
}

/**
 * Собирает часть `trigger:` вызова `fb('init', …)`.
 *
 * Значения задержки и прокрутки зашиты в дашборде теми же константами
 * (5000 мс и 50%), и менять их здесь в одиночку нельзя: пользователь, который
 * настроил триггер мышкой, а код взял у агента, получил бы другое поведение.
 */
function triggerSnippet(targeting?: Record<string, unknown> | null): string {
  const type = typeof targeting?.triggerType === "string" ? targeting.triggerType : "immediate";

  if (type === "delay") {
    const delay = typeof targeting?.triggerDelay === "number" ? targeting.triggerDelay : 5000;
    return `,\n    trigger: ${JSON.stringify({ type: "delay", delay })}`;
  }
  if (type === "scroll") {
    const scrollPercent =
      typeof targeting?.triggerScroll === "number" ? targeting.triggerScroll : 50;
    return `,\n    trigger: ${JSON.stringify({ type: "scroll", scrollPercent })}`;
  }
  // immediate и exit_intent триггера в сниппете не требуют: первый — поведение
  // по умолчанию, второй виджет ставит сам по displayMode.
  return "";
}

export function buildInstallSnippet(input: InstallSnippetInput): string {
  const widgetScriptUrl = `${input.shareHostOrigin.replace(/\/+$/, "")}/widget/feedbay.umd.js`;
  const apiUrl = `${input.apiOrigin.replace(/\/+$/, "")}/api/v1`;

  // STANDARD рисуется внутри страницы, а не поверх неё, поэтому ему нужен
  // контейнер. Всплывающим режимам он не нужен — виджет создаёт слой сам.
  const container = input.displayMode === "STANDARD" ? '<div id="feedbay-survey"></div>\n\n' : "";

  return `${container}<!-- FeedBay Survey Widget -->
<script>
  (function(w,d,s,o,f,js,fjs){
    w['FeedBay']=o;w[o]=w[o]||function(){
    (w[o].q=w[o].q||[]).push(arguments)};
    js=d.createElement(s),fjs=d.getElementsByTagName(s)[0];
    js.id=o;js.src=f;js.async=1;
    fjs.parentNode.insertBefore(js,fjs);
  }(window,document,'script','fb','${widgetScriptUrl}'));
  fb('init', {
    surveyId: '${input.publicId}',
    apiUrl: '${apiUrl}'${triggerSnippet(input.targeting)}
  });
</script>`;
}
