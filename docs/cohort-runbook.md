# Cohort runbook

Sequence for the EDU homework-tutor lab, driven by one operator on one
subscription. Split into what must be done **before** the session and what
happens **during** it.

The ordering constraint: the portal's hostname must be **known before** the
Entra redirect URI can be registered, and the registration must exist before
the first sign-in. So all Entra configuration happens up front, in Part A.

---

## Part A — Ahead of time

### A1. Create the Entra app registration

1. Entra portal → **App registrations** → **New registration**
2. Name it (e.g. `edu-cohort-portal`)
3. **Supported account types**: *Accounts in this organizational directory only*
   (single tenant) — Bicep builds the issuer from your tenant ID, so
   multi-tenant will mismatch
4. Leave **Redirect URI** blank here; added in A3
5. **Register**
6. From **Overview**, copy the **Application (client) ID**

### A2. Add the redirect URI

**Authentication** → **Add a platform** → **Web**, then add the URI in exactly
this form:

```text
https://<portal-app-name>.azurewebsites.net/.auth/login/aad/callback
```

Missing or mistyped → `AADSTS50011` at sign-in.

> **Two portal UIs exist.** If you land on **Authentication (Preview)**, the
> redirect URIs are under the **Redirect URI configuration** tab and the
> implicit-grant settings under **Settings**. The classic blade puts both on one
> page — the banner link *"To switch to the old experience"* is often faster.

### A3. Enable ID token issuance

**Authentication** → **Implicit grant and hybrid flows** → tick
**ID tokens (used for implicit and hybrid flows)** → **Save**.

Leave **Access tokens** unchecked.

Required because App Service Easy Auth uses the OpenID Connect **hybrid flow**
(`response_type=code+id_token`). Without it, sign-in fails with
`AADSTS700054: response_type 'id_token' is not enabled for the application`.

> In the preview UI this section stays **hidden** until at least one Web
> redirect URI exists — so A3 must be completed before A4 is even visible.

### A4. Create a client secret

**Certificates & secrets** → **New client secret** → set an expiry past the
session → **Add**.

Copy the **Value** column immediately — it is shown once and is unrecoverable
afterwards. The **Secret ID** is *not* the secret; pasting it produces
`AADSTS7000215 invalid client secret` at sign-in.

### A6. Optional: Verify the secret works

Cheap insurance against a bad copy/paste:

```powershell
$b = @{ client_id='<client-id>'; client_secret='<secret>'; scope='https://graph.microsoft.com/.default'; grant_type='client_credentials' }
try { $null = Invoke-RestMethod -Method Post -Uri "https://login.microsoftonline.com/<tenant-id>/oauth2/v2.0/token" -Body $b -ErrorAction Stop; 'SECRET VALID' }
catch { $_.ErrorDetails.Message }
```

The secret is written to Key Vault by the deploy script in B1 and is never
stored in the azd environment or as an App Service setting. Rotate it, or delete
the registration, after a throwaway lab.

---

## Part B — During the session

### B1. Deploy the lab (~20 min, mostly unattended)

```powershell
./lab/deploy.ps1 -EnvironmentName <environment-name> `
  -PortalAppName '<portal-app-name>' `
  -PortalAuthClientId '<client-id>' `
  -PortalAuthKeyVaultResourceGroup '<key-vault-resource-group>' `
  -PortalAuthKeyVaultName '<globally-unique-vault-name>'
```

The script creates the Key Vault if needed and prompts once for the client
secret, writing it straight to the vault. Have the secret from A4 ready to
paste; it is not echoed.

`-PortalAppName` is what pins the hostname to the pre-registered redirect URI.
Omit it and Bicep falls back to a hashed name whose URI is *not* registered.

The long pole is the App Service build, not Search — Search provisions in well
under a minute. Start this early and talk over it.

### B2. Sign in to the portal

Open the printed portal URL. Expect a redirect to Microsoft sign-in, then the
portal.

If sign-in fails immediately after an Entra change, wait a minute and retry in
a fresh InPrivate window — Entra changes take a moment to propagate, and a
cached failed session reproduces the old error misleadingly.

### B3. Seed the knowledge layer

Two scripts, in this order. Both are idempotent.

```powershell
./scripts/setup-policy-ingestion.ps1 -EnvironmentName <environment-name>
./scripts/setup-knowledge-bases.ps1  -EnvironmentName <environment-name>
```

`setup-policy-ingestion.ps1` builds `pedagogy-policy-index` plus the blob data
source and indexer that parse each professor's policy JSON.
`setup-knowledge-bases.ps1` creates `course-content-index` and both knowledge
bases over their own sources:

| Knowledge base | Index | Fed by |
| --- | --- | --- |
| `pedagogy-policy-base` | `pedagogy-policy-index` | Blob indexer, triggered on policy save |
| `course-knowledge-base` | `course-content-index` | Portal push on IMSCC import |

`setup-blob-ingestion.ps1` builds a separate chunked pull pipeline over the
`course-content` container. It is **not** on the demo path — the portal pushes
documents straight into the index — so skip it unless you are demonstrating
blob-sourced ingestion specifically.

### B4. Upload an IMSCC and set a pedagogy policy

In the portal: import `scripts/tests/fixtures/biology-101-full.imscc` with
subject `Biology 101`. It carries 8 documents — syllabus, four weekly pages, a
study guide, and two assignments.

Then set the pedagogy controls and save. Saving writes the policy blob and
triggers the indexer; the response reports `indexerTriggered`. The trigger is
fire-and-forget, so leave a few seconds before asking the tutor anything.

Verify what actually landed rather than trusting the form:

```powershell
$t = az account get-access-token --resource https://search.azure.com --query accessToken -o tsv
$h = @{ Authorization = "Bearer $t"; 'Content-Type' = 'application/json' }
$b = @{ search = '*' } | ConvertTo-Json
(Invoke-RestMethod -Method POST -Uri "https://<search-service>.search.windows.net/indexes/pedagogy-policy-index/docs/search?api-version=2024-07-01" -Headers $h -Body $b).value | Select-Object professorName, helpLevel, maxStepsRevealed, allowDirectAnswers, policyText
```

### B5. Create the agent and test policy-then-content ordering

Create a **prompt agent** in the Foundry portal on the `gpt-5.4` deployment.
Paste the fenced instruction block from
[../lab/agent-instructions.md](../lab/agent-instructions.md) into
**Instructions** — the surrounding prose is documentation, not prompt.

Attach both knowledge bases as tools, **policy first**:

```text
https://<search-service>.search.windows.net/knowledgebases/pedagogy-policy-base/mcp?api-version=2026-04-01
https://<search-service>.search.windows.net/knowledgebases/course-knowledge-base/mcp?api-version=2026-04-01
```

Then run the A/B in Checkpoint E of the instructions doc: ask the microscopy
question under a restrictive policy, flip the policy in the portal, and ask
again in a **new thread**. Same question, opposite behaviour.

Judge it from the **run trace**, not the answer text — a model will produce
policy-shaped prose without ever calling the policy knowledge base. Confirm two
retrieval calls, policy first.

---

## Failure modes seen in rehearsal

| Symptom | Cause | Fix |
| --- | --- | --- |
| `AADSTS50011` | Redirect URI missing/mistyped | A3 |
| `AADSTS700054` | ID tokens not enabled | A4 |
| `AADSTS7000215` | Secret ID used instead of secret Value | A5 |
| 401 on `/.auth/login/aad/callback` | Entra change not yet propagated | Wait, retry in InPrivate |
| `Authentication is required.` on every API call | Deployed without auth parameters | Redeploy with them |
| Portal loads but policy save fails | Storage locked by policy | B2 |
| Implicit-grant checkbox not visible | No Web platform yet (preview UI) | Do A3 before A4 |
| `azd deploy` reports SUCCESS but old code runs | Staging folder not rebuilt | `ui/package.json` `build` script rebuilds it; verify deployed *content*, not timestamps |
| Policy saved but tutor behaviour unchanged | Asked before the indexer finished, or old thread | Wait a few seconds; always retest in a new thread |
| Tutor explains the method but withholds the answer under `full_solution` | Permissive level stated as permission, not instruction | Instruction block already says STATE THE FINAL ANSWER — confirm the agent version was saved |
| Citations render as `cite9:0†source` | Unresolved annotation markers | Cosmetic in the playground; a custom UI must map annotations to links |

## Open items before the session

- End-to-end timing has not been measured on a clean environment
- Storage tag survival across redeploy is predicted but not yet observed
- The professor portal has no editor for per-subject overrides, and no longer
  sends them; the policy model still supports them
- `allowDirectAnswers` and `helpLevel` can express contradictory settings
  (e.g. `hint_only` + direct answers allowed) and nothing ranks them — left
  deliberately open as a cohort design discussion
