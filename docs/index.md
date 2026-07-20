# EDU Homework Agent Accelerator

The EDU Homework Agent Accelerator is a practical foundation for bringing AI-assisted homework support to academic environments with clear pedagogical controls, configurable knowledge access, and a professor-friendly management experience.

## Why it matters

This accelerator helps institutions provide a tutor experience that is:

- supportive and student-friendly
- grounded in approved course knowledge
- configurable by professors without requiring a redeployment of the agent
- easy to extend with additional Azure AI Search sources over time

## What the solution includes

- a hosted homework tutor experience powered by Microsoft Foundry and the Microsoft Agent Framework
- a configurable toolbox layer for Azure AI Search-backed knowledge retrieval
- a professor portal for tuning tutoring behavior and managing knowledge access
- a documentation site and deployment path for Azure-hosted rollout

## How it works

1. Students ask homework-related questions through the tutor experience.
2. The agent applies the active pedagogy policy to decide how much guidance to provide.
3. The toolbox connects to Azure AI Search so the tutor can ground responses in approved course materials.
4. Professors can adjust the tutoring behavior through the portal and publish new knowledge-source configurations without redeploying the agent.

## Get started

- Review the [architecture overview](architecture.md) for the system flow.
- Learn how to configure the agent and policy in [configuration.md](configuration.md).
- See the [usage guide](how-to-use.md) for student and professor workflows.
- Deploy the solution with [scripts/deploy.ps1](../scripts/deploy.ps1) or [scripts/deploy.sh](../scripts/deploy.sh).
