# Changelog

## Unreleased

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
