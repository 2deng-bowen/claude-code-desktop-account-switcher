"""Which of a session's model replies went through the relay, and on which account.

  python check-routing.py                 # the most recently written session
  python check-routing.py <session id>    # one session (main and subagents)

Matches each reply's request id in the session's transcript (~/.claude/projects) against the
relay log. A reply missing from the log went straight to the window login: that is where a rate
limit on an account that "should have quota" comes from. Only replies since the relay started
logging request ids (account-switcher 1.3) can be matched.
"""
import glob
import json
import os
import re
import sys
import time

HOME = os.path.expanduser("~")
LOG = os.path.join(HOME, ".claude", "account-switcher", "relay.log")

if len(sys.argv) > 1:
    found = glob.glob(os.path.join(HOME, ".claude", "projects", "*", sys.argv[1] + ".jsonl"))
    if not found:
        sys.exit(f"no transcript for session {sys.argv[1]}")
    main = found[0]
else:
    main = max(glob.glob(os.path.join(HOME, ".claude", "projects", "*", "*.jsonl")), key=os.path.getmtime)

# The log's times are local; transcripts' are UTC. Replies older than the log's first request id
# cannot be matched, so they are left out rather than counted as direct.
relay, since = {}, None
with open(LOG, encoding="utf-8") as f:
    for line in f:
        m = re.search(r"^(\S+ \S+) (\S+) POST \S+ -> (\d+) .* (req_\S+)$", line.strip())
        if m:
            relay[m.group(4)] = (m.group(2), m.group(3))
            if since is None:
                since = time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(time.mktime(time.strptime(m.group(1), "%Y-%m-%d %H:%M:%S"))))
if since is None:
    sys.exit("the relay log has no request ids yet (relay older than 1.3, or no request since)")

print(f"session {os.path.basename(main)[:-6]} (replies since {since}Z)")
for path in [main] + sorted(glob.glob(os.path.join(main[:-6], "subagents", "*.jsonl"))):
    replies = {}
    with open(path, encoding="utf-8") as f:
        for line in f:
            try:
                r = json.loads(line)
            except ValueError:
                continue
            if r.get("type") == "assistant" and r.get("requestId") and r.get("timestamp", "") >= since:
                replies.setdefault(r["requestId"], (r.get("timestamp", ""), r.get("apiErrorStatus")))
    if not replies:
        continue
    via = {i: relay[i] for i in replies if i in relay}
    accounts = sorted({a for a, _ in via.values()})
    missing = [(t, i, err) for i, (t, err) in replies.items() if i not in relay]
    who = "main" if path == main else "subagent " + os.path.basename(path)[6:14]
    print(f"  {who:18} replies {len(replies):4}  via relay {len(via):4} {accounts}  direct {len(missing)}")
    for t, i, err in missing[-5:]:
        print(f"      direct: {t[:19]}Z {i}{'  HTTP ' + str(err) if err else ''}")
