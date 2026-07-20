# Troubleshooting

This page groups issues by where they surface: building, running, configuring behavior, knowledge access, and deploying. Start with the section that matches your symptom.

## Build issues

### Agent build fails

- Verify the .NET 10 SDK is installed.
- Re-run `dotnet build foundry-tutor/hello-world-dotnet-agent-framework/src/hello-world-dotnet-agent-framework/hello-world.csproj` to capture the latest compiler diagnostics.

### Portal build fails

- Ensure Node.js is installed.
- Re-run `npm --prefix ui/app run build` after installing dependencies if needed.
- The portal is a scaffold and is not part of the deployed agent.

## Deploy issues

### `azd deploy` fails to register the agent

- If you see a token/login error, re-run `azd auth login --scope https://ai.azure.com/.default` and retry.
- Confirm `AZURE_AI_MODEL_DEPLOYMENT_NAME` matches a real model deployment in the Foundry project.
- A very fast (under ~10s) deploy usually means no code change was detected — azd reused the existing container.

## Runtime issues

### Invoking the agent returns an error

- Use `azd ai agent invoke "<prompt>"` — the hosted agent uses the Responses protocol, not a custom `/chat` endpoint.
- Check logs with `azd ai agent monitor homework-tutor`.
- A `session_not_ready` / 424 on the first call is usually a cold start; retry once the container is up.

### The policy change did not take effect

- The pedagogy policy is compiled into the agent, so you must **redeploy** after editing it.
- Confirm the deploy actually rebuilt the container (watch for a ~1 minute deploy, not a ~10s no-op).

## Behavior issues

### The tutor gives away too much (or too little)

- Lower `helpLevel` (for example `guided` → `hint_only`) or reduce `maxStepsRevealed` in the policy, then redeploy.
- Ensure `allowDirectAnswers` is `false` if direct solutions should never appear.
- Check `subjectOverrides` — a per-subject override can quietly change behavior for one course.

## Knowledge access (planned)

The Azure AI Search **toolbox** is defined in [../toolbox/toolbox.yaml](../toolbox/toolbox.yaml) but is **not yet connected** to the deployed agent, so the tutor does not currently retrieve course material. Wiring it up requires a Foundry connection or Standard Agent Setup.

## Deployment issues

### Deployment fails

- Confirm Azure Developer CLI (1.28+) and the Foundry `azd` extensions are installed.
- Ensure the subscription has model-deployment quota in the target region.
- Review the output of the deployment script for the failing step.

### Documentation site does not update or looks unstyled

- Confirm the GitHub Pages source is set to **GitHub Actions**, not "Deploy from a branch."
- Check the Pages workflow run for build errors.
- If styles are missing, verify `baseurl` in [../docs/_config.yml](../docs/_config.yml) matches the repository name.
