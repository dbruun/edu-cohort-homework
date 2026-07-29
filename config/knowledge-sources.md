# Managing knowledge sources

The tutor grounds answers in an **Azure AI Search knowledge base**. The search
service is provisioned by infrastructure-as-code; the knowledge base, knowledge
source, and index are created (and seeded) by a script.

## What the infrastructure provisions

`infra/resources.bicep` creates:

- an **Azure AI Search** service (`srch-<token>`) — **Basic** SKU by default
  (`searchSku` parameter). Basic is fine for a pilot/cohort. **Upgrade to
  `standard` (S1) or higher for go-live** for more storage, replicas (SLA /
  high-availability), and semantic-ranker throughput.
- a **Foundry project connection** `course-knowledge-connection` (AAD auth) that
  the Toolbox references (`toolbox/toolbox.yaml`).
- a **gpt-5.4-mini** model deployment used by the knowledge base for query
  planning / answer synthesis.
- RBAC: the search service can call the Foundry model; the agent and the Foundry
  project can read the search index.

## Bootstrap the knowledge base (one command)

After `azd provision`, seed the index and create the knowledge base + knowledge
source with dummy microbiology data:

```powershell
./scripts/setup-knowledge-base.ps1 -EnvironmentName <your-azd-env>
```

This creates the `course-materials` index, uploads
`scripts/seed-data/microbiology.json`, then creates the `course-materials-source`
knowledge source and the `course-knowledge-base` knowledge base. It is
idempotent — re-run it any time you change the seed data.

## Adding real course material

To replace the dummy data or add more knowledge without redeploying the agent:

1. Edit `scripts/seed-data/microbiology.json` (or pass `-SeedDataPath` to your
   own file) using the same `id / title / content / subject / url` shape.
2. Re-run `scripts/setup-knowledge-base.ps1` to re-upload.
3. For larger or non-JSON corpora, create a dedicated Azure AI Search index and
   add it as an additional knowledge source, then reference it from the
   knowledge base and `toolbox/toolbox.yaml`.
4. Publish a new toolbox version from the Foundry portal or SDK so the agent
   picks up the new source.

## Go-live checklist

- Raise `searchSku` from `basic` to at least `standard` (S1).
- Add **integrated vectorization** (an embedding deployment + a vector field and
  vectorizer on the index) for semantic/vector hybrid retrieval — the seed index
  is text + semantic-ranker only.
- Consider `semanticSearch: 'standard'` on the search service for higher
  semantic-ranker volume.
