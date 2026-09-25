# MCP Integration

## Read-only message export

The local stdio MCP server provides `wechat.export_messages` for downstream projects that need the same versioned message contract as the CLI export.

Example input:

```json
{
  "contact": "wxid_example",
  "limit": 100,
  "from": "YYYY-MM-DD",
  "to": "YYYY-MM-DD"
}
```

The tool returns a JSON string with `schema: "weflow-message/v1"` and `coverage` metadata for the requested range, returned count, conservative `mayHaveMore` status, and returned time bounds. `limit` defaults to 100 and is capped at 1000. `from` and `to` are inclusive local dates. Use a session ID when a display name is ambiguous.

This tool is read-only. It does not expose database paths, keys, configuration, or unrestricted filesystem access, and it does not invoke AI. Unknown WeChat message codes remain in the output with their original `localType` and `messageType: "other"`.

WeFlow CLI exposes article, knowledge-base, and selected local-data functions through an MCP server over stdio. The server reads the project's local `output/` directory and only contacts external services when a requested tool requires it. The available inventory follows `mcp-server/index.ts`; do not hard-code a tool count in client documentation.

External article fetching accepts only credential-free HTTPS URLs on the exact `mp.weixin.qq.com` host. Redirects must remain on that host and all network reads have finite timeout, redirect, result-count, and response-size limits.

## Configure a client

From the project root, generate the baseline configuration:

```powershell
weflow-cli mcp-config --output .mcp.json --dry-run --json-result
weflow-cli mcp-config --output .mcp.json --yes
```

Without `--output`, `weflow-cli mcp-config` remains a read-only command that prints the configuration to stdout.

The generated server starts with Node.js and `tsx`:

```json
{
  "mcpServers": {
    "weflow": {
      "command": "npx",
      "args": ["tsx", "mcp-server/index.ts"],
      "cwd": "${workspaceFolder}"
    }
  }
}
```

Copy this entry into your MCP client's configuration and ensure `cwd` points to the cloned WeFlow CLI directory. Restart the client after saving the configuration.

## Available tools

| Tool | Purpose | Local data required |
| --- | --- | --- |
| `wechat.search_articles` | Search captured official-account articles. | `output/biz-daily/` |
| `wechat.get_daily` | Read a daily article collection. | `output/biz-daily/` |
| `wechat.get_review` | Read an AI learning review. | `output/reviews/Daily/` |
| `wechat.get_stats` | Show article, knowledge-base, and local WeChat data statistics. | Generated output |
| `wechat.get_concepts` | List compiled concepts. | Vault Wiki output |
| `wechat.get_concept` | Read one compiled concept. | Vault Wiki output |
| `wechat.format_article` | Convert Markdown to WeChat-ready HTML. | None |
| `wechat.list_themes` | List available article themes. | None |
| `wechat.fetch_article` | Fetch and convert a public WeChat article. | Network access |
| `wechat.search_public` | Search public WeChat articles. | Network access |
| `wechat.list_sessions` | List recent chat sessions with last-message snippets. | Decrypted WeChat database |
| `wechat.get_messages` | Read recent messages with one contact. | Decrypted WeChat database |
| `wechat.search_favorites` | Search WeChat favorites (official-account articles, notes, links). | Decrypted WeChat database |
| `wechat.read_favorite` | Fetch and read the body of a favorited article. | Decrypted WeChat database, network access |
| `wechat.get_daily_report` | Filter daily reports by topic/keyword with AI summaries. | `output/biz-daily/` |
| `wechat.get_sns` | Read the Moments timeline or statistics. | Decrypted WeChat database |
| `wechat.get_weread` | Read WeRead shelf, notebooks, or search books. | `wereadApiKey` config |
| `wechat.get_todos` | List todos extracted from chat history. | `scripts/extract_todos.py`, Python |
| `wechat.search_knowledge` | Fuzzy-search concept pages in the knowledge base. | Vault Wiki output |
| `wechat.search_memory` | Search long-term assistant memory. | `~/.weflow-cli/assistant_memory.json` |
| `wechat.search_chats` | Find which conversation discussed something (literal words). | Decrypted WeChat database, **words leave the machine - `confirm: true` required** |
| `wechat.search_semantic` | Find chat messages by meaning, not literal words. | `dashscopeApiKey` config, network - **query and hits leave the machine, `confirm: true` required** |
| `wechat.who_owes_reply` | Rank the conversations waiting on a reply. | Decrypted WeChat database, **text leaves the machine - `confirm: true` required** |
| `wechat.draft_reply` | Draft candidate replies. | Decrypted WeChat database, **text leaves the machine - `confirm: true` required** |
| `wechat.export_chat` | Export one conversation to HTML, txt, json or excel. | Decrypted WeChat database, **writes under `output/exports/`** |
| `wechat.export_messages` | Return a conversation's local messages as `weflow-message/v1` JSON. Read-only; returns no database path, key or configuration. | Decrypted WeChat database |
| `wechat.get_reading_stats` | Which sources push most and what the daily processes. | `output/biz-daily/` |

This table lists the tools shipped today; `weflow-cli mcp-config` prints the authoritative list for the
installed version. **`wechat.look_at_image` is deliberately not on it**: that tool works by handing the image to
the assistant's own model through a side channel, and MCP returns only the tool's *text* - the image would go
nowhere while the reply still said "you can see it now". A tool that cannot do its job on a transport is not
offered on it (the same rule `unavailableToolReason` applies elsewhere). The chat-data tools share service code with the optional `weflow-cli assistant` WeChat bot, but access is still controlled by the MCP client's permissions and local configuration. The bot and MCP transport are not interchangeable message channels.

## Safety boundary

- The server inherits the permissions of the MCP client. Only add it to a client you trust.
- Article and knowledge-base tools read files under the current project directory. Keep `cwd` scoped to your intended WeFlow CLI checkout.
- Chat-data tools (`list_sessions`, `get_messages`, `search_favorites`, `get_sns`, `get_todos`) read your locally decrypted WeChat database. Only run this MCP server on machines where that is acceptable, and never expose the stdio server over a network.
- `read_favorite`, `fetch_article`, and `search_public` make network requests; `read_favorite` rejects private/loopback URLs.
- The MCP surface is **derived from the assistant's tool table minus `save_memory`**, not a hand-written read-only list - so it is *not* read-only, and this line used to claim it was. What it actually contains, declared in `capabilities --json` under `safety.mcpSurface`: one tool that writes (`export_chat`, new directories under `output/exports/` only) and four that send user data to cloud models (`who_owes_reply` and `search_chats` send chat text to the decision model, `search_semantic` sends the query for embedding and the hits for reranking, `draft_reply` sends a conversation to two models - and **all four** require `confirm: true`, not just `draft_reply`; that is what `safety.mcpSurface.requiresConfirm` lists, and it is now checked against the source rather than restated). Publishing, sending messages, mutating todos, changing configuration and writing assistant memory stay out.
- **Four tools on this surface send user data to cloud models, and each of them requires an explicit
  confirmation from the machine caller.** They are `who_owes_reply` (every conversation's text, one request
  each), `search_chats` (your question plus words extracted from the chats - not the message bodies),
  `search_semantic` (the query for embedding, then the hits for reranking) and `draft_reply` (a whole
  conversation). An MCP call that does not pass `confirm: true` returns a **preview only** - what would be
  sent and to whom, with character counts where the script can produce them cheaply - and nothing leaves the
  machine. `capabilities --json` lists them under `safety.mcpSurface.requiresConfirm`, and the tool
  descriptions say so, because a calling model that does not know cannot ask its user. The CLI keeps its own
  equivalent boundary for the same work (`--dry-run` / `--yes`), and none of these tools ever sends a message.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Server fails to start | Run `npm install` in the configured `cwd`, then run `npx tsx mcp-server/index.ts`. |
| No articles found | Generate a daily collection first, then confirm `output/biz-daily/` exists under `cwd`. |
| Client cannot find `npx` | Configure an absolute Node.js command path or install Node.js 22.13+. |
