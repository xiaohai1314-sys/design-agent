using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;

namespace RegIndexerCs;

internal static class Program
{
    private static readonly JsonSerializerOptions JsonOpts = new()
    {
        Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping
    };

    private static string? ArgVal(string[] args, string flag)
    {
        for (int i = 0; i < args.Length - 1; i++)
        {
            if (args[i] == flag) return args[i + 1];
        }
        return null;
    }

    private static bool HasFlag(string[] args, string flag) => args.Contains(flag);

    private static string ResolvePythonExe(string[] args)
    {
        var explicitPy = ArgVal(args, "--python");
        if (!string.IsNullOrWhiteSpace(explicitPy)) return explicitPy;

        var sibling = Path.Combine(AppContext.BaseDirectory, "python", "python.exe");
        if (File.Exists(sibling)) return sibling;
        return "python";
    }

    public static async Task<int> Main(string[] args)
    {
        Console.OutputEncoding = Encoding.UTF8;
        if (args.Length == 0)
        {
            Console.Error.WriteLine("Usage: reg-indexer <index|query|stats> [--folder DIR] [--db PATH] [--q TEXT]");
            return 1;
        }

        var cmd = args[0];
        var dbPath = ArgVal(args, "--db");
        if (string.IsNullOrWhiteSpace(dbPath))
        {
            Console.Error.WriteLine("Missing required --db <sqlite_path>");
            return 1;
        }

        try
        {
            using var conn = RegDatabase.OpenAndInit(dbPath);
            var pythonExe = ResolvePythonExe(args);

            switch (cmd)
            {
                case "index":
                {
                    var folder = ArgVal(args, "--folder");
                    if (string.IsNullOrWhiteSpace(folder))
                    {
                        Console.Error.WriteLine("Missing required --folder <dir>");
                        return 1;
                    }
                    var summary = await RegDatabase.SyncFolderAsync(conn, folder, pythonExe);
                    Console.WriteLine(JsonSerializer.Serialize(summary, JsonOpts));
                    return 0;
                }
                case "query":
                {
                    var folder = ArgVal(args, "--folder");
                    if (!string.IsNullOrWhiteSpace(folder))
                    {
                        await RegDatabase.SyncFolderAsync(conn, folder, pythonExe);
                    }
                    var query = ArgVal(args, "--q") ?? string.Empty;
                    var standard = ArgVal(args, "--standard");
                    bool currentOnly = HasFlag(args, "--current-only");
                    bool mandatoryOnly = HasFlag(args, "--mandatory-only");
                    int limit = int.TryParse(ArgVal(args, "--limit"), out var lim) ? lim : 8;

                    var res = RegDatabase.Query(conn, query, standard, currentOnly, mandatoryOnly, limit);
                    Console.WriteLine(JsonSerializer.Serialize(res, JsonOpts));
                    return 0;
                }
                case "stats":
                {
                    var folder = ArgVal(args, "--folder");
                    if (!string.IsNullOrWhiteSpace(folder))
                    {
                        await RegDatabase.SyncFolderAsync(conn, folder, pythonExe);
                    }
                    var res = RegDatabase.GetStats(conn);
                    Console.WriteLine(JsonSerializer.Serialize(res, JsonOpts));
                    return 0;
                }
                default:
                    Console.Error.WriteLine($"Unknown subcommand: {cmd}");
                    return 1;
            }
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine(ex.Message);
            return 1;
        }
    }
}
