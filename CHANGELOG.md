# Changelog

## 0.2.0 – first public release

- 42 tools for surveys, questions, design, sharing, folders and responses; 20 of them read-only.
- Your own model does the thinking: `brand_read_site` returns what a website declares about its look,
  and the `import_survey_from_document` prompt rebuilds a questionnaire from a file you attach.
- Links to pictures, video and audio are checked and copied into FeedBay storage, not hotlinked.
- The hosted server signs you in with OAuth 2.1, so Claude (web, desktop, mobile) and ChatGPT connect
  by URL; sessions survive token refresh.
- stdio transport (`feedbay-mcp`) and Streamable HTTP transport (`feedbay-mcp-http`).
- One-click install for Claude Desktop (`feedbay-<version>.mcpb`).
- The permissions come from the API key itself: a read-only key never sees a tool that writes.
- Text written by survey respondents reaches the model fenced off as data.
- The HTTP transport answers an unknown session with 404, closes sessions idle for 30 minutes,
  and rate-limits per key and per failed handshake.
