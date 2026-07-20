# Managing knowledge sources

The tutor uses a Foundry Toolbox MCP endpoint. To add more knowledge without redeploying the agent:

1. Create or update an Azure AI Search resource and index.
2. Add a Foundry project connection for that resource.
3. Update the toolbox definition in `toolbox/toolbox.yaml` with the new index.
4. Publish a new toolbox version from the Foundry portal or SDK.
5. Point the hosted agent at the toolbox consumer endpoint; the consumer endpoint will continue to serve the active default version.
