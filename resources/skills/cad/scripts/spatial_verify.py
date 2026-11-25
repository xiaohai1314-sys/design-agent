#!/usr/bin/env python3
"""校验空间图件的来源绑定、坐标变换和显式关系，不判断设计语义。"""

import argparse
import hashlib
import json
import math
from pathlib import Path


VALID_TRANSFORMS = {"native", "affine", "projective"}
VALID_RELATIONS = {"contains", "intersects", "side_of_line", "orientation"}


def file_sha256(path):
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def as_matrix(transform):
    values = transform.get("matrix")
    transform_type = transform.get("type")
    if transform_type not in VALID_TRANSFORMS or not isinstance(values, list):
        return None
    if len(values) == 6:
        try:
            a, b, c, d, e, f = [float(value) for value in values]
        except (TypeError, ValueError):
            return None
        return [[a, b, c], [d, e, f], [0.0, 0.0, 1.0]]
    if len(values) == 9:
        try:
            flat = [float(value) for value in values]
        except (TypeError, ValueError):
            return None
        return [flat[0:3], flat[3:6], flat[6:9]]
    return None


def determinant(matrix):
    return (
        matrix[0][0] * (matrix[1][1] * matrix[2][2] - matrix[1][2] * matrix[2][1])
        - matrix[0][1] * (matrix[1][0] * matrix[2][2] - matrix[1][2] * matrix[2][0])
        + matrix[0][2] * (matrix[1][0] * matrix[2][1] - matrix[1][1] * matrix[2][0])
    )


def transform_point(matrix, point):
    try:
        x, y = float(point[0]), float(point[1])
    except (IndexError, TypeError, ValueError):
        return None
    denominator = matrix[2][0] * x + matrix[2][1] * y + matrix[2][2]
    if abs(denominator) < 1e-12:
        return None
    return [
        (matrix[0][0] * x + matrix[0][1] * y + matrix[0][2]) / denominator,
        (matrix[1][0] * x + matrix[1][1] * y + matrix[1][2]) / denominator,
    ]


def non_collinear(points):
    for first in range(len(points)):
        for second in range(first + 1, len(points)):
            for third in range(second + 1, len(points)):
                ax, ay = points[first]
                bx, by = points[second]
                cx, cy = points[third]
                if abs((bx - ax) * (cy - ay) - (by - ay) * (cx - ax)) > 1e-9:
                    return True
    return False


def verification_path(evidence_path):
    name = evidence_path.name
    suffix = ".spatial-evidence.json"
    if name.endswith(suffix):
        return evidence_path.with_name(name[: -len(suffix)] + ".spatial-verification.json")
    return evidence_path.with_suffix(".spatial-verification.json")


def verify(packet, root):
    checks = []
    source = packet.get("source") if isinstance(packet.get("source"), dict) else {}
    artifact = packet.get("artifact") if isinstance(packet.get("artifact"), dict) else {}
    transform = packet.get("transform") if isinstance(packet.get("transform"), dict) else {}
    matrix = as_matrix(transform)

    for label, descriptor in (("source", source), ("artifact", artifact)):
        relative_path = descriptor.get("relativePath")
        expected_sha = descriptor.get("sha256")
        target = root / relative_path if isinstance(relative_path, str) else None
        actual_sha = file_sha256(target) if target and target.is_file() else None
        checks.append(
            {
                "id": f"{label}_sha256",
                "passed": bool(expected_sha and actual_sha == expected_sha),
                "message": "来源指纹匹配" if expected_sha and actual_sha == expected_sha else "来源文件不存在或 SHA256 不匹配",
            }
        )

    determinant_value = determinant(matrix) if matrix else 0.0
    checks.append(
        {
            "id": "transform_invertible",
            "passed": matrix is not None and abs(determinant_value) > 1e-12,
            "message": "坐标矩阵可逆" if matrix and abs(determinant_value) > 1e-12 else "坐标矩阵缺失、格式错误或不可逆",
        }
    )

    anchors = packet.get("anchors") if isinstance(packet.get("anchors"), list) else []
    exact = [anchor for anchor in anchors if isinstance(anchor, dict) and anchor.get("quality") == "exact"]
    source_points = [anchor.get("sourcePoint") for anchor in exact]
    transform_type = transform.get("type")
    required_exact = 4 if transform_type == "projective" else 3 if transform_type == "affine" else 0
    anchor_count_ok = len(exact) >= required_exact and (
        transform_type != "affine" or non_collinear(source_points)
    )
    checks.append(
        {
            "id": "exact_anchor_geometry",
            "passed": anchor_count_ok,
            "message": f"需要至少 {required_exact} 个可验证锚点" if not anchor_count_ok else "锚点数量与几何分布满足要求",
        }
    )

    residuals = []
    if matrix:
        for anchor in exact:
            projected = transform_point(matrix, anchor.get("sourcePoint"))
            target = anchor.get("artifactPoint")
            if projected is None or not isinstance(target, list) or len(target) != 2:
                continue
            residuals.append(math.dist(projected, target))
    rms = math.sqrt(sum(value * value for value in residuals) / len(residuals)) if residuals else None
    width, height = artifact.get("width"), artifact.get("height")
    if isinstance(width, (int, float)) and isinstance(height, (int, float)):
        tolerance = max(4.0, math.hypot(width, height) * 0.005)
    else:
        tolerance = None
    residual_ok = required_exact == 0 or (
        rms is not None and tolerance is not None and rms <= tolerance and len(residuals) >= required_exact
    )
    checks.append(
        {
            "id": "anchor_rms",
            "passed": residual_ok,
            "rmsPx": rms,
            "tolerancePx": tolerance,
            "message": "锚点残差在阈值内" if residual_ok else "锚点残差缺失或超过阈值",
        }
    )

    relations = packet.get("relations") if isinstance(packet.get("relations"), list) else []
    invalid_relations = [
        relation
        for relation in relations
        if not isinstance(relation, dict)
        or relation.get("type") not in VALID_RELATIONS
        or relation.get("passed") is not True
    ]
    checks.append(
        {
            "id": "required_relations",
            "passed": not invalid_relations,
            "message": "全部显式空间关系通过" if not invalid_relations else "存在未通过或未声明的空间关系",
        }
    )

    has_estimated = any(isinstance(anchor, dict) and anchor.get("quality") == "estimated" for anchor in anchors)
    hard_failure = any(
        not check["passed"]
        for check in checks
        if check["id"] not in {"exact_anchor_geometry", "anchor_rms"}
        or (check["id"] == "anchor_rms" and anchor_count_ok)
    )
    if hard_failure or (required_exact > 0 and not anchor_count_ok and not has_estimated):
        result = "failed"
    elif has_estimated or (required_exact > 0 and not anchor_count_ok):
        result = "schematic"
    else:
        result = "verified"
    return {"schemaVersion": 1, "result": result, "checks": checks}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("evidence")
    parser.add_argument("--root", default=".")
    parser.add_argument("--output")
    args = parser.parse_args()
    evidence_path = Path(args.evidence)
    packet = json.loads(evidence_path.read_text(encoding="utf-8"))
    output = verify(packet, Path(args.root).resolve())
    target = Path(args.output) if args.output else verification_path(evidence_path)
    target.write_text(json.dumps(output, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(output, ensure_ascii=False))


if __name__ == "__main__":
    main()
