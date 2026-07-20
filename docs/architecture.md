# Architecture overview

The accelerator uses a simple hosted-agent pattern:

```mermaid
flowchart LR
  Student[Student] --> Agent[Homework Agent]
  Agent --> Policy[Pedagogy Policy]
  Agent --> Toolbox[Foundry Toolbox]
  Toolbox --> Search[Azure AI Search]
  Professor[Professor] --> Portal[Professor Portal]
  Portal --> Policy
```

The professor portal updates policy and knowledge source configuration without redeploying the agent. The agent reads the policy at runtime and uses the toolbox endpoint to access search-backed knowledge.
