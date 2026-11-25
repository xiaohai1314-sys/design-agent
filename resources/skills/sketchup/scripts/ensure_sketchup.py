#!/usr/bin/env python3
"""确保 SketchUp 已启动且 MCP 服务（默认 127.0.0.1:9877）就绪。开着 = 零动作，没开 = 带空白页拉起。

一条命令干完：探针 → 不通就拉起 → 轮询到就绪。成功打印一行 READY；失败打印一行 FAILED + 原始错误
（socket 报错、应答内容、进程退出等事实），Windows 上再附 9877 的监听进程与各 SketchUp 进程的
PID、运行时长、屏幕窗口。**不附带任何归因或处理建议**：猜错的建议会把模型和用户带偏（2026-11-17
残留进程占着 9877 不应答，被报成「扩展被禁用」），原因交给拿着全部上下文的模型判断。
只用 Python 标准库。

改这个文件前先知道四件事（前三件 mac 与 Windows 实测一致）：

1. **必须带一份文档启动。** SketchUp 的 Ruby 环境跟着「显现出来的文档窗口」走，不跟着 App
   进程走：不带文档启动会停在欢迎界面，插件不加载、端口永远不监听。别用 `open -g` / `-j`
   去躲前台化——窗口不显现就不会就绪，拉起必然把 SketchUp 推到前台。
2. **「端口通」不等于就绪。** accept 循环挂在 UI.start_timer 上跑 SketchUp 主线程，宿主卡死时
   端口照样 LISTEN 但零应答。就绪判定必须是一次完整的 JSON-RPC 往返。
3. **Windows 上必须让 SketchUp 脱离本进程树**，且启动器的三个标准流要接到 NUL——否则
   SketchUp 会继承执行后端的管道，让它收不到 EOF。见 launch()。
4. **SketchUp 已在运行时不另开实例。** 已有实例在跑时带文档启动会另起一个进程，它的插件绑 9877
   失败就停了、不重试，只会多留一个空白窗口（实测 2026-09-22、2026-11-11）。
5. **Windows 定位不能只靠官方注册表。** 非官方安装包可能不写 HKLM\\SOFTWARE\\SketchUp，读不到时
   再查卸载项、App Paths、.skp 文件关联、默认安装目录；而且先判进程在不在跑再定位，定位失败
   不能把「已在运行」报成「未找到」（2026-11-19 真机）。

时序、路径与逐条实测记录见 docs/mcp/SketchUp-拉起与就绪-真机验证.md。
"""

import glob
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import time

HOST = os.environ.get("SU_HOST", "127.0.0.1")
# 与宿主插件 main.rb 的 @port、载荷 server.py 同一个数（docs/mcp/patches/sketchup-port-9877.patch）。
# 上游默认的 9876 别家 SketchUp MCP 扩展也在用：被占时我们的服务起不来，占着的那个还能通过探针。
PORT = int(os.environ.get("SU_PORT", "9877"))
# 不要再探 9876：过渡期已结束，插件和载荷都只用 PORT。9876 现在是 Blender 插件的端口，探它只会把
# Blender 当成「连得上但不应答」的 SketchUp（见 docs/mcp/patches/README.md「ZMO 显示名与专用端口 9877」）。
# 与 mcpHostPlugins.ts 的 MIN_SKETCHUP_YEAR 同一个数：su_mcp 插件只铺到 2022+ 的 Plugins 目录。
MIN_YEAR = 2022
LAUNCH_TIMEOUT = 60.0  # mac 11.8s、Windows 18.519s 完整就绪；冷盘 / 杀毒扫描另留余量
DOCUMENT_LAUNCH_CHECK = 8.0  # 尽快识别“带文档启动后宿主直接退出”，避免空等完整超时
IS_WIN = sys.platform == "win32"


def one_line(text):
    """执行器约定只读一行输出：原始错误里的换行压成空格。"""
    return re.sub(r"\s*[\r\n]+\s*", " ", str(text).strip())


def probe(timeout=2.0):
    """一次完整往返，返回 ``(是否就绪, 原始错误)``。用 prompts/list：它不碰
    Sketchup.active_model，零副作用、响应恒定小。

    **不能只判「端口通」**：Ruby 侧的 accept 循环挂在 UI.start_timer(0.1) 上跑在 SketchUp
    主线程，端口 LISTEN 了不代表有人应答。端口上的任意字节、截断 JSON 或错误响应都不能证明
    su_mcp 已就绪。
    """
    address = "%s:%d" % (HOST, PORT)
    try:
        s = socket.create_connection((HOST, PORT), timeout=timeout)
    except OSError as exc:
        return False, "连接 %s 失败：%s" % (address, exc)
    try:
        s.settimeout(timeout)
        s.sendall((json.dumps({"jsonrpc": "2.0", "method": "prompts/list", "params": {}, "id": 1}) + "\n").encode())
        buf = b""
        while b"\n" not in buf:
            chunk = s.recv(4096)
            if not chunk:
                break
            buf += chunk
    except OSError as exc:
        return False, "%s 已连接，等待应答时出错：%s" % (address, str(exc) or type(exc).__name__)
    finally:
        s.close()
    if b"\n" not in buf:
        return False, "%s 已连接，连接被关闭且没有完整应答（收到 %r）" % (address, buf[:200])
    line = buf.split(b"\n", 1)[0]
    try:
        reply = json.loads(line)
    except (ValueError, UnicodeDecodeError):
        return False, "%s 应答不是 JSON：%r" % (address, line[:200])
    result = reply.get("result") if isinstance(reply, dict) else None
    if (isinstance(result, dict) and reply.get("jsonrpc") == "2.0"
            and reply.get("id") == 1 and "error" not in reply
            and isinstance(result.get("prompts"), list)
            and result.get("success") is not False):
        return True, None
    return False, "%s 应答不符合预期：%s" % (address, line[:200].decode("utf-8", "replace"))


def wait_ready(seconds):
    """轮询到就绪，返回 ``(耗时, 最后一次的原始错误)``；超时耗时为 None。"""
    t0 = time.time()
    error = None
    while True:
        ok, error = probe()
        if ok:
            return time.time() - t0, None
        if time.time() - t0 >= seconds:
            return None, error
        time.sleep(0.5)


def _win_registered_version_names():
    r"""枚举 HKLM\SOFTWARE\SketchUp 下的版本子键名，合并 64/32 位注册表视图。"""
    import winreg

    names = set()
    for view in (winreg.KEY_WOW64_64KEY, winreg.KEY_WOW64_32KEY):
        try:
            parent = winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\SketchUp", 0,
                                    winreg.KEY_READ | view)
        except OSError:
            continue
        with parent:
            index = 0
            while True:
                try:
                    names.add(winreg.EnumKey(parent, index))
                except OSError:
                    break
                index += 1
    return names


def _win_installed_years():
    """返回注册表中所有受支持的 SketchUp 年份，新版优先；不设置未来版本上限。"""
    years = set()
    for name in _win_registered_version_names():
        match = re.fullmatch(r"SketchUp (\d{4})", name, flags=re.IGNORECASE)
        if match and int(match.group(1)) >= MIN_YEAR:
            years.add(int(match.group(1)))
    return sorted(years, reverse=True)


def _win_install_location(year):
    r"""读 HKLM\SOFTWARE\SketchUp\SketchUp <年份>\InstallLocation 的「(默认)」值。

    注意是**子键 + 默认值**，不是父键下的命名值（口径同 suPluginHandlers.ts），64 位视图
    读不到再降级 32 位。
    用 winreg 而不是 `reg query`：后者的输出按控制台代码页编码，中文机上 text=True 按 ANSI
    解可能直接抛 UnicodeDecodeError；winreg 返回的本来就是 Unicode，也不用起子进程。
    """
    import winreg

    for view in (winreg.KEY_WOW64_64KEY, winreg.KEY_WOW64_32KEY):
        try:
            with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE,
                                r"SOFTWARE\SketchUp\SketchUp %d\InstallLocation" % year,
                                0, winreg.KEY_READ | view) as key:
                val, _ = winreg.QueryValueEx(key, "")
        except OSError:
            continue
        if isinstance(val, str) and val.strip():
            return val.strip()
    return None


def _win_clear_stale_cef_locks(year):
    """没有 SketchUp 进程时清掉 CEF 顶层陈旧的 ``SKETCHUP_LOCK``，删不掉的跳过。

    SketchUp 2026 的 CEF 只轮换 ``CacheN`` 槽，异常退出留下的锁会耗尽缓存槽，宿主在建模窗口创建前
    就退出。只在 main 已确认没有 SketchUp 进程后调用，绝不碰 Chromium 子目录中的数据库 ``LOCK``。
    """
    appdata = os.environ.get("APPDATA")
    if not year or not appdata:
        return
    support_root = os.path.join(appdata, "SketchUp", "SketchUp %d" % year)
    pattern = os.path.join(glob.escape(support_root), "WebCache-*", "Cache*", "SKETCHUP_LOCK")
    for lock_path in glob.glob(pattern):
        try:
            os.remove(lock_path)
        except OSError:
            pass


def _win_sketchup_log_errors(started_at):
    """本轮 SketchUp 日志里记下的 CEF 缓存创建失败原文；没有返回空列表。"""
    errors = []
    pattern = os.path.join(glob.escape(tempfile.gettempdir()), "SketchUpLog-*.log")
    for log_path in glob.glob(pattern):
        try:
            if os.path.getmtime(log_path) + 1 < started_at:
                continue
            with open(log_path, encoding="utf-8", errors="replace") as log_file:
                for line in log_file:
                    if "Failed to create a cache folder for CEF" in line and line.strip() not in errors:
                        errors.append(line.strip())
        except OSError:
            continue
    return errors


def _win_dir_years(path, root):
    """``path`` 在安装根以下经过的 ``SketchUp <年份>`` 目录给出的年份集合。

    自定义安装可能把多个年份的 InstallLocation 记成同一个上层目录，exe 与兜底模板都靠目录名
    归属版本。根本身是注册表为这一年给出的位置，不按名字参与判断。
    """
    relative = os.path.relpath(os.path.dirname(path), root)
    return {int(m.group(1)) for m in
            (re.fullmatch(r"SketchUp (\d{4})", part, flags=re.IGNORECASE)
             for part in relative.split(os.sep))
            if m}


def _win_find_exe(install_root, year, max_depth=3):
    """在注册表安装根的浅层目录中找指定年份的 SketchUp.exe。

    标准安装通常直接命中根目录；自定义安装有时把 InstallLocation 记为更上层目录，而这个
    上层目录下可能并排装着多个年份。遍历顺序与年份无关，所以收集深度上限内的全部命中再挑：
    路径里有 ``SketchUp <年份>`` 目录的优先，带着别的年份目录的排除；认不出年份的命中只在
    位于根目录或独此一个时采用，多个都认不出就跳过这一年，不拿别的版本打开本年份的模板。
    限制递归深度，避免错误注册值指向大目录时扫描整块磁盘。
    """
    if not install_root:
        return None
    root = os.path.abspath(os.path.expandvars(install_root))
    if not os.path.isdir(root):
        return None

    own, unknown = [], []
    for current, dirs, files in os.walk(root):
        relative = os.path.relpath(current, root)
        depth = 0 if relative == os.curdir else relative.count(os.sep) + 1
        if depth >= max_depth:
            dirs[:] = []
        hit = next((name for name in files if name.casefold() == "sketchup.exe"), None)
        if not hit:
            continue
        exe = os.path.join(current, hit)
        years = _win_dir_years(exe, root)
        if year in years:
            own.append((depth, exe))
        elif not years:
            unknown.append((depth, exe))
    if own:
        return min(own)[1]
    # os.walk 自顶向下，根目录的命中必然排第一。
    if unknown and (unknown[0][0] == 0 or len(unknown) == 1):
        return unknown[0][1]
    return None


def _win_reg_read(hive, path, name=""):
    """读注册表字符串值（64 位视图读不到再读 32 位）；不存在或为空返回 None。"""
    import winreg

    for view in (winreg.KEY_WOW64_64KEY, winreg.KEY_WOW64_32KEY):
        try:
            with winreg.OpenKey(hive, path, 0, winreg.KEY_READ | view) as key:
                val, _ = winreg.QueryValueEx(key, name)
        except OSError:
            continue
        if isinstance(val, str) and val.strip():
            return val.strip()
    return None


def _win_reg_subkeys(hive, path):
    """注册表键下的子键名，合并 64/32 位视图。"""
    import winreg

    names = set()
    for view in (winreg.KEY_WOW64_64KEY, winreg.KEY_WOW64_32KEY):
        try:
            key = winreg.OpenKey(hive, path, 0, winreg.KEY_READ | view)
        except OSError:
            continue
        with key:
            index = 0
            while True:
                try:
                    names.add(winreg.EnumKey(key, index))
                except OSError:
                    break
                index += 1
    return names


def _win_exes_under(root, max_depth=3):
    """``root`` 浅层目录里的全部 SketchUp.exe（限深，防止错误的值指向整块磁盘）。"""
    if not root:
        return []
    root = os.path.abspath(os.path.expandvars(root.strip().strip('"')))
    found = []
    for current, dirs, files in os.walk(root):
        relative = os.path.relpath(current, root)
        if relative != os.curdir and relative.count(os.sep) + 1 >= max_depth:
            dirs[:] = []
        found += [os.path.join(current, name) for name in files if name.casefold() == "sketchup.exe"]
    return found


def _win_fallback_texts():
    r"""HKLM\SOFTWARE\SketchUp 之外留有 SketchUp.exe 路径的地方，原样返回（命令行、图标串或路径）。

    非官方安装包（直装 / 绿色 / 精简版）常不写官方的 InstallLocation，但卸载项、App Paths、
    .skp 文件关联、默认安装目录通常至少留下一处。
    """
    import winreg

    texts = []
    uninstall = r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall"
    for hive in (winreg.HKEY_LOCAL_MACHINE, winreg.HKEY_CURRENT_USER):
        for name in sorted(_win_reg_subkeys(hive, uninstall)):
            entry = uninstall + "\\" + name
            if "sketchup" not in (_win_reg_read(hive, entry, "DisplayName") or "").casefold():
                continue
            texts.append(_win_reg_read(hive, entry, "DisplayIcon"))
            texts += _win_exes_under(_win_reg_read(hive, entry, "InstallLocation"))
        texts.append(_win_reg_read(hive, r"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\SketchUp.exe"))
    progid = _win_reg_read(winreg.HKEY_CLASSES_ROOT, ".skp")
    if progid:
        texts.append(_win_reg_read(winreg.HKEY_CLASSES_ROOT, progid + r"\shell\open\command"))
    for env_name in ("ProgramW6432", "ProgramFiles"):
        base = os.environ.get(env_name)
        if base:
            texts += _win_exes_under(os.path.join(base, "SketchUp"))
    return [text for text in texts if text]


def _exe_from_text(text):
    r"""从命令行 / 图标串（``"C:\…\SketchUp.exe" "%1"``、``C:\…\SketchUp.exe,0``）里取出 exe 路径。"""
    match = re.search(r'([^"]*?sketchup\.exe)', text, flags=re.IGNORECASE)
    return os.path.expandvars(match.group(1).strip()) if match else None


def _win_exe_year(exe):
    """按 exe 文件版本的主版本号换算年份（FileVersion 24.0.484 → 2024，真机核对过）；读不到返回 None。"""
    import ctypes
    from ctypes import wintypes

    ver = ctypes.WinDLL("version")
    ver.GetFileVersionInfoSizeW.argtypes = [wintypes.LPCWSTR, ctypes.POINTER(wintypes.DWORD)]
    ver.GetFileVersionInfoW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD, ctypes.c_void_p]
    ver.VerQueryValueW.argtypes = [ctypes.c_void_p, wintypes.LPCWSTR,
                                   ctypes.POINTER(ctypes.c_void_p), ctypes.POINTER(wintypes.UINT)]
    size = ver.GetFileVersionInfoSizeW(exe, None)
    if not size:
        return None
    buf = ctypes.create_string_buffer(size)
    if not ver.GetFileVersionInfoW(exe, 0, size, buf):
        return None
    info, length = ctypes.c_void_p(), wintypes.UINT()
    if not ver.VerQueryValueW(buf, "\\", ctypes.byref(info), ctypes.byref(length)) or length.value < 52:
        return None
    # VS_FIXEDFILEINFO：dwSignature、dwStrucVersion、dwFileVersionMS（高 16 位是主版本号）…
    major = ctypes.cast(info, ctypes.POINTER(wintypes.DWORD))[2] >> 16
    return 2000 + major if 10 <= major < 100 else None


def _path_year(path):
    """读不到文件版本时，从路径里的 ``SketchUp 2025`` / ``SketchUp Pro 2025`` / ``SU2025`` 认年份。"""
    years = re.findall(r"(?:sketchup|su)[ _-]*(?:pro[ _-]*)?(20\d\d)", path, flags=re.IGNORECASE)
    return int(years[-1]) if years else None


def _win_locate_fallback():
    """注册表 InstallLocation 定位不到时，从其他线索里挑受支持的最高版本。资源根取 exe 所在目录。"""
    best = None
    seen = set()
    for text in _win_fallback_texts():
        exe = _exe_from_text(text)
        if not exe or os.path.normcase(exe) in seen or not os.path.isfile(exe):
            continue
        seen.add(os.path.normcase(exe))
        try:
            year = _win_exe_year(exe)
        except (OSError, AttributeError, ValueError):
            year = None
        year = year or _path_year(exe)
        if year and year >= MIN_YEAR and (best is None or year > best[0]):
            best = (year, exe)
    return (best[1], os.path.dirname(best[1]), best[0]) if best else (None, None, None)


def locate():
    """SketchUp 装在哪。返回 (启动目标, 资源根, 年份)；没有受支持的版本则全为 None。新版优先。

    年份随定位结果带出，下游选模板、定位 WebCache 直接用它：多个年份的注册值可能指向同一个
    上层目录，拿资源根反查年份有歧义。
    """
    if IS_WIN:
        for year in _win_installed_years():
            loc = _win_install_location(year)
            if not loc:
                continue
            exe = _win_find_exe(loc, year)
            if exe:
                return exe, loc, year
        return _win_locate_fallback()

    best = None
    for app in glob.glob("/Applications/SketchUp */SketchUp.app"):
        m = re.search(r"SketchUp (\d{4})/SketchUp\.app$", app)
        if m and int(m.group(1)) >= MIN_YEAR:
            best = max(best or (0, ""), (int(m.group(1)), app))
    return (best[1], best[1], best[0]) if best else (None, None, None)


def running():
    """SketchUp 本体在不在跑。

    **pattern 必须精确**：宽松的 `pgrep -fi sketchup` 会撞上一堆 sketchup-mcp 的 python 进程
    （实测一台机器上 72 个），把「MCP 客户端在跑」误判成「SketchUp 在跑」，然后死等一个
    根本不存在的服务。
    """
    if IS_WIN:
        # errors="replace"：tasklist 的输出按控制台代码页编码，本地化提示里的非 ASCII
        # 会让严格解码抛异常，把「在跑」误判成「没在跑」。判据 sketchup.exe 是纯 ASCII，
        # 替换掉解不出的字节不影响结论。
        out = subprocess.run(["tasklist", "/FI", "IMAGENAME eq SketchUp.exe", "/NH"],
                             capture_output=True, text=True, errors="replace")
        return "sketchup.exe" in out.stdout.lower()
    return subprocess.run(["pgrep", "-f", "SketchUp.app/Contents/MacOS/SketchUp"],
                          capture_output=True).returncode == 0


def _win_port_owner(port):
    """本机 IPv4 上监听 ``port`` 的进程 PID；没人监听返回 None。

    表头和状态词（LISTENING）随系统语言本地化，地址不会，所以按「外部地址为 0.0.0.0:0」认监听行。
    """
    out = subprocess.run(["netstat", "-ano", "-p", "TCP"], capture_output=True, text=True,
                         errors="replace").stdout
    for line in out.splitlines():
        parts = line.split()
        if (len(parts) >= 5 and parts[1].endswith(":%d" % port) and parts[2] == "0.0.0.0:0"
                and parts[-1].isdigit()):
            return int(parts[-1])
    return None


def _win_image_name(pid):
    """PID 对应的映像名（如 SketchUp.exe）；进程已不在返回 None。"""
    out = subprocess.run(["tasklist", "/FI", "PID eq %d" % pid, "/FO", "CSV", "/NH"],
                         capture_output=True, text=True, errors="replace").stdout.strip()
    # 没匹配时 tasklist 只输出一句本地化提示，不是带引号的 CSV 行。
    return out.split('","', 1)[0].lstrip('"') if out.startswith('"') else None


def _win_sketchup_pids():
    """正在运行的 SketchUp.exe 的 PID 列表。"""
    out = subprocess.run(["tasklist", "/FI", "IMAGENAME eq SketchUp.exe", "/FO", "CSV", "/NH"],
                         capture_output=True, text=True, errors="replace").stdout
    pids = []
    for line in out.splitlines():
        cols = line.strip().strip('"').split('","')
        # 没匹配时 tasklist 只输出一句本地化提示，不是 CSV 行。
        if len(cols) >= 2 and cols[0].casefold() == "sketchup.exe" and cols[1].isdigit():
            pids.append(int(cols[1]))
    return pids


def _win_process_age(pid):
    """进程已运行多少秒；拿不到（进程已退、无权限）返回 None。"""
    import ctypes
    from ctypes import wintypes

    kernel32 = ctypes.WinDLL("kernel32")
    kernel32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    kernel32.OpenProcess.restype = wintypes.HANDLE
    kernel32.GetProcessTimes.argtypes = [wintypes.HANDLE] + [ctypes.POINTER(wintypes.FILETIME)] * 4
    kernel32.GetSystemTimeAsFileTime.argtypes = [ctypes.POINTER(wintypes.FILETIME)]
    kernel32.GetSystemTimeAsFileTime.restype = None
    kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
    handle = kernel32.OpenProcess(0x1000, False, pid)  # PROCESS_QUERY_LIMITED_INFORMATION
    if not handle:
        return None
    times = [wintypes.FILETIME() for _ in range(5)]  # 创建、退出、内核、用户、现在
    try:
        if not kernel32.GetProcessTimes(handle, *(ctypes.byref(t) for t in times[:4])):
            return None
        kernel32.GetSystemTimeAsFileTime(ctypes.byref(times[4]))
    finally:
        kernel32.CloseHandle(handle)

    def ticks(ft):
        return (ft.dwHighDateTime << 32) | ft.dwLowDateTime

    return (ticks(times[4]) - ticks(times[0])) / 1e7


def _win_screen_windows(pid):
    """该进程在屏幕上的窗口标题，供模型判断它是什么。看不到任何窗口时返回空列表。

    算两种：带标题的可见顶层窗口（最小化、在别的虚拟桌面上的都算可见）；被系统换成「未响应」
    替身的隐藏窗口——主线程约 5 秒不处理消息（Ruby 脚本跑在主线程，跑久了就是这样），系统会把
    原窗口藏起来，换上 dwm.exe 名下、class 为 Ghost 的可见窗口，标题是原标题加「（未响应）」。
    只看自己名下的可见窗口，这种正在跑脚本的 SketchUp 会被当成没有窗口的残留进程。
    隐藏的 GDI+ Window、IME 窗口等残留进程身上也有，不算。
    标题用 GetWindowTextW 读：对别的进程的窗口它只取系统存下的标题、不发消息，对方卡死也拖不住我们。
    """
    import ctypes
    from ctypes import wintypes

    # 独立的 WinDLL 实例：下面设 argtypes 不改到全局 windll.user32 上。
    user32 = ctypes.WinDLL("user32")
    enum_proc = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    user32.EnumWindows.argtypes = [enum_proc, wintypes.LPARAM]
    user32.GetWindowThreadProcessId.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.DWORD)]
    user32.GetWindowTextW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
    user32.GetClassNameW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
    user32.IsWindowVisible.argtypes = [wintypes.HWND]
    windows = []  # (所属 PID, 标题, class, 是否可见)

    @enum_proc
    def visit(hwnd, _):
        owner = wintypes.DWORD()
        user32.GetWindowThreadProcessId(hwnd, ctypes.byref(owner))
        title = ctypes.create_unicode_buffer(512)
        user32.GetWindowTextW(hwnd, title, len(title))
        cls = ctypes.create_unicode_buffer(256)
        user32.GetClassNameW(hwnd, cls, len(cls))
        windows.append((owner.value, title.value, cls.value, bool(user32.IsWindowVisible(hwnd))))
        return True

    user32.EnumWindows(visit, 0)
    ghosts = [title for _, title, cls, visible in windows if cls == "Ghost" and visible]
    seen = []
    for owner, title, _, visible in windows:
        if owner != pid or not title:
            continue
        if visible:
            seen.append("「%s」" % title)
        elif any(ghost.startswith(title) for ghost in ghosts):
            seen.append("「%s」（显示为未响应）" % title)
    return seen


def _win_port_facts():
    """探针失败时附在 FAILED 后面的事实：谁在监听 PORT（程序、PID、运行时长、屏幕窗口），以及其他
    SketchUp 进程各有哪些窗口。只陈述，不归因、不给处理建议。

    这些事实不能省：2026-11-17 一台机器上，一个已运行 4.7 天、没有窗口的残留 SketchUp 占着 9877
    不应答，用户的 SketchUp 绑不上端口。只给 socket 超时的话，模型会去折腾用户开着模型的那个窗口；
    看到监听者 PID 和「窗口：无」，一条 taskkill 就解决了。查询本身出错时报查询错误，不影响 FAILED。
    """
    try:
        owner = _win_port_owner(PORT)
        if owner is None:
            text = "%d 端口无进程监听" % PORT
        else:
            age = _win_process_age(owner)
            text = "%d 端口监听进程：%s（PID %d%s，窗口：%s）" % (
                PORT, _win_image_name(owner) or "进程已不在", owner,
                "，已运行 %.0f 秒" % age if age is not None else "",
                "、".join(_win_screen_windows(owner)) or "无")
        others = ["PID %d（窗口：%s）" % (pid, "、".join(_win_screen_windows(pid)) or "无")
                  for pid in _win_sketchup_pids() if pid != owner]
        if others:
            text += "；其他 SketchUp 进程：" + "；".join(others)
        return text
    except Exception as exc:  # noqa: BLE001 — 事实查询失败不能吞掉原本的 FAILED
        return "查询 %d 端口监听进程失败：%s: %s" % (PORT, type(exc).__name__, exc)



def _blank_copy(src):
    """把模板拷成一份本次专用的空白文档。

    每次都用新文件名：上一轮拉起的 SketchUp 正开着上一份副本，用户 Ctrl+S 会静默存回那个临时
    文件，覆盖它就是抹掉用户的模型。临时副本交给系统清理临时目录，这里不删。
    """
    fd, dst = tempfile.mkstemp(prefix="zmo-sketchup-blank-", suffix=".skp")
    os.close(fd)
    shutil.copyfile(src, dst)
    return dst


def _win_blank_doc(res_root, year):
    # 本机同时有 2022/2024 配置；只取待启动版本的默认模板，避免套用别的版本或单位。
    # 年份用 locate() 给出的，不按资源根反查：多个年份的注册值可能共用同一个上层目录。
    if not res_root:
        return None
    src = None
    # Windows 2024 真机配置在 Local；保留 Roaming 兼容已有部署，不能从 mac 路径推断。
    for env_name in ("LOCALAPPDATA", "APPDATA"):
        base = os.environ.get(env_name)
        if not base:
            continue
        pattern = os.path.join(glob.escape(base), "SketchUp*", "**", "PrivatePreferences.json")
        for prefs in sorted(glob.glob(pattern, recursive=True)):
            if ("sketchup %d" % year) not in os.path.normcase(prefs).split(os.sep):
                continue
            try:
                with open(prefs, encoding="utf-8-sig") as f:
                    p = json.load(f)["This Computer Only"]["Preferences"]
                value = p.get("DefaultTemplate%d" % (year % 100))
            except (OSError, ValueError, KeyError, TypeError, AttributeError):
                continue
            if isinstance(value, str) and os.path.isfile(value):
                src = value
                break
        if src:
            break
    if not src:
        # C:\[01APP]\[SU2024] 是合法安装目录；只转义字面根路径，后面的 ** 仍需递归匹配。
        cands = glob.glob(os.path.join(glob.escape(res_root), "**", "Templates", "*.skp"), recursive=True)
        # 与 exe 同一归属规则：本年份目录下的优先，别的年份目录下的排除。.skp 前向不兼容，
        # 套错版本的模板可能打不开，打得开也是别的版本的单位与样式。
        own = [c for c in cands if year in _win_dir_years(c, res_root)]
        cands = own or [c for c in cands if not _win_dir_years(c, res_root)]
        if not cands:
            return None
        simple = sorted(c for c in cands if "simple" in os.path.basename(c).lower())
        src = simple[0] if simple else min(cands, key=os.path.getsize)
    return _blank_copy(src)


def blank_doc(res_root, year):
    """造一张「空白页」：用户默认模板的副本。

    为什么读用户的默认模板，而不是我们自带一个 .skp：.skp 前向不兼容（2024 存的文件
    2023 打不开），自带就要维护版本矩阵；用户机器上那份必然与他的 SketchUp 兼容，
    语言、单位、样式也都是他 File>New 会得到的样子。
    为什么拷贝而不是直接打开模板本体：直接开等于让用户在编辑模板，随手一存就把模板改了。
    """
    if IS_WIN:
        return _win_blank_doc(res_root, year)
    src = None
    # ① 用户配置的默认模板。键名带版本号（DefaultTemplate24），按前缀匹配。
    for prefs in glob.glob(os.path.join(
            os.environ["APPDATA"] if IS_WIN else os.path.expanduser("~/Library/Application Support"),
            "SketchUp*", "**", "PrivatePreferences.json"), recursive=True):
        try:
            with open(prefs, encoding="utf-8") as f:
                p = json.load(f)["This Computer Only"]["Preferences"]
            hit = [v for k, v in p.items() if k.startswith("DefaultTemplate") and os.path.exists(v)]
            if hit:
                src = hit[0]
                break
        except (OSError, ValueError, KeyError):
            continue
    # ② 兜底：软件自带模板里挑一个（Simple 优先，没有就取最小的）。
    if not src:
        cands = glob.glob(os.path.join(res_root, "**", "Templates", "*.skp"), recursive=True)
        if not cands:
            return None
        simple = [c for c in cands if "Simple" in c]
        src = simple[0] if simple else min(cands, key=os.path.getsize)

    return _blank_copy(src)


def launch(target, doc=None):
    if IS_WIN:
        # **必须让 SketchUp 脱离我们的进程树**：execute 后端超时会对整棵树打
        # `taskkill /PID <pid> /T /F`（见 windowsUtf8Shell.ts 的 terminateProcessTree），
        # 直接 Popen 出来的 SketchUp 会被连坐硬杀 —— 那是用户正在编辑的模型，是数据损失，
        # 不是体验问题。
        # `cmd /c start "" <exe> <doc>`：中间那个 cmd 立刻退出，SketchUp 的父进程随即消失，
        # /T 再遍历也够不到它。开头那个空 "" 是 start 的窗口标题占位 —— 不写的话，带空格的
        # exe 路径（C:\Program Files\…）会被 start 当成标题，程序根本起不来。
        CREATE_NO_WINDOW = 0x08000000  # 别弹黑框，同 winNoConsole.ts 的治理口径
        # 等 cmd 退出后再返回，确认中间父进程已消失；NUL 防止 SketchUp 继承执行器管道，
        # 否则即使脚本已打印 READY，执行器也可能一直等不到 EOF（真机已复现）。
        # 路径通过环境变量单次展开，配合关闭延迟展开，保留空格、&、% 和 ! 的字面含义。
        env = os.environ.copy()
        env["ZMO_SU_EXE"] = target
        env["ZMO_SU_DIR"] = os.path.dirname(target)
        doc_arg = ""
        if doc:
            env["ZMO_SU_DOC"] = doc
            # 该片段作为 % 格式化参数后插入，不参与模板自身的 %% 转义。
            doc_arg = ' "%ZMO_SU_DOC%"'
        # /D 只使用动态发现出的 exe 所在目录，不依赖快捷方式的“起始位置”，也不写死盘符。
        command = ('"%s" /d /v:off /s /c start "" /D "%%ZMO_SU_DIR%%" '
                   '"%%ZMO_SU_EXE%%"%s' % (env.get("COMSPEC", "cmd.exe"), doc_arg))
        subprocess.run(command, env=env, check=True, stdin=subprocess.DEVNULL,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                       creationflags=CREATE_NO_WINDOW, close_fds=True)
    else:
        # 不加 -g：实测 -g 时 App 有时不前台化，而不前台化就不会就绪（见文件头）。
        args = ["/usr/bin/open", "-a", target]
        if doc:
            args.append(doc)
        subprocess.run(args, check=True)


def main():
    ok, error = probe()
    if ok:
        print("READY SketchUp 已在运行，MCP 服务就绪")
        return 0

    # 先看进程再找安装位置：在跑就不需要安装位置，而定位失败（非官方安装包不写注册表）不能把
    # 「已在运行、服务未就绪」报成「未找到」（2026-11-19 真机：SketchUp 2025 开着，报未找到）。
    if running():
        # 不另开实例，见文件头第 4 条。mac 上进程活着但服务不来，多半是 App 在后台，激活一下就活
        # （实测 9ms）；不自动强杀，那个状态下可能卡着「保存更改？」的模态框。
        target = None if IS_WIN else locate()[0]
        if target:
            subprocess.run(["/usr/bin/open", "-a", target], check=False)
            took, error = wait_ready(12)
            if took is not None:
                print("READY SketchUp 已激活到前台，MCP 服务就绪（%.1fs）" % took)
                return 0
        print("FAILED SketchUp 已在运行，MCP 服务未就绪：%s" % error)
        return 1

    target, res_root, year = locate()
    if not target:
        where = "（注册表、卸载项、App Paths、.skp 文件关联、默认安装目录均未找到）" if IS_WIN else ""
        print("FAILED 未找到 SketchUp %d 或更高版本%s；%s" % (MIN_YEAR, where, error))
        return 1

    if IS_WIN:
        _win_clear_stale_cef_locks(year)
    doc = blank_doc(res_root, year)
    if not doc:
        print("FAILED 未找到 SketchUp %d 的模板文件（%s），无法构造空白文档" % (year, res_root))
        return 1

    launch_started = time.time()
    launch(target, doc)
    if IS_WIN:
        took, error = wait_ready(DOCUMENT_LAUNCH_CHECK)
        if took is None and not running():
            logged = _win_sketchup_log_errors(launch_started)
            print("FAILED 已执行 %s %s，SketchUp 进程在 %.0fs 内退出%s"
                  % (target, doc, DOCUMENT_LAUNCH_CHECK,
                     "；SketchUp 日志：" + "；".join(logged) if logged else ""))
            return 1
        if took is None:
            # 进程还在，更可能只是正常冷启动较慢；补足原有总超时。
            rest, error = wait_ready(max(0.0, LAUNCH_TIMEOUT - DOCUMENT_LAUNCH_CHECK))
            took = None if rest is None else DOCUMENT_LAUNCH_CHECK + rest
    else:
        took, error = wait_ready(LAUNCH_TIMEOUT)
    if took is None:
        print("FAILED 已拉起 SketchUp，%.0fs 内 MCP 服务未就绪：%s" % (LAUNCH_TIMEOUT, error))
        return 1
    print("READY 已拉起 SketchUp 并打开空白文档，MCP 服务就绪（%.1fs）" % took)
    return 0


def run():
    """单行输出：stdout 只有一行 READY / FAILED，原始错误里的换行压平。
    Windows 上失败时在原始错误后附上端口与 SketchUp 进程的事实（见 _win_port_facts）。"""
    import io

    out = io.StringIO()
    stdout = sys.stdout
    sys.stdout = out
    try:
        code = main()
    except (OSError, subprocess.SubprocessError) as exc:
        print("FAILED %s: %s" % (type(exc).__name__, exc))
        code = 1
    finally:
        sys.stdout = stdout
    line = one_line(out.getvalue())
    if IS_WIN and line.startswith("FAILED"):
        line = "%s；%s" % (line, one_line(_win_port_facts()))
    print(line)
    return code


if __name__ == "__main__":
    sys.exit(run())
