# EDU Homework Agent Accelerator

A hands-on accelerator for building a student homework tutor on Microsoft
Foundry, grounding it in approved course material with Azure AI Search, and
evolving it toward LMS delivery and professor-owned pedagogy.

The main path in this repository is the **Phase 1 lab**: deploy a slim Foundry +
Azure AI Search stack and professor portal, seed a course knowledge base, create
the tutor in the Foundry portal, and verify grounded answers with citations. The
lab intentionally does not deploy containers or an LTI tool.

## Target architecture

The lab proves the agent and knowledge layer at the center of the design. The
diagram below shows the end-to-end target architecture, including the later LMS,
delivery, data-integration, and pedagogy layers.

![Homework Tutor end-to-end architecture](architecture.png)

## Start here: build the grounded tutor

The guided lab takes about **2-3 hours** and has four steps:

| Step | Outcome | Where |
| --- | --- | --- |
| 1. Deploy the lab | Foundry project, models, Azure AI Search, professor portal, RBAC, and project connection | Terminal |
| 2. Seed course knowledge | Search index, knowledge source, knowledge base, and sample microbiology content | Terminal |
| 3. Create the tutor | `homework-tutor` agent using the provided instructions | Foundry portal |
| 4. Add knowledge | Grounded, cited responses in the Foundry Playground | Foundry portal |

Follow the complete [getting started guide](docs/getting-started.md) for
prerequisites, portal steps, verification, cleanup, and troubleshooting.

### 1. Deploy the lab infrastructure

First create a single-tenant **Entra app registration** and a client secret — the
professor portal requires sign-in and has no anonymous mode. Leave its redirect
URI empty for now; you add it after this step, once the hostname exists.

From the repository root, choose a short environment name and run:

```powershell
$secret = Read-Host 'Entra client secret' -MaskInput

./lab/deploy.ps1 -EnvironmentName eduhw01 `
  -PortalAuthClientId '<application-id>' `
  -PortalAuthClientSecret $secret
```

Then add `<professor-portal-url>/.auth/login/aad/callback` to the registration,
using the portal URL the script prints. The App Service name carries a stable
hash, so don't guess the hostname. On the same **Authentication** blade, tick
**ID tokens (used for implicit and hybrid flows)** — Easy Auth uses the hybrid
flow and sign-in fails with `AADSTS700054` without it.

The lab provisions and deploys:

- a Microsoft Foundry account and `homework` project
- `gpt-5.4` and `gpt-5.4-mini` model deployments
- an Azure AI Search service
- the professor portal on Linux Azure App Service
- the RBAC assignments and Foundry project connection needed for grounding

The infrastructure lives in [lab/infra](lab/infra). It deliberately excludes
ACR, Container Apps, MongoDB, the hosted agent container, and the LTI tool.

### 2. Seed the knowledge base

```powershell
python scripts/setup-knowledge-base.py --environment-name eduhw01
```

This creates `course-materials`, `course-materials-source`, and
`course-knowledge-base`, then loads the sample content from
[scripts/seed-data/microbiology.json](scripts/seed-data/microbiology.json).

### 3. Create the agent in Foundry

Open the `homework` project in the Foundry portal, create an agent named
`homework-tutor` with the `gpt-5.4` deployment, and paste in
[lab/agent-instructions.md](lab/agent-instructions.md).

### 4. Attach knowledge and test

Add `course-knowledge-base` to the agent, save it, and ask:

> How do bacteria resist antibiotics?

The response should use the seeded course material and include citations. Ask a
question outside that material to verify that the tutor declines to invent an
answer.

## Evolution roadmap

The repository is organized so each phase can build on a working tutor rather
than requiring the entire platform up front.

![Homework Tutor Agent evolution roadmap](sequence.png)

| Phase | Focus | Repository starting points |
| --- | --- | --- |
| 1 | Agent grounded in academic data | [lab](lab), [scripts/setup-knowledge-base.py](scripts/setup-knowledge-base.py) |
| 2 | LMS data integration | [config/knowledge-sources.md](config/knowledge-sources.md), [toolbox](toolbox) |
| 3 | Professor-owned pedagogy | [src/HomeworkAgent/Pedagogy](src/HomeworkAgent/Pedagogy), [ui/app](ui/app) |
| 4 | LTI 1.3 launch and role routing | [lti-tool](lti-tool), [docs/lti-integration.md](docs/lti-integration.md) |
| 5 | Optional multi-agent orchestration | [scaling-to-multi-agents](scaling-to-multi-agents) |

The later-phase folders are implementation and exploration surfaces, not part of
the current lab deployment.

## Repository map

- [lab](lab) - the primary infrastructure and agent-creation lab
- [scripts](scripts) - knowledge setup and supporting automation
- [src/HomeworkAgent](src/HomeworkAgent) - .NET Agent Framework tutor and pedagogy policy composition
- [toolbox](toolbox) - Foundry Toolbox definition for Azure AI Search
- [lti-tool](lti-tool) - LTI 1.3 launch and role-routing implementation
- [bridge](bridge) - AG-UI streaming bridge
- [ui](ui) - student tutor UI and professor portal
- [scaling-to-multi-agents](scaling-to-multi-agents) - optional multi-agent evolution
- [docs](docs) - GitHub Pages documentation

## Documentation

- [Getting started](docs/getting-started.md) - the main lab walkthrough
- [Architecture](docs/architecture-diagram.html) - components and data flow
- [LTI integration](docs/lti-integration.md) - the later LMS delivery phase
- [Configuration](docs/getting-started.md) - deployment, pedagogy, and knowledge settings
- [Published documentation](https://dbruun.github.io/edu-cohort-homework/)
