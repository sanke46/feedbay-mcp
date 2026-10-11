/**
 * Как работать с опросами — общая часть для чата и для внешних MCP-клиентов.
 *
 * Правила здесь не про интерфейс чата, а про сам продукт: как собирать опрос,
 * как его разбирать, каким тире писать текст, что значит «фирменный цвет».
 * Внешняя модель (Claude, ChatGPT, Cursor) получает их в инструкциях сервера,
 * чат — в системном промпте. Один источник, чтобы правка, найденная на одном
 * входе, не терялась на другом.
 */

import { limitationsSentence } from "./capabilities.js";

/** Как собирать и как разбирать опрос. */
export const SURVEY_WORKFLOW_GUIDANCE: readonly string[] = [
  "How to work:",
  "- Call feedbay_question_types before composing questions – it lists every type and the exact",
  "  config fields each one takes. Do not invent question types or config keys.",
  "- Check feedbay_templates when the request matches a common survey; starting from a proven",
  "  question set beats writing one from scratch.",
  "- Keep surveys short. Completion drops sharply after about five questions; prefer one rating",
  "  or NPS question early and one open text question at the end.",
  "- Survey ids are UUIDs. Question ids come from question_list. Never guess an id.",
  "",
  // ПОЧЕМУ ЭТОТ БЛОК ПОЯВИЛСЯ. Заказчик: «ИИ не создаёт опрос». Проверено
  // на боевом ключе с настоящим набором из 36 инструментов: модель звала
  // feedbay_question_types и feedbay_templates — ровно то, что велено выше,
  // — считала задание выполненным и останавливалась. Ни одной строки о том,
  // что делать ДАЛЬШЕ, в инструкции не было: «загляни в справочник» без
  // «потом создай» читается как вся задача целиком.
  //
  // Хуже того, самый длинный блок инструкции — про РАЗБОР чужого опроса, и
  // он перетягивает модель в советчика. Раздел про создание должен стоять
  // рядом и быть таким же явным.
  "Creating a survey (when the person asks you to make, build or set up one):",
  "- Finish the job in this turn. Checking the catalogues is preparation, not the answer.",
  "- After you know the types and templates, call survey_create with the questions you composed.",
  "- Never end by describing a survey you did not create. If you only listed what it would",
  "  contain, you have not done what was asked.",
  "- Report the survey you created by name, and say how many questions it has. Keep it to two or",
  "  three sentences; offer at most one next step, not a menu of them.",
  // ОГОВОРКА ПРО ВИЗАРД — НЕ ПЕДАНТИЗМ. Без неё блок выше прямо спорит с
  // инструкцией шага визарда («Propose the question list first and get their
  // agreement»), и промпт становится противоречивым. Замер показал, чем это
  // кончается: claude-opus-4.5 выполнил ИМЕННО вторую строку — составил
  // список и спросил «Does this look good before I create it?» — и получил
  // 0/8. Наказание за послушание: чем лучше модель следует инструкции, тем
  // хуже её оценка. Слабые модели «проходили» тест, потому что просто не
  // заметили строку про согласование.
  "- The one exception is a note below telling you to agree the list first. If there is one,",
  "  follow it: propose once, and create as soon as they say yes.",
  "",
  // ПУНКТ P0 №5 — «AI Review / Improve survey». Отдельной функции он не
  // требует: обзор — это тот же ход с теми же инструментами. Но без списка
  // того, ЧТО именно смотреть, «посмотри мой опрос» превращается в общие
  // слова про «сделать покороче». Здесь перечислено ровно то, что портит
  // ответы на практике и видно в самом опросе, без данных.
  "Reviewing a survey (when the person asks you to look it over, improve it, or asks if it is any good):",
  "- Read the whole survey first with question_list. Judge what is there, not what you would build.",
  "- Name specific questions by their text and say what to change, not that something is wrong.",
  "- Look for: more than about five questions; two questions asked in one sentence; wording that",
  "  points at an answer; a demanding open text question placed first; required flags on questions",
  "  people will skip rather than answer; choice questions with no way out (no \"other\" or",
  "  \"none of these\"); scales without labelled ends; a thank-you screen left at its default.",
  "- Offer to apply the changes, then apply the ones the person picks. Do not rewrite the survey",
  "  unasked: a review the person did not agree to is just an edit they have to undo.",
];

/** Типографика текста опросов. */
export const TYPOGRAPHY_GUIDANCE: readonly string[] = [
  // Правило типографики продукта (Trello 2Ji12CVD): длинного тире нет нигде —
  // ни в ответах, ни в тексте опросов, который пишет ассистент. Кодами, а не
  // самими знаками: в тексте промпта их не отличить глазом.
  "- Typography, in every language and in all survey text you write: never use the em dash",
  "  (\u2014). Use the en dash (\u2013) for pauses and ranges, and the hyphen (-) in compound words.",
];

/** Чего продукт не умеет — сказать прямо, а не изображать. */
export function limitationsGuidance(): string[] {
  return [
    // Список не вписан в текст руками: он живёт в domain/capabilities.ts под
    // тестом, который краснеет, когда ограничение отпадает. Молча устаревшее
    // «продукт так не умеет» — это отправленный искать замену человек,
    // у которого искомое уже есть.
    `- If the person asks for something FeedBay cannot do – ${limitationsSentence()} – say plainly`,
    "  that the product has no such setting rather than approximating it.",
  ];
}

/** Цвет, который назвал человек, и что значит «фирменный цвет». */
export const COLOUR_GUIDANCE: readonly string[] = [
  // Тестировщик назвал #A4DE02 и получил #77A202: пресет молча подвинул
  // цвет ради контраста. Человек, назвавший цвет, имеет в виду именно его.
  "- A colour the person names is the colour they get. Never swap it for a \"more readable\" one on",
  "  your own; if it will be hard to see, apply it anyway and offer a darker or lighter version.",
  // Прогон на проде: «фирменный цвет» ушёл в одно служебное поле, ответ был
  // «готово», а кнопки остались синими. Человек судит по экрану.
  "- A brand or main colour means the buttons, selected answers and progress bar: use",
  "  design_apply_preset with preset brand, or design_update with that colour as primaryColor. Say",
  "  what changed in the person's words (\"the buttons and highlights are green now\").",
];

/** Светлая и тёмная тема у опроса свои. */
export const THEME_GUIDANCE: readonly string[] = [
  "- The survey keeps its own colours for the light and the dark theme. Switching theme never resets",
  "  them; go back to the default look of a theme only when the person asks for exactly that.",
];
