#!/usr/bin/env bash
set -euo pipefail

ENVIRONMENT_NAME="${1:-homework-tutor}"
LOCATION="${2:-northcentralus}"
MODEL_DEPLOYMENT_NAME="${3:-gpt-5.4-mini}"
# Deploy into an EXISTING Foundry project instead of provisioning a new one. Pass the project
# endpoint (e.g. https://<account>.services.ai.azure.com/api/projects/<project>). When set, the
# script resolves the project ARM ID + resource group and skips `azd provision`.
PROJECT_ENDPOINT="${4:-}"
# Course-knowledge Azure AI Search toolbox. Empty (default) = tutor-only deploy, no knowledge
# grounding, no Search prerequisites. To enable: uncomment the `course-knowledge` service in
# azure.yaml, set TOOLBOX_NAME=course-knowledge, and provide the Search endpoint + key below.
TOOLBOX_NAME_ARG="${5:-}"
SEARCH_ENDPOINT="${6:-}"
SEARCH_ADMIN_KEY="${7:-}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Deploy the EDU Homework Tutor from the repo-root azure.yaml (ai-project model + src/HomeworkAgent
# hosted agent, with the pedagogy policy composed into the agent's instructions).
AGENT_PROJECT="$(cd "$SCRIPT_DIR/.." && pwd)"

echo "==> Checking Azure CLI login..."
if ! az account show >/dev/null 2>&1; then
  echo "Not logged in. Run 'az login' (and 'azd auth login'), then re-run." >&2
  exit 1
fi
SUBSCRIPTION_ID="$(az account show --query id -o tsv)"
TENANT_ID="$(az account show --query tenantId -o tsv)"
echo "    Subscription: $SUBSCRIPTION_ID"

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

echo "==> Setting core azd environment values..."
azd env set AZURE_SUBSCRIPTION_ID "$SUBSCRIPTION_ID" >/dev/null
azd env set AZURE_TENANT_ID "$TENANT_ID" >/dev/null
azd env set AZURE_LOCATION "$LOCATION" >/dev/null
# Must be set before deploy so the agent starts with a valid model deployment.
azd env set AZURE_AI_MODEL_DEPLOYMENT_NAME "$MODEL_DEPLOYMENT_NAME" >/dev/null
# Pedagogy policy path (baked into the image under ./Pedagogy).
azd env set PEDAGOGY_POLICY_URI "./Pedagogy/pedagogy-policy.json" >/dev/null
# Empty = tutor only; a name attaches that Foundry Toolbox for course-knowledge grounding.
azd env set TOOLBOX_NAME "$TOOLBOX_NAME_ARG" >/dev/null

if [[ -n "$PROJECT_ENDPOINT" ]]; then
  echo "==> Using existing Foundry project (skipping provision)..."
  ACCOUNT_HOST="${PROJECT_ENDPOINT#*://}"; ACCOUNT_HOST="${ACCOUNT_HOST%%.*}"
  PROJECT_NAME="${PROJECT_ENDPOINT##*/projects/}"; PROJECT_NAME="${PROJECT_NAME%%\?*}"; PROJECT_NAME="${PROJECT_NAME%/}"
  ACCOUNT_ID="$(az resource list --resource-type "Microsoft.CognitiveServices/accounts" \
    --query "[?name=='$ACCOUNT_HOST'].id | [0]" -o tsv)"
  if [[ -z "$ACCOUNT_ID" ]]; then
    echo "Foundry account '$ACCOUNT_HOST' not found in subscription $SUBSCRIPTION_ID." >&2
    exit 1
  fi
  RESOURCE_GROUP="$(az resource list --resource-type "Microsoft.CognitiveServices/accounts" \
    --query "[?name=='$ACCOUNT_HOST'].resourceGroup | [0]" -o tsv)"

  azd env set AZURE_AI_PROJECT_ENDPOINT "$PROJECT_ENDPOINT" >/dev/null
  azd env set FOUNDRY_PROJECT_ENDPOINT "$PROJECT_ENDPOINT" >/dev/null
  azd env set AZURE_AI_PROJECT_ID "$ACCOUNT_ID/projects/$PROJECT_NAME" >/dev/null
  azd env set AZURE_RESOURCE_GROUP "$RESOURCE_GROUP" >/dev/null
  echo "    Project '$PROJECT_NAME' in resource group '$RESOURCE_GROUP'."
else
  echo "==> Provisioning Foundry project + model..."
  azd provision --no-prompt
fi

if [[ -n "$TOOLBOX_NAME_ARG" && -n "$SEARCH_ENDPOINT" && -n "$SEARCH_ADMIN_KEY" ]]; then
  echo "==> Creating $TOOLBOX_NAME_ARG search connection (course-knowledge-connection)..."
  azd ai connection create course-knowledge-connection \
    --kind cognitive-search \
    --target "$SEARCH_ENDPOINT" \
    --auth-type api-key \
    --key "$SEARCH_ADMIN_KEY"
elif [[ -n "$TOOLBOX_NAME_ARG" ]]; then
  echo "WARNING: TOOLBOX_NAME '$TOOLBOX_NAME_ARG' set but SearchEndpoint/SearchAdminKey missing." >&2
  echo "WARNING: Ensure the toolbox service is uncommented in azure.yaml and its connection + index exist, or deploy will fail." >&2
fi

echo "==> Deploying hosted agent..."
azd deploy homework-agent --no-prompt

echo "==> Smoke testing the deployed agent..."
azd ai agent invoke homework-agent "Can you help me get started on a homework problem?"

echo "==> Done. View the agent with: azd ai agent show homework-agent --output json"
