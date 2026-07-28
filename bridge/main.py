# AG-UI bridge for the EDU Homework Tutor.
#
# Thin, backend-AGNOSTIC service. It does NOT define the tutor. It invokes a
# Foundry agent BY NAME via `FoundryAgent` and re-exposes it over the AG-UI (SSE)
# protocol for the browser chat UI. `FoundryAgent` is Foundry's agent-native way
# to invoke *any* agent in a project — it abstracts over the two backend shapes:
#
#   * Hosted agent  (container-backed, e.g. our Python MAF agent): reference by
#     name; set FOUNDRY_ALLOW_PREVIEW=true so calls route through the per-agent
#     endpoint (.../agents/<name>/endpoint/protocols/openai).
#   * Prompt / "traditional" Foundry agent: reference by name + version
#     (FOUNDRY_AGENT_VERSION); FOUNDRY_ALLOW_PREVIEW can be false.
#
# Only configuration differs between the two — the bridge code and the UI stay the
# same. So moving to a single Foundry agent later is an env change, not a rewrite.

import os

from agent_framework.ag_ui import add_agent_framework_fastapi_endpoint
from agent_framework.foundry import FoundryAgent
from azure.identity.aio import DefaultAzureCredential
from dotenv import load_dotenv
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

load_dotenv()

PROJECT_ENDPOINT = os.environ.get("FOUNDRY_PROJECT_ENDPOINT", "")
# Accept either FOUNDRY_AGENT_NAME (Foundry convention) or HOSTED_AGENT_NAME.
AGENT_NAME = os.environ.get("FOUNDRY_AGENT_NAME") or os.environ.get("HOSTED_AGENT_NAME", "homework-tutor")
# Optional — required only for prompt/traditional agents referenced by version.
AGENT_VERSION = os.environ.get("FOUNDRY_AGENT_VERSION") or None
# Hosted agents currently require the preview per-agent-endpoint route; prompt
# agents can use the non-preview agent_reference route. Defaults to hosted.
ALLOW_PREVIEW = os.environ.get("FOUNDRY_ALLOW_PREVIEW", "true").strip().lower() in ("1", "true", "yes")
ALLOWED_ORIGINS = [o.strip() for o in os.environ.get("ALLOWED_ORIGINS", "*").split(",") if o.strip()]

app = FastAPI(title="Homework Tutor AG-UI bridge")
app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=ALLOWED_ORIGINS != ["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
def health() -> dict:
    return {
        "status": "ok",
        "agent": AGENT_NAME,
        "agentVersion": AGENT_VERSION,
        "allowPreview": ALLOW_PREVIEW,
        "hasProjectEndpoint": bool(PROJECT_ENDPOINT),
    }


if PROJECT_ENDPOINT:
    # Invoke the Foundry agent by name — same call for hosted or prompt agents.
    agent_kwargs = {
        "project_endpoint": PROJECT_ENDPOINT,
        "agent_name": AGENT_NAME,
        "credential": DefaultAzureCredential(),
        "allow_preview": ALLOW_PREVIEW,
    }
    if AGENT_VERSION:
        agent_kwargs["agent_version"] = AGENT_VERSION
    agent = FoundryAgent(**agent_kwargs)
    add_agent_framework_fastapi_endpoint(app, agent, path="/")
