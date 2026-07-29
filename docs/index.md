# EDU Homework Agent Accelerator

The main path is a **2-3 hour hands-on lab** for building a homework tutor on
Microsoft Foundry and grounding it in approved course material through Azure AI
Search. You deploy the cloud foundation, seed a knowledge base, create the agent
in the Foundry portal, and verify grounded answers with citations.

## Start with Phase 1

| Step | What you do | Result |
| --- | --- | --- |
| 1 | Run the lab deployment | Foundry project, models, Azure AI Search, RBAC, and connection |
| 2 | Seed the knowledge base | Search index and sample microbiology course content |
| 3 | Create the tutor in Foundry | A guarded `homework-tutor` agent |
| 4 | Attach knowledge and test | Grounded, cited answers in the Playground |

[Start the guided lab](getting-started.md). It includes prerequisites, exact
commands, portal steps, verification, cleanup, and troubleshooting.

## Where the lab fits

The lab deploys the Foundry and knowledge components at the center of this target
architecture. LMS launch, the streaming bridge, periodic LMS data sync, and
professor-managed pedagogy are later phases and are not provisioned by the lab.

![Homework Tutor end-to-end architecture](architecture.png)

## Grow in phases

The repository carries starting points for the broader solution, but the value
path is intentionally incremental.

![Homework Tutor Agent evolution roadmap](sequence.png)

1. Ground the agent in academic data.
2. Add LMS data integration.
3. Add professor-owned pedagogy controls.
4. Launch from the LMS over LTI 1.3.
5. Introduce multi-agent orchestration only if scale or specialization requires it.

## Continue exploring

- Review the [architecture overview](architecture.md) for the target system and current lab boundary.
- Learn how the later agent and pedagogy implementation is [configured](configuration.md).
- Explore [LTI integration](lti-integration.md) for the LMS delivery phase.
- Use the [troubleshooting guide](troubleshooting.md) for lab deployment and grounding issues.
