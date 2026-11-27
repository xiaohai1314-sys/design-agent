"""Read the prompt-writing sections of the mounted residential rewrite template."""

import argparse
import re
import sys
from pathlib import Path


SECTIONS = {
    "SKILL.md": ("提示词输出规范", "用户文字需求优先原则"),
    "plan_layout_home.md": (
        "Step 1：提取用户特殊要求",
        "Step 2：确认出图风格",
        "Step 3：拼装最终提示词",
        "输出规范",
    ),
}


def read_sections(path, titles):
    document = path.read_text(encoding="utf-8-sig")
    parts = re.split(r"^##[ \t]+(.+?)[ \t]*$", document, flags=re.MULTILINE)
    selected = {}
    for title, body in zip(parts[1::2], parts[2::2]):
        title = title.strip().replace(":", "：")
        if title in titles:
            if title in selected or not body.strip() or "ask_image_edit" in body.lower():
                raise ValueError("外部改写段落不兼容")
            selected[title] = f"## {title}\n\n{body.strip()}"
    if selected.keys() != set(titles):
        raise ValueError("外部改写模板缺少预期章节")
    return "\n\n".join(selected[title] for title in titles)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("rewrite_root", type=Path)
    args = parser.parse_args()
    try:
        sections = [read_sections(args.rewrite_root / name, titles)
                    for name, titles in SECTIONS.items()]
    except (OSError, ValueError) as error:
        parser.exit(1, f"{error}\n")
    sys.stdout.buffer.write(("\n\n".join(sections) + "\n").encode("utf-8"))
