# LTI configuration & testing guide

How the homework tutor is surfaced inside an LMS via **LTI 1.3 / LTI Advantage**, how it's deployed, how to register it with a platform, and how to run a test launch end‑to‑end.

For the *why* (design rationale, launch flow, role mapping) see [lti-integration.md](lti-integration.md). This document is the *how*.

> **Status:** the thin tool is deployed and a **real LTI 1.3 launch has been proven** against the 1EdTech LTI Reference Implementation — a Learner launch rendered the tutor experience with identity, roles, context, and deployment claims all validated. The tool currently renders **stub pages** (the Foundry chat proxy and React portal are not yet wired).

---

## What is deployed

A thin [ltijs](https://cvmcosta.me/ltijs/) service (`lti-tool/`) running on **Azure Container Apps**. ltijs owns the OIDC login, launch validation, and JWKS endpoints; our code only does **role routing** (Learner → tutor, Instructor/TA/ContentDeveloper → portal, unknown → 403).

### Live endpoints

Base host (this deployment): `ca-lti-tool-cohortltia2.delightfulplant-bfdae994.northcentralus.azurecontainerapps.io`

| Purpose | Path | Notes |
| --- | --- | --- |
| OIDC login initiation | `/login` | register with the LMS |
| Launch / redirect URI | `/lti/launch` | register with the LMS |
| Public JWKS | `/keys` | register with the LMS; `{"keys":[]}` until a platform is registered |
| Dynamic Registration | `/register` | paste into an LMS that supports it |
| Liveness | `/healthz` | returns `200 {"status":"ok"}` |

### Architecture notes (why it looks the way it does)

- **Mongo runs as a sidecar** in the *same* Container App, reached over `localhost:27017`. ltijs requires a Mongo store; Azure Container Apps' internal Envoy TCP ingress does **not** reliably proxy the MongoDB wire protocol app‑to‑app, so a separate Mongo Container App fails the driver handshake. The sidecar avoids the proxy entirely.
- **Cosmos DB for MongoDB was abandoned** in this subscription: management‑group Azure Policies (`CosmosDB_PublicNetwork_Modify`, `CosmosDB_LocalAuth_Modify`) force `publicNetworkAccess: Disabled` and `disableLocalAuth: true`, which breaks ltijs's connection‑string auth. The sidecar Mongo isn't a `DocumentDB` account, so those policies don't apply.
- **Sidecar Mongo storage is ephemeral** — platform registrations and keys are lost on replica recycle/redeploy. For durability, register platforms via `PLATFORM_*` env (re‑registered on boot) or add an Azure Files volume.
- **`azd deploy` replaces `containers[0]` by index, not by name** — the `lti-tool` container is listed first in the Bicep so the image lands on the right container.

---

## Registering the tool with a platform

Three supported paths.

### A. LTI Dynamic Registration (recommended)

Set `TOOL_URL` (done automatically in Bicep from the app's own FQDN) and an LMS admin pastes:

```
https://<host>/register
```

The tool self‑configures the platform. **Proven with the Anthology/Blackboard Developer Portal** — the app appears in *My Applications* with an Application ID (= `client_id`) and `/keys` starts serving a real key. Notes:

- Blackboard embeds a one‑time `registrationToken` in the config URL; a **second** click returns `{"status":500,…404}` (token consumed) — ignore it.
- ltijs's success response is a **blank page** (a `postMessage(close)` script), *not* an error.
- Dev‑portal registration only mints the `client_id`; an actual **launch** still needs the app placed in a Learn instance (a DVI or institution) by an admin.

### B. Manual registration via `PLATFORM_*` env

Register a single platform on boot by setting the env vars below and redeploying. This is also the **durability workaround** for the ephemeral sidecar Mongo.

### C. Testing with the 1EdTech LTI Reference Implementation (free)

Because the tool is a generic LTI 1.3 tool, any conformant platform can launch it. The 1EdTech **LTI Reference Implementation** (`lti-ri.imsglobal.org`) is a free test platform — see the step‑by‑step below.

---

## Environment variables

| Var | Purpose |
| --- | --- |
| `LTI_KEY` | ltijs encryption key (cookies/state) — secret |
| `MONGO_URL` | ltijs datastore (`mongodb://…@localhost:27017/ltijs?authSource=admin`) — secret |
| `PORT` | listen port (default `3000`) |
| `TOOL_URL` | public base URL; enables Dynamic Registration at `/register` |
| `TOOL_NAME` | tool name advertised during Dynamic Registration |
| `FRAME_ANCESTORS` | CSP `frame-ancestors` — the LMS domains allowed to iframe the tool |
| `HOMEWORK_AGENT_URL` | tutor agent base URL (chat proxy, phase 3) |
| `PLATFORM_URL` | platform **issuer** (the `iss` in the launch token) |
| `PLATFORM_NAME` | friendly platform name |
| `PLATFORM_CLIENT_ID` | the tool's `client_id` at the platform (= launch `aud`) |
| `PLATFORM_AUTH_ENDPOINT` | platform OIDC authorization endpoint |
| `PLATFORM_TOKEN_ENDPOINT` | platform OAuth2 access‑token endpoint |
| `PLATFORM_KEYSET_ENDPOINT` | platform JWKS URL (used to verify the launch signature) |

All five `PLATFORM_*` endpoint values must be set together for boot‑time registration. Example (the 1EdTech test platform used to prove the launch):

```
PLATFORM_URL=https://lti-ri.imsglobal.org
PLATFORM_NAME=lti-ri
PLATFORM_CLIENT_ID=<your platform client id>
PLATFORM_AUTH_ENDPOINT=https://lti-ri.imsglobal.org/platforms/<id>/authorizations/new
PLATFORM_TOKEN_ENDPOINT=https://lti-ri.imsglobal.org/platforms/<id>/access_tokens
PLATFORM_KEYSET_ENDPOINT=https://lti-ri.imsglobal.org/platforms/<id>/platform_keys/<keyId>.json
```

Set them on the running app without a full redeploy:

```powershell
az containerapp update `
  --name ca-lti-tool-<token> --resource-group rg-<token> --container-name lti-tool `
  --set-env-vars PLATFORM_URL=https://lti-ri.imsglobal.org PLATFORM_NAME=lti-ri `
    PLATFORM_CLIENT_ID=<client-id> `
    PLATFORM_AUTH_ENDPOINT=<auth-url> PLATFORM_TOKEN_ENDPOINT=<token-url> `
    PLATFORM_KEYSET_ENDPOINT=<jwks-url>
```

Confirm registration in the logs (`Registered platform …`) and that `/keys` returns a non‑empty key.

---

## Test a launch with the 1EdTech Reference Implementation

This is the exact flow that proved the launch. Everything on lti‑ri uses **synthetic data** — no real users.

### 1. Create the Platform (the fake LMS)

1. `lti-ri.imsglobal.org` → **Generate Keys** (keep the tab open).
2. **Manage Platforms → Add Platform**:
   - **Name:** anything (e.g. `Homework Help`)
   - **Client:** a unique id (a GUID is safest on the shared sandbox) — this becomes `PLATFORM_CLIENT_ID`
   - **Audience:** `https://lti-ri.imsglobal.org`
   - **Platform Public/Private Key:** paste from the Generate Keys tab
   - **JWT Key Set URL:** `https://<host>/keys` (leave *Tool Public Key* blank)
   - **Save**
3. On the platform view → **Platform Keys → Add Platform Key**: name it, set **Deployment ID = `1`**, Save. This surfaces the **well‑known/jwks URL** (→ `PLATFORM_KEYSET_ENDPOINT`).

### 2. Wire the platform into the tool

Grab from the platform view: **issuer** (`https://lti-ri.imsglobal.org`), **client id**, **OIDC Auth URL**, **Access Token URL**, **jwks URL**. Set them as `PLATFORM_*` (see above) and roll the app. Also ensure `FRAME_ANCESTORS` includes `lti-ri.imsglobal.org`.

### 3. Build the Resource Link

Platform view → **Courses → Add Course** (label/title/type e.g. `CourseOffering`) → Save. Then **Resource Links → Add**:

- **Tool link url:** `https://<host>/lti/launch`
- **Login initiation url:** `https://<host>/login`
- **Role:** blank = Learner, or `http://purl.imsglobal.org/vocab/lis/v2/membership#Instructor` for the instructor branch
- **Save** (skip Line Items / Deep Linking)

### 4. Launch

**Select User for Launch → Launch with New User**, then step through the manual pages (**Post request** → **Launch Resource Link**). A successful launch renders our stub:

| Role | Expected page |
| --- | --- |
| Learner / Student | **"Homework tutor"** stub — user, `context_id`, `deployment` |
| Instructor / TA / ContentDeveloper | **"Professor portal"** stub |
| unknown | **403 Access denied** |

> Use the **manual step‑through** (Post request → Launch Resource Link), not lti‑ri's tiny auto‑iframe — see the cookie gotcha below.

---

## Known gotchas

- **`MISSING_VALIDATION_COOKIE` on an iframe launch.** ltijs sets a state cookie at `/login` and reads it at `/lti/launch`. In lti‑ri's auto‑**iframe**, that's a cross‑site third‑party cookie which modern browsers block, so validation fails. Workarounds: use the **manual step‑through** (top‑level pages, proven working), or a real LMS (Canvas/Blackboard send `lti_storage_target` and use the LTI postMessage storage fallback). Hardening the tool for cookieless iframe launches is a follow‑up.
- **lti‑ri free tier.** Persisting a platform/keys may prompt for IMS membership; the objects generally live long enough for a test session.
- **Ephemeral sidecar Mongo.** A redeploy/restart wipes registrations — re‑register via Dynamic Registration or `PLATFORM_*` env (the dynamic‑registration token is one‑time and can't be replayed).
- **First‑boot race.** Each new revision's fresh Mongo re‑initialises its root user while ltijs connects → transient `AuthenticationFailed` / `502` for ~60–90 s, then self‑heals.

---

## What's proven vs. not yet

**Proven:** deploy + boot in a governed subscription; ltijs connects to its store; public OIDC/JWKS/registration endpoints serve correctly; **Dynamic Registration** with Blackboard; a **full LTI 1.3 launch** (OIDC → signed `id_token` → JWT validation → **role routing**) against a real conformant platform, with identity/roles/context/deployment claims all carried through.

**Not yet:** the Instructor branch end‑to‑end launch; the **chat proxy** to the Foundry tutor (still stubbed); the **React portal** behind the launch; cookieless **iframe** launches; LTI Advantage services (Deep Linking, NRPS, AGS); durable storage.
