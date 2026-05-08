# Authelia OIDC Configuration

Two settings in your Authelia `configuration.yml` make Claude.ai
connectors **dramatically** more pleasant: long-lived refresh tokens
(so you don't have to reconnect every 90 minutes) and pre-configured
consent (so you don't get asked to approve scopes on every reconnect).

## 1. Token lifespans

Authelia's defaults are too short for MCP usage – the default
`refresh_token` is only **90 minutes**, after which a full
re-authentication is required. Set explicit lifespans:

```yaml
identity_providers:
  oidc:
    # …hmac_secret, jwks, etc. unchanged…
    lifespans:
      access_token: 1h
      authorize_code: 1m
      id_token: 1h
      refresh_token: 90d        # default is 90m – way too short for MCP
```

If you want even longer-lived sessions for some clients (and shorter
for others), use named profiles:

```yaml
identity_providers:
  oidc:
    lifespans:
      access_token: 1h
      refresh_token: 90d
      custom:
        long_lived_mcp:
          access_token: 1h
          refresh_token: 365d
    clients:
      - client_id: trello-mcp
        lifespan: long_lived_mcp     # apply the profile to this client
        # …rest of client config…
```

## 2. Pre-configured consent

By default Authelia shows a consent page on every OAuth login. For an
MCP server you've already trusted, that gets old fast. Add
`consent_mode` and a long `pre_configured_consent_duration` to each
MCP client:

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
  consent_mode: pre-configured                  # ← skip consent on subsequent logins
  pre_configured_consent_duration: 1y           # ← cache the consent for 1 year
```

`scopes: [..., offline_access]` is also crucial – without
`offline_access` Authelia will not issue a refresh token at all, no
matter how long `lifespans.refresh_token` is.

## After changing the config

1. `docker compose restart authelia`
2. **Disconnect + reconnect each MCP connector in Claude.ai** so a new
   long-lived refresh token is issued (existing sessions keep their
   old short-lived tokens).
3. Verify in the Authelia logs:
   ```
   docker logs authelia --tail 200 | grep -iE "client|consent"
   ```

## How this works with this server

This server emits an RFC 6750 `WWW-Authenticate: Bearer
error="invalid_token"` header on 401 responses **only when a token was
presented and rejected** (expired or invalid). That signals to
Claude.ai's OAuth client to run the silent **refresh-token flow**
instead of falling back to a full reconnect.

When no token is presented at all (initial connect), the 401 is
intentionally returned **without** a WWW-Authenticate header so
Claude.ai's default OAuth discovery flow can kick in. Sending a
`Bearer realm="…"` challenge there would make the client treat the
resource as plain Basic-Bearer and the discovery flow would never
run.

The combination of long refresh tokens + the standards-compliant 401
challenge means a connector can stay live for months without manual
intervention.
