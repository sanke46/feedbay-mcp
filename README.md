# FeedBay MCP server

Build, style, publish and analyse [FeedBay](https://feedbay.io) surveys from
Claude, ChatGPT, Cursor, Codex or any other [MCP](https://modelcontextprotocol.io)
client.

You ask your assistant something like *"make a short NPS survey for our trial
users, in our brand colours, and give me the link"*. It drafts the questions,
creates the survey, styles it and hands you the share link. Later you can ask
*"what are people complaining about?"*. Your own model does the thinking on
your own subscription. FeedBay only runs the actions.

- **42 tools**: surveys, questions, design, sharing and targeting, folders,
  responses and results. 20 of them only read.
- **Two ways in**: run it locally (stdio), or connect to the hosted server at
  `https://mcp.feedbay.io/mcp`.
- **Safe by default**:
  - irreversible actions need an explicit `confirm: true`;
  - a read-only API key hides every tool that writes;
  - answers written by survey respondents reach the model fenced off as data,
    never as instructions.

Building, editing and analysing surveys work on any FeedBay account.
**Publishing a survey needs a paid plan.** When it doesn't have one, the server
tells the model so, and the model tells you.

## 1. Get an API key

In FeedBay, open **Account → API keys** and create a key. It starts with
`fb_live_`. Tick *read-only* if the assistant should only look.

The hosted server can also sign you in with your FeedBay account (OAuth). In
that case you don't need a key: see [Hosted server](#hosted-server).

## 2. Connect your client

### Claude Desktop: one-click install

1. Download `feedbay-<version>.mcpb` from the
   [latest release](https://github.com/sanke46/feedbay-mcp/releases/latest).
2. Open it. Claude Desktop shows the install dialog.
3. Paste your API key. Optionally pick a folder for exports.

### Claude Desktop: manual

Add the server to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "feedbay": {
      "command": "npx",
      "args": ["-y", "@feedbay/mcp-server"],
      "env": { "FEEDBAY_API_KEY": "fb_live_..." }
    }
  }
}
```

### Claude Code

```bash
claude mcp add feedbay -e FEEDBAY_API_KEY=fb_live_... -- npx -y @feedbay/mcp-server
```

Or use the hosted server, which asks you to sign in through the browser:

```bash
claude mcp add --transport http feedbay https://mcp.feedbay.io/mcp
```

### Cursor

In `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "feedbay": {
      "command": "npx",
      "args": ["-y", "@feedbay/mcp-server"],
      "env": { "FEEDBAY_API_KEY": "fb_live_..." }
    }
  }
}
```

To use the hosted server instead, replace the entry with
`{ "url": "https://mcp.feedbay.io/mcp" }`.

### VS Code

In `.vscode/mcp.json`:

```json
{
  "servers": {
    "feedbay": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@feedbay/mcp-server"],
      "env": { "FEEDBAY_API_KEY": "fb_live_..." }
    }
  }
}
```

### Codex CLI

In `~/.codex/config.toml`:

```toml
[mcp_servers.feedbay]
command = "npx"
args = ["-y", "@feedbay/mcp-server"]
env = { FEEDBAY_API_KEY = "fb_live_..." }
```

### Claude (web, desktop, mobile), ChatGPT and other remote-only clients

These clients connect to a URL and sign in with OAuth. Add a custom connector
with the URL `https://mcp.feedbay.io/mcp`, then sign in to FeedBay when asked.

- **Claude**: add the connector in *Settings → Connectors*. The mobile app picks
  it up from your account.
- **ChatGPT**: create the connector in developer mode, under *Settings → Apps &
  Connectors*.

Menu names change between versions. Look for "custom connector" or
"MCP server".

## Hosted server

`https://mcp.feedbay.io/mcp` speaks Streamable HTTP and accepts either of two
credentials:

- **OAuth 2.1.** Clients discover it from
  `/.well-known/oauth-protected-resource/mcp`, register themselves and send you
  to FeedBay to approve access, full or read-only. You can revoke the access
  any time under **Account → API keys → Connected apps**.
- **An API key** in the header `Authorization: Bearer fb_live_...`.

The hosted server keeps no credentials of its own. Every session acts as the
account that opened it.

## What it can do

The server also ships four prompts (`create_survey_from_brief`,
`restyle_survey`, `analyze_results`, `import_survey_from_document`) and
resources for the survey list, the question types, the templates, a single
survey and its results.

| Tool | What it does | Access |
|---|---|---|
| `feedbay_whoami` | Account and quota | read |
| `feedbay_question_types` | Question type catalogue | read |
| `feedbay_templates` | Survey templates | read |
| `feedbay_template_get` | Read one template | read |
| `survey_list` | List surveys | read |
| `survey_stats` | Survey counts | read |
| `survey_get` | Read a survey | read |
| `survey_create` | Create a survey | write |
| `survey_update` | Update survey settings | write |
| `survey_set_status` | Publish / unpublish / archive | write |
| `survey_duplicate` | Duplicate a survey | write |
| `survey_move` | Move to a folder | write |
| `survey_delete` | Delete a survey (recoverable) | write, confirm |
| `survey_delete_permanent` | Delete a survey forever | write, confirm |
| `question_list` | List questions | read |
| `question_add` | Add a question | write |
| `question_update` | Edit a question | write |
| `question_delete` | Delete a question | write, confirm |
| `question_reorder` | Reorder questions | write |
| `questions_replace` | Replace all questions | write, confirm |
| `brand_read_site` | Read a brand's colours, fonts and logo from its website | read |
| `design_get` | Read the styling | read |
| `design_update` | Update the styling | write |
| `design_apply_preset` | Switch theme or apply a brand colour | write |
| `design_match_brand` | Build light and dark themes from brand colours | write |
| `design_upload_image` | Upload a logo or background | write |
| `survey_share_info` | Links and embed code | read |
| `survey_install_snippet` | Website install code | read |
| `survey_widget_config` | What the widget receives | read |
| `survey_qr_code` | QR code image | read |
| `targeting_update` | When the widget appears | write |
| `folder_list` | List folders | read |
| `folder_create` | Create a folder | write |
| `folder_update` | Update a folder | write |
| `folder_set_status` | Archive / unarchive a folder | write |
| `folder_delete_permanent` | Delete a folder forever | write, confirm |
| `response_list` | List responses | read |
| `response_get` | Read one response | read |
| `response_delete` | Delete a response | write, confirm |
| `results_overview` | Results summary | read |
| `results_breakdown` | Cross-sections of the responses | read |
| `responses_export` | Export responses as CSV or Excel | read |

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `FEEDBAY_API_KEY` | none | Your `fb_live_...` key. Required for stdio. |
| `FEEDBAY_API_URL` | `https://feedbay.io` | API origin, without `/api/v1`. |
| `FEEDBAY_MCP_READONLY` | off | `1` registers only the read tools. A read-only key does this on its own. |
| `FEEDBAY_MCP_DOWNLOAD_DIR` | current directory | Where `responses_export` writes files. |
| `FEEDBAY_MCP_TIMEOUT_MS` | `30000` | Timeout for one API call. |
| `FEEDBAY_MCP_PORT` | `3333` | Port of the HTTP transport (`feedbay-mcp-http`). |
| `FEEDBAY_MCP_PUBLIC_URL` | none | Public URL of the HTTP transport. With the secret below, enables OAuth. |
| `FEEDBAY_MCP_INTERNAL_SECRET` | none | Secret shared with the FeedBay backend for OAuth state. |
| `FEEDBAY_APP_URL` | `https://feedbay.io` | Where people approve a connection (`/connect/authorize`). |

Behind a corporate proxy, set `NO_PROXY` for the API host if requests to it
fail.

## Development

```bash
npm install
npm run build
npm test
npm run dev                   # stdio against FEEDBAY_API_URL
npm run dev:http              # Streamable HTTP on :3333
npm run pack:mcpb             # Claude Desktop bundle into out/
```

This repository is a published mirror. The source of truth lives in FeedBay's
main repository, and every release is synced here. Issues are welcome here.
Pull requests are welcome too: we apply them upstream and they come back with
the next release. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)
