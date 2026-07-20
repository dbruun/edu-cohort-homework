#!/usr/bin/env bash
set -euo pipefail

ENVIRONMENT_NAME="${1:-dev}"
LOCATION="${2:-eastus2}"
FOUNDRY_PROJECT_ENDPOINT="${3:-${FOUNDRY_PROJECT_ENDPOINT:-https://example.services.ai.azure.com/api/projects/demo}}"
TOOLBOX_ENDPOINT="${4:-${TOOLBOX_ENDPOINT:-https://example.services.ai.azure.com/api/projects/demo/toolboxes/homework-toolbox/mcp?api-version=v1}}"
MODEL_DEPLOYMENT_NAME="${5:-${AZURE_AI_MODEL_DEPLOYMENT_NAME:-gpt-4o}}"

echo "Provisioning Azure resources for $ENVIRONMENT_NAME in $LOCATION..."

if ! azd env select "$ENVIRONMENT_NAME" >/dev/null 2>&1; then
  azd env new "$ENVIRONMENT_NAME" --no-prompt >/dev/null
fi

azd env set AZURE_LOCATION "$LOCATION" >/dev/null
azd env set FOUNDRY_PROJECT_ENDPOINT "$FOUNDRY_PROJECT_ENDPOINT" >/dev/null
azd env set TOOLBOX_ENDPOINT "$TOOLBOX_ENDPOINT" >/dev/null
azd env set AZURE_AI_MODEL_DEPLOYMENT_NAME "$MODEL_DEPLOYMENT_NAME" >/dev/null
azd env set PEDAGOGY_POLICY_URI "./Pedagogy/pedagogy-policy.json" >/dev/null

azd provision --environment "$ENVIRONMENT_NAME"
azd deploy --environment "$ENVIRONMENT_NAME"
