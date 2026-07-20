using System.Text.Json;

public sealed class PedagogyPolicy
{
    public string HelpLevel { get; init; } = "guided";
    public int MaxStepsRevealed { get; init; } = 3;
    public bool AllowDirectAnswers { get; init; } = false;
    public bool CitationsRequired { get; init; } = true;
    public Dictionary<string, string> SubjectOverrides { get; init; } = new();
    public string RefusalMessage { get; init; } = "I can help guide you, but I will not provide a complete solution for graded work.";
    public string EscalationMessage { get; init; } = "Please ask a more specific question or request a hint.";

    public static async Task<PedagogyPolicy> LoadAsync(string uri)
    {
        var path = Path.GetFullPath(uri);
        if (!File.Exists(path))
        {
            return new PedagogyPolicy();
        }

        await using var stream = File.OpenRead(path);
        return (await JsonSerializer.DeserializeAsync<PedagogyPolicy>(stream)) ?? new PedagogyPolicy();
    }

    public static async Task SaveAsync(string uri, PedagogyPolicy policy)
    {
        var path = Path.GetFullPath(uri);
        var directory = Path.GetDirectoryName(path);
        if (!string.IsNullOrWhiteSpace(directory))
        {
            Directory.CreateDirectory(directory);
        }

        await using var stream = File.Create(path);
        await JsonSerializer.SerializeAsync(stream, policy, new JsonSerializerOptions { WriteIndented = true });
    }
}
