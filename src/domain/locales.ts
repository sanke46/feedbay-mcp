/**
 * Языки интерфейса опроса (`design.locale`): кнопки, подсказки, экран
 * благодарности. Один список на `survey_create` и `design_update`, чтобы они
 * не разъехались. Источник правды – словарь рендерера
 * (packages/survey-renderer/src/i18n.ts); совпадение держит contract.test.ts.
 */
export const SURVEY_LOCALE_CODES = ["en", "ru", "es", "de", "fr", "pt"] as const;
