#define ZMO_NATIVE_EXPORTS
#include "zmo_native.h"

#include <cmath>
#include <cstring>
#include <vector>

namespace {

inline bool decode_utf8(const unsigned char* s, int32_t len, int32_t& idx, uint32_t& cp, int32_t& byte_len) {
    if (idx >= len) return false;
    unsigned char b0 = s[idx];
    if (b0 < 0x80) {
        cp = b0;
        byte_len = 1;
        return true;
    }
    if ((b0 & 0xE0) == 0xC0 && idx + 1 < len) {
        cp = ((uint32_t)(b0 & 0x1F) << 6) | (uint32_t)(s[idx + 1] & 0x3F);
        byte_len = 2;
        return true;
    }
    if ((b0 & 0xF0) == 0xE0 && idx + 2 < len) {
        cp = ((uint32_t)(b0 & 0x0F) << 12) | ((uint32_t)(s[idx + 1] & 0x3F) << 6) | (uint32_t)(s[idx + 2] & 0x3F);
        byte_len = 3;
        return true;
    }
    if ((b0 & 0xF8) == 0xF0 && idx + 3 < len) {
        cp = ((uint32_t)(b0 & 0x07) << 18) | ((uint32_t)(s[idx + 1] & 0x3F) << 12) |
             ((uint32_t)(s[idx + 2] & 0x3F) << 6) | (uint32_t)(s[idx + 3] & 0x3F);
        byte_len = 4;
        return true;
    }
    cp = b0;
    byte_len = 1;
    return true;
}

inline void append_utf8(uint32_t cp, char* out, int32_t cap, int32_t& pos) {
    auto push_b = [&](char c) {
        if (pos + 1 < cap) out[pos] = c;
        ++pos;
    };
    if (cp < 0x80) {
        push_b(static_cast<char>(cp));
    } else if (cp < 0x800) {
        push_b(static_cast<char>(0xC0 | (cp >> 6)));
        push_b(static_cast<char>(0x80 | (cp & 0x3F)));
    } else if (cp < 0x10000) {
        push_b(static_cast<char>(0xE0 | (cp >> 12)));
        push_b(static_cast<char>(0x80 | ((cp >> 6) & 0x3F)));
        push_b(static_cast<char>(0x80 | (cp & 0x3F)));
    } else {
        push_b(static_cast<char>(0xF0 | (cp >> 18)));
        push_b(static_cast<char>(0x80 | ((cp >> 12) & 0x3F)));
        push_b(static_cast<char>(0x80 | ((cp >> 6) & 0x3F)));
        push_b(static_cast<char>(0x80 | (cp & 0x3F)));
    }
}

inline bool is_cjk(uint32_t cp) {
    return (cp >= 0x4E00 && cp <= 0x9FFF) || (cp >= 0x3400 && cp <= 0x4DBF);
}

inline bool is_token_ascii_or_unit(uint32_t cp) {
    if (cp >= '0' && cp <= '9') return true;
    if (cp >= 'a' && cp <= 'z') return true;
    if (cp >= 'A' && cp <= 'Z') return true;
    return cp == '.' || cp == '-' || cp == 0x33A1 /* ㎡ */ || cp == 0x00B2 /* ² */ || cp == 0x00B3 /* ³ */;
}

struct Utf8Token {
    uint32_t cp;
    int32_t offset;
    int32_t len;
};

double point_segment_dist_sq(double px, double py, double ax, double ay, double bx, double by) {
    double dx = bx - ax;
    double dy = by - ay;
    double len_sq = dx * dx + dy * dy;
    if (len_sq <= 1e-18) {
        double ex = px - ax;
        double ey = py - ay;
        return ex * ex + ey * ey;
    }
    double t = ((px - ax) * dx + (py - ay) * dy) / len_sq;
    if (t < 0.0) t = 0.0;
    if (t > 1.0) t = 1.0;
    double proj_x = ax + t * dx;
    double proj_y = ay + t * dy;
    double rx = px - proj_x;
    double ry = py - proj_y;
    return rx * rx + ry * ry;
}

void rdp_recurse(const double* xy, int32_t start, int32_t end, double eps_sq, std::vector<uint8_t>& keep) {
    if (end <= start + 1) return;
    double max_d = -1.0;
    int32_t max_idx = -1;
    double ax = xy[start * 2], ay = xy[start * 2 + 1];
    double bx = xy[end * 2], by = xy[end * 2 + 1];
    for (int32_t i = start + 1; i < end; ++i) {
        double d = point_segment_dist_sq(xy[i * 2], xy[i * 2 + 1], ax, ay, bx, by);
        if (d > max_d) {
            max_d = d;
            max_idx = i;
        }
    }
    if (max_d > eps_sq && max_idx > start) {
        keep[max_idx] = 1;
        rdp_recurse(xy, start, max_idx, eps_sq, keep);
        rdp_recurse(xy, max_idx, end, eps_sq, keep);
    }
}

} // namespace

extern "C" {

ZMO_API int32_t zmo_tokenize_cjk_fts(
    const char* utf8_in,
    int32_t in_len,
    char* utf8_out,
    int32_t out_cap
) {
    if (!utf8_in || in_len <= 0 || !utf8_out || out_cap <= 1) {
        if (utf8_out && out_cap > 0) utf8_out[0] = '\0';
        return 0;
    }

    const unsigned char* bytes = reinterpret_cast<const unsigned char*>(utf8_in);
    std::vector<uint32_t> cps;
    cps.reserve(static_cast<size_t>(in_len));

    int32_t i = 0;
    while (i < in_len) {
        uint32_t cp = 0;
        int32_t bl = 1;
        if (!decode_utf8(bytes, in_len, i, cp, bl)) break;
        cps.push_back(cp);
        i += bl;
    }

    int32_t out_pos = 0;
    size_t n = cps.size();
    for (size_t k = 0; k < n; ++k) {
        uint32_t c = cps[k];
        if (is_cjk(c)) {
            if (k + 1 < n && is_cjk(cps[k + 1])) {
                append_utf8(c, utf8_out, out_cap, out_pos);
                append_utf8(cps[k + 1], utf8_out, out_cap, out_pos);
                append_utf8(' ', utf8_out, out_cap, out_pos);
            } else {
                append_utf8(c, utf8_out, out_cap, out_pos);
                append_utf8(' ', utf8_out, out_cap, out_pos);
            }
        } else if (is_token_ascii_or_unit(c)) {
            if (c >= 'A' && c <= 'Z') c += ('a' - 'A');
            append_utf8(c, utf8_out, out_cap, out_pos);
        } else {
            append_utf8(' ', utf8_out, out_cap, out_pos);
        }
        if (out_pos + 8 >= out_cap) break;
    }

    int32_t written = (out_pos < out_cap) ? out_pos : (out_cap - 1);
    utf8_out[written] = '\0';
    return written;
}

ZMO_API int32_t zmo_clause_boundary_ok(
    const char* utf8_text,
    int32_t text_len,
    int32_t match_pos,
    int32_t match_len
) {
    if (!utf8_text || text_len <= 0 || match_pos < 0 || match_len <= 0 || match_pos + match_len > text_len) {
        return 0;
    }
    auto is_digit_or_dot = [](unsigned char c) -> bool {
        return (c >= '0' && c <= '9') || c == '.';
    };
    if (match_pos > 0 && is_digit_or_dot(static_cast<unsigned char>(utf8_text[match_pos - 1]))) {
        return 0;
    }
    if (match_pos + match_len < text_len && is_digit_or_dot(static_cast<unsigned char>(utf8_text[match_pos + match_len]))) {
        return 0;
    }
    return 1;
}

ZMO_API float zmo_cosine_similarity_f32(
    const float* a,
    const float* b,
    int32_t dim
) {
    if (!a || !b || dim <= 0) return 0.0f;
    double dot = 0.0;
    double na = 0.0;
    double nb = 0.0;
    for (int32_t i = 0; i < dim; ++i) {
        double va = a[i];
        double vb = b[i];
        dot += va * vb;
        na += va * va;
        nb += vb * vb;
    }
    double denom = std::sqrt(na) * std::sqrt(nb);
    if (denom <= 1e-12) return 0.0f;
    return static_cast<float>(dot / denom);
}

ZMO_API int32_t zmo_cad_simplify_polyline_rdp(
    const double* xy_in,
    int32_t point_count,
    double epsilon,
    int32_t* out_indices
) {
    if (!xy_in || !out_indices || point_count <= 0) return 0;
    if (point_count <= 2 || epsilon <= 0.0) {
        for (int32_t i = 0; i < point_count; ++i) out_indices[i] = i;
        return point_count;
    }
    std::vector<uint8_t> keep(static_cast<size_t>(point_count), 0);
    keep[0] = 1;
    keep[static_cast<size_t>(point_count - 1)] = 1;
    rdp_recurse(xy_in, 0, point_count - 1, epsilon * epsilon, keep);

    int32_t count = 0;
    for (int32_t i = 0; i < point_count; ++i) {
        if (keep[static_cast<size_t>(i)]) {
            out_indices[count++] = i;
        }
    }
    return count;
}

} // extern "C"
