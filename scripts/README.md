# Data-plane and test tools

Azure Resource Manager infrastructure has one source of truth:
[`../lab/infra/main.bicep`](../lab/infra/main.bicep). Run it through
[`../lab/deploy.ps1`](../lab/deploy.ps1), which works on Windows, macOS, and
Linux under PowerShell 7+. It runs `azd up`, which provisions the infrastructure
and deploys the professor portal.

The scripts retained here perform operations that ARM/Bicep does not manage:

| Tool | Responsibility |
| --- | --- |
| `setup-knowledge-base.py` | Creates and seeds Azure AI Search data-plane objects: index, knowledge source, and knowledge base. |

## Knowledge base

```powershell
python scripts/setup-knowledge-base.py --environment-name <environment>
```

The loader uses only the Python standard library and Azure CLI. It is
idempotent and can also import a Canvas export:

```powershell
python scripts/setup-knowledge-base.py --environment-name <environment> `
  --imscc-path ./course-export.imscc --subject "Course name"
```

---

# LTI launch test scripts

Two Node scripts drive a **real LTI 1.3 launch** against the deployed LTI tool
without needing an LMS to click through. They act as our **own** LTI platform:
they sign the `id_token` with a keypair we generate, and the tool validates it
against our public key (registered as `PLATFORM_PUBLIC_KEY`). **No dependency on
lti-ri or any external platform** — nothing is hosted or fetched.

| Script | Mode | Use |
|--------|------|-----|
| `lti-launch.mjs` | headless | Fast, repeatable PASS/FAIL proof that a launch validates and routes to the right role branch (CI-style). |
| `lti-launch-browser.mjs` | headed browser | Pops open Chromium, renders the live tutor chat, and auto-sends a homework question so you see the tutor stream a hint. |

Both take `--role learner` (default) or `--role instructor`. The browser script
also accepts `--question "…"`.

## One-time setup

```powershell
cd scripts
npm install            # installs jose + playwright
npx playwright install chromium   # only needed for the browser script
Copy-Item .lti.env.example .lti.env   # then fill in real values (see below)
```

`scripts/.lti.env` and the platform key `.platform-key.pem` are **gitignored** —
never commit them. Config resolution order: real environment variables win, then
`scripts/.lti.env`, then built-in defaults. `scripts/lib/config.mjs` validates
that the required values are present.

## Running

```powershell
# from the repo root
node scripts/lti-launch.mjs --role learner
node scripts/lti-launch.mjs --role instructor

# visual — pre-warm the agent first so there's no cold-start pause
curl.exe https://<lti-tool-host>/../  # or hit the agent /health
node scripts/lti-launch-browser.mjs --role learner --question "How do I factor x^2-9?"
```

Close the browser window to end the visual run.

## Generating and populating `.lti.env`

`.lti.env` holds **our own platform identity**. We generate the signing keypair,
register its **public key** on the tool, and sign launches with the private key.
Nothing is hosted or fetched externally.

| Key | What it is | Where it comes from |
|-----|------------|---------------------|
| `TOOL_URL` | Base URL of the deployed ltijs tool | Azure (Step 3) |
| `LTI_ISS` | Our platform issuer (an identifier; never fetched) | You choose, e.g. `https://homework-tutor-platform.local` |
| `LTI_CLIENT_ID` | The tool's client id (launch `aud`) | A GUID you generate (Step 2) |
| `LTI_DEPLOYMENT_ID` | Deployment id | You choose, `1` |
| `LTI_KID` | Key id of our signing key | Printed by `gen-platform-key.mjs` (Step 1) |
| `PLATFORM_PRIVATE_KEY` | Path to our private key PEM | `../.platform-key.pem` (Step 1) |

### Step 1 — Generate the platform keypair

```powershell
node scripts/gen-platform-key.mjs
```

Writes `.platform-key.pem` (private) and `.platform-key.pub.pem` (public) at the
repo root — **both gitignored** — and prints the `LTI_KID` (a JWK thumbprint) plus
the public PEM. Keep the printed public key for Step 4.

### Step 2 — Generate a client id

```powershell
[guid]::NewGuid().ToString()
```

### Step 3 — `TOOL_URL` (deployed tool host)

```powershell
$env = 'eduhw01'       # your azd environment token
$fqdn = az containerapp show -n "ca-lti-tool-$env" -g "rg-$env" `
  --query "properties.configuration.ingress.fqdn" -o tsv
"TOOL_URL=https://$fqdn"
```

(Or `azd env get-values` and use the tool's endpoint.)

### Step 4 — Register our platform on the tool

The tool trusts our platform via `PLATFORM_*` env, verifying launches against our
**public key directly** (ltijs `RSA_KEY` method — no JWKS to host). The key is
passed **base64-encoded** so it survives single-line env transport; `server.js`
decodes it.

```powershell
$pubB64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes((Get-Content .platform-key.pub.pem -Raw)))
az containerapp update -n ca-lti-tool-<env> -g rg-<env> --container-name lti-tool `
  --set-env-vars `
    "PLATFORM_URL=https://homework-tutor-platform.local" `
    "PLATFORM_NAME=Homework Tutor Platform" `
    "PLATFORM_CLIENT_ID=<your GUID>" `
    "PLATFORM_AUTH_ENDPOINT=https://homework-tutor-platform.local/auth" `
    "PLATFORM_TOKEN_ENDPOINT=https://homework-tutor-platform.local/token" `
    "PLATFORM_PUBLIC_KEY=$pubB64"
```

`PLATFORM_URL`/`LTI_ISS` and `PLATFORM_CLIENT_ID`/`LTI_CLIENT_ID` **must match** on
both sides. The auth/token endpoints are **placeholders** — the scripts never call
them; they abort the redirect and sign the launch themselves. A successful boot
logs `Registered platform Homework Tutor Platform (...) via RSA_KEY.`

> Re-provisioning (`azd provision`) wipes imperative env, so re-run this Step 4
> after any provision. The tool still supports the JWKS path
> (`PLATFORM_KEYSET_ENDPOINT`) if you ever register a real LMS instead.

### Step 5 — fill in `.lti.env`

```ini
TOOL_URL=https://ca-lti-tool-<env>.<region>.azurecontainerapps.io
LTI_ISS=https://homework-tutor-platform.local
LTI_CLIENT_ID=<your GUID>
LTI_DEPLOYMENT_ID=1
LTI_KID=<from Step 1>
PLATFORM_PRIVATE_KEY=../.platform-key.pem
```

Verify end-to-end:

```powershell
node scripts/lti-launch.mjs --role learner   # expect RESULT: PASS
```

## Notes

- **Cold start:** the agent can scale to zero, so the *first* tutor reply may take
  up to ~2 minutes. Pre-warm it (hit the agent `/health`) before a live demo, or
  set the agent's `minReplicas=1`.
- **Why a script instead of the LMS UI:** a script keeps its own cookie jar, so it
  carries ltijs's state cookie in a single first-party context — sidestepping the
  `MISSING_VALIDATION_COOKIE` error that browsers hit during an LMS iframe launch
  (third-party cookies are blocked).
