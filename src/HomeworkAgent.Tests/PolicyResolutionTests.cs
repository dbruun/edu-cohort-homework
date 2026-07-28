using System.Text.Json;
using Xunit;

public class PolicyStoreTests
{
    [Fact]
    public void ResolvePathReturnsDefaultWhenUriIsNull()
    {
        var expected = Path.Combine(AppContext.BaseDirectory, "Pedagogy", "pedagogy-policy.json");

        Assert.Equal(expected, PolicyStore.ResolvePath(null));
    }

    [Theory]
    [InlineData("")]
    [InlineData("   ")]
    public void ResolvePathReturnsDefaultWhenUriIsBlank(string uri)
    {
        var expected = Path.Combine(AppContext.BaseDirectory, "Pedagogy", "pedagogy-policy.json");

        Assert.Equal(expected, PolicyStore.ResolvePath(uri));
    }

    [Fact]
    public void ResolvePathExpandsRelativeUriToFullPath()
    {
        var resolved = PolicyStore.ResolvePath("./Pedagogy/pedagogy-policy.json");

        Assert.True(Path.IsPathRooted(resolved));
        Assert.EndsWith(Path.Combine("Pedagogy", "pedagogy-policy.json"), resolved);
    }
}

public class PromptComposerTests
{
    [Fact]
    public void ComposeIncludesSystemPromptAndPolicyHeader()
    {
        var policy = new PedagogyPolicy { HelpLevel = "worked_example", MaxStepsRevealed = 2 };

        var prompt = PromptComposer.Compose("BASE SYSTEM PROMPT", policy);

        Assert.Contains("BASE SYSTEM PROMPT", prompt);
        Assert.Contains("Current pedagogy policy:", prompt);
        Assert.Contains("worked_example", prompt);
    }

    [Fact]
    public void ComposeEmbedsValidJsonForThePolicy()
    {
        var policy = new PedagogyPolicy { HelpLevel = "hint_only", MaxStepsRevealed = 1 };

        var prompt = PromptComposer.Compose("SYS", policy);
        var jsonStart = prompt.IndexOf('{');
        var jsonEnd = prompt.LastIndexOf('}');
        var json = prompt.Substring(jsonStart, jsonEnd - jsonStart + 1);
        var roundTripped = JsonSerializer.Deserialize<PedagogyPolicy>(json);

        Assert.NotNull(roundTripped);
        Assert.Equal("hint_only", roundTripped!.HelpLevel);
        Assert.Equal(1, roundTripped.MaxStepsRevealed);
    }
}

public class PedagogyPolicyResolutionTests
{
    [Fact]
    public void OwnsCourseIsCaseInsensitiveAndMatchesGroupMembership()
    {
        var policy = new PedagogyPolicy
        {
            CourseGroups = new List<CourseGroup>
            {
                new()
                {
                    Name = "Intro CS",
                    Courses = new List<Course> { new() { Id = "CS101", Description = "Intro" } }
                }
            }
        };

        Assert.True(policy.OwnsCourse("cs101"));
        Assert.False(policy.OwnsCourse("MATH200"));
    }

    [Fact]
    public void ResolveForCourseReturnsSameInstanceWhenCourseIdIsNull()
    {
        var policy = new PedagogyPolicy { HelpLevel = "guided" };

        Assert.Same(policy, policy.ResolveForCourse(null));
    }

    [Fact]
    public void ResolveForCourseReturnsDefaultsWhenCourseNotOwned()
    {
        var policy = new PedagogyPolicy
        {
            HelpLevel = "guided",
            MaxStepsRevealed = 3,
            CourseGroups = new List<CourseGroup>
            {
                new()
                {
                    Name = "Intro CS",
                    Courses = new List<Course> { new() { Id = "CS101", Description = "Intro" } },
                    HelpLevel = "hint_only"
                }
            }
        };

        var resolved = policy.ResolveForCourse("HIST200");

        Assert.Equal("guided", resolved.HelpLevel);
        Assert.Equal(3, resolved.MaxStepsRevealed);
    }
}

public class PedagogyCatalogTests
{
    [Fact]
    public void ResolveForCourseFallsBackToDefaultPolicyWhenNoProfessorOwnsCourse()
    {
        var catalog = new PedagogyCatalog
        {
            Professors = new List<PedagogyPolicy>
            {
                new()
                {
                    ProfessorName = "Dr. Adams",
                    HelpLevel = "worked_example",
                    CourseGroups = new List<CourseGroup>
                    {
                        new()
                        {
                            Name = "Intro CS",
                            Courses = new List<Course> { new() { Id = "CS101", Description = "Intro" } }
                        }
                    }
                }
            }
        };

        var resolved = catalog.ResolveForCourse("UNKNOWN999");

        // Falls back to a fresh default policy, not any professor's settings.
        Assert.Equal(string.Empty, resolved.ProfessorName);
        Assert.Equal("guided", resolved.HelpLevel);
    }

    [Fact]
    public void ResolveForCourseWithNullReturnsFirstProfessor()
    {
        var catalog = new PedagogyCatalog
        {
            Professors = new List<PedagogyPolicy>
            {
                new() { ProfessorName = "Dr. Adams", HelpLevel = "hint_only" },
                new() { ProfessorName = "Dr. Baker", HelpLevel = "worked_example" }
            }
        };

        var resolved = catalog.ResolveForCourse(null);

        Assert.Equal("Dr. Adams", resolved.ProfessorName);
    }

    [Fact]
    public async Task SaveAndLoadCatalogRoundTrips()
    {
        var tempPath = Path.Combine(Path.GetTempPath(), $"catalog-{Guid.NewGuid():N}.json");
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
                }
            }
        };

        try
        {
            await PedagogyCatalog.SaveAsync(tempPath, catalog);
            var reloaded = await PedagogyCatalog.LoadAsync(tempPath);

            Assert.Single(reloaded.Professors);
            Assert.Equal("Dr. Adams", reloaded.Professors[0].ProfessorName);
            Assert.Equal("hint_only", reloaded.ResolveForCourse("CS101").HelpLevel);
        }
        finally
        {
            File.Delete(tempPath);
        }
    }

    [Fact]
    public async Task LoadCatalogReturnsEmptyWhenFileMissing()
    {
        var missingPath = Path.Combine(Path.GetTempPath(), $"missing-{Guid.NewGuid():N}.json");

        var catalog = await PedagogyCatalog.LoadAsync(missingPath);

        Assert.Empty(catalog.Professors);
    }
}
