#!/usr/bin/env python3
"""Merge the three device API markdown docs into one unified markdown file."""
import re
from pathlib import Path

ROOT = Path("/Users/anray/Documents/project/hiddenjoyacom/food-digester-platform")
API = ROOT / "docs" / "api"
OUT = ROOT / "build" / "api-doc" / "merged.md"

# ---- link rewriting -------------------------------------------------------
PART_OF = {
    "onboard-api.bio-nexa.com.md": "第二部分",
    "device-api.bio-nexa.com.md": "第三部分",
    "iot.bio-nexa.com.md": "第四部分",
}

def rewrite_links(text: str) -> str:
    def repl(m: re.Match) -> str:
        label, target = m.group(1), m.group(2)
        # external links: keep label + URL in parentheses
        if target.startswith("http://") or target.startswith("https://"):
            return f"{label}（{target}）"
        # in-page anchors: keep label only
        if target.startswith("#"):
            return label
        path = target.split("#")[0]
        name = Path(path).name
        if name in PART_OF:
            return f"**{label}**（见{PART_OF[name]}）"
        # repo file references: keep label, show path as inline code
        return f"{label}（`{path.lstrip('./')}`）"
    return re.sub(r"\[([^\]]+)\]\(([^)]+)\)", repl, text)

def body_without_title(text: str) -> str:
    """Drop the leading '# title' line and any immediately following blanks."""
    lines = text.splitlines()
    i = 0
    if lines and lines[0].startswith("# "):
        i = 1
        while i < len(lines) and not lines[i].strip():
            i += 1
    return "\n".join(lines[i:]).strip()

# ---- README -> overview chapter -------------------------------------------
readme = (API / "README.md").read_text(encoding="utf-8")
readme_body = body_without_title(readme)
# README's ## sections become ## under the overview part; rewrite doc links
overview = rewrite_links(readme_body)
# renumber overview sections
overview = overview.replace("## 契约来源与优先级", "## 1.1 契约来源与优先级")
overview = overview.replace("## 当前交付边界", "## 1.2 当前交付边界")
overview = overview.replace("## 2026-10-01 证书契约升级", "## 1.3 2026-10-01 证书契约升级")

onboard = rewrite_links(body_without_title((API / "onboard-api.bio-nexa.com.md").read_text(encoding="utf-8")))
device = rewrite_links(body_without_title((API / "device-api.bio-nexa.com.md").read_text(encoding="utf-8")))
iot = rewrite_links(body_without_title((API / "iot.bio-nexa.com.md").read_text(encoding="utf-8")))

parts = [
    "# 第一部分　概述与契约来源\n\n"
    "本文档统一收录 Bio-Nexa 设备平台的设备侧 API 与联调规范，覆盖设备首次接入（Onboarding）、"
    "接入后设备 REST 操作（证书、同步、退役确认、OTA 下载授权、媒体上传会话），"
    "以及持续数据通信的 MQTT 联调说明。版本基线：2026-10-01。\n\n"
    "管理后台及客户业务 API 使用 `api.bio-nexa.com`，不在本文档范围内。\n\n"
    + overview,
    "# 第二部分　Onboarding API（`onboard-api.bio-nexa.com`）\n\n" + onboard,
    "# 第三部分　Device REST API（`device-api.bio-nexa.com`）\n\n" + device,
    "# 第四部分　设备 MQTT 联调说明（`iot.bio-nexa.com`）\n\n" + iot,
]

OUT.write_text("\n\n".join(parts) + "\n", encoding="utf-8")
print(f"wrote {OUT} ({OUT.stat().st_size} bytes)")
