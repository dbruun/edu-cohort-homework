using Azure.Core;
using Azure.Identity;

public static class PolicyStore
{
    public static string ResolvePath(string? uri)
    {
        if (string.IsNullOrWhiteSpace(uri))
        {
            return Path.Combine(AppContext.BaseDirectory, "Pedagogy", "pedagogy-policy.json");
        }

        return Path.GetFullPath(uri);
    }

    public static async Task<PedagogyPolicy> LoadAsync(string? uri)
    {
        if (Uri.TryCreate(uri, UriKind.Absolute, out var policyUri) &&
            (policyUri.Scheme == Uri.UriSchemeHttp || policyUri.Scheme == Uri.UriSchemeHttps))
        {
            var credential = new DefaultAzureCredential();
            var token = await credential.GetTokenAsync(
                new TokenRequestContext(["https://storage.azure.com/.default"]));
            using var request = new HttpRequestMessage(HttpMethod.Get, policyUri);
            request.Headers.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", token.Token);
            using var client = new HttpClient();
            using var response = await client.SendAsync(request);
            response.EnsureSuccessStatusCode();
            var policy = await response.Content.ReadFromJsonAsync<PedagogyPolicy>();
            return policy ?? new PedagogyPolicy();
        }

        return await PedagogyPolicy.LoadAsync(ResolvePath(uri));
    }
}
