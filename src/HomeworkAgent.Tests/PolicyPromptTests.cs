using System.Text;
using System.Text.Json;
using Xunit;

public class PolicyPromptTests
{
    [Fact]
    public async Task ComposesPolicyAndPromptForGuidedMode()
    {
        var policyPath = Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", "HomeworkAgent", "Pedagogy", "pedagogy-policy.json");
        var policy = await PedagogyPolicy.LoadAsync(policyPath);
        var systemPrompt = await File.ReadAllTextAsync(Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", "HomeworkAgent", "instructions", "tutor-system-prompt.md"));
        var prompt = PromptComposer.Compose(systemPrompt, policy);

        Assert.Contains("guided", prompt, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("allowDirectAnswers", prompt, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("citationsRequired", prompt, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("I can help guide you", prompt, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void PolicyJsonRoundTripsWithoutLoss()
    {
        var policy = new PedagogyPolicy
        {
            HelpLevel = "hint_only",
            MaxStepsRevealed = 1,
            AllowDirectAnswers = false,
            CitationsRequired = true,
            SubjectOverrides = new Dictionary<string, string>
            {
                ["math"] = "guided"
            }
        };

        var json = JsonSerializer.Serialize(policy);
        var roundTripped = JsonSerializer.Deserialize<PedagogyPolicy>(json);

        Assert.NotNull(roundTripped);
        Assert.Equal("hint_only", roundTripped!.HelpLevel);
        Assert.Equal(1, roundTripped.MaxStepsRevealed);
        Assert.True(roundTripped.CitationsRequired);
        Assert.Equal("guided", roundTripped.SubjectOverrides["math"]);
    }

    [Fact]
    public async Task SaveAndLoadPolicyToTemporaryFile()
    {
        var tempPath = Path.Combine(Path.GetTempPath(), $"pedagogy-{Guid.NewGuid():N}.json");
        var policy = new PedagogyPolicy
        {
            HelpLevel = "worked_example",
            MaxStepsRevealed = 4,
            AllowDirectAnswers = false,
            CitationsRequired = false
        };

        await PedagogyPolicy.SaveAsync(tempPath, policy);
        var reloaded = await PedagogyPolicy.LoadAsync(tempPath);

        try
        {
            Assert.Equal("worked_example", reloaded.HelpLevel);
            Assert.Equal(4, reloaded.MaxStepsRevealed);
            Assert.False(reloaded.CitationsRequired);
        }
        finally
        {
            File.Delete(tempPath);
        }
    }
}
