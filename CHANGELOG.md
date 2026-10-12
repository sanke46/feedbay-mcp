# Changelog

## 0.3.0 – 2026-10-12

- After the English run: a question gets an answer, not a new survey (instructions); `question_add` without
  `position` lands before the thank-you screen; a selected rating number and the multiple-choice check mark are
  coloured by the fill they sit on, and `contrastReport` shows that pair; the `primaryColor` description says it
  recolours buttons, answers and progress even when they were set before; `feedbay_question_types` with `types`
  also returns `allTypes` and points to the WELCOME and THANK_YOU screens; "text" is noted as one-line.
- After the second matrix run: the publish rule reads `canPublish`, not the plan name (a Free plan with publishing
  granted no longer looks like a contradiction); survey summaries carry `locale`; the type catalogue says what a
  word was read as (`readAs`) and lists the CSAT/CES styles; `survey_get` and `question_list` count questions the
  same way; `design_update` keeps the saved copy of the shown theme current; `survey_install_snippet` no longer
  implies the widget needs channel WEBSITE; NPS segments carry promoters, passives and detractors.
- `feedbay_whoami` names the plan (Free, Core, Plus, Lifetime…); the quota's `resetDate` now carries its UTC offset.
- `feedbay_question_types` accepts the same words as `survey_create` ("rating", "text", "phone"), and an unknown
  type gets a "did you mean" instead of the list of every type.
- `design_update` keeps both themes: a background that flips the survey to dark keeps the light colours for the
  Light button, and `theme: "light" | "dark"` edits the other theme without switching.
- `results_breakdown` takes `segmentBy` (a question id): NPS and averages for each answer of that question;
  a multiple-choice answer counts in each of its groups.
- `survey_delete` archives the survey, as the dashboard does: `survey_set_status unarchive` restores it,
  `survey_delete_permanent` erases it.
- `survey_get` and `question_list` keep warnings in the `warnings` field; the first line repeats them only on
  changes. `question_list` returns `{ questions, warnings? }`.
- Response exports (CSV and Excel) are headed by the question text in survey order ("1. How likely…") instead of
  question ids.
- Draft preview link. For a survey that is not published, `survey_share_info` now returns `previewUrl` and
  `previewExpiresAt`: a 72-hour link that shows the draft exactly as respondents will see it, without saving
  answers. The reply says the public link opens only after publishing.
- Survey language. `design_update` and `survey_create` take `locale: "en" | "ru"`, which sets the language
  of the buttons and hints respondents see (Next, Back, Other, placeholders, the thank-you text) on the link
  page, in the widget and in the dashboard preview. A survey created with Russian questions and no `locale`
  gets `ru` automatically, and the reply says so. The warning about English buttons now appears only when
  the text and the language disagree.
- `RATING_SCALE` takes `style: "numbers"`: a 1..scale grid of numbered buttons, with the end captions in
  `labels`. The renderer, the widget and the dashboard editor draw it too.
- No more warnings about CSAT/CES stars or wide matrices. The survey link now draws CSAT and CES in their
  chosen style, as the widget always did, and a matrix too wide for its card turns into rows on phones and
  in the widget popup. A wrong warning was worse than none: models swapped CSAT for a rating scale and
  lost the CSAT metric.
- 40 tools instead of 42, because Cursor hands an agent only about 40 across all servers.
  `feedbay_template_get` became `feedbay_templates` with `templateId`. `survey_widget_config` merged
  into `survey_install_snippet`, which now also shows what a visitor's browser receives. Folder tools
  come last in the list, so a client that cuts the list drops them first.
- Less to read for the model:
  - `feedbay_question_types` lists types compactly (5.7k characters instead of 11.3k); pass `types` for
    the full config of the ones you use.
  - `survey_list` drops each survey's design.
  - `response_list` drops respondents' IP and user agent, and carries the question titles.
- Results you can retell: `results_overview` names questions by their text and type, computes NPS and
  averages for rating scales, and lists open answers instead of percentages.
- Warnings in the first line of the result for things that would surprise the person:
  - CSAT/CES stars that the survey link draws as numbers;
  - more than five questions;
  - a matrix too wide for a phone;
  - English buttons on a survey written in another language.
- Fonts: a request for a serif font gets the system serif instead of a silent switch to Inter.
  `design_update` lists FeedBay's fonts and warns about one browsers will not draw. `design_get` and
  `design_update` report contrast with the WCAG target for each pair.
- On the hosted server `responses_export` returns the file in the reply and keeps no copy on the
  server's disk.
- `design_match_brand`: pass a logo only for the person's own brand, never for "make it look like
  another company's site". A thank-you screen without a title is named by its message rather than
  "New question". `unpublish` is described.
- Works with more models. Tool schemas no longer use `$ref` or `null` types, which Gemini rejects;
  `null` sent for an optional field (a habit of GPT models) now means "not set" instead of failing the
  call. `survey_move` and `survey_update` take `folderId: "root"` to take a survey out of every folder.
- The server instructions are short enough to reach the model whole (Claude Code shows about 2,000
  characters); the detailed rules now sit in the tool descriptions where they apply.
- A refusal that changed nothing (unknown question id, nothing to update, "read the site first") is
  marked `isError`, and API validation errors name the rejected fields.
- `survey_install_snippet` puts the public API address into the website code; the hosted server
  used to hand out its internal address, so the widget never loaded on a customer's site.
- `feedbay_whoami` says whether the account can publish (once the API reports it) and what FeedBay
  cannot do, and no longer returns the phone number, avatar or the server's API address.
- On a brand palette, the button label keeps the site's text colour only when it reads at least as
  well as black or white.
- Annotations: everything that needs `confirm` is marked destructive, and only the tools that fetch
  addresses the person gave are marked open-world. `survey_delete` no longer calls itself recoverable.
- The hosted server no longer goes dead an hour after you sign in. An expired access token in a live
  session now gets 401 `invalid_token`, so the client refreshes it and carries on in the same session;
  before, every tool call failed until you reconnected by hand.
- Several refreshes with the same refresh token at once, which happens when tools run in parallel as the
  token expires, all get the same new tokens. Before, the second one looked like a stolen token and
  disconnected the app.
- Only rejected credentials count towards the per-IP limit. Requests without a token, which OAuth
  clients send to find where to sign in, no longer do: from the shared address of claude.ai they could
  lock everyone out.
- README: the hosted server comes first; the npm package is not published yet.

## 0.2.0 – first public release

- 42 tools for surveys, questions, design, sharing, folders and responses; 20 of them read-only.
- Your own model does the thinking: `brand_read_site` returns what a website declares about its look,
  and the `import_survey_from_document` prompt rebuilds a questionnaire from a file you attach.
- Links to pictures, video and audio are checked and copied into FeedBay storage, not hotlinked.
- The hosted server signs you in with OAuth 2.1, so Claude (web, desktop, mobile) and ChatGPT connect
  by URL; sessions survive token refresh.
- stdio transport (`feedbay-mcp`) and Streamable HTTP transport (`feedbay-mcp-http`).
- One-click install for Claude Desktop (`feedbay-<version>.mcpb`).
- Needs Node 20 or newer: the MCP SDK relies on the global Web Crypto API, which Node 18 lacks.
- The permissions come from the API key itself: a read-only key never sees a tool that writes.
- Text written by survey respondents reaches the model fenced off as data.
- The HTTP transport answers an unknown session with 404, closes sessions idle for 30 minutes,
  and rate-limits per key and per failed handshake.
