#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""房间：从封闭轮廓或房间名文字反推房间多边形，算置信度、合并共线点、简化轮廓。"""
import math
import re

from plan_geom import (
    dot,
    point_in_polygon,
    polygon_area,
    r,
    text_point,
)
from plan_column import piece_point

AREA_RE = re.compile(r"([0-9]+(?:\.[0-9]+)?)\s*(?:㎡|m2|m²|平方米|平米|平)", re.I)

NUMERIC_RE = re.compile(r"^[\s0-9.,，xX×*+\-_/()（）㎡m²平方米]*$")

# 不是房间名的文字：门窗编号（M1021、C1815、FM甲1022、TLM…）、标高（±0.000 / %%P0.000 / -0.450）、
# 楼梯“上/下”、指北针“北”、比例、图名、面积统计等
NON_ROOM_RE = re.compile(
    r"^(?:[A-Z]{0,3}(?:M|C|MC|LC|GC|YC|BYC|HC|DK|TC|ZC)[甲乙丙]?\d{3,5}[a-z]?|"
    r"(?:%%[Pp]|±|[+-])?\d+(?:\.\d+)?m?|"
    r"[上下北东南西]|UP|DN|"
    r"\d+\s*[:：]\s*\d+|"
    r"[A-Z]?\d{0,3}[A-Z]?)$",
    re.I,
)

NON_ROOM_HINT_RE = re.compile(r"平面图|立面图|剖面图|详图|大样|面积|比例|说明|图例|标高|轴线|楼梯\d|^\d+-\d+$")

NON_ROOM_LAYER_RE = re.compile(r"window|door|门窗|axis|轴|dim|标注|尺寸|elev|标高|title|图签|图框", re.I)

HAS_WORD_RE = re.compile(r"[\u4e00-\u9fff]|[A-Za-z]{3,}")


def rooms_from_polygons(polys, texts):
    rooms = []
    for poly in polys:
        pts = poly["points"]
        inside = [t for t in texts if point_in_polygon(text_point(t), pts)]
        labels = sorted((t for t in inside if is_label(t["text"], t.get("layer"))), key=lambda t: -float(t.get("height") or 0))
        area_texts = [parse_area_text(t["text"]) for t in inside]
        area_texts = [a for a in area_texts if a is not None]
        rooms.append(
            {
                "name": labels[0]["text"].strip() if labels else None,
                "polygon": pts,
                "label_area_m2": area_texts[0] if area_texts else None,
                "source": "polyline",
            }
        )
    return rooms


def edge_coverage(bounds, supports):
    """推断矩形的四条边被实际墙体盖住的比例（0–1）。

    从房间名推断的矩形只在四面都被墙围住时才可信；墙只盖住一半的（敞开的大厅、L 形走廊、
    中间隔断没画）说明这个房间不是矩形，面积会偏。
    """
    total = covered = 0.0
    for side, a, b in (("left", "down", "up"), ("right", "down", "up"), ("down", "left", "right"), ("up", "left", "right")):
        lo, hi = bounds[a], bounds[b]
        if hi <= lo:
            continue
        total += hi - lo
        span = supports.get(side)
        if span:
            covered += max(0.0, min(hi, span[1]) - max(lo, span[0]))
    return covered / total if total else 0.0


def rooms_from_rectangles(texts, walls, cfg, regions=None):
    """退路：从房间名文字向四个方向找最近的墙内皮，得到一个矩形（仅适用于正交户型）。

    只在泛洪找不到围合区域时用（敞开的大厅、隔断没画），结果一定标成低置信度。
    """
    rooms = []
    axis = [w for w in walls if abs(w["base"]["d"][0]) > 0.999 or abs(w["base"]["d"][1]) > 0.999]
    for t in texts:
        if not is_label(t["text"], t.get("layer")):
            continue
        x, y = text_point(t)
        bounds = {"left": None, "right": None, "down": None, "up": None}
        supports = {}
        for w in axis:
            b = w["base"]
            half = w["thickness"] / 2
            p0, p1 = piece_point(b, w["t0"]), piece_point(b, w["t1"])
            if abs(b["d"][0]) > 0.999:  # 水平墙
                wy = p0[1]
                span = (min(p0[0], p1[0]), max(p0[0], p1[0]))
                if min(p0[0], p1[0]) <= x <= max(p0[0], p1[0]):
                    if wy > y and (bounds["up"] is None or wy - half < bounds["up"]):
                        bounds["up"], supports["up"] = wy - half, span
                    if wy < y and (bounds["down"] is None or wy + half > bounds["down"]):
                        bounds["down"], supports["down"] = wy + half, span
            else:  # 竖直墙
                wx = p0[0]
                span = (min(p0[1], p1[1]), max(p0[1], p1[1]))
                if min(p0[1], p1[1]) <= y <= max(p0[1], p1[1]):
                    if wx > x and (bounds["right"] is None or wx - half < bounds["right"]):
                        bounds["right"], supports["right"] = wx - half, span
                    if wx < x and (bounds["left"] is None or wx + half > bounds["left"]):
                        bounds["left"], supports["left"] = wx + half, span
        if None in bounds.values():
            continue
        poly = [(bounds["left"], bounds["down"]), (bounds["right"], bounds["down"]), (bounds["right"], bounds["up"]), (bounds["left"], bounds["up"])]
        near = [parse_area_text(o["text"]) for o in texts if point_in_polygon(text_point(o), poly)]
        near = [a for a in near if a is not None]
        key = tuple(round(v) for v in (bounds["left"], bounds["down"], bounds["right"], bounds["up"]))
        same = next((r for r in rooms if r["_key"] == key), None)
        if same:
            # 同一个矩形里有多个名字（如“教室”+“储藏”）：合并名称，不重复计面积
            if t["text"].strip() not in same["name"].split("/"):
                same["name"] = f"{same['name']}/{t['text'].strip()}"
            continue
        rooms.append(
            {
                "name": t["text"].strip(),
                "polygon": poly,
                "label_area_m2": near[0] if near else None,
                "source": "inferred-rect",
                "support": edge_coverage(bounds, supports),
                "seed": (x, y),
                "enclosed": False,
                "_key": key,
            }
        )
    for room in rooms:
        room.pop("_key", None)
    return rooms


def simplify_line(points, tolerance):
    """Douglas-Peucker：把折线拉到容差以内，只保留拐点。"""
    if len(points) < 3:
        return list(points)
    keep = [False] * len(points)
    keep[0] = keep[-1] = True
    stack = [(0, len(points) - 1)]
    while stack:
        a, b = stack.pop()
        if b <= a + 1:
            continue
        ax, ay = points[a]
        bx, by = points[b]
        dx, dy = bx - ax, by - ay
        length = math.hypot(dx, dy)
        best, index = -1.0, -1
        for k in range(a + 1, b):
            px, py = points[k]
            if length < 1e-9:
                distance = math.hypot(px - ax, py - ay)
            else:
                distance = abs(dy * (px - ax) - dx * (py - ay)) / length
            if distance > best:
                best, index = distance, k
        if best > tolerance:
            keep[index] = True
            stack.append((a, index))
            stack.append((index, b))
    return [point for point, kept in zip(points, keep) if kept]


def merge_collinear_points(points):
    """闭合的横平竖直折线：去掉同一条直线上的中间点，每条边是一整段（贴墙时按整段判重叠）。"""
    if len(points) < 4:
        return list(points)
    out = []
    n = len(points)
    for k in range(n):
        prev, cur, nxt = points[k - 1], points[k], points[(k + 1) % n]
        same_x = abs(prev[0] - cur[0]) < 1e-6 and abs(cur[0] - nxt[0]) < 1e-6
        same_y = abs(prev[1] - cur[1]) < 1e-6 and abs(cur[1] - nxt[1]) < 1e-6
        if not (same_x or same_y):
            out.append(cur)
    return out if len(out) >= 3 else list(points)


def simplify_closed(points, tolerance):
    """闭合折线：从离起点最远的点切开，两段分别简化后接回去。"""
    if len(points) < 5:
        return points
    far = max(range(1, len(points)), key=lambda k: math.dist(points[k], points[0]))
    head = simplify_line(points[: far + 1], tolerance)
    tail = simplify_line(points[far:] + [points[0]], tolerance)
    return head[:-1] + tail[:-1]


class RoomRegions:
    """把墙当障碍做一次栅格连通标记，从房间名位置泛洪得到被墙围住的那一片。

    「四面都有墙」验证不了「这片空间真是一个房间」：窗户、阳台栏杆、飘窗台常画成几条平行长线，
    向四周找最近墙内皮围出来的可能只是条缝。泛洪得到的是真正连通的那一片，轮廓贴合墙体，
    走廊和 L 形空间也能算对 —— 墙线在门窗洞口处是连续的（洞口挂在墙上），不会从门口漏过去。
    """

    def __init__(self, walls, cfg, max_cells=600000):
        self.ok = False
        corners = []
        for wall in walls:
            for t in (wall["t0"], wall["t1"]):
                corners.append(piece_point(wall["base"], t))
        if not corners:
            return
        self.x0 = min(p[0] for p in corners)
        self.y0 = min(p[1] for p in corners)
        width = max(p[0] for p in corners) - self.x0
        height = max(p[1] for p in corners) - self.y0
        if width <= 0 or height <= 0:
            return
        self.cell = max(50.0, math.sqrt(width * height / max_cells))
        self.cols = int(width / self.cell) + 3
        self.rows = int(height / self.cell) + 3
        self.grid = [0] * (self.cols * self.rows)  # 0 未访问，-1 墙，>0 区域编号
        self.areas, self.touches, self.cells = {}, {}, {}
        self._outlines = {}
        self.walls = walls
        self._block(walls)
        self._label()
        self.ok = True

    def _end_reach(self, wall, t, outward):
        """墙端沿墙方向要往外补多少才能把交接处封住。

        墙端顶在另一面墙上时，只补到那面墙的外皮：没做过端部延伸的墙（端点停在对方中心线）
        补上半个墙厚正好封住转角；已经延伸到外皮的墙就不再补 —— 一律外扩半个墙厚的话，
        L 形转角的内侧（房间凹角）会被咬掉一块 半墙厚 × 半墙厚 的地面。
        墙端悬空（独立墙垛、门垛）时外扩半个墙厚，和墙线画法一致。
        """
        base = wall["base"]
        half = wall["thickness"] / 2
        end = piece_point(base, t)
        tol = max(self.cell, 1.0)
        for other in self.walls:
            if other is wall:
                continue
            ob = other["base"]
            if abs(dot(ob["d"], base["d"])) > 0.1:
                continue
            across = dot(end, ob["n"]) - ob["offset"]
            along = dot(end, ob["d"])
            o_half = other["thickness"] / 2
            if abs(across) <= o_half + tol and other["t0"] - tol <= along <= other["t1"] + tol:
                # 对方墙的远侧外皮在本墙方向上的位置
                sign = 1.0 if dot(ob["n"], base["d"]) * outward > 0 else -1.0
                far = ob["offset"] + sign * o_half
                # 本墙方向上，端点到对方远侧外皮的距离
                step = (far - dot(end, ob["n"])) / (dot(ob["n"], base["d"]) * outward)
                return max(0.0, min(step, half))
        return half

    def _block(self, walls):
        cell, cols, rows, x0, y0 = self.cell, self.cols, self.rows, self.x0, self.y0
        for wall in walls:
            base = wall["base"]
            half = max(wall["thickness"] / 2, cell * 0.5)
            lo = wall["t0"] - self._end_reach(wall, wall["t0"], -1.0)
            hi = wall["t1"] + self._end_reach(wall, wall["t1"], 1.0)
            a, c = piece_point(base, lo), piece_point(base, hi)
            i0 = max(0, int((min(a[0], c[0]) - half - x0) / cell))
            i1 = min(cols - 1, int((max(a[0], c[0]) + half - x0) / cell))
            j0 = max(0, int((min(a[1], c[1]) - half - y0) / cell))
            j1 = min(rows - 1, int((max(a[1], c[1]) + half - y0) / cell))
            for j in range(j0, j1 + 1):
                py = y0 + (j + 0.5) * cell
                for i in range(i0, i1 + 1):
                    index = j * cols + i
                    if self.grid[index]:
                        continue
                    px = x0 + (i + 0.5) * cell
                    along = px * base["d"][0] + py * base["d"][1]
                    across = abs(px * base["n"][0] + py * base["n"][1] - base["offset"])
                    if across <= half and lo <= along <= hi:
                        self.grid[index] = -1

    def _label(self):
        cols, rows, grid = self.cols, self.rows, self.grid
        label = 0
        for start in range(len(grid)):
            if grid[start]:
                continue
            label += 1
            grid[start] = label
            queue = [start]
            members, edge = [], False
            while queue:
                index = queue.pop()
                members.append(index)
                i, j = index % cols, index // cols
                if i == 0 or j == 0 or i == cols - 1 or j == rows - 1:
                    edge = True
                for step in (1, -1, cols, -cols):
                    if (step == 1 and i == cols - 1) or (step == -1 and i == 0):
                        continue
                    nxt = index + step
                    if 0 <= nxt < len(grid) and not grid[nxt]:
                        grid[nxt] = label
                        queue.append(nxt)
            self.areas[label] = len(members) * self.cell * self.cell
            self.touches[label] = edge
            self.cells[label] = members

    def label_at(self, point):
        if not self.ok:
            return 0
        i = int((point[0] - self.x0) / self.cell)
        j = int((point[1] - self.y0) / self.cell)
        if not (0 <= i < self.cols and 0 <= j < self.rows):
            return 0
        value = self.grid[j * self.cols + i]
        if value > 0:
            return value
        # 名字正好压在墙线上：取周围一圈里最大的那块
        best = 0
        for di in (-1, 0, 1):
            for dj in (-1, 0, 1):
                ni, nj = i + di, j + dj
                if 0 <= ni < self.cols and 0 <= nj < self.rows:
                    candidate = self.grid[nj * self.cols + ni]
                    if candidate > 0 and (best == 0 or self.areas[candidate] > self.areas[best]):
                        best = candidate
        return best

    def probe(self, point):
        """(面积 mm², 是否碰到边界)；点落在墙里时返回 None。"""
        label = self.label_at(point)
        return (self.areas[label], self.touches[label]) if label else None

    def outline(self, point):
        """房间轮廓：沿格子边界描一圈再拉直；同一区域只描一次。"""
        label = self.label_at(point)
        if not label:
            return None
        if label not in self._outlines:
            self._outlines[label] = {
                "polygon": self._trace(self.cells[label]),
                "area": self.areas[label],
                "enclosed": not self.touches[label],
                "key": label,
            }
        return self._outlines[label]

    def _face(self, value, horizontal, lo, hi, centroid, tolerance):
        """这条边最近的那面墙内皮：横向边找水平墙，纵向边找竖直墙。"""
        best = None
        for wall in self.walls:
            base = wall["base"]
            if horizontal and abs(base["d"][0]) < 0.999:
                continue
            if not horizontal and abs(base["d"][1]) < 0.999:
                continue
            p0, p1 = piece_point(base, wall["t0"]), piece_point(base, wall["t1"])
            if horizontal:
                w_lo, w_hi, position = min(p0[0], p1[0]), max(p0[0], p1[0]), p0[1]
            else:
                w_lo, w_hi, position = min(p0[1], p1[1]), max(p0[1], p1[1]), p0[0]
            # 边和墙要真的叠在一起，不能把远处同一条线上的墙拉过来
            if min(hi, w_hi) - max(lo, w_lo) < self.cell:
                continue
            half = wall["thickness"] / 2
            face = position + half if centroid > position else position - half
            gap = abs(value - face)
            if gap <= tolerance and (best is None or gap < best[0]):
                best = (gap, face)
        return best[1] if best else None

    def _snap(self, points):
        """把轮廓的每条边贴到最近的墙面上。

        轮廓沿栅格边描出来，最多差一格（默认 50mm）；不贴的话 SketchUp 里地面和墙内表面
        会差一条缝，面积也偏 0.3% 左右。
        """
        if len(points) < 3 or not self.walls:
            return points
        tolerance = self.cell * 1.5
        original = [tuple(p) for p in points]
        out = [list(p) for p in points]
        eps = self.cell * 0.5
        for index, a in enumerate(out):
            b = out[(index + 1) % len(out)]
            # 房间在这条边的哪一侧：取边中点往两侧各探半格，落在轮廓里的那侧就是房间。
            # 不能用整个轮廓的形心——L 形房间凹角处那条边，形心可能在墙的另一侧，会把边贴到墙的外皮上。
            oa, ob = original[index], original[(index + 1) % len(original)]
            mx, my = (oa[0] + ob[0]) / 2, (oa[1] + ob[1]) / 2
            if abs(a[1] - b[1]) <= 1e-6:
                side = my + eps if point_in_polygon((mx, my + eps), original) else my - eps
                face = self._face(a[1], True, min(a[0], b[0]), max(a[0], b[0]), side, tolerance)
                if face is not None:
                    a[1] = b[1] = face
            elif abs(a[0] - b[0]) <= 1e-6:
                side = mx + eps if point_in_polygon((mx + eps, my), original) else mx - eps
                face = self._face(a[0], False, min(a[1], b[1]), max(a[1], b[1]), side, tolerance)
                if face is not None:
                    a[0] = b[0] = face
        return [tuple(p) for p in out]

    def _trace(self, members):
        cols, rows, grid = self.cols, self.rows, self.grid
        edges = {}
        for index in members:
            i, j = index % cols, index // cols
            label = grid[index]
            if j == 0 or grid[index - cols] != label:
                edges[(i, j)] = (i + 1, j)
            if i == cols - 1 or grid[index + 1] != label:
                edges[(i + 1, j)] = (i + 1, j + 1)
            if j == rows - 1 or grid[index + cols] != label:
                edges[(i + 1, j + 1)] = (i, j + 1)
            if i == 0 or grid[index - 1] != label:
                edges[(i, j + 1)] = (i, j)
        if not edges:
            return []
        # 区域里可能有独立墙垛（内岛），边界会分成外轮廓和若干个洞；房间只取最大的那个外轮廓
        loops, remaining = [], dict(edges)
        while remaining:
            start = next(iter(remaining))
            loop, cursor = [start], start
            while True:
                cursor = remaining.pop(cursor, None)
                if cursor is None or cursor == start:
                    break
                loop.append(cursor)
            loops.append(loop)
        if not loops:
            return []
        loop = max(loops, key=lambda points: abs(polygon_area(points)))
        points = [(self.x0 + i * self.cell, self.y0 + j * self.cell) for i, j in loop]
        # 先在原始的横平竖直格子边界上贴墙，再拉直：反过来的话，薄墙（≤ 一格多）围出的凹角会先被
        # Douglas-Peucker 抹成一条斜边，斜边既贴不上墙、面积也偏小
        return simplify_closed(self._snap(merge_collinear_points(points)), self.cell * 1.5)


def room_regions(walls, cfg, max_cells=600000):
    regions = RoomRegions(walls, cfg, max_cells)
    return regions if regions.ok else None


def rooms_from_labels(texts, walls, cfg):
    """图上没有房间轮廓时：从房间名泛洪，取被墙围住的那一片作为房间轮廓。

    泛洪找不到围合区域（敞开的大厅、隔断没画）的，退回「向四周找最近墙内皮」的矩形，并标成低置信度。
    """
    regions = room_regions(walls, cfg)
    rooms, by_region = [], {}
    for text in texts:
        if not is_label(text["text"], text.get("layer")):
            continue
        seed = text_point(text)
        region = regions.outline(seed) if regions else None
        if not region or not region["enclosed"] or len(region["polygon"]) < 3:
            continue
        same = by_region.get(region["key"])
        if same:
            # 同一片空间里有多个房间名：合并名称，不重复计面积；但这多半说明中间少了隔墙（没画或没识别出来），
            # 两间房被算成一间。同名重复（两个“教室”）几乎肯定是漏墙，不同名（“教室”+“储藏”）也可能是套间。
            same["labels"] += 1
            if text["text"].strip() not in same["name"].split("/"):
                same["name"] = f"{same['name']}/{text['text'].strip()}"
            else:
                same["duplicate_label"] = True
            continue
        poly = region["polygon"]
        near = [parse_area_text(other["text"]) for other in texts if point_in_polygon(text_point(other), poly)]
        near = [value for value in near if value is not None]
        room = {
            "name": text["text"].strip(),
            "polygon": poly,
            "label_area_m2": near[0] if near else None,
            "source": "inferred-region",
            "support": 1.0,
            "seed": seed,
            "enclosed": True,
            "labels": 1,
        }
        by_region[region["key"]] = room
        rooms.append(room)

    existing = [room["polygon"] for room in rooms]
    for room in rooms_from_rectangles(texts, walls, cfg, regions):
        if any(point_in_polygon(room["seed"], poly) for poly in existing):
            continue
        rooms.append(room)
    return rooms


def room_confidence(room, area, enclosed=None):
    """房间面积的可信度。

    高：轮廓是图上画出来的闭合多段线，或泛洪出的被墙围住的区域里只有这一个房间名，
        或算出的面积与图上标注差 2% 以内。
    中：从房间名推断的矩形，墙体基本围合（70%–95%）；或泛洪区域里有几个不同的房间名（可能是套间，也可能少了隔墙）。
    低：推断矩形没被墙围住（敞开的大厅、L 形走廊、隔断没画），泛洪区域里同一个房间名出现两次以上
        （几乎肯定少了隔墙，两间算成了一间），或与图上标注差 10% 以上。
    """
    if room["source"] == "polyline":
        base = "high"
    elif room["source"] == "inferred-region":
        if room.get("duplicate_label"):
            base = "low"
        elif room.get("labels", 1) > 1:
            base = "medium"
        else:
            base = "high"
    else:
        support = room.get("support")
        if support is None:
            base = "medium"
        elif support >= 0.95:
            base = "high"
        elif support >= 0.7:
            base = "medium"
        else:
            base = "low"
        if enclosed is False:
            base = "low"
    label = room.get("label_area_m2")
    if label:
        diff = abs(area - label) / label
        if diff <= 0.02:
            return "high"
        if diff > 0.10:
            return "low"
        if base == "high":
            base = "medium"
    return base


def parse_area_text(text):
    m = AREA_RE.search(text or "")
    return float(m.group(1)) if m else None


def is_label(text, layer=None):
    t = (text or "").strip()
    if not t or len(t) > 20 or NUMERIC_RE.match(t):
        return False
    if layer and NON_ROOM_LAYER_RE.search(layer):
        return False
    if NON_ROOM_RE.match(t) or NON_ROOM_HINT_RE.search(t):
        return False
    return bool(HAS_WORD_RE.search(t))
