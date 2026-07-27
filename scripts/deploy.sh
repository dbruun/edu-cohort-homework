#!/usr/bin/env bash
set -euo pipefail

ENVIRONMENT_NAME="${1:-homework-tutor}"
LOCATION="${2:-northcentralus}"
MODEL_DEPLOYMENT_NAME="${3:-gpt-5.4-mini}"
# Optional: wire the course-knowledge Azure AI Search toolbox. Provide both to create the
# CognitiveSearch connection (course-knowledge-connection) the toolbox in azure.yaml references.
SEARCH_ENDPOINT="${4:-}"
SEARCH_ADMIN_KEY="${5:-}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Deploy the real EDU Homework Tutor: the repo-root azure.yaml wires the ai-project model,
# the course-knowledge Azure AI Search toolbox, and the src/HomeworkAgent hosted agent.
AGENT_PROJECT="$(cd "$SCRIPT_DIR/.." && pwd)"

echo "==> Installing required azd Foundry extensions..."
azd extension install azure.ai.projects   >/dev/null
azd extension install azure.ai.inspector  >/dev/null
azd extension install azure.ai.agents     >/dev/null
azd extension install azure.ai.toolboxes  >/dev/null

cd "$AGENT_PROJECT"

echo "==> Selecting/creating azd environment '$ENVIRONMENT_NAME' (resource group will be rg-$ENVIRONMENT_NAME)..."
if ! azd env select "$ENVIRONMENT_NAME" 2>/dev/null; then
  azd env new "$ENVIRONMENT_NAME" --no-prompt
fi

SUBSCRIPTION_ID="$(az account show --query id -o tsv)"
echo "==> Using subscription $SUBSCRIPTION_ID in $LOCATION"
azd env set AZURE_SUBSCRIPTION_ID "$SUBSCRIPTION_ID" >/dev/null
azd env set AZURE_LOCATION "$LOCATION" >/dev/null
# Must be set before deploy so the agent container starts with a valid model deployment.
azd env set AZURE_AI_MODEL_DEPLOYMENT_NAME "$MODEL_DEPLOYMENT_NAME" >/dev/null
# Pedagogy policy path (baked into the container image under ./Pedagogy).
azd env set PEDAGOGY_POLICY_URI "./Pedagogy/pedagogy-policy.json" >/dev/null

echo "==> Provisioning Foundry project + model..."
azd provision --no-prompt

if [[ -n "$SEARCH_ENDPOINT" && -n "$SEARCH_ADMIN_KEY" ]]; then
  echo "==> Creating course-knowledge-connection (Azure AI Search) for the toolbox..."
  azd ai connection create course-knowledge-connection \
    --kind cognitive-search \
    --target "$SEARCH_ENDPOINT" \
    --auth-type api-key \
    --key "$SEARCH_ADMIN_KEY"
else
  echo "WARNING: SearchEndpoint/SearchAdminKey not provided. Skipping course-knowledge-connection." >&2
  echo "WARNING: The course-knowledge toolbox references it, so 'azd deploy' will fail until it exists." >&2
  echo "WARNING: Create it once with:" >&2
  echo "  azd ai connection create course-knowledge-connection --kind cognitive-search --target \"https://<search>.search.windows.net/\" --auth-type api-key --key \"<admin-key>\"" >&2
fi

echo "==> Deploying toolbox + hosted agent..."
azd deploy --no-prompt

echo "==> Smoke testing the deployed agent..."
azd ai agent invoke "Can you help me get started on a homework problem?"

echo "==> Done. View the agent with: azd ai agent show --output json"
