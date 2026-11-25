using System.Diagnostics;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;
using Microsoft.Data.Sqlite;

namespace RegIndexerCs;

internal sealed record SyncSummary(
    [property: JsonPropertyName("folder")] string Folder,
    [property: JsonPropertyName("total_files")] int TotalFiles,
    [property: JsonPropertyName("added_or_updated")] int AddedOrUpdated,
    [property: JsonPropertyName("skipped_cached")] int SkippedCached,
    [property: JsonPropertyName("removed")] int Removed,
    [property: JsonPropertyName("failed_files")] List<string> FailedFiles
);

internal sealed record SearchHitChunk(
    [property: JsonPropertyName("cite")] string Cite,
    [property: JsonPropertyName("standardName")] string StandardName,
    [property: JsonPropertyName("standardNo")] string StandardNo,
    [property: JsonPropertyName("clauseId")] string ClauseId,
    [property: JsonPropertyName("pageNo")] uint PageNo,
    [property: JsonPropertyName("text")] string Text,
    [property: JsonPropertyName("explanation"), JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? Explanation,
    [property: JsonPropertyName("validityStatus")] string ValidityStatus,
    [property: JsonPropertyName("supersededBy"), JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? SupersededBy,
    [property: JsonPropertyName("warningText"), JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? WarningText,
    [property: JsonPropertyName("isMandatory")] bool IsMandatory,
    [property: JsonPropertyName("sourceFile")] string SourceFile,
    [property: JsonPropertyName("score")] long Score
);

internal sealed record QueryResponse(
    [property: JsonPropertyName("indexedDocs")] int IndexedDocs,
    [property: JsonPropertyName("indexedPages")] int IndexedPages,
    [property: JsonPropertyName("totalHits")] int TotalHits,
    [property: JsonPropertyName("queryMs")] double QueryMs,
    [property: JsonPropertyName("chunks")] List<SearchHitChunk> Chunks
);

internal sealed record StatsResponse(
    [property: JsonPropertyName("indexedDocs")] int IndexedDocs,
    [property: JsonPropertyName("totalPages")] int TotalPages,
    [property: JsonPropertyName("scannedOnlyDocs")] int ScannedOnlyDocs,
    [property: JsonPropertyName("sampleFiles")] List<string> SampleFiles
);

internal static partial class RegDatabase
{
    private const long IndexSchemaVersion = 2;

    [GeneratedRegex(@"^第?\s*(\d{1,3}(?:\.\d{1,3}){1,4})\s*[条款]?")]
    private static partial Regex ClauseLineRegex();

    [GeneratedRegex(@"^(\d{1,3}(?:\.\d{1,3}){2,})([A-Za-z])?$")]
    private static partial Regex ClauseAnchorRegex();

    [GeneratedRegex(@"必须|严禁|不得|不应")]
    private static partial Regex MandatoryRegex();

    private sealed record ParsedPageRow(
        uint PageNo,
        string ClauseId,
        string Cite,
        string RowStdName,
        string RowStdNo,
        string RowValidity,
        string Explanation,
        bool IsMandatory,
        string Text
    );

    internal static SqliteConnection OpenAndInit(string dbPath)
    {
        var dir = Path.GetDirectoryName(Path.GetFullPath(dbPath));
        if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);

        var conn = new SqliteConnection($"Data Source={dbPath}");
        conn.Open();

        using var cmd = conn.CreateCommand();
        cmd.CommandText = """
            PRAGMA journal_mode = WAL;
            PRAGMA synchronous = NORMAL;
            PRAGMA foreign_keys = ON;

            CREATE TABLE IF NOT EXISTS reg_documents (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                file_path TEXT NOT NULL UNIQUE,
                doc_title TEXT NOT NULL,
                standard_code TEXT NOT NULL,
                status TEXT NOT NULL,
                status_label TEXT NOT NULL,
                is_full_text_mandatory INTEGER NOT NULL DEFAULT 0,
                superseded_by TEXT,
                warning_text TEXT,
                file_size INTEGER NOT NULL DEFAULT 0,
                file_mtime INTEGER NOT NULL DEFAULT 0,
                file_hash TEXT NOT NULL DEFAULT '',
                source_format TEXT NOT NULL DEFAULT 'pdf',
                page_count INTEGER NOT NULL DEFAULT 0,
                text_page_count INTEGER NOT NULL DEFAULT 0,
                index_status TEXT NOT NULL DEFAULT 'indexed',
                schema_version INTEGER NOT NULL DEFAULT 2,
                indexed_at INTEGER NOT NULL DEFAULT 0
            );

            CREATE INDEX IF NOT EXISTS idx_reg_docs_path ON reg_documents(file_path);
            CREATE INDEX IF NOT EXISTS idx_reg_docs_code ON reg_documents(standard_code);

            CREATE TABLE IF NOT EXISTS reg_pages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                doc_id INTEGER NOT NULL REFERENCES reg_documents(id) ON DELETE CASCADE,
                page_no INTEGER NOT NULL,
                clause_id TEXT NOT NULL DEFAULT '',
                cite TEXT NOT NULL DEFAULT '',
                row_std_name TEXT NOT NULL DEFAULT '',
                row_std_no TEXT NOT NULL DEFAULT '',
                row_validity TEXT NOT NULL DEFAULT '',
                explanation TEXT NOT NULL DEFAULT '',
                is_mandatory INTEGER NOT NULL DEFAULT 0,
                page_text TEXT NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_reg_pages_doc_page ON reg_pages(doc_id, page_no);

            CREATE VIRTUAL TABLE IF NOT EXISTS reg_pages_fts USING fts5(
                fts_tokens,
                content='',
                tokenize='unicode61'
            );
            """;
        cmd.ExecuteNonQuery();

        foreach (var colDef in new[]
        {
            "cite TEXT NOT NULL DEFAULT ''",
            "row_std_name TEXT NOT NULL DEFAULT ''",
            "row_std_no TEXT NOT NULL DEFAULT ''",
            "row_validity TEXT NOT NULL DEFAULT ''"
        })
        {
            try
            {
                using var alter = conn.CreateCommand();
                alter.CommandText = $"ALTER TABLE reg_pages ADD COLUMN {colDef}";
                alter.ExecuteNonQuery();
            }
            catch
            {
                // 已存在时忽略
            }
        }

        return conn;
    }

    internal static async Task<SyncSummary> SyncFolderAsync(SqliteConnection conn, string folder, string pythonExe)
    {
        var normRoot = Path.GetFullPath(folder).Replace('\\', '/');
        var failed = new List<string>();
        if (!Directory.Exists(folder))
        {
            return new SyncSummary(normRoot, 0, 0, 0, 0, failed);
        }

        var diskFiles = new Dictionary<string, FileInfo>(StringComparer.Ordinal);
        foreach (var file in EnumerateRegFiles(folder))
        {
            var key = file.FullName.Replace('\\', '/');
            diskFiles[key] = file;
        }

        var cachedDocs = new Dictionary<string, (long Id, long Size, long Mtime, long SchemaVer)>(StringComparer.Ordinal);
        using (var cmd = conn.CreateCommand())
        {
            cmd.CommandText = "SELECT id, file_path, file_size, file_mtime, schema_version FROM reg_documents";
            using var reader = cmd.ExecuteReader();
            while (reader.Read())
            {
                cachedDocs[reader.GetString(1)] = (reader.GetInt64(0), reader.GetInt64(2), reader.GetInt64(3), reader.GetInt64(4));
            }
        }

        int removed = 0;
        foreach (var kv in cachedDocs)
        {
            if (diskFiles.ContainsKey(kv.Key)) continue;
            using var tx = conn.BeginTransaction();
            DeleteDocById(conn, tx, kv.Value.Id);
            tx.Commit();
            removed++;
        }

        int addedOrUpdated = 0;
        int skipped = 0;

        foreach (var kv in diskFiles)
        {
            var pathKey = kv.Key;
            var fi = kv.Value;
            long size = fi.Length;
            long mtime = new DateTimeOffset(fi.LastWriteTimeUtc).ToUnixTimeSeconds();

            if (cachedDocs.TryGetValue(pathKey, out var cached) &&
                cached.Size == size &&
                cached.Mtime == mtime &&
                cached.SchemaVer == IndexSchemaVersion)
            {
                skipped++;
                continue;
            }

            var ext = fi.Extension.ToLowerInvariant().TrimStart('.');
            var docTitle = Path.GetFileNameWithoutExtension(fi.Name);
            List<ParsedPageRow> pageRows = [];
            string indexStatus = "indexed";

            try
            {
                if (ext == "pdf")
                {
                    var (rawPages, usedOcr) = await PdfExtractor.ExtractPagesAsync(fi.FullName, pythonExe);
                    var cleaned = rawPages.Select(p => (p.PageNo, Text: SanitizeLines(p.Text))).ToList();
                    DedupeRepeatedMargins(cleaned);
                    bool anyText = cleaned.Any(p => p.Text.Trim().Length >= 10);
                    if (!anyText) indexStatus = "scanned";
                    else if (usedOcr) indexStatus = "ocr";

                    foreach (var (pno, text) in cleaned)
                    {
                        if (string.IsNullOrWhiteSpace(text)) continue;
                        var m = ClauseLineRegex().Match(text);
                        var cid = m.Success ? m.Groups[1].Value : $"第{pno}页";
                        bool mand = MandatoryRegex().IsMatch(text);
                        pageRows.Add(new ParsedPageRow(pno, cid, "", "", "", "", "", mand, text));
                    }
                }
                else if (ext is "md" or "txt")
                {
                    pageRows = ExtractMarkdownOrText(fi.FullName);
                }
                else if (ext == "json")
                {
                    pageRows = ExtractJsonChunks(fi.FullName, docTitle);
                }
            }
            catch (Exception ex)
            {
                failed.Add($"{pathKey}: {ex.Message}");
                continue;
            }

            var preview = string.Join("\n", pageRows.Take(3).Select(r => r.Text));
            var meta = MetadataEngine.Inspect(docTitle, preview);
            var sha = ComputeSha256(fi.FullName);
            long nowSecs = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
            int mandFlag = meta.Status == StandardStatus.CurrentMandatoryGeneral || meta.IsFullTextMandatory ? 1 : 0;

            using var tx = conn.BeginTransaction();
            if (cachedDocs.TryGetValue(pathKey, out var existing))
            {
                DeleteDocById(conn, tx, existing.Id);
            }

            long docId;
            using (var insDoc = conn.CreateCommand())
            {
                insDoc.Transaction = tx;
                insDoc.CommandText = """
                    INSERT INTO reg_documents (
                        file_path, doc_title, standard_code, status, status_label,
                        is_full_text_mandatory, superseded_by, warning_text,
                        file_size, file_mtime, file_hash, source_format,
                        page_count, text_page_count, index_status, schema_version, indexed_at
                    ) VALUES ($fp, $dt, $sc, $st, $sl, $im, $sb, $wt, $sz, $mt, $fh, $sf, $pc, $pc, $is, $sv, $ia);
                    SELECT last_insert_rowid();
                    """;
                insDoc.Parameters.AddWithValue("$fp", pathKey);
                insDoc.Parameters.AddWithValue("$dt", docTitle);
                insDoc.Parameters.AddWithValue("$sc", meta.StandardCode);
                insDoc.Parameters.AddWithValue("$st", MetadataEngine.StatusToDbString(meta.Status));
                insDoc.Parameters.AddWithValue("$sl", meta.StatusLabel);
                insDoc.Parameters.AddWithValue("$im", mandFlag);
                insDoc.Parameters.AddWithValue("$sb", (object?)meta.SupersededBy ?? DBNull.Value);
                insDoc.Parameters.AddWithValue("$wt", (object?)meta.WarningText ?? DBNull.Value);
                insDoc.Parameters.AddWithValue("$sz", size);
                insDoc.Parameters.AddWithValue("$mt", mtime);
                insDoc.Parameters.AddWithValue("$fh", sha);
                insDoc.Parameters.AddWithValue("$sf", ext);
                insDoc.Parameters.AddWithValue("$pc", pageRows.Count);
                insDoc.Parameters.AddWithValue("$is", indexStatus);
                insDoc.Parameters.AddWithValue("$sv", IndexSchemaVersion);
                insDoc.Parameters.AddWithValue("$ia", nowSecs);
                docId = (long)(insDoc.ExecuteScalar() ?? 0L);
            }

            using (var insPage = conn.CreateCommand())
            using (var insFts = conn.CreateCommand())
            {
                insPage.Transaction = tx;
                insFts.Transaction = tx;
                insPage.CommandText = """
                    INSERT INTO reg_pages (doc_id, page_no, clause_id, cite, row_std_name, row_std_no, row_validity, explanation, is_mandatory, page_text)
                    VALUES ($di, $pn, $ci, $ct, $rsn, $rso, $rv, $ex, $im, $pt);
                    SELECT last_insert_rowid();
                    """;
                insFts.CommandText = "INSERT INTO reg_pages_fts (rowid, fts_tokens) VALUES ($id, $tok)";

                var pDi = insPage.Parameters.Add("$di", SqliteType.Integer);
                var pPn = insPage.Parameters.Add("$pn", SqliteType.Integer);
                var pCi = insPage.Parameters.Add("$ci", SqliteType.Text);
                var pCt = insPage.Parameters.Add("$ct", SqliteType.Text);
                var pRsn = insPage.Parameters.Add("$rsn", SqliteType.Text);
                var pRso = insPage.Parameters.Add("$rso", SqliteType.Text);
                var pRv = insPage.Parameters.Add("$rv", SqliteType.Text);
                var pEx = insPage.Parameters.Add("$ex", SqliteType.Text);
                var pIm = insPage.Parameters.Add("$im", SqliteType.Integer);
                var pPt = insPage.Parameters.Add("$pt", SqliteType.Text);

                var fId = insFts.Parameters.Add("$id", SqliteType.Integer);
                var fTok = insFts.Parameters.Add("$tok", SqliteType.Text);

                foreach (var row in pageRows)
                {
                    pDi.Value = docId;
                    pPn.Value = (long)row.PageNo;
                    pCi.Value = row.ClauseId;
                    pCt.Value = row.Cite;
                    pRsn.Value = row.RowStdName;
                    pRso.Value = row.RowStdNo;
                    pRv.Value = row.RowValidity;
                    pEx.Value = row.Explanation;
                    pIm.Value = (mandFlag == 1 || row.IsMandatory) ? 1 : 0;
                    pPt.Value = row.Text;
                    long pageId = (long)(insPage.ExecuteScalar() ?? 0L);

                    var effStd = string.IsNullOrEmpty(row.RowStdName) ? docTitle : row.RowStdName;
                    var effNo = string.IsNullOrEmpty(row.RowStdNo) ? meta.StandardCode : row.RowStdNo;
                    // 调用 C++ 原生 UTF-8 FTS 分词内核
                    string ftsTokens = NativeMethods.TokenizeForFts($"{effStd} {effNo} {row.ClauseId} {row.Text} {row.Explanation}");
                    fId.Value = pageId;
                    fTok.Value = ftsTokens;
                    insFts.ExecuteNonQuery();
                }
            }

            tx.Commit();
            addedOrUpdated++;
        }

        return new SyncSummary(normRoot, diskFiles.Count, addedOrUpdated, skipped, removed, failed);
    }

    internal static QueryResponse Query(
        SqliteConnection conn,
        string query,
        string? standard,
        bool currentOnly,
        bool mandatoryOnly,
        int limit
    )
    {
        var sw = Stopwatch.StartNew();
        int indexedDocs = CountScalar(conn, "SELECT COUNT(*) FROM reg_documents");
        int indexedPages = CountScalar(conn, "SELECT COUNT(*) FROM reg_pages");

        var rawQ = (query ?? string.Empty).Trim();
        if (string.IsNullOrEmpty(rawQ) || indexedPages == 0)
        {
            return new QueryResponse(indexedDocs, indexedPages, 0, sw.Elapsed.TotalMilliseconds, []);
        }

        var wholeClause = DetectClauseNumber(rawQ);
        var (positive, negative) = wholeClause is not null
            ? (new List<string> { rawQ }, new List<string>())
            : ParseQuery(rawQ);

        if (positive.Count == 0)
        {
            return new QueryResponse(indexedDocs, indexedPages, 0, sw.Elapsed.TotalMilliseconds, []);
        }

        var ftsTerms = new List<string>();
        var termGroups = new List<(string? ClauseAnchor, List<string> Variants)>();

        foreach (var term in positive)
        {
            var cid = DetectClauseNumber(term);
            if (cid is not null)
            {
                ftsTerms.Add($"\"{cid.Replace("\"", "")}\"");
                termGroups.Add((cid, [cid]));
            }
            else
            {
                var variants = UnitExpander.Expand(term);
                var ftsParts = NativeMethods.TokenizeForFts(term);
                foreach (var tok in ftsParts.Split(' ', StringSplitOptions.RemoveEmptyEntries))
                {
                    ftsTerms.Add($"\"{tok.Replace("\"", "")}\"");
                }
                termGroups.Add((null, variants));
            }
        }

        var negGroups = negative.Select(UnitExpander.Expand).ToList();
        var matchExpr = string.Join(" OR ", ftsTerms.Distinct().Take(24));
        if (string.IsNullOrWhiteSpace(matchExpr))
        {
            return new QueryResponse(indexedDocs, indexedPages, 0, sw.Elapsed.TotalMilliseconds, []);
        }

        var whereParts = new List<string> { "reg_pages_fts MATCH $match" };
        using var cmd = conn.CreateCommand();
        cmd.Parameters.AddWithValue("$match", matchExpr);

        if (!string.IsNullOrWhiteSpace(standard))
        {
            var escaped = "%" + standard.Trim().Replace("\\", "\\\\").Replace("%", "\\%").Replace("_", "\\_") + "%";
            cmd.Parameters.AddWithValue("$std", escaped);
            whereParts.Add("(d.doc_title LIKE $std ESCAPE '\\' OR d.standard_code LIKE $std ESCAPE '\\' OR p.row_std_name LIKE $std ESCAPE '\\' OR p.row_std_no LIKE $std ESCAPE '\\')");
        }
        if (currentOnly)
        {
            whereParts.Add("(d.status != 'repealed' AND p.row_validity NOT LIKE '%废止%')");
        }
        if (mandatoryOnly)
        {
            whereParts.Add("(p.is_mandatory = 1 OR d.is_full_text_mandatory = 1)");
        }

        cmd.CommandText = $"""
            SELECT d.doc_title, d.standard_code, d.status, d.status_label,
                   d.superseded_by, d.warning_text, d.file_path,
                   p.page_no, p.clause_id, p.cite, p.row_std_name, p.row_std_no, p.row_validity,
                   p.explanation, p.is_mandatory, p.page_text,
                   bm25(reg_pages_fts) AS rank_score
            FROM reg_pages_fts f
            JOIN reg_pages p ON p.id = f.rowid
            JOIN reg_documents d ON d.id = p.doc_id
            WHERE {string.Join(" AND ", whereParts)}
            ORDER BY rank_score ASC
            LIMIT 240
            """;

        var hits = new List<SearchHitChunk>();
        var lowerRaw = rawQ.ToLowerInvariant();

        using var reader = cmd.ExecuteReader();
        while (reader.Read())
        {
            var docTitle = reader.GetString(0);
            var docStdCode = reader.GetString(1);
            var docStatusStr = reader.GetString(2);
            var docStatusLabel = reader.GetString(3);
            var docSupersededBy = reader.IsDBNull(4) ? null : reader.GetString(4);
            var docWarningText = reader.IsDBNull(5) ? null : reader.GetString(5);
            var filePath = reader.GetString(6);
            var pageNo = (uint)Math.Max(1, reader.GetInt64(7));
            var clauseId = reader.GetString(8);
            var rowCite = reader.GetString(9);
            var rowStdName = reader.GetString(10);
            var rowStdNo = reader.GetString(11);
            var rowValidity = reader.GetString(12);
            var explanation = reader.GetString(13);
            var isMandatory = reader.GetInt64(14) != 0;
            var pageText = reader.GetString(15);
            var bm25Val = reader.IsDBNull(16) ? 0.0 : reader.GetDouble(16);

            var effTitle = string.IsNullOrEmpty(rowStdName) ? docTitle : rowStdName;
            var effCode = string.IsNullOrEmpty(rowStdNo) ? docStdCode : rowStdNo;
            StandardStatus effStatus;
            string effLabel;
            string? effSuperseded;
            string? effWarning;

            if (!string.IsNullOrEmpty(effCode) && effCode != effTitle)
            {
                var rm = MetadataEngine.Inspect($"{effCode} {effTitle}", pageText);
                effStatus = rm.Status;
                effLabel = string.IsNullOrEmpty(rowValidity) ? rm.StatusLabel : rowValidity;
                effSuperseded = rm.SupersededBy ?? docSupersededBy;
                effWarning = rm.WarningText ?? docWarningText;
            }
            else
            {
                effStatus = MetadataEngine.StatusFromDbString(docStatusStr);
                effLabel = string.IsNullOrEmpty(rowValidity) ? docStatusLabel : rowValidity;
                effSuperseded = docSupersededBy;
                effWarning = docWarningText;
            }

            var lowerHay = $"{effTitle} {effCode} {pageText} {explanation}".ToLowerInvariant();
            if (negGroups.Any(vs => vs.Any(v => lowerHay.Contains(v.ToLowerInvariant(), StringComparison.Ordinal))))
            {
                continue;
            }

            int matchedGroups = 0;
            long score = 0;
            foreach (var (clauseAnchor, variants) in termGroups)
            {
                bool hitGroup = false;
                foreach (var v in variants)
                {
                    var lv = v.ToLowerInvariant();
                    int pos = lowerHay.IndexOf(lv, StringComparison.Ordinal);
                    if (pos < 0) continue;

                    if (clauseAnchor is not null)
                    {
                        if (NativeMethods.ClauseBoundaryOk(lowerHay, pos, lv.Length))
                        {
                            hitGroup = true;
                            score += 45;
                            bool lineHead = pos < 6 || lowerHay.AsSpan(Math.Max(0, pos - 3), Math.Min(3, pos)).Contains('\n');
                            if (lineHead || clauseId == clauseAnchor) score += 25;
                        }
                    }
                    else
                    {
                        hitGroup = true;
                        score += v.Length >= 3 ? 12 : 6;
                    }
                    if (hitGroup) break;
                }
                if (hitGroup) matchedGroups++;
            }

            if (matchedGroups == 0) continue;
            if (matchedGroups == termGroups.Count) score += 35;
            if (lowerHay.Contains(lowerRaw, StringComparison.Ordinal)) score += 30;
            score += MetadataEngine.RankWeight(effStatus);
            score += (long)Math.Round(-bm25Val * 2.0);
            if (isMandatory) score += 8;

            string snippetText = pageText;
            if (pageText.Length > 1200)
            {
                var lowerPage = pageText.ToLowerInvariant();
                int firstPos = -1;
                foreach (var (_, vs) in termGroups)
                {
                    foreach (var v in vs)
                    {
                        int p = lowerPage.IndexOf(v.ToLowerInvariant(), StringComparison.Ordinal);
                        if (p >= 0) { firstPos = p; break; }
                    }
                    if (firstPos >= 0) break;
                }
                int start = firstPos >= 0 ? Math.Max(0, firstPos - 180) : 0;
                int takeLen = Math.Min(1100, pageText.Length - start);
                snippetText = pageText.Substring(start, takeLen);
            }

            var citeStr = string.IsNullOrEmpty(rowCite)
                ? $"{effCode} 第{pageNo}页 ({clauseId})"
                : rowCite;

            hits.Add(new SearchHitChunk(
                citeStr,
                effTitle,
                effCode,
                clauseId,
                pageNo,
                snippetText,
                string.IsNullOrWhiteSpace(explanation) ? null : explanation,
                effLabel,
                effSuperseded,
                effWarning,
                isMandatory,
                filePath,
                score
            ));
        }

        hits.Sort((a, b) =>
        {
            int c = b.Score.CompareTo(a.Score);
            return c != 0 ? c : a.PageNo.CompareTo(b.PageNo);
        });

        int totalHits = hits.Count;
        int capped = limit <= 0 ? 8 : Math.Min(limit, 30);
        if (hits.Count > capped) hits = hits.Take(capped).ToList();

        return new QueryResponse(indexedDocs, indexedPages, totalHits, sw.Elapsed.TotalMilliseconds, hits);
    }

    internal static StatsResponse GetStats(SqliteConnection conn)
    {
        int docs = CountScalar(conn, "SELECT COUNT(*) FROM reg_documents");
        int pages = CountScalar(conn, "SELECT COALESCE(SUM(page_count), 0) FROM reg_documents");
        int scanned = CountScalar(conn, "SELECT COUNT(*) FROM reg_documents WHERE index_status = 'scanned'");
        var samples = new List<string>();
        using var cmd = conn.CreateCommand();
        cmd.CommandText = "SELECT doc_title FROM reg_documents ORDER BY id DESC LIMIT 12";
        using var r = cmd.ExecuteReader();
        while (r.Read()) samples.Add(r.GetString(0));
        return new StatsResponse(docs, pages, scanned, samples);
    }

    private static void DeleteDocById(SqliteConnection conn, SqliteTransaction tx, long docId)
    {
        using (var delFts = conn.CreateCommand())
        {
            delFts.Transaction = tx;
            delFts.CommandText = "DELETE FROM reg_pages_fts WHERE rowid IN (SELECT id FROM reg_pages WHERE doc_id = $id)";
            delFts.Parameters.AddWithValue("$id", docId);
            delFts.ExecuteNonQuery();
        }
        using (var delDoc = conn.CreateCommand())
        {
            delDoc.Transaction = tx;
            delDoc.CommandText = "DELETE FROM reg_documents WHERE id = $id";
            delDoc.Parameters.AddWithValue("$id", docId);
            delDoc.ExecuteNonQuery();
        }
    }

    private static IEnumerable<FileInfo> EnumerateRegFiles(string root)
    {
        var stack = new Stack<DirectoryInfo>();
        stack.Push(new DirectoryInfo(root));
        while (stack.Count > 0)
        {
            var dir = stack.Pop();
            IEnumerable<FileSystemInfo> entries;
            try { entries = dir.EnumerateFileSystemInfos(); }
            catch { continue; }
            foreach (var item in entries)
            {
                if (item.Name.StartsWith('.')) continue;
                if (item is DirectoryInfo sub) stack.Push(sub);
                else if (item is FileInfo fi)
                {
                    var ext = fi.Extension.ToLowerInvariant();
                    if (ext is ".pdf" or ".md" or ".txt" or ".json") yield return fi;
                }
            }
        }
    }

    private static string SanitizeLines(string raw) =>
        string.Join("\n", raw.Split('\n').Select(l => l.Trim()).Where(l => l.Length > 0));

    private static void DedupeRepeatedMargins(List<(uint PageNo, string Text)> pages)
    {
        if (pages.Count < 8) return;
        var counts = new Dictionary<string, int>(StringComparer.Ordinal);
        foreach (var (_, txt) in pages)
        {
            var lines = txt.Split('\n');
            if (lines.Length < 6) continue;
            var seen = new HashSet<string>(StringComparer.Ordinal);
            foreach (var edge in new[] { lines[0].Trim(), lines[^1].Trim() })
            {
                if (edge.Length <= 48 && seen.Add(edge))
                {
                    counts[edge] = counts.GetValueOrDefault(edge) + 1;
                }
            }
        }
        int threshold = Math.Max(5, (int)Math.Ceiling(pages.Count * 0.3));
        var noisy = counts.Where(kv => kv.Value >= threshold).Select(kv => kv.Key).ToHashSet(StringComparer.Ordinal);
        if (noisy.Count == 0) return;

        for (int i = 0; i < pages.Count; i++)
        {
            var lines = pages[i].Text.Split('\n');
            if (lines.Length < 6) continue;
            var kept = string.Join("\n", lines.Where(l => !noisy.Contains(l.Trim())));
            pages[i] = (pages[i].PageNo, kept);
        }
    }

    private static List<ParsedPageRow> ExtractMarkdownOrText(string filePath)
    {
        var raw = File.ReadAllText(filePath, Encoding.UTF8);
        var outRows = new List<ParsedPageRow>();
        uint secNo = 1;
        var buf = new StringBuilder();

        foreach (var para in raw.Split(["\r\n\r\n", "\n\n"], StringSplitOptions.None))
        {
            var t = para.Trim();
            if (t.Length < 12) continue;
            if (buf.Length > 0 && buf.Length + t.Length > 950)
            {
                var s = buf.ToString();
                var m = ClauseLineRegex().Match(s);
                var cid = m.Success ? m.Groups[1].Value : $"P{secNo}";
                outRows.Add(new ParsedPageRow(secNo, cid, "", "", "", "", "", MandatoryRegex().IsMatch(s), s));
                secNo++;
                buf.Clear();
            }
            if (buf.Length > 0) buf.Append("\n\n");
            buf.Append(t);
        }

        if (buf.Length > 0)
        {
            var s = buf.ToString();
            var m = ClauseLineRegex().Match(s);
            var cid = m.Success ? m.Groups[1].Value : $"P{secNo}";
            outRows.Add(new ParsedPageRow(secNo, cid, "", "", "", "", "", MandatoryRegex().IsMatch(s), s));
        }

        return outRows;
    }

    private static List<ParsedPageRow> ExtractJsonChunks(string filePath, string fallbackTitle)
    {
        var raw = File.ReadAllText(filePath, Encoding.UTF8);
        using var doc = JsonDocument.Parse(raw);
        var root = doc.RootElement;

        JsonElement arrEl;
        if (root.ValueKind == JsonValueKind.Array) arrEl = root;
        else if (root.TryGetProperty("citations", out var c) && c.ValueKind == JsonValueKind.Array) arrEl = c;
        else if (root.TryGetProperty("chunks", out var ch) && ch.ValueKind == JsonValueKind.Array) arrEl = ch;
        else return [];

        static string GetStr(JsonElement obj, params string[] keys)
        {
            foreach (var k in keys)
            {
                if (obj.TryGetProperty(k, out var val) && val.ValueKind == JsonValueKind.String)
                {
                    var s = val.GetString()?.Trim();
                    if (!string.IsNullOrEmpty(s)) return s;
                }
            }
            return string.Empty;
        }

        var rows = new List<ParsedPageRow>();
        uint idx = 0;
        foreach (var item in arrEl.EnumerateArray())
        {
            idx++;
            if (item.ValueKind != JsonValueKind.Object) continue;
            var text = GetStr(item, "text", "content");
            if (string.IsNullOrEmpty(text)) continue;

            var rsn = GetStr(item, "standardName", "guifanName");
            if (string.IsNullOrEmpty(rsn)) rsn = fallbackTitle;
            var rso = GetStr(item, "standardNo");
            var cid = GetStr(item, "clauseId");
            if (string.IsNullOrEmpty(cid)) cid = $"C{idx}";
            var cite = GetStr(item, "cite");
            if (string.IsNullOrEmpty(cite)) cite = $"{rso}-{cid}";
            var rv = GetStr(item, "validityStatus");
            var exp = GetStr(item, "explanation");
            bool mand = item.TryGetProperty("isMandatory", out var mProp) && mProp.ValueKind == JsonValueKind.True
                ? true
                : (item.TryGetProperty("isMandatory", out mProp) && mProp.ValueKind == JsonValueKind.False
                    ? false
                    : MandatoryRegex().IsMatch(text));

            rows.Add(new ParsedPageRow(idx, cid, cite, rsn, rso, rv, exp, mand, text));
        }

        return rows;
    }

    private static (List<string> Positive, List<string> Negative) ParseQuery(string raw)
    {
        var sb = new StringBuilder(raw.Length);
        foreach (var ch in raw)
        {
            sb.Append(ch switch
            {
                '\u3000' or '，' or '、' or '；' or ';' or ',' => ' ',
                '“' or '”' => '"',
                _ => ch
            });
        }

        var tokens = new List<string>();
        var buf = new StringBuilder();
        bool inQuote = false;
        foreach (var ch in sb.ToString())
        {
            if (ch == '"')
            {
                if (buf.Length > 0 && !string.IsNullOrWhiteSpace(buf.ToString())) tokens.Add(buf.ToString().Trim());
                buf.Clear();
                inQuote = !inQuote;
            }
            else if (char.IsWhiteSpace(ch) && !inQuote)
            {
                if (buf.Length > 0 && !string.IsNullOrWhiteSpace(buf.ToString())) tokens.Add(buf.ToString().Trim());
                buf.Clear();
            }
            else buf.Append(ch);
        }
        if (buf.Length > 0 && !string.IsNullOrWhiteSpace(buf.ToString())) tokens.Add(buf.ToString().Trim());

        var pos = new List<string>();
        var neg = new List<string>();
        var seenP = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var seenN = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

        foreach (var tok in tokens.Take(10))
        {
            bool isNeg = tok.StartsWith('-') || tok.StartsWith('－');
            var target = isNeg ? tok[1..].Trim() : tok;
            if (string.IsNullOrEmpty(target)) continue;
            if (isNeg)
            {
                if (seenN.Add(target)) neg.Add(target);
            }
            else if (seenP.Add(target)) pos.Add(target);
        }

        return (pos, neg);
    }

    private static string? DetectClauseNumber(string raw)
    {
        var compact = new string(raw.Where(c => !char.IsWhiteSpace(c)).ToArray());
        if (compact.StartsWith('第')) compact = compact[1..];
        if (compact.EndsWith('条')) compact = compact[..^1];
        var m = ClauseAnchorRegex().Match(compact);
        if (!m.Success) return null;
        return m.Groups[1].Value + m.Groups[2].Value.ToUpperInvariant();
    }

    private static int CountScalar(SqliteConnection conn, string sql)
    {
        using var cmd = conn.CreateCommand();
        cmd.CommandText = sql;
        return Convert.ToInt32(cmd.ExecuteScalar() ?? 0);
    }

    private static string ComputeSha256(string filePath)
    {
        try
        {
            using var fs = File.OpenRead(filePath);
            var hash = SHA256.HashData(fs);
            return Convert.ToHexStringLower(hash);
        }
        catch { return string.Empty; }
    }
}
