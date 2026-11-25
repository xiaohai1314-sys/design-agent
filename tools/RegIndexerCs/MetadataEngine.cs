using System.Text.RegularExpressions;

namespace RegIndexerCs;

internal enum StandardStatus
{
    CurrentMandatoryGeneral,
    CurrentStandard,
    LocalGuideline,
    PartiallySuperseded,
    Repealed
}

internal sealed record StandardMeta(
    string StandardCode,
    StandardStatus Status,
    string StatusLabel,
    bool IsFullTextMandatory,
    string? SupersededBy,
    string? WarningText
);

internal static partial class MetadataEngine
{
    private static readonly (string Num, string Name, string[] Keywords, string Replacer)[] PartiallySuperseded =
    [
        ("50016", "《建筑设计防火规范》", ["建筑设计防火", "建规"], "GB 55037-2022《建筑防火通用规范》"),
        ("50067", "《汽车库、修车库、停车场设计防火规范》", ["汽车库", "修车库"], "GB 55037-2022《建筑防火通用规范》"),
        ("50084", "《自动喷水灭火系统设计规范》", ["自动喷水"], "GB 55036-2022《消防设施通用规范》"),
        ("50116", "《火灾自动报警系统设计规范》", ["火灾自动报警"], "GB 55036-2022《消防设施通用规范》"),
        ("50140", "《建筑灭火器配置设计规范》", ["灭火器"], "GB 55036-2022《消防设施通用规范》"),
        ("50974", "《消防给水及消火栓系统技术规范》", ["消火栓", "消防给水"], "GB 55036-2022《消防设施通用规范》"),
        ("51251", "《建筑防烟排烟系统技术标准》", ["防烟", "排烟"], "GB 55036-2022《消防设施通用规范》"),
        ("50763", "《无障碍设计规范》", ["无障碍设计规范"], "GB 55019-2021《建筑与市政工程无障碍通用规范》"),
        ("50096", "《住宅设计规范》", ["住宅设计规范"], "GB 55038-2025《住宅项目规范》"),
        ("50009", "《建筑结构荷载规范》", ["荷载规范"], "GB 55001-2021《工程结构通用规范》"),
        ("50010", "《混凝土结构设计规范》", ["混凝土结构设计"], "GB 55008-2021《混凝土结构通用规范》")
    ];

    [GeneratedRegex(@"((?:GB|DB\d{2}|JGJ|CJJ|CECS|T/\w+)\s*/?\s*T?\s*[0-9]{2,5}(?:[-—][0-9]{4})?)", RegexOptions.IgnoreCase)]
    private static partial Regex StandardCodeRegex();

    internal static string StatusToDbString(StandardStatus s) => s switch
    {
        StandardStatus.CurrentMandatoryGeneral => "current_mandatory_general",
        StandardStatus.PartiallySuperseded => "partially_superseded",
        StandardStatus.Repealed => "repealed",
        StandardStatus.LocalGuideline => "local_guideline",
        _ => "current"
    };

    internal static StandardStatus StatusFromDbString(string? s) => s switch
    {
        "current_mandatory_general" => StandardStatus.CurrentMandatoryGeneral,
        "partially_superseded" => StandardStatus.PartiallySuperseded,
        "repealed" => StandardStatus.Repealed,
        "local_guideline" => StandardStatus.LocalGuideline,
        _ => StandardStatus.CurrentStandard
    };

    internal static int RankWeight(StandardStatus s) => s switch
    {
        StandardStatus.CurrentMandatoryGeneral => 40,
        StandardStatus.CurrentStandard => 25,
        StandardStatus.LocalGuideline => 18,
        StandardStatus.PartiallySuperseded => 6,
        StandardStatus.Repealed => -50,
        _ => 10
    };

    internal static string? ExtractStandardCode(string text)
    {
        var m = StandardCodeRegex().Match(text);
        return m.Success ? m.Groups[1].Value.Trim().ToUpperInvariant() : null;
    }

    internal static StandardMeta Inspect(string docTitle, string sampleText)
    {
        var upper = docTitle.ToUpperInvariant();

        if (upper.Contains("GB 550") || upper.Contains("GB550") || docTitle.Contains("通用规范"))
        {
            return new StandardMeta(
                ExtractStandardCode(docTitle) ?? "GB 550xx",
                StandardStatus.CurrentMandatoryGeneral,
                "现行·通规(全文强制)",
                true,
                null,
                null
            );
        }

        foreach (var (num, name, keywords, replacer) in PartiallySuperseded)
        {
            if (upper.Contains(num) || keywords.Any(k => docTitle.Contains(k, StringComparison.Ordinal)))
            {
                var code = ExtractStandardCode(docTitle) ?? $"GB {num}";
                return new StandardMeta(
                    code,
                    StandardStatus.PartiallySuperseded,
                    "现行·强条已替代",
                    false,
                    replacer,
                    $"{name} 中的原强制性条文已被 {replacer} 等现行通用规范替代废止，工程合规核查请以现行通用规范为准。"
                );
            }
        }

        if (upper.Contains("GBJ") || docTitle.Contains("废止") || docTitle.Contains("失效"))
        {
            return new StandardMeta(
                ExtractStandardCode(docTitle) ?? "废止标准",
                StandardStatus.Repealed,
                "已废止",
                false,
                null,
                "本标准已废止或失效，新建工程严禁直接引用。"
            );
        }

        if (upper.Contains("DB") || docTitle.Contains("地方") || docTitle.Contains("苏建函") ||
            docTitle.Contains("问答") || docTitle.Contains("解答"))
        {
            return new StandardMeta(
                ExtractStandardCode(docTitle) ?? "地方技术指引",
                StandardStatus.LocalGuideline,
                "地方标准/指引",
                false,
                null,
                null
            );
        }

        bool fullMand = sampleText.Contains("全部条文必须严格执行") || sampleText.Contains("强制性工程建设规范");
        return new StandardMeta(
            ExtractStandardCode(docTitle) ?? docTitle,
            StandardStatus.CurrentStandard,
            "现行标准",
            fullMand,
            null,
            null
        );
    }
}
