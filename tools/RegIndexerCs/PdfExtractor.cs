using System.Diagnostics;
using System.Text;
using System.Text.Json;
using Windows.Data.Pdf;
using Windows.Globalization;
using Windows.Graphics.Imaging;
using Windows.Media.Ocr;
using Windows.Storage;
using Windows.Storage.Streams;

namespace RegIndexerCs;

internal static class PdfExtractor
{
    private const int MaxOcrPagesPerDoc = 80;

    internal static async Task<(List<(uint PageNo, string Text)> Pages, bool UsedOcr)> ExtractPagesAsync(
        string pdfPath,
        string pythonExe
    )
    {
        var pythonPages = TryExtractViaPython(pdfPath, pythonExe);
        bool hasDigitalText = pythonPages.Any(p => p.Text.Trim().Length >= 10);
        if (hasDigitalText)
        {
            return (pythonPages, false);
        }

        // 数字文本层为空（如扫描版图集/老规范）时，回退 Windows 10/11 原生 WinRT Data.Pdf + Media.Ocr (zh-Hans-CN)
        var ocrPages = await TryExtractViaWindowsOcrAsync(pdfPath);
        if (ocrPages.Count > 0)
        {
            return (ocrPages, true);
        }

        return (pythonPages, false);
    }

    private static List<(uint PageNo, string Text)> TryExtractViaPython(string pdfPath, string pythonExe)
    {
        if (string.IsNullOrWhiteSpace(pythonExe)) return [];

        const string pyCode = """
import json, sys
p = sys.argv[1]
pages = []
try:
    import fitz
    doc = fitz.open(p)
    for i, page in enumerate(doc):
        pages.append([i + 1, page.get_text("text") or ""])
except Exception:
    try:
        from pypdf import PdfReader
        reader = PdfReader(p)
        for i, page in enumerate(reader.pages):
            pages.append([i + 1, page.extract_text() or ""])
    except Exception:
        pages = []
sys.stdout.buffer.write(json.dumps(pages, ensure_ascii=False).encode("utf-8"))
""";

        try
        {
            var psi = new ProcessStartInfo
            {
                FileName = pythonExe,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                CreateNoWindow = true,
                StandardOutputEncoding = Encoding.UTF8
            };
            psi.ArgumentList.Add("-c");
            psi.ArgumentList.Add(pyCode);
            psi.ArgumentList.Add(pdfPath);

            using var proc = Process.Start(psi);
            if (proc is null) return [];
            var jsonOut = proc.StandardOutput.ReadToEnd();
            if (!proc.WaitForExit(45000))
            {
                try { proc.Kill(true); } catch { }
                return [];
            }
            if (proc.ExitCode != 0 || string.IsNullOrWhiteSpace(jsonOut)) return [];

            using var doc = JsonDocument.Parse(jsonOut);
            var list = new List<(uint, string)>();
            foreach (var item in doc.RootElement.EnumerateArray())
            {
                if (item.GetArrayLength() >= 2)
                {
                    uint pno = item[0].GetUInt32();
                    string txt = item[1].GetString() ?? string.Empty;
                    list.Add((pno, txt));
                }
            }
            return list;
        }
        catch
        {
            return [];
        }
    }

    private static async Task<List<(uint PageNo, string Text)>> TryExtractViaWindowsOcrAsync(string pdfPath)
    {
        var results = new List<(uint, string)>();
        try
        {
            var ocrEngine = OcrEngine.TryCreateFromLanguage(new Language("zh-Hans-CN"))
                ?? OcrEngine.TryCreateFromUserProfileLanguages();
            if (ocrEngine is null) return results;

            var file = await StorageFile.GetFileFromPathAsync(Path.GetFullPath(pdfPath));
            var pdfDoc = await PdfDocument.LoadFromFileAsync(file);
            uint limit = Math.Min(pdfDoc.PageCount, MaxOcrPagesPerDoc);

            for (uint i = 0; i < limit; i++)
            {
                using var page = pdfDoc.GetPage(i);
                using var stream = new InMemoryRandomAccessStream();
                var renderOpts = new PdfPageRenderOptions
                {
                    DestinationWidth = (uint)Math.Clamp(page.Size.Width * 2.0, 1200, 2400)
                };
                await page.RenderToStreamAsync(stream, renderOpts);
                stream.Seek(0);

                var decoder = await BitmapDecoder.CreateAsync(stream);
                using var bitmap = await decoder.GetSoftwareBitmapAsync(BitmapPixelFormat.Bgra8, BitmapAlphaMode.Premultiplied);
                var ocrRes = await ocrEngine.RecognizeAsync(bitmap);
                var pageText = string.Join("\n", ocrRes.Lines.Select(l => l.Text));
                results.Add((i + 1, pageText));
            }
        }
        catch
        {
            // Windows OCR 不可用时静默回退
        }
        return results;
    }
}
