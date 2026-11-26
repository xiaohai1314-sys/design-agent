using System.Runtime.InteropServices;
using System.Text;

namespace RegIndexerCs;

internal static partial class NativeMethods
{
    private const string DllName = "design_native";

    static NativeMethods()
    {
        NativeLibrary.SetDllImportResolver(typeof(NativeMethods).Assembly, (libraryName, assembly, searchPath) =>
        {
            if (libraryName != DllName) return IntPtr.Zero;
            var baseDir = AppContext.BaseDirectory;
            var candidates = new[]
            {
                Path.Combine(baseDir, "design_native.dll"),
                Path.Combine(Directory.GetParent(baseDir.TrimEnd('\\', '/'))?.FullName ?? baseDir, "design_native.dll"),
                Path.Combine(Environment.CurrentDirectory, "resources", "runtime", "design_native.dll")
            };
            foreach (var p in candidates)
            {
                if (File.Exists(p) && NativeLibrary.TryLoad(p, out var handle))
                {
                    return handle;
                }
            }
            return IntPtr.Zero;
        });
    }

    [LibraryImport(DllName)]
    internal static partial int design_tokenize_cjk_fts(
        ReadOnlySpan<byte> utf8In,
        int inLen,
        Span<byte> utf8Out,
        int outCap
    );

    [LibraryImport(DllName)]
    internal static partial int design_clause_boundary_ok(
        ReadOnlySpan<byte> utf8Text,
        int textLen,
        int matchPos,
        int matchLen
    );

    [LibraryImport(DllName)]
    internal static partial float design_cosine_similarity_f32(
        ReadOnlySpan<float> a,
        ReadOnlySpan<float> b,
        int dim
    );

    internal static string TokenizeForFts(string input)
    {
        if (string.IsNullOrEmpty(input)) return string.Empty;
        var inBytes = Encoding.UTF8.GetBytes(input);
        int cap = Math.Max(inBytes.Length * 3 + 64, 1024);
        byte[] outBuf = new byte[cap];
        int written = design_tokenize_cjk_fts(inBytes, inBytes.Length, outBuf, cap);
        if (written <= 0) return string.Empty;
        return Encoding.UTF8.GetString(outBuf, 0, written);
    }

    internal static bool ClauseBoundaryOk(string lowerHaystack, int charPos, int charLen)
    {
        if (charPos > 0)
        {
            char prev = lowerHaystack[charPos - 1];
            if ((prev >= '0' && prev <= '9') || prev == '.') return false;
        }
        int end = charPos + charLen;
        if (end < lowerHaystack.Length)
        {
            char next = lowerHaystack[end];
            if ((next >= '0' && next <= '9') || next == '.') return false;
        }
        return true;
    }

    /// <summary>Verify C++ native boundary kernel directly with UTF-8 spans.</summary>
    internal static bool ClauseBoundaryOkUtf8(byte[] hayBytes, int bytePos, int byteLen)
        => design_clause_boundary_ok(hayBytes, hayBytes.Length, bytePos, byteLen) == 1;
}
