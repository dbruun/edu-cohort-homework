#!/usr/bin/env bash
# Deploys the HANDS-ON LAB infrastructure via the Azure Developer CLI (azd): a
# Foundry account + project, two model deployments, and an Azure AI Search service
# (with RBAC + connection for portal knowledge-base grounding). Slim lab stack —
# no hosted agent, LTI tool, or ACR.
#
# Creates/selects a dedicated azd environment, sets subscription/region, and runs
# `azd up` to provision lab/infra and deploy the professor portal.
#
# Requires: azd + Azure CLI, logged in (`azd auth login`, `az login`), and
# permission to create resource groups AND role assignments at the subscription
# (Owner, or Contributor + User Access Administrator).
#
# Usage: ./lab/deploy.sh <environment-name> [location] [search-sku] [portal-auth-client-id]
#   e.g. ./lab/deploy.sh eduhw01 northcentralus basic 00000000-0000-0000-0000-000000000000
#
# The professor portal requires Entra sign-in. Pass the app registration's client
# ID as the 4th argument (or set PORTAL_AUTH_CLIENT_ID). Supply the credential
# either as PORTAL_AUTH_CLIENT_SECRET, or via the three PORTAL_AUTH_KEY_VAULT_*
# / PORTAL_AUTH_CLIENT_SECRET_NAME variables. The secret is never accepted as a
# positional argument, so it stays out of shell history and the process list.
set -euo pipefail

ENV_NAME="${1:?Usage: ./lab/deploy.sh <environment-name> [location] [search-sku] [portal-auth-client-id]}"
LOCATION="${2:-northcentralus}"
SEARCH_SKU="${3:-basic}"

PORTAL_AUTH_CLIENT_ID="${4:-${PORTAL_AUTH_CLIENT_ID:-}}"
PORTAL_AUTH_CLIENT_SECRET="${PORTAL_AUTH_CLIENT_SECRET:-}"
PORTAL_AUTH_KEY_VAULT_RESOURCE_GROUP="${PORTAL_AUTH_KEY_VAULT_RESOURCE_GROUP:-}"
PORTAL_AUTH_KEY_VAULT_NAME="${PORTAL_AUTH_KEY_VAULT_NAME:-}"
PORTAL_AUTH_CLIENT_SECRET_NAME="${PORTAL_AUTH_CLIENT_SECRET_NAME:-}"

kv_set=0
for v in "$PORTAL_AUTH_KEY_VAULT_RESOURCE_GROUP" "$PORTAL_AUTH_KEY_VAULT_NAME" "$PORTAL_AUTH_CLIENT_SECRET_NAME"; do
  [ -n "$v" ] && kv_set=$((kv_set + 1))
done

if [ -n "$PORTAL_AUTH_CLIENT_ID" ]; then
  if [ -n "$PORTAL_AUTH_CLIENT_SECRET" ] && [ "$kv_set" -ne 0 ]; then
    echo "Supply either PORTAL_AUTH_CLIENT_SECRET or the PORTAL_AUTH_KEY_VAULT_* variables, not both." >&2
    exit 1
  fi
  if [ -z "$PORTAL_AUTH_CLIENT_SECRET" ] && [ "$kv_set" -eq 0 ]; then
    read -rsp "Entra client secret for $PORTAL_AUTH_CLIENT_ID: " PORTAL_AUTH_CLIENT_SECRET
    echo
  fi
  if [ -z "$PORTAL_AUTH_CLIENT_SECRET" ] && [ "$kv_set" -ne 3 ]; then
    echo "Easy Auth requires PORTAL_AUTH_CLIENT_SECRET, or all three PORTAL_AUTH_KEY_VAULT_* variables." >&2
    exit 1
  fi
else
  echo "WARNING: no portal-auth-client-id supplied. Easy Auth will NOT be configured" >&2
  echo "         and the professor portal will reject every API call." >&2
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "==> Selecting/creating azd environment '$ENV_NAME'..."
azd env select "$ENV_NAME" 2>/dev/null || azd env new "$ENV_NAME" --no-prompt

SUBSCRIPTION_ID="$(az account show --query id -o tsv)"
TENANT_ID="$(az account show --query tenantId -o tsv)"
echo "==> Using subscription $SUBSCRIPTION_ID in $LOCATION (search=$SEARCH_SKU)"
azd env set AZURE_SUBSCRIPTION_ID "$SUBSCRIPTION_ID" >/dev/null
azd env set AZURE_TENANT_ID "$TENANT_ID" >/dev/null
azd env set AZURE_LOCATION "$LOCATION" >/dev/null
azd env set SEARCH_SKU "$SEARCH_SKU" >/dev/null
azd env set PORTAL_AUTH_CLIENT_ID "$PORTAL_AUTH_CLIENT_ID" >/dev/null
azd env set PORTAL_AUTH_CLIENT_SECRET "$PORTAL_AUTH_CLIENT_SECRET" >/dev/null
azd env set PORTAL_AUTH_KEY_VAULT_RESOURCE_GROUP "$PORTAL_AUTH_KEY_VAULT_RESOURCE_GROUP" >/dev/null
azd env set PORTAL_AUTH_KEY_VAULT_NAME "$PORTAL_AUTH_KEY_VAULT_NAME" >/dev/null
azd env set PORTAL_AUTH_CLIENT_SECRET_NAME "$PORTAL_AUTH_CLIENT_SECRET_NAME" >/dev/null

echo "==> Provisioning the lab and deploying the professor portal (a few minutes)..."
azd up --no-prompt

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
echo "  embeddings model  : $(get EMBEDDING_DEPLOYMENT_NAME)"
echo "  professor portal  : $(get PORTAL_URL)"
echo "  policy storage    : $(get POLICY_STORAGE_ACCOUNT)"
echo ""
echo "Next: seed the knowledge base ->"
echo "  python ../scripts/setup-knowledge-base.py --environment-name $ENV_NAME"
