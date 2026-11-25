using System.Text.RegularExpressions;

namespace RegIndexerCs;

internal static partial class UnitExpander
{
    [GeneratedRegex(@"^(\d+(?:\.\d+)?)\s*(?:㎡|m²|m2|平方米|平方)$", RegexOptions.IgnoreCase)]
    private static partial Regex AreaRegex();

    [GeneratedRegex(@"^(\d+(?:\.\d+)?)\s*(?:m³|m3|立方米|立方)$", RegexOptions.IgnoreCase)]
    private static partial Regex VolRegex();

    [GeneratedRegex(@"^(\d+(?:\.\d+)?)\s*(?:mm|毫米)$", RegexOptions.IgnoreCase)]
    private static partial Regex MmRegex();

    [GeneratedRegex(@"^(\d+(?:\.\d+)?)\s*(?:m|米)$", RegexOptions.IgnoreCase)]
    private static partial Regex MeterRegex();

    [GeneratedRegex(@"^(\d+(?:\.\d+)?)\s*(?:h|小时)$", RegexOptions.IgnoreCase)]
    private static partial Regex HourRegex();

    [GeneratedRegex(@"^(\d+(?:\.\d+)?)\s*(?:min|分钟)$", RegexOptions.IgnoreCase)]
    private static partial Regex MinRegex();

    [GeneratedRegex(@"^(\d+(?:\.\d+)?)\s*(?:mpa|兆帕)$", RegexOptions.IgnoreCase)]
    private static partial Regex MpaRegex();

    internal static List<string> Expand(string query)
    {
        var trimmed = query.Trim();
        if (string.IsNullOrEmpty(trimmed)) return [];

        var set = new HashSet<string>(StringComparer.Ordinal) { trimmed };

        var mArea = AreaRegex().Match(trimmed);
        if (mArea.Success)
        {
            var n = mArea.Groups[1].Value;
            foreach (var v in new[] { $"{n}㎡", $"{n}m²", $"{n}m2", $"{n} m²", $"{n} ㎡", $"{n}平方米", $"{n}平方", $"{n} 平方米" })
                set.Add(v);
        }

        if (trimmed is "㎡" or "m²" or "平方米" or "平方")
        {
            set.Add("㎡");
            set.Add("m²");
            set.Add("平方米");
        }

        var mVol = VolRegex().Match(trimmed);
        if (mVol.Success)
        {
            var n = mVol.Groups[1].Value;
            foreach (var v in new[] { $"{n}m³", $"{n}m3", $"{n} m³", $"{n}立方米", $"{n}立方" })
                set.Add(v);
        }

        var mMm = MmRegex().Match(trimmed);
        if (mMm.Success)
        {
            var n = mMm.Groups[1].Value;
            foreach (var v in new[] { $"{n}mm", $"{n} mm", $"{n}毫米", $"{n} 毫米" })
                set.Add(v);
        }

        var mLen = MeterRegex().Match(trimmed);
        if (mLen.Success)
        {
            var n = mLen.Groups[1].Value;
            foreach (var v in new[] { $"{n}m", $"{n} m", $"{n}米", $"{n} 米" })
                set.Add(v);
        }

        var mHr = HourRegex().Match(trimmed);
        if (mHr.Success)
        {
            var n = mHr.Groups[1].Value;
            foreach (var v in new[] { $"{n}h", $"{n} h", $"{n}小时" })
                set.Add(v);
        }

        var mMin = MinRegex().Match(trimmed);
        if (mMin.Success)
        {
            var n = mMin.Groups[1].Value;
            foreach (var v in new[] { $"{n}min", $"{n} min", $"{n}分钟" })
                set.Add(v);
        }

        var mP = MpaRegex().Match(trimmed);
        if (mP.Success)
        {
            var n = mP.Groups[1].Value;
            foreach (var v in new[] { $"{n}MPa", $"{n} MPa", $"{n}mpa", $"{n}兆帕" })
                set.Add(v);
        }

        var list = set.ToList();
        int idx = list.IndexOf(trimmed);
        if (idx > 0)
        {
            list.RemoveAt(idx);
            list.Insert(0, trimmed);
        }
        return list;
    }
}
