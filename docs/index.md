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
- a **professor portal** (React UI + policy API) for tuning the pedagogy that shapes the tutor
- a pedagogy policy that is the shared contract between the portal and the tutor
- a documentation site and an `azd`-based deployment path

> **Status note:** The hosted tutor is deployed and verified, and the professor portal is fully built and runs locally. The remaining integration step is connecting the portal's saved policy to the **deployed** agent for a live read — today those changes are applied by redeploying the agent. The Azure AI Search toolbox is defined but not yet connected. See the [architecture overview](architecture.md) for the full picture.

## How it works

1. Professors set the pedagogy policy in the portal — help level, step limits, direct-answer and citation rules.
2. Students ask homework-related questions through the tutor.
3. The tutor answers under that pedagogy policy, preferring hints and guided steps over direct answers.
4. A planned Foundry Toolbox will let the tutor ground responses in approved Azure AI Search content.

## Get started

- Review the [architecture overview](architecture.md) for what is deployed today.
- Learn how to configure the agent and policy in [configuration.md](configuration.md).
- See the [usage guide](how-to-use.md) for student, professor, and developer workflows.
- Deploy the hosted agent with [scripts/deploy.ps1](../scripts/deploy.ps1) or [scripts/deploy.sh](../scripts/deploy.sh).
