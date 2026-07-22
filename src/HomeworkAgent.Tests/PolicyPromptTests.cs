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

    [Fact]
    public void CourseGroupOverridesApplyToMemberCourses()
    {
        var policy = new PedagogyPolicy
        {
            HelpLevel = "guided",
            MaxStepsRevealed = 3,
            AllowDirectAnswers = false,
            CitationsRequired = true,
            CourseGroups = new List<CourseGroup>
            {
                new()
                {
                    Name = "Group 1",
                    Courses = new List<string> { "CS101", "CS102" },
                    HelpLevel = "hint_only",
                    AllowDirectAnswers = false,
                    MaxStepsRevealed = 1
                }
            }
        };

        var resolved = policy.ResolveForCourse("CS101");

        Assert.Equal("hint_only", resolved.HelpLevel);
        Assert.Equal(1, resolved.MaxStepsRevealed);
        // Fields the group leaves unset inherit the top-level default.
        Assert.True(resolved.CitationsRequired);
    }

    [Fact]
    public void CourseNotInAnyGroupUsesDefaults()
    {
        var policy = new PedagogyPolicy
        {
            HelpLevel = "guided",
            CourseGroups = new List<CourseGroup>
            {
                new() { Name = "Group 1", Courses = new List<string> { "CS101" }, HelpLevel = "hint_only" }
            }
        };

        var resolved = policy.ResolveForCourse("HIST200");

        Assert.Equal("guided", resolved.HelpLevel);
    }
}
