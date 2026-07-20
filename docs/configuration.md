# Configuration guide

## Environment variables

The agent expects the following settings:

- FOUNDRY_PROJECT_ENDPOINT: the Foundry project endpoint for the hosted agent runtime
- TOOLBOX_ENDPOINT: the MCP endpoint for the Foundry Toolbox
- AZURE_AI_MODEL_DEPLOYMENT_NAME: the model deployment to invoke
- PEDAGOGY_POLICY_URI: the location of the pedagogy JSON policy

A starter template is available in [../src/HomeworkAgent/.env.example](../src/HomeworkAgent/.env.example).

## Pedagogy policy

The policy is stored as JSON and controls:

- helpLevel: hint_only, guided, worked_example, or full_solution
- maxStepsRevealed: how much progress the tutor can reveal at once
- allowDirectAnswers: whether the tutor may give a direct answer
- citationsRequired: whether the tutor must cite knowledge sources

The default policy is defined in [../src/HomeworkAgent/Pedagogy/pedagogy-policy.json](../src/HomeworkAgent/Pedagogy/pedagogy-policy.json).

## Knowledge sources

Knowledge sources are represented in [../toolbox/toolbox.yaml](../toolbox/toolbox.yaml). To add a new source:

1. Add the Azure AI Search connection details to the toolbox definition.
2. Update the index list for the new source.
3. Publish a new toolbox version through the professor portal workflow.
4. Keep the consumer endpoint stable so the agent does not need to be redeployed.
