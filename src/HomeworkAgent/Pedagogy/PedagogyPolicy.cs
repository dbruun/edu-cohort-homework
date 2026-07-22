using System.Text.Json;

public sealed class PedagogyPolicy
{
    /// <summary>Identifier of the professor who owns this pedagogy.</summary>
    public string ProfessorId { get; init; } = string.Empty;
    /// <summary>Display name of the owning professor.</summary>
    public string ProfessorName { get; init; } = string.Empty;
    public string HelpLevel { get; init; } = "guided";
    public int MaxStepsRevealed { get; init; } = 3;
    public bool AllowDirectAnswers { get; init; } = false;
    public bool CitationsRequired { get; init; } = true;
    public Dictionary<string, string> SubjectOverrides { get; init; } = new();
    public List<CourseGroup> CourseGroups { get; init; } = new();
    public string RefusalMessage { get; init; } = "I can help guide you, but I will not provide a complete solution for graded work.";
    public string EscalationMessage { get; init; } = "Please ask a more specific question or request a hint.";

    /// <summary>True when any of this professor's groups contains the given course.</summary>
    public bool OwnsCourse(string courseId) =>
        CourseGroups.Any(g => g.Courses.Any(c => string.Equals(c.Id, courseId, StringComparison.OrdinalIgnoreCase)));

    /// <summary>
    /// Returns the effective policy for a specific course. If the course belongs to a
    /// course group, that group's limits override the defaults. The first matching group wins.
    /// </summary>
    public PedagogyPolicy ResolveForCourse(string? courseId)
    {
        if (string.IsNullOrWhiteSpace(courseId))
        {
            return this;
        }

        var group = CourseGroups.FirstOrDefault(g =>
            g.Courses.Any(c => string.Equals(c.Id, courseId, StringComparison.OrdinalIgnoreCase)));

        if (group is null)
        {
            return this;
        }

        return new PedagogyPolicy
        {
            ProfessorId = ProfessorId,
            ProfessorName = ProfessorName,
            HelpLevel = group.HelpLevel ?? HelpLevel,
            MaxStepsRevealed = group.MaxStepsRevealed ?? MaxStepsRevealed,
            AllowDirectAnswers = group.AllowDirectAnswers ?? AllowDirectAnswers,
            CitationsRequired = group.CitationsRequired ?? CitationsRequired,
            SubjectOverrides = SubjectOverrides,
            CourseGroups = CourseGroups,
            RefusalMessage = RefusalMessage,
            EscalationMessage = EscalationMessage
        };
    }

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

/// <summary>
/// A course the tutor supports, with a human-readable description so professors and
/// students can tell courses apart.
/// </summary>
public sealed class Course
{
    public string Id { get; init; } = string.Empty;
    public string Description { get; init; } = string.Empty;
}

/// <summary>
/// A named group of courses that share the same tutoring limits. Any field left null
/// inherits the owning professor's policy default; set fields override it for every course in the group.
/// </summary>
public sealed class CourseGroup
{
    public string Name { get; init; } = string.Empty;
    public List<Course> Courses { get; init; } = new();
    public string? HelpLevel { get; init; }
    public int? MaxStepsRevealed { get; init; }
    public bool? AllowDirectAnswers { get; init; }
    public bool? CitationsRequired { get; init; }
}

/// <summary>
/// The full set of professor-owned pedagogies. Because a student can take courses from
/// multiple professors, the tutor resolves the correct pedagogy from whichever professor
/// owns the course being asked about.
/// </summary>
public sealed class PedagogyCatalog
{
    public List<PedagogyPolicy> Professors { get; init; } = new();

    /// <summary>
    /// Resolves the effective pedagogy for a course by finding the professor that owns it.
    /// Falls back to a default policy when no professor claims the course.
    /// </summary>
    public PedagogyPolicy ResolveForCourse(string? courseId)
    {
        if (string.IsNullOrWhiteSpace(courseId))
        {
            return Professors.FirstOrDefault() ?? new PedagogyPolicy();
        }

        var owner = Professors.FirstOrDefault(p => p.OwnsCourse(courseId));
        return owner is null
            ? new PedagogyPolicy()
            : owner.ResolveForCourse(courseId);
    }

    public static async Task<PedagogyCatalog> LoadAsync(string uri)
    {
        var path = Path.GetFullPath(uri);
        if (!File.Exists(path))
        {
            return new PedagogyCatalog();
        }

        await using var stream = File.OpenRead(path);
        return (await JsonSerializer.DeserializeAsync<PedagogyCatalog>(stream)) ?? new PedagogyCatalog();
    }

    public static async Task SaveAsync(string uri, PedagogyCatalog catalog)
    {
        var path = Path.GetFullPath(uri);
        var directory = Path.GetDirectoryName(path);
        if (!string.IsNullOrWhiteSpace(directory))
        {
            Directory.CreateDirectory(directory);
        }

        await using var stream = File.Create(path);
        await JsonSerializer.SerializeAsync(stream, catalog, new JsonSerializerOptions { WriteIndented = true });
    }
}
