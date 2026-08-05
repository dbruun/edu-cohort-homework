"""Create and seed the Azure AI Search knowledge base for the homework tutor.

The Azure resources are provisioned separately. This script creates the
data-plane index, uploads course documents, and creates the knowledge source
and knowledge base. It is idempotent and requires only Python 3 and Azure CLI.
"""

from __future__ import annotations

import argparse
from html.parser import HTMLParser
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import sys
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen
import xml.etree.ElementTree as ElementTree
import zipfile


DEFAULT_API_VERSION = "2026-04-01"
KB_MODEL_NAMES = ("gpt-5.4-mini", "gpt-5.4-nano", "gpt-5-mini", "gpt-5-nano")
IMSCC_TEXT_EXTENSIONS = {".htm", ".html", ".md", ".txt", ".xml"}
MAX_IMSCC_MEMBER_BYTES = 10 * 1024 * 1024


class HTMLTextExtractor(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.parts: list[str] = []
        self.ignored_depth = 0

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag in {"script", "style"}:
            self.ignored_depth += 1

    def handle_endtag(self, tag: str) -> None:
        if tag in {"script", "style"} and self.ignored_depth:
            self.ignored_depth -= 1

    def handle_data(self, data: str) -> None:
        if not self.ignored_depth:
            self.parts.append(data)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Create the Azure AI Search index, knowledge source, and knowledge "
            "base, then load the sample course material."
        )
    )
    parser.add_argument(
        "--environment-name",
        help="azd environment name; resolves the resource group as rg-<name-without-hyphens>",
    )
    parser.add_argument("--resource-group", help="Azure resource group name")
    parser.add_argument("--search-service", help="Azure AI Search service name")
    parser.add_argument("--foundry-account", help="Microsoft Foundry AIServices account name")
    parser.add_argument("--index-name", default="course-materials")
    parser.add_argument("--knowledge-source-name", default="course-materials-source")
    parser.add_argument("--knowledge-base-name", default="course-knowledge-base")
    parser.add_argument("--kb-model-deployment", default="gpt-5.4-mini")
    parser.add_argument("--kb-model-name", choices=KB_MODEL_NAMES, default="gpt-5.4-mini")
    parser.add_argument("--embedding-deployment", default="text-embedding-3-small")
    parser.add_argument("--embedding-model-name", default="text-embedding-3-small")
    parser.add_argument("--embedding-dimensions", type=int, default=1536)
    parser.add_argument("--openai-api-version", default="2024-10-21")
    parser.add_argument("--api-version", default=DEFAULT_API_VERSION)
    parser.add_argument(
        "--seed-data-path",
        type=Path,
        default=Path(__file__).resolve().parent / "seed-data" / "microbiology.json",
    )
    parser.add_argument(
        "--imscc-path",
        type=Path,
        help="Canvas IMSCC export to import instead of the JSON seed data",
    )
    parser.add_argument(
        "--subject",
        help="Course name to associate with imported IMSCC documents",
    )
    return parser.parse_args()


def resolve_resource_group(resource_group: str | None, environment_name: str | None) -> str:
    if resource_group:
        return resource_group
    if environment_name:
        return f"rg-{environment_name.replace('-', '')}"
    raise ValueError(
        "Provide --resource-group or --environment-name so the resource group can be resolved."
    )


def azure_cli_command(arguments: list[str]) -> list[str]:
    az_path = shutil.which("az")
    if not az_path:
        raise RuntimeError("Azure CLI was not found. Install it and run 'az login' first.")
    return [az_path, *arguments]


def run_az(*arguments: str) -> str:
    result = subprocess.run(
        azure_cli_command(list(arguments)),
        check=False,
        capture_output=True,
        text=True,
        encoding="utf-8",
    )
    if result.returncode != 0:
        detail = result.stderr.strip() or result.stdout.strip() or "unknown Azure CLI error"
        raise RuntimeError(f"Azure CLI command failed: {detail}")
    return result.stdout.strip()


class SearchClient:
    def __init__(self, endpoint: str, api_version: str, access_token: str) -> None:
        self.endpoint = endpoint.rstrip("/")
        self.api_version = api_version
        self.headers = {
            "Authorization": f"Bearer {access_token}",
            "Content-Type": "application/json",
        }

    def request(
        self,
        method: str,
        path: str,
        body: dict[str, Any],
        *,
        return_representation: bool = False,
    ) -> Any:
        url = f"{self.endpoint}{path}?{urlencode({'api-version': self.api_version})}"
        headers = dict(self.headers)
        if return_representation:
            headers["Prefer"] = "return=representation"
        request = Request(
            url,
            data=json.dumps(body).encode("utf-8"),
            headers=headers,
            method=method.upper(),
        )
        try:
            with urlopen(request) as response:
                payload = response.read()
        except HTTPError as error:
            detail = error.read().decode("utf-8", errors="replace")
            raise RuntimeError(
                f"Azure AI Search returned HTTP {error.code} for {method.upper()} {path}: {detail}"
            ) from error
        except URLError as error:
            raise RuntimeError(f"Could not reach Azure AI Search at {self.endpoint}: {error.reason}") from error

        return json.loads(payload) if payload else None


def create_embeddings(
    resource_uri: str,
    deployment: str,
    api_version: str,
    access_token: str,
    inputs: list[str],
    dimensions: int,
) -> list[list[float]]:
    url = (
        f"{resource_uri.rstrip('/')}/openai/deployments/{deployment}/embeddings?"
        f"{urlencode({'api-version': api_version})}"
    )
    request = Request(
        url,
        data=json.dumps({"input": inputs, "dimensions": dimensions}).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {access_token}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    try:
        with urlopen(request) as response:
            payload = json.load(response)
    except HTTPError as error:
        detail = error.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"Foundry embeddings request returned HTTP {error.code}: {detail}") from error
    except URLError as error:
        raise RuntimeError(f"Could not reach the Foundry embeddings endpoint: {error.reason}") from error

    data = sorted(payload.get("data", []), key=lambda item: item["index"])
    embeddings = [item["embedding"] for item in data]
    if len(embeddings) != len(inputs):
        raise RuntimeError(f"Expected {len(inputs)} embeddings but received {len(embeddings)}.")
    if any(len(embedding) != dimensions for embedding in embeddings):
        raise RuntimeError(f"Foundry returned an embedding with dimensions other than {dimensions}.")
    return embeddings


def load_documents(path: Path) -> list[dict[str, Any]]:
    if not path.is_file():
        raise FileNotFoundError(f"Seed data file not found: {path}")
    with path.open(encoding="utf-8") as seed_file:
        documents = json.load(seed_file)
    if not isinstance(documents, list) or not all(isinstance(item, dict) for item in documents):
        raise ValueError(f"Seed data must be a JSON array of objects: {path}")
    return documents


def html_to_text(content: str) -> str:
    parser = HTMLTextExtractor()
    parser.feed(content)
    parser.close()
    return " ".join(" ".join(parser.parts).split())


def elements_named(root: ElementTree.Element, name: str) -> list[ElementTree.Element]:
    return [element for element in root.iter() if element.tag.rsplit("}", 1)[-1] == name]


def load_imscc_documents(path: Path, subject: str | None = None) -> list[dict[str, Any]]:
    if not path.is_file():
        raise FileNotFoundError(f"IMSCC file not found: {path}")
    if not zipfile.is_zipfile(path):
        raise ValueError(f"IMSCC file is not a ZIP archive: {path}")

    with zipfile.ZipFile(path) as package:
        try:
            manifest = ElementTree.fromstring(package.read("imsmanifest.xml"))
        except KeyError as error:
            raise ValueError("IMSCC file does not contain imsmanifest.xml.") from error
        except ElementTree.ParseError as error:
            raise ValueError(f"IMSCC manifest is not valid XML: {error}") from error

        course_title = next(
            (
                title.text.strip()
                for title in elements_named(manifest, "title")
                if title.text and title.text.strip()
            ),
            path.stem,
        )
        documents: list[dict[str, Any]] = []
        seen_members: set[str] = set()
        for resource in elements_named(manifest, "resource"):
            title = next(
                (
                    element.text.strip()
                    for element in elements_named(resource, "title")
                    if element.text and element.text.strip()
                ),
                resource.get("identifier", "Canvas course content"),
            )
            member_names = [
                file.get("href")
                for file in elements_named(resource, "file")
                if file.get("href") and Path(file.get("href", "")).suffix.lower() in IMSCC_TEXT_EXTENSIONS
            ]
            if not member_names and resource.get("href"):
                member_names = [resource.get("href")]

            for member_name in member_names:
                if member_name in seen_members:
                    continue
                try:
                    member = package.getinfo(member_name)
                except KeyError:
                    continue
                if member.file_size > MAX_IMSCC_MEMBER_BYTES:
                    raise ValueError(
                        f"IMSCC member exceeds the {MAX_IMSCC_MEMBER_BYTES // (1024 * 1024)} MB limit: {member_name}"
                    )
                raw_content = package.read(member).decode("utf-8", errors="replace")
                suffix = Path(member_name).suffix.lower()
                content = (
                    html_to_text(raw_content)
                    if suffix in {".htm", ".html"}
                    else " ".join(ElementTree.fromstring(raw_content).itertext()).strip()
                    if suffix == ".xml"
                    else raw_content.strip()
                )
                content = " ".join(content.split())
                if not content:
                    continue
                seen_members.add(member_name)
                documents.append(
                    {
                        "id": f"imscc-{hashlib.sha256(member_name.encode()).hexdigest()[:24]}",
                        "title": title,
                        "content": content,
                        "subject": subject or course_title,
                        "url": f"imscc://{path.stem}/{member_name}",
                    }
                )

    if not documents:
        raise ValueError(f"No text course content found in IMSCC file: {path}")
    return documents


def main() -> int:
    args = parse_args()
    resource_group = resolve_resource_group(args.resource_group, args.environment_name)
    print(f"==> Resource group: {resource_group}")

    search_service = args.search_service
    if not search_service:
        print(f"==> Discovering the Azure AI Search service in {resource_group}...")
        search_service = run_az(
            "search", "service", "list", "-g", resource_group, "--query", "[0].name", "-o", "tsv"
        )
        if not search_service:
            raise RuntimeError(
                f"No Azure AI Search service found in {resource_group}. Create one before running this script."
            )
    print(f"==> Search service: {search_service}")

    foundry_account = args.foundry_account
    if not foundry_account:
        print(f"==> Discovering the Foundry (AIServices) account in {resource_group}...")
        foundry_account = run_az(
            "cognitiveservices",
            "account",
            "list",
            "-g",
            resource_group,
            "--query",
            "[?kind=='AIServices'] | [0].name",
            "-o",
            "tsv",
        )
        if not foundry_account:
            raise RuntimeError(f"No AIServices account found in {resource_group}.")
    print(f"==> Foundry account: {foundry_account}")

    source_path = args.imscc_path or args.seed_data_path
    documents = (
        load_imscc_documents(args.imscc_path, args.subject)
        if args.imscc_path
        else load_documents(args.seed_data_path)
    )
    search_endpoint = f"https://{search_service}.search.windows.net"
    openai_resource_uri = f"https://{foundry_account}.openai.azure.com/"

    print("==> Fetching Azure access tokens for Search and document embeddings...")
    search_token = run_az(
        "account", "get-access-token", "--resource", "https://search.azure.com",
        "--query", "accessToken", "-o", "tsv",
    )
    foundry_token = run_az(
        "account", "get-access-token", "--resource", "https://cognitiveservices.azure.com",
        "--query", "accessToken", "-o", "tsv",
    )
    search = SearchClient(search_endpoint, args.api_version, search_token)

    print(f"==> Creating/updating index '{args.index_name}'...")
    index = {
        "name": args.index_name,
        "fields": [
            {"name": "id", "type": "Edm.String", "key": True, "filterable": True, "sortable": True},
            {"name": "title", "type": "Edm.String", "searchable": True, "analyzer": "en.microsoft"},
            {"name": "content", "type": "Edm.String", "searchable": True, "analyzer": "en.microsoft"},
            {
                "name": "subject",
                "type": "Edm.String",
                "searchable": True,
                "filterable": True,
                "facetable": True,
            },
            {"name": "url", "type": "Edm.String", "filterable": True},
            {
                "name": "contentVector",
                "type": "Collection(Edm.Single)",
                "searchable": True,
                "dimensions": args.embedding_dimensions,
                "vectorSearchProfile": "content-vector-profile",
            },
        ],
        "vectorSearch": {
            "algorithms": [
                {
                    "name": "content-vector-hnsw",
                    "kind": "hnsw",
                    "hnswParameters": {
                        "metric": "cosine",
                        "m": 4,
                        "efConstruction": 400,
                        "efSearch": 500,
                    },
                }
            ],
            "profiles": [
                {
                    "name": "content-vector-profile",
                    "algorithm": "content-vector-hnsw",
                    "vectorizer": "content-vectorizer",
                }
            ],
            "vectorizers": [
                {
                    "name": "content-vectorizer",
                    "kind": "azureOpenAI",
                    "azureOpenAIParameters": {
                        "resourceUri": openai_resource_uri,
                        "deploymentId": args.embedding_deployment,
                        "modelName": args.embedding_model_name,
                    },
                }
            ],
        },
        "semantic": {
            "defaultConfiguration": "default",
            "configurations": [
                {
                    "name": "default",
                    "prioritizedFields": {
                        "titleField": {"fieldName": "title"},
                        "prioritizedContentFields": [{"fieldName": "content"}],
                        "prioritizedKeywordsFields": [{"fieldName": "subject"}],
                    },
                }
            ],
        },
    }
    search.request("PUT", f"/indexes('{args.index_name}')", index)
    print("    index ready.")

    print(f"==> Uploading course documents from {source_path}...")
    embedding_inputs = [
        f"{document.get('title', '')}\n{document.get('subject', '')}\n\n{document.get('content', '')}"
        for document in documents
    ]
    embeddings = create_embeddings(
        openai_resource_uri,
        args.embedding_deployment,
        args.openai_api_version,
        foundry_token,
        embedding_inputs,
        args.embedding_dimensions,
    )
    actions = [
        {"@search.action": "mergeOrUpload", **document, "contentVector": embedding}
        for document, embedding in zip(documents, embeddings, strict=True)
    ]
    search.request("POST", f"/indexes('{args.index_name}')/docs/index", {"value": actions})
    print(f"    uploaded {len(actions)} document(s).")

    print(f"==> Creating/updating knowledge source '{args.knowledge_source_name}'...")
    knowledge_source = {
        "name": args.knowledge_source_name,
        "kind": "searchIndex",
        "description": "Course materials for the EDU homework tutor.",
        "searchIndexParameters": {"searchIndexName": args.index_name},
    }
    search.request(
        "PUT",
        f"/knowledgesources('{args.knowledge_source_name}')",
        knowledge_source,
        return_representation=True,
    )
    print("    knowledge source ready.")

    print(f"==> Creating/updating knowledge base '{args.knowledge_base_name}'...")
    knowledge_base = {
        "name": args.knowledge_base_name,
        "description": "EDU homework tutor course-knowledge base.",
        "knowledgeSources": [{"name": args.knowledge_source_name}],
        "models": [
            {
                "kind": "azureOpenAI",
                "azureOpenAIParameters": {
                    "resourceUri": openai_resource_uri,
                    "deploymentId": args.kb_model_deployment,
                    "modelName": args.kb_model_name,
                },
            }
        ],
    }
    search.request(
        "PUT",
        f"/knowledgebases('{args.knowledge_base_name}')",
        knowledge_base,
        return_representation=True,
    )
    print("    knowledge base ready.")

    print(f"\nDone. Knowledge base '{args.knowledge_base_name}' is live on {search_endpoint}")
    print(f"  index            : {args.index_name} ({len(actions)} docs)")
    print(f"  knowledge source : {args.knowledge_source_name}")
    print(f"  reasoning model  : {args.kb_model_deployment} ({args.kb_model_name})")
    print(f"  embeddings model : {args.embedding_deployment} ({args.embedding_dimensions} dimensions)")
    print("\nNext: attach this knowledge base to the agent in the Foundry portal.")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (FileNotFoundError, ValueError, RuntimeError) as error:
        print(f"Error: {error}", file=sys.stderr)
        raise SystemExit(1) from error