#!/usr/bin/env bash
# Deploys the HANDS-ON LAB infrastructure via the Azure Developer CLI (azd): a
# Foundry account + project, two model deployments, and an Azure AI Search service
# (with RBAC + connection for portal knowledge-base grounding). Slim lab stack —
# no hosted agent, LTI tool, or ACR.
#
# Creates/selects a dedicated azd environment, sets subscription/region, and runs
# `azd provision` against lab/infra (subscription-scoped Bicep that creates
# rg-<token>).
#
# Requires: azd + Azure CLI, logged in (`azd auth login`, `az login`), and
# permission to create resource groups AND role assignments at the subscription
# (Owner, or Contributor + User Access Administrator).
#
# Usage: ./lab/deploy.sh <environment-name> [location] [search-sku]
#   e.g. ./lab/deploy.sh eduhw01 northcentralus basic
set -euo pipefail

ENV_NAME="${1:?Usage: ./lab/deploy.sh <environment-name> [location] [search-sku]}"
LOCATION="${2:-northcentralus}"
SEARCH_SKU="${3:-basic}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "==> Selecting/creating azd environment '$ENV_NAME'..."
azd env select "$ENV_NAME" 2>/dev/null || azd env new "$ENV_NAME" --no-prompt

SUBSCRIPTION_ID="$(az account show --query id -o tsv)"
echo "==> Using subscription $SUBSCRIPTION_ID in $LOCATION (search=$SEARCH_SKU)"
azd env set AZURE_SUBSCRIPTION_ID "$SUBSCRIPTION_ID" >/dev/null
azd env set AZURE_LOCATION "$LOCATION" >/dev/null
azd env set SEARCH_SKU "$SEARCH_SKU" >/dev/null

echo "==> Provisioning Foundry + models + Azure AI Search (a few minutes)..."
azd provision --no-prompt

get() { azd env get-value "$1" 2>/dev/null; }

echo ""
echo "Lab infrastructure deployed (azd env '$ENV_NAME')."
echo "  resource group    : $(get RESOURCE_GROUP_NAME)"
echo "  Foundry account   : $(get FOUNDRY_ACCOUNT_NAME)"
echo "  Foundry project   : $(get FOUNDRY_PROJECT_NAME)"
echo "  project endpoint  : $(get FOUNDRY_PROJECT_ENDPOINT)"
echo "  search service    : $(get SEARCH_SERVICE_NAME)"
echo "  chat model        : $(get CHAT_DEPLOYMENT_NAME)"
echo "  KB reasoning model: $(get KB_REASONING_DEPLOYMENT_NAME)"
echo ""
echo "Next: seed the knowledge base ->"
echo "  ./scripts/setup-knowledge-base.ps1 -EnvironmentName $ENV_NAME"
