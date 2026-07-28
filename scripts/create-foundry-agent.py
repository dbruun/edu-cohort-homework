"""Create (or update) the single Foundry homework-tutor agent.

Runs against your existing Foundry project (set via PROJECT_ENDPOINT). This creates
a standard declarative Foundry agent (AGENTS api, not assistants) with the tutor
model + instructions.

Grounding is attached in the Foundry portal: attendees add the course knowledge
base to this agent (and grant its access) through the UI. That's a deliberate
learning exercise — and the portal wires the knowledge-base connection and the
per-agent identity's permissions correctly.

Env:
  PROJECT_ENDPOINT          Foundry project endpoint (required)
  MODEL_DEPLOYMENT_NAME     model deployment (default gpt-5.4-mini)
  AGENT_NAME                agent name (default homework-tutor)
"""

import os

from azure.ai.projects import AIProjectClient
from azure.ai.projects.models import PromptAgentDefinition
from azure.identity import DefaultAzureCredential
from dotenv import load_dotenv

load_dotenv()

PROJECT_ENDPOINT = os.environ["PROJECT_ENDPOINT"]
MODEL = os.environ.get("MODEL_DEPLOYMENT_NAME", "gpt-5.4-mini")
AGENT_NAME = os.environ.get("AGENT_NAME", "homework-tutor")

INSTRUCTIONS = (
    "You are a homework tutor for students. Your goal is to build understanding, "
    "not to hand out answers.\n"
    "- Prefer hints, guiding questions, and step-by-step explanations over direct solutions.\n"
    "- Reveal only a few steps at a time and check the student's understanding before continuing.\n"
    "- Do not provide a complete solution to graded work; explain what you can help with instead.\n"
    "- Keep responses supportive, concise, and educational.\n"
    "\n"
    "Grounding: when a course knowledge base is attached, use it to retrieve approved "
    "course material before answering any subject-matter question, and base your answer "
    "only on what it returns. Cite the source of each fact. Do NOT invent citations or use "
    "outside sources (e.g. CDC, WHO, Wikipedia). If nothing relevant is found, tell the "
    "student the course material does not cover the topic rather than answering from memory."
)


def main() -> None:
    credential = DefaultAzureCredential(exclude_interactive_browser_credential=False)
    with AIProjectClient(endpoint=PROJECT_ENDPOINT, credential=credential) as project_client:
        definition = PromptAgentDefinition(model=MODEL, instructions=INSTRUCTIONS)

        # create_version creates the named agent if new, or adds a version if it exists.
        version = project_client.agents.create_version(agent_name=AGENT_NAME, definition=definition)
        ver = getattr(version, "version", None) or getattr(version, "id", "?")
        print(f"Created/updated agent '{AGENT_NAME}' (version {ver}), model={MODEL}")
        print("Next: in the Foundry portal, attach the course knowledge base to this agent")
        print("and grant its access, then test in the playground.")


if __name__ == "__main__":
    main()
