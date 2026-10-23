"""Add or remove the plugin dir in env.CLAUDE_CODE_PLUGIN_DIRS of a Claude Code settings.json.

  python settings_env.py add <settings.json> <plugin dir>
  python settings_env.py remove <settings.json>

Reads and writes UTF-8 without a BOM, keeps every other key and their order, writes atomically.
"""
import json
import os
import sys

op, path = sys.argv[1], sys.argv[2]
data = {}
if os.path.exists(path):
    with open(path, encoding="utf-8-sig") as f:
        data = json.load(f)
env = data.setdefault("env", {})
sep = ";" if os.name == "nt" else ":"
dirs = [d for d in (env.get("CLAUDE_CODE_PLUGIN_DIRS") or "").split(sep) if d and "account-switcher" not in d]
if op == "add":
    dirs.append(sys.argv[3])
if dirs:
    env["CLAUDE_CODE_PLUGIN_DIRS"] = sep.join(dirs)
else:
    env.pop("CLAUDE_CODE_PLUGIN_DIRS", None)
tmp = path + ".tmp-account-switcher"
with open(tmp, "w", encoding="utf-8", newline="\n") as f:
    json.dump(data, f, indent=2, ensure_ascii=False)
    f.write("\n")
os.replace(tmp, path)
print(env.get("CLAUDE_CODE_PLUGIN_DIRS", ""))
