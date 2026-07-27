# LTI tool (thin)

A minimal **LTI 1.3 / LTI Advantage** tool built on [ltijs](https://cvmcosta.me/ltijs/). It surfaces the homework tutor (students) and the professor portal (instructors) inside Canvas & Blackboard from one codebase. See [../docs/lti-integration.md](../docs/lti-integration.md) for the full design.

This is **phase 1**: OIDC login + launch validation + role routing. Tutor chat and the portal UI are stubbed (marked with `TODO`).

## Endpoints (register these with the LMS)

| Purpose | Path |
| --- | --- |
| OIDC login initiation | `https://<host>/login` |
| Launch / target link URI | `https://<host>/lti/launch` |
| Public JWKS | `https://<host>/keys` |
| Dynamic Registration | `https://<host>/register` |
| Liveness | `https://<host>/healthz` |

## Required env

| Var | Purpose |
| --- | --- |
| `LTI_KEY` | ltijs encryption key (cookies/state) |
| `MONGO_URL` | ltijs datastore. In Azure this points at an internal-only `mongo` Container App (private in-environment TCP, key auth). Locally, any MongoDB. |
| `PORT` | listen port (default `3000`) |
| `FRAME_ANCESTORS` | CSP `frame-ancestors` for the LMS domains |
| `TOOL_URL` | public base URL of this tool; enables LTI Dynamic Registration at `/register` |
| `TOOL_NAME` | tool name advertised during Dynamic Registration |
| `HOMEWORK_AGENT_URL` | tutor agent base URL (chat proxy, phase 3) |

## Optional — pre-register one platform

Set all of `PLATFORM_URL`, `PLATFORM_CLIENT_ID`, `PLATFORM_AUTH_ENDPOINT`, `PLATFORM_TOKEN_ENDPOINT`, `PLATFORM_KEYSET_ENDPOINT` (and optionally `PLATFORM_NAME`) to register a platform on boot. Otherwise use LTI Dynamic Registration: set `TOOL_URL` and have the LMS admin paste `https://<host>/register`.

## Run locally

```bash
npm install
LTI_KEY=dev-key MONGO_URL="mongodb://localhost:27017/ltijs" npm start
```

Deployed as the `lti-tool` service (Azure Container Apps) via `azd up`. Its MongoDB store runs as a separate internal-only `mongo` Container App on the same environment (managed Cosmos DB for MongoDB is blocked by tenant governance policy). Mongo storage is ephemeral — use a managed Mongo for production.
