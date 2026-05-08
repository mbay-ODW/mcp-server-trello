# Local Development

A `docker-compose.local.yml` is included in this repo for running the
server on a developer laptop without Traefik, Authelia or TLS. The
container binds to `127.0.0.1` so it is **never** reachable from the
network – auth is intentionally disabled to keep the workflow simple.

## Quick start

```bash
cp example.env .env
$EDITOR .env       # set TRELLO_API_KEY + TRELLO_TOKEN

docker compose -f docker-compose.local.yml up
docker compose -f docker-compose.local.yml logs -f
```

The server listens at `http://localhost:8006/sse` (and `/mcp`).

## Ports across the MCP stack

The sibling repos all reserve their own port for parallel local
development:

| Repo | URL |
|------|-----|
| `hero-mcp-server`  | http://localhost:8001/sse |
| `mail-mcp`         | http://localhost:8002/sse |
| `paperless-mcp`    | http://localhost:8003/sse |
| `portainer-mcp`    | http://localhost:8004/sse |
| `whatsapp-mcp`     | http://localhost:8005/sse |
| `mcp-server-trello`| http://localhost:8006/sse |

## Connecting from Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json`:

```jsonc
{
  "mcpServers": {
    "trello-local": { "url": "http://localhost:8006/sse" }
  }
}
```

Restart Claude Desktop.

## Connecting from MCP Inspector

```bash
npx @modelcontextprotocol/inspector
```
Set `Transport` to `SSE`, URL to `http://localhost:8006/sse`.

## How auth is disabled

The server passes every request through when **all** of these env vars
are unset / empty:

- `MCP_API_KEY`
- `OIDC_INTROSPECTION_URL`
- `OIDC_CLIENT_ID`
- `OIDC_CLIENT_SECRET`

The `docker-compose.local.yml` deliberately does not set them. The
`127.0.0.1:PORT:CONTAINERPORT` binding is the safety belt.
