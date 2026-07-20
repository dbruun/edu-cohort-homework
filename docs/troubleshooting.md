# Troubleshooting

This page groups issues by where they surface: building, running, configuring behavior, knowledge access, and deploying. Start with the section that matches your symptom.

## Build issues

### Agent build fails

- Verify that the .NET SDK is installed and that the project targets a supported framework.
- Re-run `dotnet build src/HomeworkAgent/HomeworkAgent.csproj` to capture the latest compiler diagnostics.
- If content files appear duplicated, confirm the instruction and policy files are included once in [../src/HomeworkAgent/HomeworkAgent.csproj](../src/HomeworkAgent/HomeworkAgent.csproj).

### Portal build fails

- Ensure Node.js is installed.
- Re-run `npm --prefix ui/app run build` after installing dependencies if needed.
- Delete `node_modules` and reinstall if a dependency appears corrupted.

### Tests fail

- Run `dotnet test src/HomeworkAgent.Tests/HomeworkAgent.Tests.csproj` to see the failing assertion.
- Policy round-trip failures usually mean a field was renamed in [../src/HomeworkAgent/Pedagogy/PedagogyPolicy.cs](../src/HomeworkAgent/Pedagogy/PedagogyPolicy.cs) without updating the JSON.

## Runtime issues

### The agent starts but `/chat` returns an error

- Check `/health` first — it echoes the resolved project endpoint, toolbox endpoint, model deployment, and policy path.
- Confirm `AZURE_AI_MODEL_DEPLOYMENT_NAME` matches a real deployment in your Foundry project.
- Confirm `FOUNDRY_PROJECT_ENDPOINT` is reachable and that authentication is configured.

### The policy does not seem to apply

- Verify `PEDAGOGY_POLICY_URI` points at the intended file; if the file is missing the agent falls back to built-in defaults.
- Confirm the JSON parses and the field names match the schema in the [configuration guide](configuration.md).
- Remember the policy is read per request — a stale response usually means the file was not saved where the agent is reading it.

## Behavior issues

### The tutor gives away too much (or too little)

- Lower `helpLevel` (for example `guided` → `hint_only`) or reduce `maxStepsRevealed`.
- Ensure `allowDirectAnswers` is `false` if direct solutions should never appear.
- Check `subjectOverrides` — a per-subject override can quietly change behavior for one course.

### Responses are missing citations

- Set `citationsRequired` to `true` in the policy.
- Confirm the toolbox is actually returning grounded context (see knowledge issues below).

## Knowledge access issues

### The tutor cannot find course material

- Confirm the index is listed in [../toolbox/toolbox.yaml](../toolbox/toolbox.yaml) and that the connection details are correct.
- Verify the Azure AI Search index is populated and reachable from the Foundry project.
- Publish a new toolbox version after changing sources so the update is live.

## Deployment issues

### Deployment fails

- Confirm Azure Developer CLI is installed and authenticated.
- Ensure the selected subscription has the required quota and permissions.
- Review the output of the deployment script for the failing step.
- If the environment already exists, the scripts reuse it — check that the stored values are the ones you intend to deploy with.

### Documentation site does not update or looks unstyled

- Confirm the GitHub Pages source is set to **GitHub Actions**, not "Deploy from a branch."
- Check the Pages workflow run for build errors.
- If styles are missing, verify `baseurl` in [../docs/_config.yml](../docs/_config.yml) matches the repository name.
