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
                    Courses = new List<Course>
                    {
                        new() { Id = "CS101", Description = "Intro to Programming" },
                        new() { Id = "CS102", Description = "Data Structures" }
                    },
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
                new()
                {
                    Name = "Group 1",
                    Courses = new List<Course> { new() { Id = "CS101", Description = "Intro" } },
                    HelpLevel = "hint_only"
                }
            }
        };

        var resolved = policy.ResolveForCourse("HIST200");

        Assert.Equal("guided", resolved.HelpLevel);
    }

    [Fact]
    public void CatalogResolvesEachCourseToItsOwningProfessor()
    {
        var catalog = new PedagogyCatalog
        {
            Professors = new List<PedagogyPolicy>
            {
                new()
                {
                    ProfessorId = "prof-adams",
                    ProfessorName = "Dr. Adams",
                    HelpLevel = "guided",
                    CourseGroups = new List<CourseGroup>
                    {
                        new()
                        {
                            Name = "Intro CS",
                            Courses = new List<Course> { new() { Id = "CS101", Description = "Intro to Programming" } },
                            HelpLevel = "hint_only"
                        }
                    }
                },
                new()
                {
                    ProfessorId = "prof-baker",
                    ProfessorName = "Dr. Baker",
                    HelpLevel = "worked_example",
                    CourseGroups = new List<CourseGroup>
                    {
                        new()
                        {
                            Name = "History",
                            Courses = new List<Course> { new() { Id = "HIST200", Description = "Modern History" } },
                            AllowDirectAnswers = true
                        }
                    }
                }
            }
        };

        // A student taking both courses gets each professor's own pedagogy.
        var cs = catalog.ResolveForCourse("CS101");
        Assert.Equal("Dr. Adams", cs.ProfessorName);
        Assert.Equal("hint_only", cs.HelpLevel);

        var hist = catalog.ResolveForCourse("HIST200");
        Assert.Equal("Dr. Baker", hist.ProfessorName);
        Assert.Equal("worked_example", hist.HelpLevel);
        Assert.True(hist.AllowDirectAnswers);
    }
}
