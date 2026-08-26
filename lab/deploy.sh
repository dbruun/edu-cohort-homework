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
# ID as the 4th argument (or set PORTAL_AUTH_CLIENT_ID), plus
# PORTAL_AUTH_KEY_VAULT_RESOURCE_GROUP and PORTAL_AUTH_KEY_VAULT_NAME. The vault
# and secret are created here if missing, prompting for the secret value. That
# value is written straight to Key Vault and is never passed as an argument,
# stored in the azd environment, or set on the site, so it cannot reach shell
# history, the process list, or a file on disk.
set -euo pipefail

ENV_NAME="${1:?Usage: ./lab/deploy.sh <environment-name> [location] [search-sku] [portal-auth-client-id]}"
LOCATION="${2:-northcentralus}"
SEARCH_SKU="${3:-basic}"

PORTAL_AUTH_CLIENT_ID="${4:-${PORTAL_AUTH_CLIENT_ID:-}}"
PORTAL_AUTH_KEY_VAULT_RESOURCE_GROUP="${PORTAL_AUTH_KEY_VAULT_RESOURCE_GROUP:-}"
PORTAL_AUTH_KEY_VAULT_NAME="${PORTAL_AUTH_KEY_VAULT_NAME:-}"
PORTAL_AUTH_CLIENT_SECRET_NAME="${PORTAL_AUTH_CLIENT_SECRET_NAME:-portal-auth-client-secret}"

# Easy Auth is the portal's only authentication, so a deployment missing any of
# these would serve every professor's imports to anonymous callers. Fail here
# rather than letting the template deploy something unprotected.
if [ -z "$PORTAL_AUTH_CLIENT_ID" ]; then
  echo "PORTAL_AUTH_CLIENT_ID is required: the portal has no authentication without it." >&2
  exit 1
fi
if [ -z "$PORTAL_AUTH_KEY_VAULT_RESOURCE_GROUP" ] || [ -z "$PORTAL_AUTH_KEY_VAULT_NAME" ]; then
  echo "PORTAL_AUTH_KEY_VAULT_RESOURCE_GROUP and PORTAL_AUTH_KEY_VAULT_NAME are required." >&2
  echo "The Entra client secret is read from Key Vault; it is never stored as a site setting." >&2
  exit 1
fi

# The template references the vault as an existing resource and App Service reads
# the secret from it at runtime, so both have to exist before provisioning.
echo "==> Checking Key Vault '$PORTAL_AUTH_KEY_VAULT_NAME'..."
if ! az group show -n "$PORTAL_AUTH_KEY_VAULT_RESOURCE_GROUP" -o none 2>/dev/null; then
  echo "    creating resource group '$PORTAL_AUTH_KEY_VAULT_RESOURCE_GROUP'"
  az group create -n "$PORTAL_AUTH_KEY_VAULT_RESOURCE_GROUP" -l "$LOCATION" -o none
fi

if ! az keyvault show -g "$PORTAL_AUTH_KEY_VAULT_RESOURCE_GROUP" -n "$PORTAL_AUTH_KEY_VAULT_NAME" -o none 2>/dev/null; then
  echo "    creating vault '$PORTAL_AUTH_KEY_VAULT_NAME'"
  az keyvault create -g "$PORTAL_AUTH_KEY_VAULT_RESOURCE_GROUP" -n "$PORTAL_AUTH_KEY_VAULT_NAME" \
    --location "$LOCATION" --enable-rbac-authorization true --enable-purge-protection true \
    --retention-days 90 -o none
fi

# An RBAC vault grants its creator nothing, so writing the secret needs an
# explicit role. Re-running is harmless: an existing assignment is not an error.
VAULT_ID="$(az keyvault show -g "$PORTAL_AUTH_KEY_VAULT_RESOURCE_GROUP" -n "$PORTAL_AUTH_KEY_VAULT_NAME" --query id -o tsv)"
CALLER_ID="$(az ad signed-in-user show --query id -o tsv 2>/dev/null || true)"
if [ -n "$CALLER_ID" ]; then
  az role assignment create --assignee-object-id "$CALLER_ID" --assignee-principal-type User \
    --role 'Key Vault Secrets Officer' --scope "$VAULT_ID" -o none 2>/dev/null || true
fi

# Confirm the data plane is actually usable before asking for a credential. A
# tenant policy can create the vault with public access disabled, which makes
# every secret operation fail; so can RBAC that has not propagated yet. Both
# surface the same way as a missing secret, so probe first and let a genuine
# "not found" be the only ambiguity left. Retry briefly, because a role assigned
# seconds ago routinely takes a moment to take effect.
PROBE_OK=0
for attempt in 1 2 3 4 5 6; do
  if PROBE_ERR=$(az keyvault secret list --vault-name "$PORTAL_AUTH_KEY_VAULT_NAME" --maxresults 1 -o none 2>&1); then
    PROBE_OK=1
    break
  fi
  if [ "$attempt" -lt 6 ]; then
    echo "    waiting for vault access to take effect..."
    sleep 10
  fi
done

if [ "$PROBE_OK" -ne 1 ]; then
  echo >&2
  if [ "$(az keyvault show -g "$PORTAL_AUTH_KEY_VAULT_RESOURCE_GROUP" -n "$PORTAL_AUTH_KEY_VAULT_NAME" --query 'properties.publicNetworkAccess' -o tsv 2>/dev/null)" = "Disabled" ]; then
    echo "ERROR: Key Vault '$PORTAL_AUTH_KEY_VAULT_NAME' has public network access disabled," >&2
    echo "       so neither this script nor App Service can reach it. This is usually a" >&2
    echo "       tenant policy applied at creation. Make the vault reachable, then re-run:" >&2
    echo "         - grant an exemption and run: az keyvault update -g $PORTAL_AUTH_KEY_VAULT_RESOURCE_GROUP -n $PORTAL_AUTH_KEY_VAULT_NAME --public-network-access Enabled" >&2
    echo "         - or add a private endpoint reachable from both this machine and the App Service subnet" >&2
  else
    echo "ERROR: Cannot read secrets from '$PORTAL_AUTH_KEY_VAULT_NAME'. Confirm the signed-in" >&2
    echo "       account holds 'Key Vault Secrets Officer' on the vault, then re-run." >&2
  fi
  echo "       Details: $PROBE_ERR" >&2
  echo >&2
  exit 1
fi

# The data plane is known good, so a failure here means the secret is absent.
if az keyvault secret show --vault-name "$PORTAL_AUTH_KEY_VAULT_NAME" --name "$PORTAL_AUTH_CLIENT_SECRET_NAME" -o none 2>/dev/null; then
  echo "    secret '$PORTAL_AUTH_CLIENT_SECRET_NAME' already present; leaving it unchanged"
else
  echo
  echo "Enter the Entra client secret for app registration $PORTAL_AUTH_CLIENT_ID."
  echo "It is written directly to Key Vault and is not echoed or saved locally."
  read -rsp 'Client secret: ' PORTAL_AUTH_CLIENT_SECRET_VALUE
  echo
  if [ -z "$PORTAL_AUTH_CLIENT_SECRET_VALUE" ]; then
    echo "No client secret was entered." >&2
    exit 1
  fi
  az keyvault secret set --vault-name "$PORTAL_AUTH_KEY_VAULT_NAME" \
    --name "$PORTAL_AUTH_CLIENT_SECRET_NAME" --value "$PORTAL_AUTH_CLIENT_SECRET_VALUE" -o none
  unset PORTAL_AUTH_CLIENT_SECRET_VALUE
  echo "    stored '$PORTAL_AUTH_CLIENT_SECRET_NAME'"
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
# The extraction worker is now deployed by azd up along with the portal and the
# dispatcher, so it no longer needs a manual publishing step here.
echo "Next steps ->"
echo "  1. create the search objects the portal and the import pipeline read:"
echo "     pwsh ../scripts/setup-policy-ingestion.ps1 -EnvironmentName $ENV_NAME"
echo "     pwsh ../scripts/setup-knowledge-bases.ps1  -EnvironmentName $ENV_NAME"
echo "     (in that order: the second builds a knowledge source over the"
echo "      policy index the first creates, and fails without it)"
echo "  2. optional, to answer questions before any course is imported:"
echo "     python ../scripts/setup-knowledge-base.py --environment-name $ENV_NAME"
echo "     (loads the sample content into its own 'course-materials' index,"
echo "      and takes over the 'course-knowledge-base' name from step 2)"
