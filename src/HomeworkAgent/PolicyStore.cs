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
}
