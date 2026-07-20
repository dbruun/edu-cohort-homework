using System.Text;
using System.Text.Json;

public static class PromptComposer
{
    public static string Compose(string systemPrompt, PedagogyPolicy policy)
    {
        var policyJson = JsonSerializer.Serialize(policy, new JsonSerializerOptions { WriteIndented = true });
        var builder = new StringBuilder();
        builder.AppendLine(systemPrompt);
        builder.AppendLine();
        builder.AppendLine("Current pedagogy policy:");
        builder.AppendLine(policyJson);
        return builder.ToString();
    }
}
