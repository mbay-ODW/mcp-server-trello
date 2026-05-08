# Self-hosted Deployment (Docker + Traefik + Authelia)

Run `mcp-server-trello` as a long-running service behind Traefik with
Authelia handling OIDC, so [Claude.ai](https://claude.ai) can connect
via the standard MCP OAuth flow. Same setup as the sibling repos
(`hero-mcp`, `mail-mcp`, `paperless-mcp`, `portainer-mcp`,
`whatsapp-mcp`).

## Image

GitHub Actions build & push on every commit to `main`:
```
ghcr.io/mbay-odw/mcp-server-trello:latest
```

## docker-compose

[`docker-compose.yml`](../docker-compose.yml) – drop into a Portainer
stack and set the env vars below.

## Required env

| Variable | Required | Description |
|---|---|---|
| `DOMAIN` | yes (compose) | Public domain – host becomes `trello-mcp.${DOMAIN}` |
| `TRELLO_API_KEY` | yes | Trello API key (from https://trello.com/app-key) |
| `TRELLO_TOKEN` | yes | Trello user token |
| `TRELLO_BOARD_ID` | no | Default board id used by tools that don't take one |
| `MCP_TRANSPORT` | no | `http` (compose default). `stdio` for local CLI use |
| `PORT` | no | TCP port (default `3000`) |
| `MCP_API_KEY` | no | Static fallback Bearer token |
| `OIDC_INTROSPECTION_URL` | yes for OAuth | e.g. `http://authelia:9091/api/oidc/introspection` |
| `OIDC_CLIENT_ID` | yes for OAuth | Client id registered in Authelia (default `trello-mcp`) |
| `OIDC_CLIENT_SECRET` | yes for OAuth | **Plaintext** (Authelia stores its bcrypt hash) |
| `OAUTH_ISSUER` | optional | Public Authelia URL – enables in-process discovery endpoints |
| `MCP_SERVER_URL` | optional | Public URL of this server – needed for RFC 9728 discovery |
| `LOG_LEVEL` | no | `error \| warn \| info` (default) `\| debug \| trace` |

If neither `MCP_API_KEY` nor a complete OIDC triple is configured, the
server falls open and accepts every request – fine for local dev, **do
not run that mode in production**.

## Authelia client

Add to `identity_providers.oidc.clients` in your Authelia
`configuration.yml`:

```yaml
- client_id: trello-mcp
  client_name: Claude Trello MCP
  authorization_policy: one_factor
  client_secret: $2b$12$REPLACE_ME_BCRYPT_HASH
  redirect_uris:
    - https://claude.ai/api/mcp/auth_callback
  scopes: [openid, profile, email, offline_access, address, phone, groups]
  grant_types: [authorization_code, refresh_token]
  response_types: [code]
  token_endpoint_auth_method: client_secret_post
  introspection_endpoint_auth_method: client_secret_basic
  consent_mode: pre-configured
  pre_configured_consent_duration: 1y
```

Bcrypt hash:
```bash
docker run --rm authelia/authelia:latest \
  authelia crypto hash generate bcrypt --password 'your-plaintext-secret'
```
Plaintext goes into `OIDC_CLIENT_SECRET`, hash into `client_secret` in
the yaml.

For long-lived sessions, also set in your Authelia config:
```yaml
identity_providers:
  oidc:
    lifespans:
      access_token: 1h
      authorize_code: 1m
      id_token: 1h
      refresh_token: 90d
```
(default refresh_token is 90 minutes – way too short for daily MCP
usage). See [docs/authelia-config.md](authelia-config.md) for the
full reasoning.

## Traefik wiring

### Container labels (`docker-compose.yml`)

The included compose file uses a single `Host(...)` router – every
path under `trello-mcp.${DOMAIN}` reaches this container.

### Optional: file-provider OAuth mirror

If you want Claude.ai to fetch the OAuth discovery / authorize /
consent / static endpoints under the SAME host as the MCP server (RFC
9728 same-origin convention), drop
[`traefik/trello-mcp-oauth.yml`](../traefik/trello-mcp-oauth.yml) into
your Traefik file-provider directory and update the `Host(...)`
rules. The file mirrors the matching paths to Authelia.

> **Heads up:** if you already define `authelia-oidc` in another
> file-provider yaml (e.g. for hero-mcp), drop the `services:` block
> from one of them, or Traefik will log "service already defined".

If you go this route you can leave `OAUTH_ISSUER` / `MCP_SERVER_URL`
unset on the container – the in-process discovery routes only kick in
when both env vars are present.

## Claude.ai connector

1. Settings → Connectors → Add custom connector
2. URL: `https://trello-mcp.${DOMAIN}/sse` (or `/mcp` – both work)
3. Submit. Claude.ai redirects to Authelia for login, exchanges the
   code for a Bearer token, then connects to the MCP endpoint with
   that token.

## Debugging

Set `LOG_LEVEL=debug` to log every incoming request, the auth decision
path (introspection HTTP status, `sub`/`scope` on success, explicit
DENY reason on failure), session lifecycle, and a 404-catch-all that
fires when Claude.ai hits an unexpected path.

```bash
docker logs -f trello-mcp
```

## Available tools

All upstream Trello tools are exposed:
- `get_cards_by_list_id`, `get_lists`, `get_my_cards`
- `add_card_to_list`, `update_card_details`, `add_comment`,
  `move_card`, `archive_card`
- `attach_image_to_card`, `attach_file_to_card`
- `add_list_to_board`, `archive_list`
- `get_recent_activity`
- Plus the 5 health endpoints (`get_health*`, `perform_system_repair`).

See the upstream README for the full tool reference.
