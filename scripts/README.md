# Deployment scripts

These scripts deploy the **EDU Homework Tutor** as a hosted agent on Microsoft Foundry
using the Azure Developer CLI (`azd`). They are turnkey: a new user who has never
touched this project can run one command and get a working, deployed agent.

## What they do

1. Check you're logged in (`az account show`) and capture the subscription + tenant.
2. Install the required `azd` Foundry extensions (`azure.ai.agents`, `azure.ai.toolboxes`, and dependencies).
3. Create/select an `azd` environment (this also names the resource group `rg-<env>`).
4. Set the subscription, tenant, region, model deployment name, pedagogy policy path, and toolbox name.
5. **New project:** provision the Foundry project + model (`azd provision`).
   **Existing project** (`-ProjectEndpoint` / 4th bash arg): resolve the project ARM ID + resource group and skip provisioning.
6. Optionally create the `course-knowledge-connection` (Azure AI Search) when a toolbox name + Search creds are supplied.
7. Deploy the `homework-agent` (`azd deploy homework-agent`).
8. Run a smoke-test invocation.

> The scripts deploy the repo-root [`azure.yaml`](../azure.yaml), which wires the `ai-project`
> model and the `src/HomeworkAgent` hosted agent (pedagogy composed from
> `Pedagogy/pedagogy-policy.json`). The Azure AI Search **toolbox is commented out by default**
> so a first deploy needs no Search resources — see [Enabling course knowledge](#enabling-course-knowledge).

## Prerequisites

- [Azure Developer CLI](https://learn.microsoft.com/azure/developer/azure-developer-cli/install-azd) **1.28+**
- [Azure CLI](https://learn.microsoft.com/cli/azure/install-azure-cli)
- .NET 10 SDK
- Log in first: `az login` and `azd auth login` (tokens expire — re-run both if a deploy reports "Login expired").
- A model deployment matching `ModelDeploymentName` must exist (or, for a new project, `azd provision` creates it).

## Quick start (tutor only — no Search needed)

**New Foundry project:**

```powershell
./scripts/deploy.ps1 -EnvironmentName homework-tutor -Location northcentralus
```
```bash
bash ./scripts/deploy.sh homework-tutor northcentralus gpt-5.4-mini
```

**Existing Foundry project** (skips provisioning):

```powershell
./scripts/deploy.ps1 -ProjectEndpoint "https://<account>.services.ai.azure.com/api/projects/<project>"
```
```bash
bash ./scripts/deploy.sh homework-tutor northcentralus gpt-5.4-mini \
  "https://<account>.services.ai.azure.com/api/projects/<project>"
```

## Enabling course knowledge

Grounding via the Azure AI Search toolbox is opt-in:

1. Uncomment the `course-knowledge` service (and the `- course-knowledge` line under `homework-agent.uses`) in [../azure.yaml](../azure.yaml).
2. Have an Azure AI Search service with a populated `course-materials` index.
3. Re-run with the toolbox name + Search endpoint/key:

```powershell
./scripts/deploy.ps1 -ProjectEndpoint "<endpoint>" `
  -ToolboxName course-knowledge `
  -SearchEndpoint "https://<search>.search.windows.net/" -SearchAdminKey "<admin-key>"
```

## Parameters

| PowerShell / bash position | Default | Notes |
|-----------|---------|-------|
| `-EnvironmentName` / #1 | `homework-tutor` | Also becomes the resource-group suffix (`rg-<env>`) for new projects. |
| `-Location` / #2 | `northcentralus` | Needs Foundry + model quota. |
| `-ModelDeploymentName` / #3 | `gpt-5.4-mini` | Must match a `deployments[].name` in the root `azure.yaml`. |
| `-ProjectEndpoint` / #4 | _(empty)_ | Deploy into an existing project; resolves ARM ID + RG and skips provision. |
| `-ToolboxName` / #5 | _(empty)_ | Empty = tutor only. Set to `course-knowledge` to attach the Search toolbox. |
| `-SearchEndpoint` / #6 | _(empty)_ | Azure AI Search URL; with the admin key, creates `course-knowledge-connection`. |
| `-SearchAdminKey` / #7 | _(empty)_ | Admin key for the Search service. |

## Tearing down

```bash
azd down --environment homework-tutor --force --purge
```

---

# Knowledge base setup

`setup-knowledge-base.ps1` and `setup-knowledge-base.py` seed the **Azure AI Search** knowledge base that
grounds the tutor in course material. The search service, Foundry connection,
and reasoning-model deployment are provisioned by Bicep (`azd provision`); this
script creates the data-plane objects (index, knowledge source, knowledge base)
and loads dummy microbiology data. It is idempotent.

```powershell
./scripts/setup-knowledge-base.ps1 -EnvironmentName <your-azd-env>
```

Cross-platform Python (standard library only):

```bash
python scripts/setup-knowledge-base.py --environment-name <your-azd-env>
```

It auto-discovers the search service and Foundry account from `rg-<env>`, or you
can pass `-SearchService`, `-ResourceGroup`, and `-FoundryAccount` explicitly.
The Python equivalents are `--search-service`, `--resource-group`,
`--foundry-account`, and `--seed-data-path`. Edit or replace the seed corpus via
`scripts/seed-data/microbiology.json`. See [../config/knowledge-sources.md](../config/knowledge-sources.md)
for the go-live checklist (Standard SKU, integrated vectorization).

To import a Canvas course export instead, use the Python script with
`--imscc-path ./course-export.imscc`. It imports manifest-listed HTML, text, and
XML course-work resources into the same knowledge base; use `--subject "Course
Name"` to set the course label for the imported documents.

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
