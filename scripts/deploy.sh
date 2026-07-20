#!/usr/bin/env bash
set -euo pipefail

ENVIRONMENT_NAME="${1:-homework-tutor}"
LOCATION="${2:-northcentralus}"
MODEL_DEPLOYMENT_NAME="${3:-gpt-5.4-mini}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGENT_PROJECT="$(cd "$SCRIPT_DIR/../foundry-tutor/hello-world-dotnet-agent-framework" && pwd)"

echo "==> Installing required azd Foundry extensions..."
azd extension install azure.ai.projects  >/dev/null
azd extension install azure.ai.inspector >/dev/null
azd extension install azure.ai.agents    >/dev/null

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

echo "==> Provisioning Foundry project + model..."
azd provision --no-prompt

echo "==> Deploying hosted agent..."
azd deploy --no-prompt

echo "==> Smoke testing the deployed agent..."
azd ai agent invoke "Can you help me get started on a homework problem?"

echo "==> Done. View the agent with: azd ai agent show --output json"
