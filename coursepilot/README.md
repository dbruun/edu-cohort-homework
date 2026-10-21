# CourseWise

A small, Entra-authenticated web chat for the existing `homework-tutor` Foundry
agent. The server streams AG-UI events to the browser, including answer text,
retrieval status, and source links. Chat history stays in the current browser tab.

The learner UI is branded CourseWise. The existing `coursepilot` directory,
deployment identifiers, and Azure resource names remain unchanged.

CourseWise reuses the lab's Linux App Service plan, Foundry project, Key Vault,
and Log Analytics workspace. It creates its own App Service and managed identity.
The identity receives Foundry User access on the project and Key Vault Secrets
User access on the specific sign-in secret.

## Configure and deploy

> **Accelerator only - not ready for production.** These deployment instructions
> are for learning and demonstrations, not an institutionally approved student
> service. Before production use, your institution must conduct a security and
> privacy review, perform security testing, and approve remediation of identified
> issues. That review must cover EasyAuth and app-registration configuration,
> enrollment and course-level authorization, data isolation, prompt-injection
> defenses, and student-data handling. EasyAuth alone does not provide enrollment
> checks or course-level access control. Use only synthetic or explicitly approved
> non-sensitive demo data until the required controls are implemented, validated,
> and approved by your institution.

Run commands from this directory with Node.js 22+, Azure CLI, and azd installed.
Sign in to the subscription containing the lab, then create an azd environment:

```powershell
azd env new <environment-name>
```

Set these non-secret environment values using `azd env set NAME VALUE`:

| Variable | Value |
| --- | --- |
| `AZURE_SUBSCRIPTION_ID` | Existing lab subscription |
| `AZURE_RESOURCE_GROUP` | Existing lab resource group |
| `AZURE_LOCATION` | Region of the existing App Service plan |
| `COURSEPILOT_PLAN_NAME` | Existing professor portal App Service plan |
| `FOUNDRY_ACCOUNT_NAME` | Existing Foundry account |
| `FOUNDRY_PROJECT_NAME` | Existing Foundry project |
| `FOUNDRY_AGENT_NAME` | Tutor agent name |
| `FOUNDRY_AGENT_VERSION` | Explicit tutor version |
| `COURSEPILOT_AUTH_CLIENT_ID` | CourseWise's single-tenant Entra application ID |
| `COURSEPILOT_AUTH_KEY_VAULT_NAME` | Existing vault in the lab resource group |
| `COURSEPILOT_AUTH_SECRET_NAME` | Existing secret containing the application's client secret |
| `LOG_ANALYTICS_WORKSPACE_NAME` | Existing lab workspace |
| `POLICY_STORAGE_ACCOUNT` | Existing account containing the `policies` blob container |

Do not put the client secret in azd settings or source files. App Service resolves
its Key Vault reference using managed identity.

```powershell
npm ci
npm run build
npm test
azd up
```

The build stages the app and shared identity parser in `.azd-deploy`. App Service
restores production npm dependencies during deployment. For an already provisioned
environment, use `azd deploy` to deploy code changes.

Add `<COURSEPILOT_URL>/.auth/login/aad/callback` as a **Web** redirect URI on the
app registration, preserving existing callbacks. Enable **ID tokens (used for
implicit and hybrid flows)**. `COURSEPILOT_URL` is an azd provisioning output.

## Behavior and limits

The browser posts AG-UI run requests to `/api/chat` and consumes server-sent events
incrementally. Foundry is called server-side with managed identity; no Foundry
credentials reach the browser. Easy Auth protects the deployed site and its APIs.
The app rejects client-supplied system messages and tools.

Assistant replies support Markdown and LaTeX math, rendered with KaTeX. Use
`\(...\)` for inline math and `\[...\]` on separate lines for display math;
`$$...$$` is also supported, while single dollar signs remain currency. Code
examples are left literal. Markdown HTML and images are disabled, links are
restricted to HTTPS, and rendered output is sanitized. KaTeX scripts, styles,
and fonts are bundled locally by `npm run build`; there is no CDN dependency.
Start locally with `npm start` only after building.

Streamed updates are batched to animation frames. Incomplete equations show a
short placeholder until closed, and invalid completed equations remain readable
with a formatting warning. Chat history retains the original response, not
rendered HTML. The page follows the streamed reply as it grows. Scrolling up
pauses automatic following; scrolling back to the bottom resumes it.
Provider citation annotations map inline references such as `[1]`
to the same numbered document in "Course sources cited." Only course documents
referenced by provider citation annotations appear in this list; uncited retrieval
candidates are omitted, including when no course citations are available.
Numbers are local to each reply, follow course-source retrieval order, and exclude the teaching
policy, so the cited-only list can have gaps in its numbering. Repeated retrievals
of the same document reuse its number. Unmatched citations are explicitly marked
unavailable instead of being guessed.

The professor and course controls live in the page header. Inline citations and
cited-source titles open the retrieved document text in a panel to the right of
the chat, or below it on smaller screens, without opening another tab. Preview
text is displayed as plain text and may be a chunk or excerpt rather than the
complete original file. No extra network request or public document endpoint is
needed. The panel can be closed with its Close button or Escape, and clears when
the course changes or a new chat starts. Only course text is previewed; teaching
policy text is never included, numbered, or linked. A note confirms that the
teaching policy was consulted.

The tutor formatting instructions live in `lab/agent-instructions.md`. To apply
prompt changes to the deployed tutor, publish a new Foundry agent version with
those instructions and update `FOUNDRY_AGENT_VERSION` before deploying
CourseWise. A UI deployment does not change the remote agent's instructions.

Professor and course fields provide conversational context, not verified
enrollment or per-course authorization. This is a demo chat UI, not an LMS
integration or an enrollment access-control boundary.

Agent instructions include the selected course ID and name in every content
search and use/cite only results whose `courseName` metadata matches that course.
The existing knowledge source exposes `courseName` in its reference source data.
This is instruction-based scoping, not a server-enforced Search filter: the
shared retrieval can still return other courses' documents.

Teaching policies are loaded from that container before the server starts, then
cached in memory for 15 minutes per process. The first request after expiry
reloads all policies; concurrent requests share the reload. Cache hits do not
contact storage or policy Search. Failed reloads fail the chat rather than serving
expired rules. Policy saves may take up to 15 minutes to reach a running instance;
they do not invalidate its snapshot. Restarting the app reloads policies.

Use a tutor version that accepts the `COURSEPILOT_SERVER_POLICY` developer message
and has only the course-content MCP tool. CourseWise creates that message from
saved policies, never from client-supplied policy settings. Professor/course
selection is still demo context, not verified enrollment. The app's identity has
Storage Blob Data Reader access only to the policies container. Its credential
and storage client are reused; Foundry authentication and policy loading are
warmed before listening. This does not prevent Free-tier idle unloads.
