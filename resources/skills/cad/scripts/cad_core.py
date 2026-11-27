#!/usr/bin/env python3
"""CAD 工具箱（同目录 cad.py）的底层：DWG 转换与缓存、Layout 与图层、文字/尺寸/块/几何抽取、图幅识别、
逐实体隔离绘制与出图。

只记录可复现的几何和文字证据，不推断房间、楼层或方案功能。
"""
import ctypes
import fnmatch
import glob
import hashlib
import json
import math
import os
import re
import shutil
import statistics
import subprocess
import sys
import tempfile
import time
from collections import Counter, namedtuple
from pathlib import Path


class CadError(Exception):
    """可直接展示给模型的失败原因；入口脚本输出 `ERROR: ...` 并以非零码退出。"""


def configure_stdio():
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass


# ---------------------------------------------------------------------------
# DWG → DXF 转换与缓存
# ---------------------------------------------------------------------------

# 单个转换后端的时限。LibreDWG 偶发在坏图上卡死；不设时限会吃满 execute 工具的整轮预算。
CONVERT_TIMEOUT_SECONDS = 120
# 转换结果按原件内容寻址缓存，同一张图多次调用只转换一次。
CACHE_MAX_AGE_SECONDS = 7 * 24 * 3600
CACHE_MAX_FILES = 24
# 遍历结果（collect_layout、顶层实体包围盒）按「原件内容 + 本脚本 + ezdxf 版本」寻址，存在 DXF 缓存旁。
# 这些结果要把整张图的块递归炸开才算得出，大图上一次 30 秒以上；不缓存的话每条命令都重算一遍。
CACHE_MAX_RESULT_FILES = 96
SCRIPT_DIGEST = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()[:16]


def resolve_dwg2dxf() -> str | None:
    """优先定位技能随包发布的 LibreDWG，再回退系统 PATH。

    平台 → vendor 子目录的映射与 scripts/fetch-cad-runtime.mjs 的 MANIFEST.destDir 配对，改一处须同步另一处。
    """
    skill_dir = Path(__file__).resolve().parent.parent
    if sys.platform == "win32":
        bundled = skill_dir / "vendor" / "win64" / "dwg2dxf.exe"
    elif sys.platform == "darwin":
        bundled = skill_dir / "vendor" / "darwin" / "dwg2dxf"
    else:
        bundled = skill_dir / "vendor" / "linux" / "dwg2dxf"
    return str(bundled) if bundled.exists() else shutil.which("dwg2dxf")


def resolve_libredwg() -> Path | None:
    """返回 Windows 技能包内的 LibreDWG 动态库，供受控执行环境回退。"""
    if sys.platform != "win32":
        return None
    library = Path(__file__).resolve().parent.parent / "vendor" / "win64" / "libredwg-0.dll"
    return library if library.exists() else None


class LibreDwgBitChain(ctypes.Structure):
    """LibreDWG Bit_Chain 的稳定 C ABI 前缀，DXF writer 通过它接收输出句柄。"""

    _fields_ = [
        ("chain", ctypes.POINTER(ctypes.c_ubyte)),
        ("size", ctypes.c_size_t),
        ("byte", ctypes.c_size_t),
        ("bit", ctypes.c_ubyte),
        ("opts", ctypes.c_ubyte),
        ("version", ctypes.c_int),
        ("from_version", ctypes.c_int),
        ("fh", ctypes.c_void_p),
        ("codepage", ctypes.c_uint16),
    ]


def dxf_is_complete(path: Path) -> bool:
    """DXF 以 `0 / EOF` 结尾。转换器中途崩溃（实测 dwg2dxf 在个别图上段错误）会留下截断文件，
    只看「文件存在且非空」会把半截 DXF 当成功，读出来是一张空图。"""
    try:
        if path.stat().st_size < 256:
            return False
        with path.open("rb") as source:
            source.seek(-64, os.SEEK_END)
            return source.read().rstrip().endswith(b"EOF")
    except OSError:
        return False


def dwg_to_dxf_with_executable(src: Path, target: Path) -> str | None:
    """用 dwg2dxf 可执行文件转换；成功返回 None，失败返回可诊断文本。"""
    executable = resolve_dwg2dxf()
    if executable is None:
        return "未找到 dwg2dxf"
    try:
        result = subprocess.run(
            [executable, "-y", "-o", str(target), str(src)],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            timeout=CONVERT_TIMEOUT_SECONDS,
        )
    except subprocess.TimeoutExpired:
        target.unlink(missing_ok=True)
        return f"dwg2dxf 超过 {CONVERT_TIMEOUT_SECONDS}s 未完成"
    except OSError as error:
        return f"dwg2dxf 无法执行: {error}"
    # LibreDWG 对可恢复的告警也会返回非零码，只要产出了完整 DXF 就算成功。
    if dxf_is_complete(target):
        return None
    target.unlink(missing_ok=True)
    detail = (result.stderr or b"").decode("utf-8", "replace").strip()
    return f"dwg2dxf exit {result.returncode}: {detail[:300] or '未产出完整 DXF'}"


def dwg_to_dxf_with_library(src: Path, target: Path) -> str | None:
    """用随包 DLL 直接完成转换；成功返回 None，失败返回可诊断文本。"""
    library_path = resolve_libredwg()
    if library_path is None:
        return "未找到可用的 LibreDWG 动态库"

    bridge_source = target.parent / "source.dwg"
    try:
        # LibreDWG 的 Windows 文件 API 使用窄字符路径，先把可能含中文的原件复制到 ASCII 临时路径。
        shutil.copy2(src, bridge_source)
        add_directory = getattr(os, "add_dll_directory", None)
        directory_handle = add_directory(str(library_path.parent)) if add_directory else None
        try:
            library = ctypes.CDLL(str(library_path))
        finally:
            if directory_handle is not None:
                directory_handle.close()

        library.dwg_new_Document.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_int]
        library.dwg_new_Document.restype = ctypes.c_void_p
        library.dwg_read_file.argtypes = [ctypes.c_char_p, ctypes.c_void_p]
        library.dwg_read_file.restype = ctypes.c_int
        library.dwg_write_dxf.argtypes = [ctypes.POINTER(LibreDwgBitChain), ctypes.c_void_p]
        library.dwg_write_dxf.restype = ctypes.c_int
        library.dwg_free.argtypes = [ctypes.c_void_p]
        library.dwg_free.restype = None

        document = library.dwg_new_Document(25, 0, 0)
        if not document:
            return "LibreDWG 无法创建文档对象"
        file_handle = None
        runtime = None
        try:
            read_result = library.dwg_read_file(os.fsencode(bridge_source), document)
            if read_result >= 0x100:
                return f"LibreDWG 读取失败（error {read_result}）"

            runtime = ctypes.CDLL("msvcrt")
            runtime.fopen.argtypes = [ctypes.c_char_p, ctypes.c_char_p]
            runtime.fopen.restype = ctypes.c_void_p
            runtime.fclose.argtypes = [ctypes.c_void_p]
            runtime.fclose.restype = ctypes.c_int
            file_handle = runtime.fopen(os.fsencode(target), b"wb")
            if not file_handle:
                return "LibreDWG 无法创建临时 DXF"

            # R_2013 DXF 兼容当前 ezdxf 解析器，也能承载现有项目图纸中的常用实体。
            chain = LibreDwgBitChain(None, 0, 0, 0, 0, 38, 38, file_handle, 30)
            write_result = library.dwg_write_dxf(ctypes.byref(chain), document)
            if write_result >= 0x100 and not target.exists():
                return f"LibreDWG 写入失败（error {write_result}）"
        finally:
            if file_handle and runtime is not None:
                runtime.fclose(file_handle)
            library.dwg_free(document)
    except Exception as error:
        return str(error)
    finally:
        bridge_source.unlink(missing_ok=True)

    if dxf_is_complete(target):
        return None
    target.unlink(missing_ok=True)
    return "LibreDWG 未生成完整 DXF"


def dwg_to_dxf_with_wasm(src: Path, target: Path) -> str | None:
    """用受控 Node 运行时加载 LibreDWG WASM；成功返回 None，失败返回可诊断文本。"""
    converter = Path(__file__).with_name("dwg_to_dxf.mjs")
    if not converter.exists():
        return "未找到 LibreDWG WASM 转换脚本"
    node = shutil.which("node")
    if node is None:
        return "未找到 Node 运行时"

    try:
        result = subprocess.run(
            [node, str(converter), str(src), str(target)],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=CONVERT_TIMEOUT_SECONDS,
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        return f"LibreDWG WASM 无法执行: {error}"

    if dxf_is_complete(target):
        return None
    target.unlink(missing_ok=True)
    detail = (result.stderr or result.stdout or b"").decode("utf-8", "replace").strip()
    return f"LibreDWG WASM exit {result.returncode}: {detail[-600:] or '无诊断输出'}"


def convert_dwg(src: Path, target: Path) -> None:
    """依次尝试可执行文件、Windows DLL、WASM；全部失败时抛出带三段诊断的 CadError。"""
    executable_detail = dwg_to_dxf_with_executable(src, target)
    if executable_detail is None:
        return
    library_detail = dwg_to_dxf_with_library(src, target)
    if library_detail is None:
        return
    wasm_detail = dwg_to_dxf_with_wasm(src, target)
    if wasm_detail is None:
        return
    raise CadError(
        "DWG 转换失败："
        f"{executable_detail}；DLL 回退失败：{library_detail[:300]}；WASM 回退失败：{wasm_detail[-600:]}"
    )


def cache_root() -> Path:
    override = os.environ.get("DESIGN_AGENT_CAD_CACHE_DIR")
    root = Path(override) if override else Path(tempfile.gettempdir()) / "design-agent-cad-cache"
    root.mkdir(parents=True, exist_ok=True)
    return root


def file_digest(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def prune_cache(root: Path, keep: Path) -> None:
    """删过期条目，并把条目数压到上限以内；正在使用的条目永远保留。"""
    try:
        entries = sorted(root.glob("*.dxf"), key=lambda item: item.stat().st_mtime, reverse=True)
    except OSError:
        return
    now = time.time()
    for index, entry in enumerate(entries):
        if entry == keep:
            continue
        try:
            if index >= CACHE_MAX_FILES or now - entry.stat().st_mtime > CACHE_MAX_AGE_SECONDS:
                entry.unlink(missing_ok=True)
        except OSError:
            pass


def dxf_path_for(source: Path) -> Path:
    """DXF 原样返回；DWG 返回按内容寻址缓存的转换结果，缓存缺失时现转。"""
    if source.suffix.lower() == ".dxf":
        return source
    root = cache_root()
    cached = root / f"{file_digest(source)[:24]}.dxf"
    if dxf_is_complete(cached):
        try:
            os.utime(cached)
        except OSError:
            pass
        return cached
    work = Path(tempfile.mkdtemp(prefix="convert-", dir=root))
    try:
        target = work / "converted.dxf"
        convert_dwg(source, target)
        os.replace(target, cached)
    finally:
        shutil.rmtree(work, ignore_errors=True)
    prune_cache(root, cached)
    return cached


def source_cache_key(source: Path) -> str:
    """遍历结果的缓存键：原件内容变了、本脚本改了、ezdxf 升级了，旧结果都不再命中。"""
    import ezdxf

    material = f"{file_digest(source)}|{SCRIPT_DIGEST}|{ezdxf.__version__}"
    return hashlib.sha256(material.encode()).hexdigest()[:24]


# 遍历结果的缓存按内容寻址、不随代码变化：判定逻辑（图框、单位、图层）改了就加一，
# 否则升级后同一张图还会拿到旧结果。
TRAVERSAL_CACHE_VERSION = 2


def result_path(key: str | None, layout_id: str, kind: str) -> Path | None:
    """没有缓存键或缓存目录建不出来（只读磁盘）时返回 None，调用方照常现算、不存盘。"""
    if not key:
        return None
    try:
        root = cache_root()
    except OSError:
        return None
    return root / f"{key}.v{TRAVERSAL_CACHE_VERSION}.{re.sub(r'[^0-9A-Za-z_-]', '_', layout_id)}.{kind}.json"


def load_result(path: Path):
    """读缓存的遍历结果；没有、损坏或读不了都当未命中。"""
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        os.utime(path)
    except (OSError, ValueError):
        return None
    return data


def prune_results(root: Path, keep: Path) -> None:
    """遍历结果同样限龄限量；先写后改名，崩溃留下的 .tmp 也按龄清掉。"""
    try:
        entries = sorted(
            (item for pattern in ("*.collect.json", "*.extents.json", "*.json.*.tmp") for item in root.glob(pattern)),
            key=lambda item: item.stat().st_mtime,
            reverse=True,
        )
    except OSError:
        return
    now = time.time()
    for index, entry in enumerate(entries):
        if entry == keep:
            continue
        try:
            if index >= CACHE_MAX_RESULT_FILES or now - entry.stat().st_mtime > CACHE_MAX_AGE_SECONDS:
                entry.unlink(missing_ok=True)
        except OSError:
            pass


def save_result(path: Path, data) -> None:
    """缓存写失败（磁盘满、只读）不影响本次命令，下次照样重算。"""
    temporary = path.with_name(f"{path.name}.{os.getpid()}.tmp")
    try:
        temporary.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
        os.replace(temporary, path)
    except OSError:
        temporary.unlink(missing_ok=True)
        return
    prune_results(path.parent, path)


def open_document(source: Path):
    """读入 DWG/DXF，返回 (document, warnings)。结构损坏的 DXF 退到 ezdxf 恢复模式。"""
    if not source.exists():
        raise CadError(f"文件不存在: {source}")
    extension = source.suffix.lower()
    if extension not in (".dwg", ".dxf"):
        raise CadError(f"只支持 .dwg/.dxf，收到 {extension or '无扩展名'}")
    dxf_path = dxf_path_for(source)

    import ezdxf
    from ezdxf import recover

    try:
        return ezdxf.readfile(str(dxf_path)), []
    except ezdxf.DXFStructureError as error:
        try:
            document, _auditor = recover.readfile(str(dxf_path))
        except Exception as recover_error:
            raise CadError(f"DXF 无法读取：{error}；恢复模式也失败：{recover_error}") from recover_error
        return document, [f"DXF 结构异常，已按恢复模式读取：{error}"]
    except OSError as error:
        raise CadError(f"DXF 无法读取：{error}") from error


# 天正（Tangent）的墙、门窗、标高、文字、尺寸等是 TCH_* 自定义类，数据只有天正自己的内核解释得了。
# 通用读取器要么整个丢掉（LibreDWG 转换就是这样），要么只剩一份显示用的线条（代理图形）。
# 转换后的 DXF 类表里仍留着这些类和实例数，据此能认出「图里本来有、读出来没有」。
TANGENT_CLASS_LABELS = {
    "TCH_WALL": "墙体",
    "TCH_OPENING": "门窗洞口",
    "TCH_TEXT": "文字",
    "TCH_DIMENSION2": "尺寸标注",
    "TCH_ELEVATION": "标高符号",
    "TCH_COLUMN": "柱",
    "TCH_AXIS_LABEL": "轴号",
    "TCH_MULTILEADER": "引出标注",
    "TCH_PIPE": "管线",
    "TCH_PIPEFITTING": "管件",
    "TCH_EQUIPMENT": "设备",
}
TANGENT_WARNING_TOP = 6


def tangent_warning(document):
    """图里有天正自定义对象时返回一条警告，否则返回 None。类表读不出来按没有处理，不影响其它命令。"""
    counts = Counter()
    try:
        for dxf_class in document.classes.classes.values():
            name = str(dxf_class.dxf.get("name", "") or "").upper()
            if name.startswith("TCH_") and dxf_class.dxf.get("is_an_entity", 1):
                counts[name] += int(dxf_class.dxf.get("instance_count", 0) or 0)
        proxies = sum(1 for entity in document.entitydb.values() if entity.dxftype() == "ACAD_PROXY_ENTITY")
    except Exception:
        return None
    if not counts:
        return None
    total = sum(counts.values())
    detail = "、".join(
        f"{TANGENT_CLASS_LABELS.get(name, name)} {count}" if count else TANGENT_CLASS_LABELS.get(name, name)
        for name, count in counts.most_common(TANGENT_WARNING_TOP)
    )
    scale = f"约 {total} 个" if total else f"{len(counts)} 类"
    fate = (
        f"现在只剩 {proxies} 个代理图形（只有显示线条，没有墙厚、文字等语义）"
        if proxies
        else "读取时已全部丢弃，文档里没有对应的实体"
    )
    return (
        f"图中含天正（Tangent）自定义对象{scale}（{detail}），{fate}。"
        "墙体、门窗、标高、尺寸数字、房间名等在解析结果里会缺失或残缺，不能据此判断图纸里没有这些内容。"
        "请让用户在天正里用「图形导出」另存为 T3 版本（普通 DWG，不是仅另存为低版本），换这份副本再解析。"
    )


# ---------------------------------------------------------------------------
# 文档、Layout、单位与图层
# ---------------------------------------------------------------------------

LayoutSpec = namedtuple("LayoutSpec", "id name kind layout")


def iter_layouts(document):
    """模型空间固定为 `model`，图纸空间按标签页顺序编号为 `layout-01`、`layout-02`……"""
    yield LayoutSpec("model", "Model", "modelspace", document.modelspace())
    index = 0
    for name in document.layouts.names_in_taborder():
        if name.lower() in ("model", "modelspace"):
            continue
        index += 1
        yield LayoutSpec(f"layout-{index:02d}", str(name), "paperspace", document.layouts.get(name))


def find_layout(document, key):
    specs = list(iter_layouts(document))
    wanted = str(key or "model").casefold()
    for spec in specs:
        if wanted in (spec.id.casefold(), spec.name.casefold()):
            return spec
    available = "、".join(f"{spec.id}（{spec.name}）" for spec in specs)
    raise CadError(f"找不到 Layout「{key}」；可用：{available}")


UNIT_NAMES = {0: "未指定", 1: "英寸", 2: "英尺", 3: "英里", 4: "毫米", 5: "厘米", 6: "米", 7: "千米", 10: "码", 14: "分米"}


def drawing_units(document):
    try:
        code = int(document.header.get("$INSUNITS", 0) or 0)
    except (TypeError, ValueError):
        code = 0
    return code, UNIT_NAMES.get(code, f"代码 {code}")


def default_tolerance(document):
    """曲线离散的默认弦高：约 0.5 毫米换算到图纸单位；未指定单位按毫米处理（国内施工图的惯例）。"""
    code, _name = drawing_units(document)
    if code in (0, 4):
        return 0.5
    try:
        from ezdxf import units

        return 0.5 * units.conversion_factor(4, code)
    except Exception:
        return 0.5


def split_patterns(values):
    return [part.strip() for value in values or [] for part in str(value).split(",") if part.strip()]


def name_matcher(values):
    """名称匹配器：含 * ? [ 的模式按通配符整体匹配，否则按子串匹配；不区分大小写。没有模式时返回 None（不过滤）。"""
    patterns = [pattern.casefold() for pattern in split_patterns(values)]
    if not patterns:
        return None

    def match(name):
        text = str(name or "").casefold()
        return any(
            fnmatch.fnmatchcase(text, pattern) if any(char in pattern for char in "*?[") else pattern in text
            for pattern in patterns
        )

    return match


def effective_layer(entity, parent_layer):
    """块内画在 0 层的实体随块引用所在图层（AutoCAD 的 0 层继承规则）；其它图层保持原样。"""
    layer = str(entity.dxf.get("layer", "0") or "0")
    return parent_layer if layer == "0" and parent_layer else layer


def layer_states(document):
    states = {}
    for layer in document.layers:
        try:
            states[str(layer.dxf.name)] = {
                "on": layer.is_on(),
                "frozen": layer.is_frozen(),
                "color": abs(int(layer.dxf.get("color", 7) or 7)),
            }
        except Exception:
            continue
    return states


def apply_layer_visibility(document, *, only=None, all_layers=False):
    """出图前改内存里的图层开关：all_layers 打开并解冻全部图层；only 只保留匹配的图层。返回被关掉的图层数。

    块内 0 层实体随块引用图层显示，所以 0 层不匹配时也照常关掉，不影响块内容。
    """
    hidden = 0
    for layer in document.layers:
        if all_layers:
            layer.on()
            layer.thaw()
        if only is not None and not only(str(layer.dxf.name)):
            layer.off()
            hidden += 1
    return hidden


# ---------------------------------------------------------------------------
# 展开遍历：炸开块引用（可选尺寸标注），标上生效图层与稳定路径
# ---------------------------------------------------------------------------

# path：顶层实体的 handle；块内实体在其后追加「.序号」（多重插入为「.m序号.序号」，尺寸标注内部为「.d序号」）。
# 同一张图无论用哪个命令、查哪个范围，同一实体的路径都一样，可以跨命令引用。
Node = namedtuple("Node", "entity kind layer path block depth in_dimension")
MAX_BLOCK_DEPTH = 8


def safe_entity_type(entity):
    try:
        return str(entity.dxftype())
    except Exception:
        return type(entity).__name__


def safe_entity_handle(entity):
    try:
        return str(entity.dxf.get("handle", "") or "")
    except Exception:
        return ""


def entity_extents(entity, cache=None):
    """快速包围盒（ezdxf fast 模式，曲线按控制点估）；算不出时返回 None。"""
    try:
        from ezdxf import bbox

        box = bbox.extents([entity], fast=True, cache=cache)
    except Exception:
        return None
    if not box.has_data:
        return None
    return (box.extmin.x, box.extmin.y, box.extmax.x, box.extmax.y)


def top_level_extents(spec, key=None):
    """每个顶层实体的快速包围盒（按存储顺序，算不出的为 None）。

    按范围查询要拿它判断哪些实体与范围相交；块引用的包围盒要递归进块内才算得出，整张图算一遍很慢，
    所以给了缓存键就存盘复用，同一张图后续每条带范围的命令都不再重算。
    """
    path = result_path(key, spec.id, "extents")
    cached = load_result(path) if path else None
    if isinstance(cached, list) and len(cached) == len(spec.layout):
        return cached
    from ezdxf import bbox

    cache = bbox.Cache()
    boxes = [entity_extents(entity, cache) for entity in spec.layout]
    boxes = [list(box) if box is not None else None for box in boxes]
    if path:
        save_result(path, boxes)
    return boxes


def walk_layout(layout, *, region=None, explode_blocks=True, explode_dimensions=False, extents=None):
    """按存储顺序遍历 Layout；块引用先产出自身，再递归产出块内实体（已换算到本 Layout 坐标）。

    给了 region 时先用顶层实体的快速包围盒剪掉范围外的实体，避免把整张图的块都炸开；算不出包围盒的实体保留。
    extents 是 top_level_extents 的结果，给了就直接用，不再逐个重算包围盒。
    """
    cache = None
    if region is not None and extents is None:
        from ezdxf import bbox

        cache = bbox.Cache()
    for ordinal, entity in enumerate(layout):
        if region is not None:
            box = extents[ordinal] if extents is not None else entity_extents(entity, cache)
            if box is not None and not boxes_intersect(box, region):
                continue
        path = safe_entity_handle(entity) or f"n{ordinal}"
        layer = str(entity.dxf.get("layer", "0") or "0")
        yield from _walk(entity, layer, path, None, 0, False, explode_blocks, explode_dimensions)


def _walk(entity, layer, path, block, depth, in_dimension, explode_blocks, explode_dimensions):
    kind = safe_entity_type(entity)
    yield Node(entity, kind, layer, path, block, depth, in_dimension)
    if depth >= MAX_BLOCK_DEPTH:
        return
    if kind == "INSERT" and explode_blocks:
        try:
            references = list(entity.multi_insert()) if entity.mcount > 1 else [entity]
        except Exception:
            references = [entity]
        for reference_index, reference in enumerate(references):
            try:
                children = list(reference.virtual_entities())
            except Exception:
                continue
            prefix = f"{path}.m{reference_index}" if len(references) > 1 else path
            name = str(reference.dxf.get("name", ""))
            for index, child in enumerate(children):
                yield from _walk(
                    child, effective_layer(child, layer), f"{prefix}.{index}", name, depth + 1,
                    in_dimension, explode_blocks, explode_dimensions,
                )
    elif kind == "DIMENSION" and explode_dimensions:
        try:
            children = list(entity.virtual_entities())
        except Exception:
            return
        for index, child in enumerate(children):
            yield from _walk(
                child, effective_layer(child, layer), f"{path}.d{index}", block, depth + 1,
                True, explode_blocks, explode_dimensions,
            )


# ---------------------------------------------------------------------------
# 文字、尺寸、图框与 viewport
# ---------------------------------------------------------------------------

# 私有区字符以转义书写：字面量肉眼不可见，编辑工具也可能把它吞成空串（空串 replace 会在每个字符间插入替换值）。
PUA_SYMBOL_MAP = {"\ue532": "Φ"}


def normalize_symbols(text: str) -> str:
    """还原 AutoCAD 控制码、`\\U+xxxx` / `\\M+cxxxx`（旧版 DWG 的多字节编码）转义和已知私有区工程符号。"""
    try:
        from ezdxf.lldxf.encoding import decode_dxf_unicode, decode_mif_to_unicode

        text = decode_mif_to_unicode(decode_dxf_unicode(text))
    except ImportError:
        pass
    for code, char in (("%%c", "Ø"), ("%%C", "Ø"), ("%%d", "°"), ("%%D", "°"), ("%%p", "±"), ("%%P", "±")):
        text = text.replace(code, char)
    for source, replacement in PUA_SYMBOL_MAP.items():
        text = text.replace(source, replacement)
    return text


def searchable_text(text: str) -> str:
    """保留原文的同时提供忽略 CAD 排版空白的检索串。"""
    return "".join(str(text or "").split())


def vec_xy(point):
    return (float(point[0]), float(point[1]))


def text_insert(entity, dxftype):
    """TEXT/ATTRIB 的非默认对齐点在 align_point，MTEXT 使用 insert。"""
    if dxftype in ("TEXT", "ATTRIB") and (entity.dxf.get("halign", 0) or entity.dxf.get("valign", 0)) and entity.dxf.hasattr("align_point"):
        return entity.dxf.align_point
    return entity.dxf.insert


def text_height(entity):
    for attribute in ("char_height", "height"):
        try:
            value = float(entity.dxf.get(attribute) or 0)
        except Exception:
            continue
        if value > 0:
            return value
    return 2.5


def text_rotation(entity, dxftype):
    try:
        if dxftype == "MTEXT":
            return float(entity.get_rotation())
        return float(entity.dxf.get("rotation", 0) or 0)
    except Exception:
        return 0.0


def text_bbox(entity, dxftype, text):
    """由文字锚点、字高和字数建立可复现近似框，避免复杂 SHX 图逐实体 bbox 计算失控。"""
    try:
        x, y = vec_xy(text_insert(entity, dxftype))
    except Exception:
        return None, "anchor_only"
    height = text_height(entity)
    width = max(height, len(text) * height * 0.6)
    return [round(x, 3), round(y - height, 3), round(x + width, 3), round(y + height * 0.2, 3)], "estimated"


def boxes_intersect(a, b):
    return not (a[2] < b[0] or b[2] < a[0] or a[3] < b[1] or b[3] < a[1])


def boxes_overlap(a, b, ratio=0.005):
    """实质重叠：重叠的宽、高都超过较小框对应边长的 0.5%。只是边缘相接（相邻图幅的图框）不算，
    坐标取整带来的微小交叠也不算。"""
    overlap_x = min(a[2], b[2]) - max(a[0], b[0])
    overlap_y = min(a[3], b[3]) - max(a[1], b[1])
    return (
        overlap_x > ratio * min(a[2] - a[0], b[2] - b[0])
        and overlap_y > ratio * min(a[3] - a[1], b[3] - b[1])
        and overlap_x > 0
        and overlap_y > 0
    )


def box_contains(outer, inner, tolerance_ratio=0.0):
    tolerance = max(outer[2] - outer[0], outer[3] - outer[1]) * tolerance_ratio
    return (
        inner[0] >= outer[0] - tolerance
        and inner[1] >= outer[1] - tolerance
        and inner[2] <= outer[2] + tolerance
        and inner[3] <= outer[3] + tolerance
    )


def bbox_area(box):
    if not box or len(box) != 4:
        return 0.0
    return max(0.0, float(box[2]) - float(box[0])) * max(0.0, float(box[3]) - float(box[1]))


def bbox_center(box):
    return ((float(box[0]) + float(box[2])) / 2, (float(box[1]) + float(box[3])) / 2)


def point_in_bbox(point, box):
    return box[0] <= point[0] <= box[2] and box[1] <= point[1] <= box[3]


def points_bbox(points):
    xs = [point[0] for point in points]
    ys = [point[1] for point in points]
    return [min(xs), min(ys), max(xs), max(ys)]


def aggregate_boxes(boxes):
    boxes = [box for box in boxes if box]
    if not boxes:
        return None
    return [
        round(min(box[0] for box in boxes), 3),
        round(min(box[1] for box in boxes), 3),
        round(max(box[2] for box in boxes), 3),
        round(max(box[3] for box in boxes), 3),
    ]


def native_extents(layout):
    try:
        from ezdxf import bbox

        box = bbox.extents(layout, fast=True)
    except Exception:
        return None
    if not box.has_data:
        return None
    return [round(float(value), 3) for value in (box.extmin.x, box.extmin.y, box.extmax.x, box.extmax.y)]


def axis_orientation(dx, dy):
    """水平/竖直判定，容差约 0.6°（斜率 1%）；都不是时返回 None。"""
    if abs(dx) + abs(dy) == 0:
        return None
    if abs(dy) <= abs(dx) * 0.01:
        return "h"
    if abs(dx) <= abs(dy) * 0.01:
        return "v"
    return None


def make_text_item(entity, kind, layer, item_id, block):
    try:
        raw = entity.plain_text() if kind == "MTEXT" else entity.dxf.text
        value = normalize_symbols(str(raw).strip())
        anchor = vec_xy(text_insert(entity, kind))
    except Exception:
        return None
    if not value:
        return None
    box, _quality = text_bbox(entity, kind, value)
    item = {
        "id": item_id,
        "type": kind,
        "text": value,
        "layer": layer,
        "anchor": [round(anchor[0], 3), round(anchor[1], 3)],
        "height": round(text_height(entity), 3),
        "bbox": box,
    }
    rotation = text_rotation(entity, kind)
    if abs(rotation) > 1e-6:
        item["rotation"] = round(rotation, 2)
    if block:
        item["block"] = block
    search = searchable_text(value)
    if search != value:
        item["searchText"] = search
    return item


DIMENSION_KINDS = {0: "linear", 1: "aligned", 2: "angular", 3: "diameter", 4: "radius", 5: "angular3p", 6: "ordinate"}


def make_dimension_item(entity, layer, item_id, block):
    try:
        measurement = round(float(entity.get_measurement()), 3)
    except Exception:
        measurement = None
    try:
        kind = DIMENSION_KINDS.get(int(entity.dimtype) & 7, "other")
    except Exception:
        kind = "other"
    item = {"id": item_id, "layer": layer, "kind": kind, "measurement": measurement}

    def point(attribute):
        try:
            if entity.dxf.hasattr(attribute):
                x, y = vec_xy(entity.dxf.get(attribute))
                return [round(x, 3), round(y, 3)]
        except Exception:
            pass
        return None

    item["anchor"] = point("text_midpoint") or point("defpoint")
    if kind in ("linear", "aligned"):
        first, second = point("defpoint2"), point("defpoint3")
        if first and second:
            item["p1"], item["p2"] = first, second
        if kind == "linear":
            angle = float(entity.dxf.get("angle", 0) or 0) % 180
            item["orientation"] = "h" if math.isclose(angle, 0, abs_tol=0.5) or math.isclose(angle, 180, abs_tol=0.5) else (
                "v" if math.isclose(angle, 90, abs_tol=0.5) else f"{angle:g}°"
            )
        elif first and second:
            item["orientation"] = axis_orientation(second[0] - first[0], second[1] - first[1]) or "斜"
    # 空串与 "<>" 表示显示测量值；其它内容是图上实际显示的替代文字，比测量值更接近原图。
    override = normalize_symbols(str(entity.dxf.get("text", "") or "").strip())
    if override and override != "<>":
        item["text"] = override
    if block:
        item["block"] = block
    return item


def closed_polyline_box(entity):
    """4–32 个顶点的闭合多段线的包围盒，作为图框候选（几何事实，不是图面语义结论）。

    没设闭合标志、但首尾点重合的多段线同样围成一个框。
    """
    try:
        if entity.dxftype() == "LWPOLYLINE":
            closed = entity.closed
            points = [(float(point[0]), float(point[1])) for point in entity.get_points("xy")]
        else:
            closed = entity.is_closed
            points = [(float(vertex.dxf.location.x), float(vertex.dxf.location.y)) for vertex in entity.vertices]
    except Exception:
        return None
    if not closed and not (len(points) >= 5 and math.isclose(points[0][0], points[-1][0]) and math.isclose(points[0][1], points[-1][1])):
        return None
    if len(points) < 4 or len(points) > 32:
        return None
    box = points_bbox(points)
    if box[2] - box[0] <= 0 or box[3] - box[1] <= 0:
        return None
    return [round(value, 3) for value in box]


def viewport_item(entity, layout_id):
    """paperspace viewport 的几何参数，供把模型空间证据与图纸页关联。"""
    try:
        viewport_id = int(entity.dxf.id)
    except Exception:
        viewport_id = 0
    if viewport_id <= 1:
        return None
    try:
        center = vec_xy(entity.dxf.center)
        view_center = vec_xy(entity.dxf.view_center_point)
        view_height = float(entity.dxf.view_height)
        width = float(entity.dxf.width)
        height = float(entity.dxf.height)
        rotation = float(entity.dxf.view_twist_angle or 0)
    except Exception:
        return None
    return {
        "id": f"{layout_id}:viewport-{viewport_id}",
        "paperspaceCenter": [round(center[0], 3), round(center[1], 3)],
        "paperspaceSize": [round(width, 3), round(height, 3)],
        "modelCenter": [round(view_center[0], 3), round(view_center[1], 3)],
        "modelHeight": round(view_height, 3),
        "scale": round(height / view_height, 8) if view_height else None,
        "rotation": round(rotation, 6),
    }


def coordinate_quantile_inliers(boxes):
    """用坐标分位区间识别显著离群证据；只有保留绝大多数证据时才裁，避免稀疏或多簇图纸被误裁。"""
    if len(boxes) < 20:
        return boxes, []
    centers = [bbox_center(box) for box in boxes]
    trim_count = max(1, int(len(boxes) * 0.01))

    def axis_fence(values):
        ordered = sorted(values)
        low = ordered[trim_count]
        high = ordered[-trim_count - 1]
        span = high - low
        padding = span * 0.25 if span > 0 else 1.0
        return low - padding, high + padding

    min_x, max_x = axis_fence([center[0] for center in centers])
    min_y, max_y = axis_fence([center[1] for center in centers])
    inliers, outliers = [], []
    for box, center in zip(boxes, centers):
        target = inliers if min_x <= center[0] <= max_x and min_y <= center[1] <= max_y else outliers
        target.append(box)
    if len(inliers) < max(3, math.ceil(len(boxes) * 0.9)):
        return boxes, []
    return inliers, outliers


MAX_FRAMES = 80


def titled_frame_boxes(boxes, texts):
    """带图名（“一层平面图”“屋顶层平面图”）的闭合矩形，按包含关系只留最外层。

    天正出图常把几十个图幅平铺在同一张图纸边框里：按包含关系它们全是「嵌套图框」，
    会被当成内边框丢掉；而它们各自带图名，这正是图幅本身。包住两个以上带图名框的矩形
    （图纸边框、图册封面）不是某一个图幅，先排除掉。
    """
    title_texts = [text for text in texts if text.get("anchor") and DRAWING_TITLE_PATTERN.search(text["text"])]
    if not title_texts:
        return []
    titled = [box for box in boxes if any(point_in_bbox(text["anchor"], box) for text in title_texts)]
    if len(titled) < 2:
        return titled
    titled.sort(key=bbox_area, reverse=True)
    leaves = [box for box in titled if sum(1 for other in titled if other is not box and box_contains(box, other, 0.01)) < 2]
    kept = []
    for box in leaves:  # 已按面积从大到小，内边框这种被包住的就不再收
        if not any(box_contains(other, box, 0.01) for other in kept):
            kept.append(box)
    return kept


def reading_order_sorted(boxes):
    """按阅读顺序（先上后下、先左后右）排；行高取中位数，跨行的图幅不会被排串。"""
    heights = sorted(box[3] - box[1] for box in boxes)
    row_height = heights[len(heights) // 2] if heights else 1.0
    top_y = max((bbox_center(box)[1] for box in boxes), default=0.0)

    def key(box):
        center_x, center_y = bbox_center(box)
        return (round((top_y - center_y) / max(row_height, 1e-9)), center_x)

    return sorted(boxes, key=key)


def build_frames(ordered, layout_id):
    frames, ids = [], {}
    for index, (box, parent) in enumerate(ordered[:MAX_FRAMES], start=1):
        ids[id(box)] = f"{layout_id}:frame-{index}"
        frame = {"id": ids[id(box)], "bbox": box}
        if parent is not None and id(parent) in ids:
            frame["within"] = ids[id(parent)]
        frames.append(frame)
    return frames


def organize_frames(raw_boxes, reference, layout_id, texts=None):
    """去重、按包含关系分出顶层与嵌套图框，顶层按阅读顺序（先上后下、先左后右）编号。

    面积门槛以剔除离群后的主体范围为参照：若拿含离群点的全证据范围，一处飞到远处的文字就能把参照面积放大
    几十倍，真实图幅全被当成小框滤掉。由大到小处理，父框是否保留在处理子框前已确定：顶层框须不小于最大
    顶层框的 1/8（去掉孤立小方框），嵌套框须占父框 25% 以上（内边框这类）；房间轮廓、表格格子等不算图框。

    给了 texts 时先看有没有带图名的框：有两个以上就按它们分幅（一张图纸里平铺多个图幅的常见出图方式），
    没有就退回包含关系。
    """
    unique = {}
    for box in raw_boxes:
        unique.setdefault(tuple(round(value, 1) for value in box), box)
    all_boxes = list(unique.values())

    if texts:
        titled = titled_frame_boxes(all_boxes, texts)
        if len(titled) >= 2:
            return build_frames([(box, None) for box in reading_order_sorted(titled)], layout_id)

    minimum_area = bbox_area(reference) * 0.005 if reference else 0.0
    boxes = sorted((box for box in all_boxes if bbox_area(box) >= minimum_area), key=bbox_area, reverse=True)

    kept, top_level, nested = set(), [], []
    for index, box in enumerate(boxes):
        outers = [other for other in boxes[:index] if bbox_area(other) > bbox_area(box) and box_contains(other, box, 0.01)]
        parent = min(outers, key=bbox_area) if outers else None
        if parent is None:
            if not top_level or bbox_area(box) >= bbox_area(top_level[0]) / 8:
                top_level.append(box)
                kept.add(id(box))
        elif id(parent) in kept and bbox_area(box) >= bbox_area(parent) * 0.25:
            nested.append((box, parent))
            kept.add(id(box))

    ordered = [(box, None) for box in reading_order_sorted(top_level)]
    for owner in top_level:
        children = [box for box, parent in nested if parent is owner]
        ordered.extend((box, owner) for box in reading_order_sorted(children))
    return build_frames(ordered, layout_id)



TITLE_FIELD_GRID = 0.015


def title_block_fields(group, texts):
    """在一组同尺寸图框里找图签的「可变字段」：同一相对位置在绝大多数图框里都有文字，且内容各不相同。

    图名、图号满足这两条；公司名、电话、日期每张都一样，图面内容位置各异，都不会入选。
    返回（字段相对位置列表，每个图框的「位置 → 文字」表）。
    """
    cells = []
    for frame in group:
        x0, y0, x1, y1 = frame["bbox"]
        width, height = x1 - x0, y1 - y0
        cell = {}
        for text in texts:
            x, y = text["anchor"]
            if x0 <= x <= x1 and y0 <= y <= y1:
                key = (round((x - x0) / width / TITLE_FIELD_GRID), round((y - y0) / height / TITLE_FIELD_GRID))
                cell.setdefault(key, []).append(text)
        cells.append(cell)

    presence = Counter(key for cell in cells for key in cell)
    needed = max(2, math.ceil(len(group) * 0.8))
    fields = []
    for key, count in presence.items():
        if count < needed:
            continue
        values = [" ".join(text["text"] for text in cell[key]) for cell in cells if key in cell]
        if len(set(values)) < max(2, math.ceil(len(values) * 0.5)):
            continue
        u, v = key[0] * TITLE_FIELD_GRID, key[1] * TITLE_FIELD_GRID
        fields.append((key, count, min(u, 1 - u, v, 1 - v)))
    # 图签多贴着图框边缘：出现次数相同时离边缘近的优先；最多取 3 个字段，再按阅读顺序排列。
    fields.sort(key=lambda item: (-item[1], item[2]))
    chosen = sorted((item[0] for item in fields[:3]), key=lambda key: (-key[1], key[0]))
    return chosen, cells


def label_sheets(frames, texts):
    """给顶层图框配图名（图签可变字段拼成），识别不出时不猜；另记下框内字号最大的短文字作线索。

    两者都给：有的图把图名写成图面里的图注（字号最大），图签里只有图号。
    """
    top = [frame for frame in frames if "within" not in frame]
    groups = []
    for frame in top:
        width, height = frame["bbox"][2] - frame["bbox"][0], frame["bbox"][3] - frame["bbox"][1]
        for group in groups:
            reference = group[0]["bbox"]
            if math.isclose(width, reference[2] - reference[0], rel_tol=0.03) and math.isclose(height, reference[3] - reference[1], rel_tol=0.03):
                group.append(frame)
                break
        else:
            groups.append([frame])

    for group in groups:
        if len(group) < 2:
            continue
        fields, cells = title_block_fields(group, texts)
        for frame, cell in zip(group, cells):
            parts = [" ".join(one_line(text["text"]) for text in cell[key]) for key in fields if key in cell]
            if parts:
                frame["label"] = " ".join(parts)[:80]

    for frame in frames:
        inside = [text for text in texts if point_in_bbox(text["anchor"], frame["bbox"])]
        if not frame.get("label"):
            frame["label"] = drawing_title(inside)
        short = [text for text in inside if 2 <= len(comparable_characters(text["text"])) <= 30]
        if short:
            frame["largestText"] = one_line(max(short, key=lambda text: (text["height"], len(text["text"])))["text"])


DRAWING_TITLE_PATTERN = re.compile(r"(平面图|剖面图|立面图|详图|大样图?|总平面|门窗表|设计说明|节点图?|布置图)")


def drawing_title(texts):
    """图签字段拼不出图名时，按常见图名后缀找框内字号较大的一条（如「首层平面图」「1-1 剖面图」）。"""
    heights = [text["height"] for text in texts if text.get("height")]
    floor = max(heights) * 0.5 if heights else 0.0
    titled = [
        text
        for text in texts
        if text.get("text")
        and DRAWING_TITLE_PATTERN.search(text["text"])
        and (text.get("height") or 0) >= floor
    ]
    if not titled:
        return ""
    best = max(titled, key=lambda text: (text["height"], len(text["text"])))
    return one_line(best["text"])[:80]


def one_line(text):
    return " / ".join(part.strip() for part in str(text).splitlines() if part.strip())


def select_render_bounds(inliers, evidence_boxes, frames, subject_bounds, native_bounds):
    """选择默认出图范围：能框住几乎全部证据的真实图框 > 剔除离群后的文字/尺寸范围 > 原生 extents。

    完整证据范围由调用方另存，这里的裁剪只影响派生视图，不删任何证据。
    """
    subject_centers = [bbox_center(box) for box in inliers]
    evidence_centers = [bbox_center(box) for box in evidence_boxes]
    qualified = []
    for frame in frames:
        box = frame["bbox"]
        width, height = box[2] - box[0], box[3] - box[1]
        aspect_ratio = max(width / height, height / width) if width > 0 and height > 0 else math.inf
        coverage = sum(point_in_bbox(center, box) for center in subject_centers) / len(subject_centers) if subject_centers else 0.0
        cropping_loss = 1 - sum(point_in_bbox(center, box) for center in evidence_centers) / len(evidence_centers) if evidence_centers else 1.0
        if coverage >= 0.85 and aspect_ratio <= 10 and cropping_loss <= 0.1:
            qualified.append(frame)
    if qualified:
        selected = min(qualified, key=lambda item: bbox_area(item["bbox"]))
        return selected["bbox"], f"frame:{selected['id']}"
    if subject_bounds:
        return subject_bounds, "text_dimension_evidence"
    return native_bounds, "native_extents"


def collect_layout(spec):
    """一次遍历提取一个 Layout 的文字（含块属性与块内文字）、尺寸、图框与 viewport，并识别图幅。"""
    texts, dimensions, frame_boxes, viewports = [], [], [], []
    for node in walk_layout(spec.layout):
        entity, kind = node.entity, node.kind
        item_id = f"{spec.id}:{node.path}"
        if kind in ("TEXT", "MTEXT"):
            item = make_text_item(entity, kind, node.layer, item_id, node.block)
            if item:
                texts.append(item)
        elif kind == "INSERT":
            for index, attribute in enumerate(getattr(entity, "attribs", [])):
                handle = safe_entity_handle(attribute)
                attribute_id = f"{spec.id}:{handle}" if handle else f"{item_id}.a{index}"
                item = make_text_item(attribute, "ATTRIB", effective_layer(attribute, node.layer), attribute_id, node.block)
                if item:
                    texts.append(item)
        elif kind == "DIMENSION":
            dimensions.append(make_dimension_item(entity, node.layer, item_id, node.block))
        elif kind in ("LWPOLYLINE", "POLYLINE"):
            box = closed_polyline_box(entity)
            if box:
                frame_boxes.append(box)
        elif kind == "VIEWPORT" and node.depth == 0:
            item = viewport_item(entity, spec.id)
            if item:
                viewports.append(item)

    evidence_boxes = [item["bbox"] for item in texts if item["bbox"]]
    evidence_boxes += [[*item["anchor"], *item["anchor"]] for item in dimensions if item["anchor"]]
    evidence_bounds = aggregate_boxes(evidence_boxes)
    inliers, outliers = coordinate_quantile_inliers(evidence_boxes)
    subject_bounds = aggregate_boxes(inliers) or evidence_bounds
    native_bounds = None if evidence_bounds else native_extents(spec.layout)

    frames = organize_frames(frame_boxes, subject_bounds or native_bounds, spec.id, texts)
    label_sheets(frames, texts)
    render_bounds, render_source = select_render_bounds(inliers, evidence_boxes, frames, subject_bounds, native_bounds)
    heights = [item["height"] for item in texts]
    return {
        "evidenceBbox": evidence_bounds,
        "nativeBbox": native_bounds,
        "renderBbox": render_bounds,
        "renderBboxSource": render_source,
        "clippedOutlierCount": len(outliers),
        "medianTextHeight": round(statistics.median(heights), 3) if heights else None,
        "texts": texts,
        "dimensions": dimensions,
        "frames": frames,
        "viewports": viewports,
    }


def collect_layout_cached(spec, key=None):
    """collect_layout 的存盘版：同一张图的第二条命令起直接读结果，不再把整张图的块炸开一遍。

    无论命中与否都返回 JSON 往返后的结构（元组变列表），首次与后续命令拿到的数据形态一致。
    """
    path = result_path(key, spec.id, "collect")
    cached = load_result(path) if path else None
    if isinstance(cached, dict) and "frames" in cached:
        return cached
    collected = json.loads(json.dumps(collect_layout(spec)))
    if path:
        save_result(path, collected)
    return collected


def top_level_frames(collected):
    return [frame for frame in collected["frames"] if "within" not in frame]


def sheet_frames(collected, minimum_text_share=0.5):
    """可以当作图幅分别出图的顶层图框：至少 2 个，且合起来框住过半文字。

    没有图框的平面图里，顶层「图框」往往只是几个房间轮廓；按它们分幅会把图切碎，此时返回空，由调用方退回别的切分方式。
    """
    frames = top_level_frames(collected)
    anchors = [text["anchor"] for text in collected["texts"]]
    if len(frames) < 2 or not anchors:
        return []
    covered = sum(any(point_in_bbox(anchor, frame["bbox"]) for frame in frames) for anchor in anchors)
    return frames if covered / len(anchors) >= minimum_text_share else []


def frame_title(frame):
    return frame.get("label") or frame.get("largestText")


def find_frame(collected, key):
    """按 id（`model:frame-3`）、短名（`frame-3`）或编号（`3`）查图框。"""
    wanted = str(key).strip().casefold()
    if wanted.isdigit():
        wanted = f"frame-{wanted}"
    for frame in collected["frames"]:
        if wanted in (frame["id"].casefold(), frame["id"].split(":", 1)[-1].casefold()):
            return frame
    available = "、".join(frame["id"].split(":", 1)[-1] for frame in collected["frames"]) or "无"
    raise CadError(f"找不到图框「{key}」；可用：{available}")


def layout_is_empty(collected):
    return not (collected["texts"] or collected["dimensions"] or collected["frames"] or collected["evidenceBbox"] or collected["nativeBbox"])


# ---------------------------------------------------------------------------
# 几何：炸开块后逐实体离散成点列
# ---------------------------------------------------------------------------

GEOMETRY_TYPES = {
    "LINE", "LWPOLYLINE", "POLYLINE", "CIRCLE", "ARC", "ELLIPSE", "SPLINE",
    "SOLID", "TRACE", "3DFACE", "HATCH", "MPOLYGON", "HELIX", "WIPEOUT",
}
ALWAYS_CLOSED_TYPES = {"CIRCLE", "SOLID", "TRACE", "3DFACE", "HATCH", "MPOLYGON", "WIPEOUT"}


def flatten_entity(entity, kind, tolerance):
    """把一个图元离散成若干（点列, 是否闭合）；HATCH 的每条边界各成一条。不支持的类型返回空。"""
    from ezdxf import path

    try:
        paths = list(path.from_hatch(entity)) if kind in ("HATCH", "MPOLYGON") else [path.make_path(entity)]
    except Exception:
        return []
    shapes = []
    for item in paths:
        for sub in (list(item.sub_paths()) if item.has_sub_paths else [item]):
            try:
                vertices = [(float(vertex.x), float(vertex.y)) for vertex in sub.flattening(tolerance)]
            except Exception:
                continue
            if len(vertices) < 2:
                continue
            closed = bool(sub.is_closed) or kind in ALWAYS_CLOSED_TYPES
            if closed and len(vertices) > 2 and math.isclose(vertices[0][0], vertices[-1][0], abs_tol=1e-9) and math.isclose(vertices[0][1], vertices[-1][1], abs_tol=1e-9):
                vertices.pop()
            shapes.append((vertices, closed))
    return shapes


def polyline_length(points, closed):
    total = sum(math.dist(points[index], points[index + 1]) for index in range(len(points) - 1))
    if closed and len(points) > 2:
        total += math.dist(points[-1], points[0])
    return total


def polygon_area(points):
    return abs(sum(points[index - 1][0] * points[index][1] - points[index][0] * points[index - 1][1] for index in range(len(points)))) / 2


def iter_geometry(
    spec,
    *,
    region=None,
    tolerance=0.5,
    include_dimensions=False,
    top_level_only=False,
    layer_match=None,
    types=None,
    extents=None,
):
    """逐个产出离散后的图元：{id, type, layer, block, dimension, closed, points, bbox, length, area}。坐标未取整。

    top_level_only 时不炸开块引用，只看直接画在 Layout 上的实体。
    layer_match / types 在离散之前就过滤掉不要的图元：离散（曲线展开成点列）是逐实体最贵的一步，
    按图层查墙线时不该把范围内所有家具都离散一遍再丢掉。判定用的就是产出记录里的 layer / type。
    """
    for node in walk_layout(
        spec.layout,
        region=region,
        explode_blocks=not top_level_only,
        explode_dimensions=include_dimensions,
        extents=extents,
    ):
        if node.kind not in GEOMETRY_TYPES or (node.in_dimension and not include_dimensions):
            continue
        if types and node.kind not in types:
            continue
        if layer_match and not layer_match(node.layer):
            continue
        shapes = flatten_entity(node.entity, node.kind, tolerance)
        for index, (points, closed) in enumerate(shapes):
            record = {
                "id": f"{spec.id}:{node.path}" + (f"~{index}" if len(shapes) > 1 else ""),
                "type": node.kind,
                "layer": node.layer,
                "closed": closed,
                "points": points,
                "bbox": points_bbox(points),
                "length": polyline_length(points, closed),
            }
            if closed and len(points) > 2:
                record["area"] = polygon_area(points)
            if node.block:
                record["block"] = node.block
            if node.in_dimension:
                record["dimension"] = True
            yield record


def iter_block_references(spec, *, region=None, nested=False, extents=None):
    """块引用：名称、生效图层、插入点、旋转、缩放、快速包围盒与属性（tag → 文字）。"""
    from ezdxf import bbox

    cache = bbox.Cache()
    for node in walk_layout(spec.layout, region=region, explode_blocks=nested, extents=extents):
        if node.kind != "INSERT":
            continue
        entity = node.entity
        try:
            insert = vec_xy(entity.dxf.insert)
        except Exception:
            continue
        attributes = {}
        for attribute in getattr(entity, "attribs", []):
            try:
                attributes[str(attribute.dxf.tag)] = normalize_symbols(str(attribute.dxf.text))
            except Exception:
                continue
        box = entity_extents(entity, cache)
        record = {
            "id": f"{spec.id}:{node.path}",
            "name": str(entity.dxf.get("name", "")),
            "layer": node.layer,
            "insert": [insert[0], insert[1]],
            "rotation": float(entity.dxf.get("rotation", 0) or 0),
            "scale": [float(entity.dxf.get("xscale", 1) or 1), float(entity.dxf.get("yscale", 1) or 1)],
            "bbox": list(box) if box else None,
            "attributes": attributes,
        }
        if node.block:
            record["parentBlock"] = node.block
        yield record


# ---------------------------------------------------------------------------
# 按当前查询给文字排序（语言无关，不内置专业词典）
# ---------------------------------------------------------------------------


def comparable_characters(value):
    """保留任意书写系统中的字母和数字，供与当前查询做语言无关的字符片段匹配。"""
    return "".join(char.casefold() for char in searchable_text(value) if char.isalnum())


def query_match_score(value, query):
    """按当前查询和原文共享的 2–6 字符片段计分。"""
    candidate = comparable_characters(value)
    request = comparable_characters(query)
    if not candidate or not request:
        return 0
    score = 0
    for size in range(2, min(6, len(candidate), len(request)) + 1):
        candidate_fragments = {candidate[index:index + size] for index in range(len(candidate) - size + 1)}
        request_fragments = {request[index:index + size] for index in range(len(request) - size + 1)}
        score += size * len(candidate_fragments & request_fragments)
    return score


def unique_texts(texts):
    """按显示文字去重，保留首个实体的定位证据。"""
    unique, seen = [], set()
    for text in texts:
        key = text["text"].casefold()
        if key in seen:
            continue
        seen.add(key)
        unique.append(text)
    return unique

# ---------------------------------------------------------------------------
# 绘制：每个 Layout 只画一次，坏实体逐个隔离
# ---------------------------------------------------------------------------

VIEW_FILE_PREFIX = "design-agent-cad-"
# read_file 对 `design-agent-cad-` 前缀的图原像素内联，但单张仍受网关字节上限约束，超了会被压到宽 1000、细线小字全糊。
# 与 agent-runtime src/agent/visualProfiles.ts 的 VISUAL_TRANSPORT_PROFILE.maxBytes 配对，改一处须同步另一处。
PASSTHROUGH_MAX_BYTES = 1_500_000
# 固定 DPI：ezdxf 按 72/dpi 定最细线宽，视图尺寸只改画布英寸数，线宽在所有视图里都是约 1 像素。
RENDER_DPI = 100
TARGET_TEXT_PIXELS = 14
MIN_LONG_EDGE = 1200
DEFAULT_MAX_LONG_EDGE = 2400
RENDER_DEGRADED_THRESHOLD = 0.10
RENDER_ERROR_MESSAGE_LIMIT = 240


class RenderBudgetExceeded(Exception):
    def __init__(self, done, total):
        super().__init__(f"{done}/{total}")
        self.done = done
        self.total = total


class RenderIsolationReport:
    """按唯一实体路径聚合渲染失败，重复绘制不放大故障比例。"""

    def __init__(self):
        self._attempted = set()
        self._skipped = {}

    def record_attempt(self, entity_path):
        self._attempted.add(entity_path)

    def record_skip(self, entity_path, entity, parent_handle, error):
        self.record_attempt(entity_path)
        existing = self._skipped.get(entity_path)
        if existing is not None:
            existing["occurrenceCount"] += 1
            return
        self._skipped[entity_path] = {
            "entityPath": entity_path,
            "entityType": safe_entity_type(entity),
            "handle": safe_entity_handle(entity) or None,
            "parentHandle": parent_handle or None,
            "errorType": type(error).__name__,
            "errorMessage": " ".join(str(error).split())[:RENDER_ERROR_MESSAGE_LIMIT],
            "occurrenceCount": 1,
        }

    def fields(self):
        attempted = len(self._attempted)
        skipped = list(self._skipped.values())
        ratio = len(skipped) / attempted if attempted else 0.0
        return {
            "attemptedEntityCount": attempted,
            "skippedEntityCount": len(skipped),
            "skippedEntityRatio": round(ratio, 6),
            "skippedEntities": skipped,
            "degraded": ratio > RENDER_DEGRADED_THRESHOLD,
        }


def render_entity_path(parent_path, entity, ordinal):
    entity_type = safe_entity_type(entity)
    handle = safe_entity_handle(entity)
    if handle:
        return f"{entity_type}#{handle}"
    local_path = f"{entity_type}[{ordinal}]"
    return f"{parent_path}/{local_path}" if parent_path else local_path


def find_cjk_font():
    """返回可用于 ezdxf 渲染的中文字体，缺失时由渲染器使用默认字体。"""
    candidates = [
        r"C:\Windows\Fonts\msyh.ttc",
        r"C:\Windows\Fonts\simhei.ttf",
        r"C:\Windows\Fonts\simsun.ttc",
        "/System/Library/Fonts/PingFang.ttc",
        "/System/Library/Fonts/STHeiti Medium.ttc",
        "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
    ]
    for path in candidates:
        if os.path.exists(path):
            return path
    for pattern in ("/usr/share/fonts/**/NotoSansCJK*.*", "/usr/share/fonts/**/*CJK*SC*.*"):
        hits = glob.glob(pattern, recursive=True)
        if hits:
            return hits[0]
    return None


def prepare_fonts(document):
    """SHX 与缺失字体统一换成系统中文字体，避免中文标注渲染成方框。"""
    font = find_cjk_font()
    if not font:
        return
    font_name = os.path.basename(font)
    for style in document.styles:
        try:
            style.dxf.font = font_name
        except Exception:
            pass


def decode_text_escapes(document):
    """把全图（含块定义）文字里的 `\\M+cxxxx` / `\\U+xxxx` 就地解码（只改内存）。

    ezdxf 读文字时不解这两种旧版 DWG 的多字节转义，渲染器会把编码原样画出来。
    """
    try:
        from ezdxf.lldxf.encoding import decode_dxf_unicode, decode_mif_to_unicode
    except ImportError:
        return
    for entity in document.entitydb.values():
        try:
            kind = entity.dxftype()
            if kind == "MTEXT":
                if "\\M+" in entity.text or "\\U+" in entity.text:
                    entity.text = decode_mif_to_unicode(decode_dxf_unicode(entity.text))
            elif kind in ("TEXT", "ATTRIB", "ATTDEF"):
                value = entity.dxf.get("text", "")
                if "\\M+" in value or "\\U+" in value:
                    entity.dxf.text = decode_mif_to_unicode(decode_dxf_unicode(value))
        except Exception:
            continue


def render_configuration(monochrome=False):
    """白底出图：ACI 7 按白底解析为黑色；monochrome 把所有颜色压成黑，浅色（黄、青）标注才看得清。"""
    from ezdxf.addons.drawing.config import BackgroundPolicy, ColorPolicy, Configuration

    return Configuration(
        background_policy=BackgroundPolicy.WHITE,
        color_policy=ColorPolicy.BLACK if monochrome else ColorPolicy.COLOR,
    )


def make_backend(ax):
    from ezdxf.addons.drawing.matplotlib import SCATTER_POINT_SIZE, MatplotlibBackend
    from matplotlib.collections import LineCollection

    class LeanMatplotlibBackend(MatplotlibBackend):
        """上游 draw_solid_lines 即使没有零长线段也会 scatter 一个空集合；复杂图纸上这些空 artist
        占了一半，白白拖慢绘制与栅格化。只在确有点、确有线时才创建 artist，其余与上游一致。"""

        def draw_solid_lines(self, lines, properties):
            color = properties.color
            lineweight = self.get_lineweight(properties)
            segments, point_x, point_y = [], [], []
            for start, end in lines:
                if start.isclose(end):
                    point_x.append(start.x)
                    point_y.append(start.y)
                else:
                    segments.append(((start.x, start.y), (end.x, end.y)))
            z = self._get_z()
            if point_x:
                self.ax.scatter(point_x, point_y, s=SCATTER_POINT_SIZE, c=color, zorder=z)
            if segments:
                self.ax.add_collection(
                    LineCollection(segments, linewidths=lineweight, color=color, zorder=z, capstyle="butt")
                )

    return LeanMatplotlibBackend(ax, adjust_figure=False)


def highlight_override(match, color="#e8341c", muted="#b8bcc2"):
    """高亮匹配图层（红），其余图层压成浅灰；按生效图层判断，块内 0 层实体随块引用图层。"""

    def override(_entity, properties):
        properties.color = color if match(properties.layer) else muted

    return override


def draw_layout_isolated(
    document, layout, backend, report, *, config=None, filter_func=None, deadline=None, property_override=None
):
    """保留 ezdxf 绘制顺序，实体出错时回滚它留下的渲染状态并跳过，不连累其它实体。

    快照必须是 O(1)：ezdxf 在块引用内部会递归回到 draw_entities，块内每个子实体都要拍一次快照；
    若快照拷贝全部已画 artist，总开销随实体数平方增长（4 万实体的图要多花 30 秒以上）。
    这里只记 axes 子 artist 列表的长度，回滚时删掉尾部新增的那一段。
    """
    from ezdxf.addons.drawing import Frontend, RenderContext

    config = config if config is not None else render_configuration()
    axis = backend.ax
    children = getattr(axis, "_children", None)
    progress = {"done": 0, "total": 0}

    def artist_mark():
        return len(children) if children is not None else set(axis.get_children())

    def drop_artists_since(mark):
        added = list(children[mark:]) if children is not None else [a for a in axis.get_children() if a not in mark]
        for artist in reversed(added):
            try:
                artist.remove()
            except (NotImplementedError, ValueError):
                pass

    class IsolatingFrontend(Frontend):
        def __init__(self, context, target_backend):
            super().__init__(context, target_backend, config=config)
            self._entity_paths = []

        def _snapshot_state(self):
            context_states = getattr(self.ctx, "_saved_states", None)
            clipping_stages = getattr(self.pipeline.clipping_portal, "_stages", None)
            backend_stack = getattr(self.pipeline.backend, "entity_stack", None)
            return {
                "artists": artist_mark(),
                "contextStates": list(context_states) if context_states is not None else None,
                "contextBlock": getattr(self.ctx, "current_block_reference_properties", None),
                "clippingStages": list(clipping_stages) if clipping_stages is not None else None,
                "backendStack": list(backend_stack) if backend_stack is not None else None,
                "currentEntityHandle": getattr(self.pipeline, "_current_entity_handle", None),
                "currentViewportScale": getattr(self.pipeline, "current_vp_scale", None),
                "parentStack": list(self.parent_stack),
            }

        def _restore_state(self, snapshot):
            drop_artists_since(snapshot["artists"])
            context_states = getattr(self.ctx, "_saved_states", None)
            if context_states is not None and snapshot["contextStates"] is not None:
                context_states[:] = snapshot["contextStates"]
            self.ctx.current_block_reference_properties = snapshot["contextBlock"]
            clipping_stages = getattr(self.pipeline.clipping_portal, "_stages", None)
            if clipping_stages is not None and snapshot["clippingStages"] is not None:
                clipping_stages[:] = snapshot["clippingStages"]
            backend_stack = getattr(self.pipeline.backend, "entity_stack", None)
            if backend_stack is not None and snapshot["backendStack"] is not None:
                backend_stack[:] = snapshot["backendStack"]
            self.pipeline._current_entity_handle = snapshot["currentEntityHandle"]
            self.pipeline.current_vp_scale = snapshot["currentViewportScale"]
            self.parent_stack[:] = snapshot["parentStack"]

        def draw_entity(self, entity, properties):
            if self._entity_paths:
                report.record_attempt(self._entity_paths[-1]["path"])
            return super().draw_entity(entity, properties)

        def draw_entities(self, entities, *, filter_func=None):
            if filter_func is not None:
                entities = filter(filter_func, entities)
            items = list(entities)
            top_level = not self._entity_paths
            regular = [entity for entity in items if safe_entity_type(entity) != "VIEWPORT"]
            viewports = [entity for entity in items if safe_entity_type(entity) == "VIEWPORT"]
            if top_level:
                progress["total"] += len(items)
            for ordinal, entity in enumerate([*regular, *viewports]):
                if deadline is not None and time.monotonic() > deadline:
                    raise RenderBudgetExceeded(progress["done"], progress["total"])
                parent_path = self._entity_paths[-1]["path"] if self._entity_paths else ""
                entity_path = render_entity_path(parent_path, entity, ordinal)
                parent_handle = next((item["handle"] for item in reversed(self._entity_paths) if item["handle"]), "")
                snapshot = self._snapshot_state()
                self._entity_paths.append({"path": entity_path, "handle": safe_entity_handle(entity)})
                try:
                    super().draw_entities([entity])
                except RenderBudgetExceeded:
                    raise
                except Exception as error:
                    report.record_skip(entity_path, entity, parent_handle, error)
                    self._restore_state(snapshot)
                finally:
                    self._entity_paths.pop()
                if top_level:
                    progress["done"] += 1

    frontend = IsolatingFrontend(RenderContext(document), backend)
    if property_override is not None:
        frontend.push_property_override_function(property_override)
    frontend.draw_layout(layout, finalize=True, filter_func=filter_func)


def region_filter(regions, known=None):
    """只画包围盒与任一区域相交的顶层实体；包围盒算不出来的实体一律保留，宁多画不漏画。

    ezdxf 只对顶层实体调用过滤器，块内子实体随其 INSERT 一起保留或跳过。
    known 是 {顶层实体 handle: 缓存的包围盒}（来自 top_level_extents），命中就不再重算。
    """
    from ezdxf import bbox

    cache = bbox.Cache()
    known = known or {}

    def keep(entity):
        handle = safe_entity_handle(entity)
        if handle in known:
            entity_box = known[handle]
            if entity_box is None:
                return True
        else:
            try:
                box = bbox.extents([entity], fast=True, cache=cache)
            except Exception:
                return True
            if not box.has_data:
                return True
            entity_box = (box.extmin.x, box.extmin.y, box.extmax.x, box.extmax.y)
        return any(boxes_intersect(entity_box, region) for region in regions)

    return keep


def extents_by_handle(spec, extents):
    """top_level_extents 的结果按 handle 索引；handle 取不到的实体不进表，由调用方现算。"""
    table = {}
    for entity, box in zip(spec.layout, extents):
        handle = safe_entity_handle(entity)
        if handle:
            table[handle] = box
    return table


def pad_bbox(box, ratio=0.02):
    """按比例外扩；零宽/零高的范围至少外扩 1 个模型单位，避免退化成一条线。"""
    x0, y0, x1, y1 = [float(value) for value in box]
    pad_x = max((x1 - x0) * ratio, 1.0)
    pad_y = max((y1 - y0) * ratio, 1.0)
    return [x0 - pad_x, y0 - pad_y, x1 + pad_x, y1 + pad_y]


def choose_long_edge(view_box, median_text_height, max_long_edge):
    """按中位字高算出让文字达到可读像素所需的长边，夹在 [MIN_LONG_EDGE, max_long_edge] 之间。

    一次算准，不做「渲染→不够清楚→放大重画」的循环：达不到的时候放大也没用，应该缩小范围。
    """
    long_side = max(view_box[2] - view_box[0], view_box[3] - view_box[1])
    if not median_text_height or long_side <= 0:
        return min(max_long_edge, max(MIN_LONG_EDGE, 2000))
    needed = math.ceil(TARGET_TEXT_PIXELS * long_side / median_text_height)
    return int(min(max_long_edge, max(MIN_LONG_EDGE, needed)))


def fit_passthrough_budget(path):
    """PNG 超过原图直传上限时先量化为 64 色调色板（线稿几乎无损），仍超再等比缩小。返回实际缩放倍数。"""
    from PIL import Image

    size = path.stat().st_size
    if size <= PASSTHROUGH_MAX_BYTES:
        return 1.0, {"bytes": size}
    with Image.open(path) as source:
        image = source.convert("RGB")
    original_width = image.width
    factor = 1.0
    for _ in range(4):
        quantized = image.quantize(colors=64, method=Image.Quantize.MEDIANCUT)
        quantized.save(path, optimize=True)
        size = path.stat().st_size
        if size <= PASSTHROUGH_MAX_BYTES:
            break
        shrink = max(0.5, math.sqrt(PASSTHROUGH_MAX_BYTES / size) * 0.92)
        image = image.resize(
            (max(1, round(image.width * shrink)), max(1, round(image.height * shrink))),
            Image.Resampling.LANCZOS,
        )
        factor = image.width / original_width
    info = {"bytes": size, "quantized": True}
    if factor < 1.0:
        info["downscaledFrom"] = original_width
    return factor, info


def pixel_stats(path):
    from PIL import Image

    with Image.open(path) as source:
        image = source.convert("L")
    histogram = image.histogram()
    pixels = max(1, image.width * image.height)
    nonwhite = sum(histogram[:245]) / pixels
    return image.width, image.height, round(nonwhite, 6)


def rasterize_view(fig, ax, box, destination, long_edge):
    """把已绘制好的 axes 定位到 box 并存成 PNG；x/y 严格同一比例尺，像素与模型坐标是线性映射。"""
    x0, y0, x1, y1 = pad_bbox(box)
    span_x, span_y = x1 - x0, y1 - y0
    if span_x >= span_y:
        width = long_edge
        height = max(1, round(long_edge * span_y / span_x))
    else:
        height = long_edge
        width = max(1, round(long_edge * span_x / span_y))
    scale = width / span_x
    # 取整后按像素高度反推 y 跨度，保证两轴比例尺严格一致。
    center_y = (y0 + y1) / 2
    span_y = height / scale
    y0, y1 = center_y - span_y / 2, center_y + span_y / 2

    fig.set_size_inches(width / RENDER_DPI, height / RENDER_DPI)
    ax.set_position([0, 0, 1, 1])
    ax.set_aspect("auto")
    ax.set_xlim(x0, x1)
    ax.set_ylim(y0, y1)
    fig.savefig(str(destination), dpi=RENDER_DPI, facecolor="white")

    factor, file_info = fit_passthrough_budget(destination)
    pixel_width, pixel_height, nonwhite = pixel_stats(destination)
    return {
        "path": str(destination),
        "width": pixel_width,
        "height": pixel_height,
        "modelBbox": [round(x0, 3), round(y0, 3), round(x1, 3), round(y1, 3)],
        "pixelsPerUnit": round(scale * factor, 8),
        "nonWhiteRatio": nonwhite,
        "blank": nonwhite < 0.0005,
        **file_info,
    }


def detect_panels(image_path, minimum_count=2, maximum_count=12):
    """按整图中的竖向留白把并排的多个图幅分开；返回像素 bbox 列表，不足 2 个或超过 12 个时返回空。"""
    import numpy as np
    from PIL import Image

    with Image.open(image_path) as source:
        pixels = np.asarray(source.convert("L"))
    nonwhite = pixels < 245
    height, width = nonwhite.shape
    if width < 600:
        return []

    blank_columns = nonwhite.sum(axis=0) <= max(1, height // 1000)
    minimum_gap = max(24, round(width * 0.012))
    gaps, start = [], None
    for index, blank in enumerate(blank_columns):
        if blank and start is None:
            start = index
        elif not blank and start is not None:
            if index - start >= minimum_gap:
                gaps.append((start, index))
            start = None
    if start is not None and width - start >= minimum_gap:
        gaps.append((start, width))

    separators = [(left + right) // 2 for left, right in gaps if left > 0 and right < width]
    boundaries = [0, *separators, width]
    panels, padding = [], 12
    for left, right in zip(boundaries, boundaries[1:]):
        ys, xs = np.nonzero(nonwhite[:, left:right])
        if len(xs) == 0:
            continue
        x0 = max(0, left + int(xs.min()) - padding)
        x1 = min(width, left + int(xs.max()) + 1 + padding)
        y0 = max(0, int(ys.min()) - padding)
        y1 = min(height, int(ys.max()) + 1 + padding)
        if x1 - x0 < max(120, round(width * 0.06)) or y1 - y0 < 80:
            continue
        panels.append([x0, y0, x1, y1])
    if len(panels) < minimum_count or len(panels) > maximum_count:
        return []
    return panels


def pixel_to_model(pixel_box, view):
    """像素 bbox（y 向下）→ 模型 bbox，按该视图的线性映射反算。"""
    x0, _y0, _x1, y1 = view["modelBbox"]
    scale = view["pixelsPerUnit"]
    left, top, right, bottom = pixel_box
    return [
        round(x0 + left / scale, 3),
        round(y1 - bottom / scale, 3),
        round(x0 + right / scale, 3),
        round(y1 - top / scale, 3),
    ]
