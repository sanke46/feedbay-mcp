# Changelog

## Unreleased

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
