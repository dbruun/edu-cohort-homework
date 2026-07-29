# EDU Homework Tutor — Foundry hosted agent (Python, Microsoft Agent Framework)
#
# A Responses-protocol hosted agent. It grounds every answer in the approved
# course materials by running an Azure AI Search query (AzureAISearchContextProvider)
# against the `course-materials` index before each model invocation, then cites the
# source. Deployed to Foundry Agent Service; invoked by the AG-UI bridge.

import asyncio
import logging
import os

from agent_framework import Agent
from agent_framework.azure import AzureAISearchContextProvider
from agent_framework.foundry import FoundryChatClient
from agent_framework_foundry_hosting import ResponsesHostServer
from azure.identity import DefaultAzureCredential
from dotenv import load_dotenv

load_dotenv()

logger = logging.getLogger(__name__)

TUTOR_INSTRUCTIONS = (
    "You are a homework tutor for students. Your goal is to build understanding, "
    "not to hand out answers.\n"
    "- Prefer hints, guiding questions, and step-by-step explanations over direct solutions.\n"
    "- Reveal only a few steps at a time and check the student's understanding before continuing.\n"
    "- Do not provide a complete solution to graded work; explain what you can help with instead.\n"
    "- Keep responses supportive, concise, and educational.\n"
    "\n"
    "Grounding: answer ONLY using the approved course-material context provided to you. "
    "Cite the source of each fact using the title/link in that context. Do NOT invent "
    "citations or use outside sources (e.g. CDC, WHO, Wikipedia). If the provided context "
    "does not cover the question, tell the student the course material does not cover it "
    "rather than answering from memory."
)


def _resolved_env(name: str) -> str:
    """Return an env var, treating un-substituted ``${VAR}``/``{{VAR}}`` placeholders as empty."""
    value = os.environ.get(name, "").strip()
    if (value.startswith("${") and value.endswith("}")) or (
        value.startswith("{{") and value.endswith("}}")
    ):
        return ""
    return value


async def main():
    credential = DefaultAzureCredential()

    client = FoundryChatClient(
        project_endpoint=os.environ["FOUNDRY_PROJECT_ENDPOINT"],
        model=os.environ["AZURE_AI_MODEL_DEPLOYMENT_NAME"],
        credential=credential,
    )

    search_endpoint = _resolved_env("AZURE_SEARCH_ENDPOINT")
    search_index_name = _resolved_env("AZURE_SEARCH_INDEX_NAME")
    context_providers = []
    if not (search_endpoint and search_index_name):
        logger.warning(
            "Azure Search environment variables are not fully set. The tutor will "
            "start, but course-material grounding will be unavailable."
        )
    else:
        # Ground answers in the approved course-materials index. The provider runs a
        # semantic search before each model invocation and injects the top matches.
        context_providers.append(
            AzureAISearchContextProvider(
                source_id="course_materials",
                endpoint=search_endpoint,
                index_name=search_index_name,
                credential=credential,
                mode="semantic",
                top_k=3,
            )
        )

    agent = Agent(
        client=client,
        name="homework-tutor",
        instructions=TUTOR_INSTRUCTIONS,
        context_providers=context_providers,
        # History is managed by the hosting infrastructure.
        default_options={"store": False},
    )

    server = ResponsesHostServer(agent)
    await server.run_async()
    if context_providers:
        await context_providers[0].close()


if __name__ == "__main__":
    asyncio.run(main())
