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

Professors control the tutor through the portal without touching code or redeploying the agent.

**Tuning pedagogy:**

- Set the **help style** (hint only, guided, worked example, or full solution).
- Set the **maximum steps** the tutor may reveal at once.
- Toggle whether **direct answers** are ever allowed.
- Toggle whether **citations** are required on grounded responses.

**Managing knowledge:**

- Review the active knowledge sources the toolbox exposes to the tutor.
- Add a new Azure AI Search index when new course material becomes available.
- Publish an updated toolbox version so the change takes effect without redeploying the agent.

**A typical adjustment:**

1. Open the professor portal.
2. Change the help style or step limit for the course.
3. Save — the portal writes the updated policy through its API.
4. The next student question is answered under the new policy.

## For developers

Use this local loop when building or extending the accelerator.

1. **Build and test the agent.**
   ```bash
   dotnet build src/HomeworkAgent/HomeworkAgent.csproj
   dotnet test src/HomeworkAgent.Tests/HomeworkAgent.Tests.csproj
   ```
2. **Configure the environment.** Copy `.env.example`, set the Foundry and toolbox values, and point `PEDAGOGY_POLICY_URI` at your policy file. See the [configuration guide](configuration.md).
3. **Build the portal.**
   ```bash
   npm --prefix ui/app run build
   ```
4. **Run locally.** Start the agent and exercise the `/health` and `/chat` endpoints to confirm the policy loads and the toolbox endpoint is wired.
5. **Deploy to Azure.** Once the environment is ready, run [../scripts/deploy.ps1](../scripts/deploy.ps1) or [../scripts/deploy.sh](../scripts/deploy.sh).

For the end-to-end request path and component responsibilities, see the [architecture overview](architecture.md).
