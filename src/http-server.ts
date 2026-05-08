/**
 * HTTP transport layer for the Trello MCP server.
 *
 * Mirrors the layout of the sibling Python/TS MCP servers in this stack
 * (paperless-mcp, hero-mcp, mail-mcp, portainer-mcp, whatsapp-mcp) so a
 * single Authelia OIDC client + Traefik routing convention covers all of
 * them. Specifically it provides:
 *
 *   - Stateful Streamable-HTTP transport on POST /mcp and POST /sse
 *     (modern Claude.ai default). Sessions are tracked in a per-process
 *     map keyed by `mcp-session-id`; the SDK assigns the id on the
 *     `initialize` request.
 *   - Classic SSE transport on GET /sse + POST /messages (Claude Desktop,
 *     older clients).
 *   - Optional Bearer auth: static MCP_API_KEY *or* OIDC token
 *     introspection against Authelia (RFC 7662). 401 responses to
 *     already-presented invalid tokens carry an RFC 6750
 *     `WWW-Authenticate: Bearer error="invalid_token"` challenge so the
 *     OAuth client runs the silent refresh-token flow instead of forcing
 *     a full reconnect.
 *
 * To enable, run with env var `MCP_TRANSPORT=http` (or pass `--http`).
 */

import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import express, { type Request, type Response, type NextFunction, type RequestHandler } from 'express';
import { randomUUID } from 'node:crypto';
import type { TrelloServer } from './index.js';

// ---------------------------------------------------------------------------
// Logging – LOG_LEVEL=debug|info|warn|error (default info).
// ---------------------------------------------------------------------------

const LOG_LEVELS = ['error', 'warn', 'info', 'debug', 'trace'] as const;
type LogLevel = (typeof LOG_LEVELS)[number];

const requestedLevel = (process.env.LOG_LEVEL ?? 'info').toLowerCase() as LogLevel;
const activeLevelIdx = Math.max(
  0,
  LOG_LEVELS.indexOf(LOG_LEVELS.includes(requestedLevel) ? requestedLevel : 'info')
);

function lvlEnabled(l: LogLevel): boolean {
  return LOG_LEVELS.indexOf(l) <= activeLevelIdx;
}

const ts = (): string => new Date().toISOString();
const log = {
  error: (...a: unknown[]) => lvlEnabled('error') && console.error(`[${ts()}] ERROR`, ...a),
  warn: (...a: unknown[]) => lvlEnabled('warn') && console.warn(`[${ts()}] WARN `, ...a),
  info: (...a: unknown[]) => lvlEnabled('info') && console.log(`[${ts()}] INFO `, ...a),
  debug: (...a: unknown[]) => lvlEnabled('debug') && console.log(`[${ts()}] DEBUG`, ...a),
  trace: (...a: unknown[]) => lvlEnabled('trace') && console.log(`[${ts()}] TRACE`, ...a),
};

// ---------------------------------------------------------------------------
// Auth: static MCP_API_KEY OR Authelia OIDC introspection
// ---------------------------------------------------------------------------

type AuthResult = { ok: true } | { ok: false; reason: 'no_header' | 'invalid_token' };

function buildAuthMiddleware(): RequestHandler {
  const mcpApiKey = process.env.MCP_API_KEY ?? '';
  const oidcIntrospectionUrl = process.env.OIDC_INTROSPECTION_URL ?? '';
  const oidcClientId = process.env.OIDC_CLIENT_ID ?? '';
  const oidcClientSecret = process.env.OIDC_CLIENT_SECRET ?? '';

  log.info(
    `[auth] config: MCP_API_KEY=${mcpApiKey ? `set(${mcpApiKey.length} chars)` : 'NOT SET'} ` +
      `OIDC_INTROSPECTION_URL=${oidcIntrospectionUrl || 'NOT SET'} ` +
      `OIDC_CLIENT_ID=${oidcClientId || 'NOT SET'} ` +
      `OIDC_CLIENT_SECRET=${oidcClientSecret ? `set(${oidcClientSecret.length} chars)` : 'NOT SET'}`
  );

  if (!mcpApiKey && (!oidcIntrospectionUrl || !oidcClientId || !oidcClientSecret)) {
    log.warn(
      '[auth] NEITHER static MCP_API_KEY NOR a complete OIDC triple is configured – ALL requests will be accepted unauthenticated (dev mode).'
    );
  }

  async function isAuthorized(req: Request): Promise<AuthResult> {
    const tag = `${req.method} ${req.path}`;

    // No auth configured at all → fall through (local dev / behind another auth layer).
    if (!mcpApiKey && (!oidcIntrospectionUrl || !oidcClientId || !oidcClientSecret)) {
      return { ok: true };
    }

    const auth = (req.headers.authorization ?? '') as string;
    const preview = auth ? auth.slice(0, 20) + (auth.length > 20 ? '…' : '') : '(none)';
    log.debug(`[auth] ${tag} – Authorization: ${preview}`);

    if (!auth) {
      log.warn(`[auth] ${tag} – DENY: no Authorization header`);
      return { ok: false, reason: 'no_header' };
    }

    if (mcpApiKey && auth === `Bearer ${mcpApiKey}`) {
      log.info(`[auth] ${tag} – OK: static MCP_API_KEY matched`);
      return { ok: true };
    }

    if (!auth.startsWith('Bearer ')) {
      log.warn(`[auth] ${tag} – DENY: Authorization is not a Bearer scheme`);
      return { ok: false, reason: 'invalid_token' };
    }

    if (!oidcIntrospectionUrl || !oidcClientId || !oidcClientSecret) {
      log.warn(
        `[auth] ${tag} – DENY: Bearer JWT presented but OIDC introspection not fully configured`
      );
      return { ok: false, reason: 'invalid_token' };
    }

    const jwtToken = auth.slice(7);
    log.debug(
      `[auth] ${tag} – introspecting token (len=${jwtToken.length}) against ${oidcIntrospectionUrl}`
    );
    const startedAt = Date.now();
    try {
      const credentials = Buffer.from(`${oidcClientId}:${oidcClientSecret}`).toString('base64');
      const resp = await fetch(oidcIntrospectionUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Authorization: `Basic ${credentials}`,
        },
        body: `token=${encodeURIComponent(jwtToken)}`,
        signal: AbortSignal.timeout(5000),
      });
      const elapsed = Date.now() - startedAt;
      const body = await resp.text();
      log.debug(
        `[auth] ${tag} – introspection HTTP ${resp.status} in ${elapsed}ms, body: ${body.slice(0, 200)}`
      );
      if (resp.status !== 200) {
        log.warn(`[auth] ${tag} – DENY: introspection returned non-200 (${resp.status})`);
        return { ok: false, reason: 'invalid_token' };
      }
      const data = JSON.parse(body) as {
        active?: boolean;
        sub?: string;
        scope?: string;
      };
      if (data.active === true) {
        log.info(
          `[auth] ${tag} – OK: OIDC token active sub=${data.sub ?? '?'} scope=${data.scope ?? '?'}`
        );
        return { ok: true };
      }
      log.warn(`[auth] ${tag} – DENY: OIDC token not active`);
      return { ok: false, reason: 'invalid_token' };
    } catch (e) {
      log.error(`[auth] ${tag} – introspection exception:`, e);
      return { ok: false, reason: 'invalid_token' };
    }
  }

  /**
   * RFC 6750: when a token *was* presented but rejected, include
   * `WWW-Authenticate: Bearer error="invalid_token"` so the OAuth client
   * runs the silent refresh-token flow. When NO token was presented yet,
   * deliberately omit the header – sending `Bearer realm="…"` would
   * short-circuit Claude.ai's OAuth discovery, which expects a naked
   * 401 to fall through to /.well-known lookup.
   */
  function sendUnauthorized(res: Response, reason: 'no_header' | 'invalid_token'): void {
    if (reason === 'invalid_token') {
      res.set(
        'WWW-Authenticate',
        'Bearer realm="trello-mcp", error="invalid_token", error_description="The access token expired or is invalid"'
      );
    }
    res.status(401).json({ error: 'Unauthorized' });
  }

  return async (req, res, next) => {
    const result = await isAuthorized(req);
    if (result.ok) return next();
    sendUnauthorized(res, result.reason);
  };
}

// ---------------------------------------------------------------------------
// Public OAuth discovery endpoints (RFC 9728 + RFC 8414).
// Optional – only registered when OAUTH_ISSUER (and MCP_SERVER_URL) are set.
// They are mounted BEFORE the auth middleware so the OAuth client can
// reach them without a token.
// ---------------------------------------------------------------------------

function registerDiscoveryRoutes(app: express.Express): void {
  const oauthIssuer = process.env.OAUTH_ISSUER ?? '';
  const mcpServerUrl = process.env.MCP_SERVER_URL ?? '';

  log.info(
    `[discovery] OAUTH_ISSUER=${oauthIssuer || 'NOT SET'} MCP_SERVER_URL=${mcpServerUrl || 'NOT SET'}`
  );

  if (oauthIssuer && mcpServerUrl) {
    app.get('/.well-known/oauth-protected-resource', (_req, res) => {
      log.info('[discovery] /.well-known/oauth-protected-resource hit');
      res.json({
        resource: mcpServerUrl,
        authorization_servers: [oauthIssuer],
        bearer_methods_supported: ['header'],
        scopes_supported: ['openid', 'profile', 'email'],
      });
    });
  }
  if (oauthIssuer) {
    app.get('/.well-known/oauth-authorization-server', (_req, res) => {
      log.info('[discovery] /.well-known/oauth-authorization-server hit');
      res.json({
        issuer: oauthIssuer,
        authorization_endpoint: `${oauthIssuer}/api/oidc/authorization`,
        token_endpoint: `${oauthIssuer}/api/oidc/token`,
        jwks_uri: `${oauthIssuer}/jwks.json`,
        introspection_endpoint: `${oauthIssuer}/api/oidc/introspection`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'],
        scopes_supported: ['openid', 'profile', 'email'],
      });
    });
  }
}

// ---------------------------------------------------------------------------
// Run – wires everything together.
// ---------------------------------------------------------------------------

export async function runHttp(trelloServer: TrelloServer): Promise<void> {
  const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 8000;
  const mcpServer = trelloServer.mcpServer;

  // Warm Trello config / metadata cache before we accept requests, identical
  // to the stdio entry point's behaviour.
  await trelloServer.loadTrelloConfig();

  const app = express();
  app.use(express.json({ limit: '10mb' }));

  // Generic incoming-request log (sees EVERY request, even routing 4xx).
  app.use((req, _res, next) => {
    const auth = (req.headers.authorization ?? '') as string;
    const preview = auth ? auth.slice(0, 20) + (auth.length > 20 ? '…' : '') : '(none)';
    log.debug(`→ ${req.method} ${req.originalUrl}  auth=${preview}  ip=${req.ip}`);
    next();
  });

  // Public (unauthenticated) discovery first.
  registerDiscoveryRoutes(app);

  const authMiddleware = buildAuthMiddleware();

  // ------------------------------------------------------------------------
  // Streamable-HTTP transport (current MCP spec) – STATEFUL.
  // Mounted on /mcp and /sse (POST) so the connector URL can end with
  // either; modern Claude.ai always uses Streamable-HTTP semantics.
  // ------------------------------------------------------------------------

  const streamableTransports: Record<string, StreamableHTTPServerTransport> = {};

  const streamableHandler: RequestHandler = async (req, res) => {
    const tag = `[stream POST ${req.path}]`;
    const incomingSessionId = (req.headers['mcp-session-id'] as string | undefined) ?? undefined;
    log.debug(
      `${tag} session=${incomingSessionId ?? '(new)'} body keys=${Object.keys(req.body ?? {}).join(',')}`
    );
    log.trace(`${tag} body: ${JSON.stringify(req.body).slice(0, 500)}`);

    try {
      let transport: StreamableHTTPServerTransport;

      if (incomingSessionId && streamableTransports[incomingSessionId]) {
        transport = streamableTransports[incomingSessionId];
      } else if (!incomingSessionId && isInitializeRequest(req.body)) {
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (sid: string) => {
            log.info(`${tag} session initialized: ${sid}`);
            streamableTransports[sid] = transport;
          },
        });
        transport.onclose = () => {
          if (transport.sessionId) {
            const remaining = Object.keys(streamableTransports).length - 1;
            log.info(
              `${tag} session closed: ${transport.sessionId} (remaining: ${remaining})`
            );
            delete streamableTransports[transport.sessionId];
          }
        };
        await mcpServer.connect(transport);
      } else {
        log.warn(`${tag} bad request – no session id and not an initialize call`);
        res.status(400).json({
          jsonrpc: '2.0',
          error: {
            code: -32000,
            message: 'Bad Request: no valid session id and not an initialize call',
          },
          id: null,
        });
        return;
      }

      await transport.handleRequest(req, res, req.body);
      log.debug(`${tag} handled, response status=${res.statusCode}`);
    } catch (error) {
      log.error(`${tag} handler error:`, error);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Internal server error' },
          id: null,
        });
      }
    }
  };

  // GET / DELETE on /mcp also belong to Streamable-HTTP (server→client SSE
  // stream / client-side session termination). They look up the transport
  // by mcp-session-id header.
  const streamableSessionLookupHandler: RequestHandler = async (req, res) => {
    const sid = req.headers['mcp-session-id'] as string | undefined;
    if (!sid || !streamableTransports[sid]) {
      res.status(400).json({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Invalid or missing session id' },
        id: null,
      });
      return;
    }
    await streamableTransports[sid].handleRequest(req, res);
  };

  app.post('/mcp', authMiddleware, streamableHandler);
  app.post('/sse', authMiddleware, streamableHandler);
  app.get('/mcp', authMiddleware, streamableSessionLookupHandler);
  app.delete('/mcp', authMiddleware, streamableSessionLookupHandler);

  // ------------------------------------------------------------------------
  // Classic SSE transport (Claude Desktop, older Claude.ai clients).
  // ------------------------------------------------------------------------

  const sseTransports: Record<string, SSEServerTransport> = {};

  app.get('/sse', authMiddleware, async (_req, res) => {
    log.info('[/sse GET] new SSE connection');
    try {
      const transport = new SSEServerTransport('/messages', res);
      sseTransports[transport.sessionId] = transport;
      log.info(
        `[/sse GET] sessionId=${transport.sessionId} – transport registered (active sessions: ${Object.keys(sseTransports).length})`
      );
      res.on('close', () => {
        const remaining = Object.keys(sseTransports).length - 1;
        log.info(`[/sse GET] sessionId=${transport.sessionId} – connection closed (remaining: ${remaining})`);
        delete sseTransports[transport.sessionId];
        transport.close();
      });
      await mcpServer.connect(transport);
    } catch (error) {
      log.error('[/sse GET] error:', error);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Internal server error' },
          id: null,
        });
      }
    }
  });

  app.post('/messages', authMiddleware, async (req, res) => {
    const sessionId = req.query.sessionId as string;
    log.debug(`[/messages POST] sessionId=${sessionId}`);
    const transport = sseTransports[sessionId];
    if (!transport) {
      log.warn(`[/messages POST] sessionId=${sessionId} – no transport found`);
      res.status(400).send('No transport found for sessionId');
      return;
    }
    try {
      await transport.handlePostMessage(req, res, req.body);
    } catch (error) {
      log.error(`[/messages POST] sessionId=${sessionId} – error:`, error);
      if (!res.headersSent) res.status(500).send('Internal server error');
    }
  });

  // Catch-all 404 with logging – useful when Claude.ai hits an unexpected path.
  app.use((req: Request, res: Response, _next: NextFunction) => {
    log.warn(
      `[404] ${req.method} ${req.originalUrl} – no route matched. Headers: ${JSON.stringify(req.headers).slice(0, 300)}`
    );
    res.status(404).json({ error: 'Not found', path: req.originalUrl });
  });

  app.listen(port, () => {
    log.info(
      `mcp-server-trello listening on :${port} (LOG_LEVEL=${LOG_LEVELS[activeLevelIdx]}, routes: /mcp /sse /messages /.well-known/*)`
    );
  });
}
