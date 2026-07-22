using System.Text.Json;

public sealed class PedagogyPolicy
{
    public string HelpLevel { get; init; } = "guided";
    public int MaxStepsRevealed { get; init; } = 3;
    public bool AllowDirectAnswers { get; init; } = false;
    public bool CitationsRequired { get; init; } = true;
    public Dictionary<string, string> SubjectOverrides { get; init; } = new();
    public List<CourseGroup> CourseGroups { get; init; } = new();
    public string RefusalMessage { get; init; } = "I can help guide you, but I will not provide a complete solution for graded work.";
    public string EscalationMessage { get; init; } = "Please ask a more specific question or request a hint.";

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
            g.Courses.Any(c => string.Equals(c, courseId, StringComparison.OrdinalIgnoreCase)));

        if (group is null)
        {
            return this;
        }

        return new PedagogyPolicy
        {
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
/// A named group of courses that share the same tutoring limits. Any field left null
/// inherits the top-level policy default; set fields override it for every course in the group.
/// </summary>
public sealed class CourseGroup
{
    public string Name { get; init; } = string.Empty;
    public List<string> Courses { get; init; } = new();
    public string? HelpLevel { get; init; }
    public int? MaxStepsRevealed { get; init; }
    public bool? AllowDirectAnswers { get; init; }
    public bool? CitationsRequired { get; init; }
}
