# EDU Homework Agent Accelerator

This repository scaffolds a student-facing homework tutor built on Microsoft Foundry Hosted Agents, Azure AI Search via Foundry Toolbox, and a professor-facing management portal.

## What is included
- A .NET hosted agent using the Microsoft Agent Framework pattern
- A configurable Foundry Toolbox that can be extended to more Azure AI Search indexes without redeploying the agent
- A professor portal for adjusting pedagogy limits and reviewing knowledge-source configuration
- Deployment scripts for Azure Developer CLI and a starter Bicep template
- A GitHub Pages-ready documentation site

## Repo structure
- [src/HomeworkAgent](src/HomeworkAgent) — hosted agent source and policy prompt composition
- [toolbox](toolbox) — toolbox definition for Azure AI Search
- [ui](ui) — professor portal starter and API scaffold
- [docs](docs) — Jekyll documentation site
- [scripts](scripts) — Azure deployment scripts
- [infra](infra) — starter infrastructure as code

## Local development
1. Build the agent with `dotnet build src/HomeworkAgent/HomeworkAgent.csproj`
2. Run the tests with `dotnet test src/HomeworkAgent.Tests/HomeworkAgent.Tests.csproj`
3. Build the portal with `npm --prefix ui/app run build`

## Azure deployment
1. Install and authenticate Azure Developer CLI.
2. Run [scripts/deploy.ps1](scripts/deploy.ps1) or [scripts/deploy.sh](scripts/deploy.sh).
3. Review the generated environment and deployed endpoints in Azure.

## Documentation
- Start with [docs/index.md](docs/index.md) for the overview.
- See [docs/architecture.md](docs/architecture.md) for the system flow.
