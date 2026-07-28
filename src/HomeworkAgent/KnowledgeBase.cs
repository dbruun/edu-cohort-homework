using System.ComponentModel;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using Azure.Core;

/// <summary>
/// Grounds the tutor in the approved course materials by querying the Azure AI
/// Search knowledge base (Foundry IQ) created by scripts/setup-knowledge-base.ps1.
/// Exposed to the agent as a function tool so the model retrieves — and cites —
/// only the professor-approved corpus instead of its own training knowledge.
/// </summary>
public sealed class KnowledgeBase
{
    // Data-plane scope for Azure AI Search RBAC (the agent's managed identity has
    // Search Index Data Reader on the service; the search service itself calls the
    // reasoning model with its own identity).
    private static readonly string[] SearchScopes = { "https://search.azure.com/.default" };

    private readonly HttpClient _http = new();
    private readonly TokenCredential _credential;
    private readonly string _endpoint;
    private readonly string _knowledgeBaseName;
    private readonly string _knowledgeSourceName;
    private readonly string _apiVersion;

    public KnowledgeBase(
        string endpoint,
        string knowledgeBaseName,
        string knowledgeSourceName,
        TokenCredential credential,
        string apiVersion = "2026-04-01")
    {
        _endpoint = endpoint.TrimEnd('/');
        _knowledgeBaseName = knowledgeBaseName;
        _knowledgeSourceName = knowledgeSourceName;
        _credential = credential;
        _apiVersion = apiVersion;
    }

    [Description("Searches the approved course-materials knowledge base and returns relevant passages with their source URLs. Call this before answering any subject-matter question, and ground the answer only in what it returns.")]
    public async Task<string> SearchCourseMaterials(
        [Description("The student's question, or the key concepts to look up in the course materials.")] string query)
    {
        AccessToken token;
        try
        {
            token = await _credential.GetTokenAsync(new TokenRequestContext(SearchScopes), CancellationToken.None);
        }
        catch (Exception ex)
        {
            return $"Could not authenticate to the knowledge base: {ex.Message}. Do not fabricate sources.";
        }

        using var request = new HttpRequestMessage(
            HttpMethod.Post,
            $"{_endpoint}/knowledgebases('{_knowledgeBaseName}')/retrieve?api-version={_apiVersion}");
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token.Token);
        request.Content = JsonContent.Create(new
        {
            intents = new[] { new { type = "semantic", search = query } },
            knowledgeSourceParams = new[]
            {
                new
                {
                    kind = "searchIndex",
                    knowledgeSourceName = _knowledgeSourceName,
                    includeReferences = true,
                    includeReferenceSourceData = true
                }
            }
        });

        using var response = await _http.SendAsync(request);
        if (!response.IsSuccessStatusCode)
        {
            var detail = await response.Content.ReadAsStringAsync();
            return $"Knowledge base search failed ({(int)response.StatusCode}). No approved sources were retrieved; do not fabricate sources. Details: {detail}";
        }

        using var stream = await response.Content.ReadAsStreamAsync();
        using var doc = await JsonDocument.ParseAsync(stream);
        if (!doc.RootElement.TryGetProperty("references", out var references) || references.GetArrayLength() == 0)
        {
            return "No matching passages were found in the approved course materials. Tell the student the material does not cover this rather than inventing an answer.";
        }

        var sb = new StringBuilder();
        sb.AppendLine("Approved course-material passages. Cite ONLY these source URLs; do not cite anything else:");
        var i = 1;
        foreach (var reference in references.EnumerateArray())
        {
            if (!reference.TryGetProperty("sourceData", out var sd) || sd.ValueKind != JsonValueKind.Object)
            {
                continue;
            }

            var title = sd.TryGetProperty("title", out var t) ? t.GetString() ?? string.Empty : string.Empty;
            var url = sd.TryGetProperty("url", out var u) ? u.GetString() ?? string.Empty : string.Empty;
            var content = sd.TryGetProperty("content", out var c) ? c.GetString() ?? string.Empty : string.Empty;
            if (content.Length > 900)
            {
                content = content[..900] + "…";
            }

            sb.AppendLine($"[{i}] {title}");
            if (!string.IsNullOrWhiteSpace(url))
            {
                sb.AppendLine($"    Source: {url}");
            }
            sb.AppendLine($"    {content}");

            if (++i > 6)
            {
                break;
            }
        }

        return sb.ToString();
    }
}
