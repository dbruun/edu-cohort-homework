# EDU Homework Agent Accelerator

The EDU Homework Agent Accelerator is a practical foundation for bringing AI-assisted homework support to academic environments with clear pedagogical controls, configurable knowledge access, and a professor-friendly management experience.

## Why it matters

This accelerator helps institutions provide a tutor experience that is:

- supportive and student-friendly
- guided by an explicit, professor-owned pedagogy policy
- deployed as a managed agent on Microsoft Foundry
- designed to extend toward Azure AI Search-backed knowledge over time

## What the solution includes

- a hosted homework tutor deployed on Microsoft Foundry using the Microsoft Agent Framework
- a pedagogy policy that shapes how much help the tutor offers
- a professor portal (scaffold) for editing that policy
- a documentation site and an `azd`-based deployment path

> **Status note:** The hosted tutor and its Foundry deployment are live. The Azure AI Search toolbox and the professor portal are included as scaffolding and are **not yet wired into the deployed agent**. See the [architecture overview](architecture.md) for exactly what is deployed today.

## How it works

1. Students ask homework-related questions through the tutor experience.
2. The tutor answers under the pedagogy policy baked into the agent at deploy time (preferring hints and guided steps over direct answers).
3. A planned Foundry Toolbox will let the tutor ground responses in approved Azure AI Search content.
4. Professors adjust tutoring behavior by editing the policy and redeploying the agent so the change takes effect.

## Get started

- Review the [architecture overview](architecture.md) for what is deployed today.
- Learn how to configure the agent and policy in [configuration.md](configuration.md).
- See the [usage guide](how-to-use.md) for student, professor, and developer workflows.
- Deploy the hosted agent with [scripts/deploy.ps1](../scripts/deploy.ps1) or [scripts/deploy.sh](../scripts/deploy.sh).
