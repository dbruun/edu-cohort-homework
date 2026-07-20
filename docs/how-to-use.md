# How to use the accelerator

This guide covers the three audiences the accelerator serves: students who ask the tutor questions, professors who shape its behavior, and developers who run and deploy it.

## For students

Students ask homework-related questions in natural language and receive help that is shaped by the professor's active policy rather than a raw answer dump.

**What to expect:**

- The tutor prefers hints, guided steps, or worked examples over direct solutions when that is the configured behavior.
- Responses are grounded in approved course materials, and citations appear when the professor requires them.
- If a question asks for a complete solution to graded work and the policy forbids it, the tutor explains what it *can* help with instead.

**Tips for better help:**

- Ask a specific question ("why does this step use the chain rule?") rather than "solve this for me."
- Share what you have tried so the tutor can meet you where you are.
- Ask follow-up questions — the tutor is designed to reveal understanding incrementally, not all at once.

## For professors

Professors shape the tutor through the **professor portal** ([../ui/app/src/App.jsx](../ui/app/src/App.jsx)), which edits the pedagogy policy that governs how much help the tutor offers.

**In the portal you can set:**

- the **help style** (hint only, guided, worked example, or full solution),
- the **maximum steps** the tutor may reveal at once,
- whether **direct answers** are ever allowed, and
- whether **citations** are required.

The portal loads the current policy and saves your edits back through its API (`GET`/`POST /api/policy`). You can run it locally today:

```bash
npm --prefix ui/app run build
```

**Applying a change to the tutor (today):**

1. Adjust the policy in the portal and save.
2. Redeploy the hosted agent with `azd deploy` so the tutor picks up the new policy.
3. The next student question is answered under the new policy.

> **Integration status:** The portal and its API are fully built and round-trip the pedagogy policy. The one remaining step is connecting the portal's saved policy to the **deployed** agent for a live read, so saves would take effect without the `azd deploy` step. Grounding knowledge through an Azure AI Search **toolbox** is likewise planned, not yet connected.

## For developers

The deployed tutor is a **hosted Foundry agent** under [../foundry-tutor/hello-world-dotnet-agent-framework](../foundry-tutor/hello-world-dotnet-agent-framework). Use this loop:

1. **Build the agent locally.**
   ```bash
   dotnet build foundry-tutor/hello-world-dotnet-agent-framework/src/hello-world-dotnet-agent-framework/hello-world.csproj
   ```
2. **Set deploy config.** In the agent folder, set the subscription, location, and model deployment in the `azd` environment (the deploy scripts do this for you).
3. **Deploy to Foundry.**
   ```bash
   azd deploy --no-prompt
   ```
   or run [../scripts/deploy.ps1](../scripts/deploy.ps1) / [../scripts/deploy.sh](../scripts/deploy.sh) for the full turnkey flow.
4. **Smoke test the deployed agent.**
   ```bash
   azd ai agent invoke "Can you help me get started on a homework problem?"
   ```
5. **Inspect logs.**
   ```bash
   azd ai agent monitor homework-tutor
   ```

The hosted agent speaks the Foundry **Responses** protocol — there is no custom `/chat` or `/health` endpoint. For the deployed vs. planned breakdown, see the [architecture overview](architecture.md).
