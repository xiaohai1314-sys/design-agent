#pragma once
#include <stdint.h>

#ifdef _WIN32
  #ifdef DESIGN_NATIVE_EXPORTS
    #define DESIGN_API __declspec(dllexport)
  #else
    #define DESIGN_API __declspec(dllimport)
  #endif
#else
  #define DESIGN_API
#endif

#ifdef __cplusplus
extern "C" {
#endif

/**
 * High-speed UTF-8 CJK 2-gram + ASCII/unit tokenizer for SQLite FTS5.
 * Returns exact bytes written to utf8_out (null-terminated if out_cap > 0), or -1 on error.
 */
DESIGN_API int32_t design_tokenize_cjk_fts(
    const char* utf8_in,
    int32_t in_len,
    char* utf8_out,
    int32_t out_cap
);

/**
 * Strict clause-number boundary check (prevents 5.1.2 matching 5.1.20 or 5.1.2.1).
 * Returns 1 if valid boundary, 0 otherwise.
 */
DESIGN_API int32_t design_clause_boundary_ok(
    const char* utf8_text,
    int32_t text_len,
    int32_t match_pos,
    int32_t match_len
);

/**
 * Fast vector cosine similarity for dense embeddings (normalized or unnormalized).
 */
DESIGN_API float design_cosine_similarity_f32(
    const float* a,
    const float* b,
    int32_t dim
);

/**
 * Ramer-Douglas-Peucker 2D polyline simplification for CAD DXF rendering/export.
 * xy_in has count * 2 doubles; out_indices holds kept point indices (max = count).
 * Returns count of kept points.
 */
DESIGN_API int32_t design_cad_simplify_polyline_rdp(
    const double* xy_in,
    int32_t point_count,
    double epsilon,
    int32_t* out_indices
);

#ifdef __cplusplus
}
#endif
