<#
.SYNOPSIS
  Create the single Foundry homework-tutor agent (model + instructions).

.DESCRIPTION
  Creates a declarative Foundry agent in the existing project via the AGENTS API.
  It does NOT wire grounding or grant any permissions — that is done in the Foundry
  portal as a hands-on exercise: attendees attach the course knowledge base to the
  agent and grant its access through the UI, then test in the playground.

  Note: Foundry provisions a dedicated managed identity per agent
  ("<account>-<project>-<agent>-AgentIdentity"). When you attach a knowledge base
  or search tool in the portal, grant that identity access to the search service.
#>
[CmdletBinding()]
param(
  # Your Foundry project endpoint, e.g. https://aif-<env>.services.ai.azure.com/api/projects/homework
  [Parameter(Mandatory = $true)]
  [string]$ProjectEndpoint,
  [string]$Model = "gpt-5.4-mini",
  [string]$AgentName = "homework-tutor"
)

$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

# Create the agent (Python, v2 agents API).
if (-not (Test-Path .venv)) { py -3.13 -m venv .venv }
& .\.venv\Scripts\python.exe -m pip install -q --disable-pip-version-check azure-ai-projects azure-ai-agents azure-identity python-dotenv

$env:PROJECT_ENDPOINT = $ProjectEndpoint
$env:MODEL_DEPLOYMENT_NAME = $Model
$env:AGENT_NAME = $AgentName
& .\.venv\Scripts\python.exe create-foundry-agent.py

Write-Host ""
Write-Host "Agent created. In the Foundry portal: attach the course knowledge base to"
Write-Host "'$AgentName', grant its access, and test it in the playground."
