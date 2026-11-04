#!/usr/bin/env python3
"""Your commits on GitHub, each with its time and the time zone it was made in, for where you wrote code.

GitHub knows which repositories you committed to each year (your contributions, the private ones too, of the
repositories you can still open); each is fetched with its commits only (no files: a few MB for years of history) into
a cache, and its commits by you are kept: by your GitHub account's emails, your login's noreply address, git's
user.email and the --email given, or by your account's name (and --name: a commit made from another computer). A commit's time keeps the offset of the computer's clock (+02:00 in Amsterdam in summer), so the day is
the day where you were. Cairn puts each commit in the town you were in that day.

Needs the GitHub CLI signed in (gh auth login) and git:

  python imports/github.py --send mini:repos/contrail/data/github.json

Writes data/github.json: {"login", "commits": [[unix time, offset in minutes, "owner/repo", first line], ...]}, each
commit once (a fork and its source share them). Run it again to add new ones: the cache is fetched again, not cloned.
"""
import argparse
import json
import os
import shutil
import subprocess
import sys
from datetime import datetime
from pathlib import Path

HERE = Path(__file__).resolve().parent
CACHE = Path.home() / ".cache" / "cairn-github"
# gh where a background job finds it too (launchd's PATH has no /usr/local/bin)
GH = shutil.which("gh") or next((p for p in ("/usr/local/bin/gh", "/opt/homebrew/bin/gh") if os.path.exists(p)), "gh")
ENV = {**os.environ, "GIT_TERMINAL_PROMPT": "0", "PATH": f"{os.path.dirname(GH) or '/usr/local/bin'}:{os.environ.get('PATH', '/usr/bin:/bin')}"}
HELPER = ["-c", "credential.helper=", "-c", "credential.helper=!gh auth git-credential"]


def gh(*args):
    out = subprocess.run([GH, "api", *args], capture_output=True, text=True, env=ENV)
    if out.returncode:
        raise SystemExit(f"gh api {' '.join(args)}: {out.stderr.strip()}")
    return json.loads(out.stdout) if out.stdout.strip() else None


def repositories(login, first_year):
    """Every repository you committed to, from each year's contributions (GraphQL contributionsCollection)."""
    names = set()
    for year in range(first_year, datetime.now().year + 1):
        q = ('query($login:String!,$from:DateTime!,$to:DateTime!){user(login:$login){contributionsCollection(from:$from,to:$to)'
             '{commitContributionsByRepository(maxRepositories:100){repository{nameWithOwner}}}}}')
        d = gh("graphql", "-f", f"query={q}", "-F", f"login={login}", "-F", f"from={year}-01-01T00:00:00Z", "-F", f"to={year}-12-31T23:59:59Z")
        for r in d["data"]["user"]["contributionsCollection"]["commitContributionsByRepository"]:
            names.add(r["repository"]["nameWithOwner"])
    return sorted(names)


def fetch(repo):
    """The repository's commits (no trees or files) in the cache: cloned once, fetched after."""
    path = CACHE / (repo.replace("/", "__") + ".git")
    url = f"https://github.com/{repo}.git"
    if path.exists():
        cmd = ["git", *HELPER, "-C", str(path), "fetch", "--quiet", "--prune", "origin", "+refs/heads/*:refs/heads/*"]
    else:
        cmd = ["git", *HELPER, "clone", "--quiet", "--bare", "--filter=tree:0", url, str(path)]
    r = subprocess.run(cmd, capture_output=True, text=True, env=ENV)
    if r.returncode:
        print(f"  {repo}: {r.stderr.strip().splitlines()[-1] if r.stderr.strip() else 'not fetched'}", file=sys.stderr)
        return None
    return path


def commits(path, repo, emails, names):
    out = subprocess.run(["git", "-C", str(path), "log", "--all", "--no-merges", "--format=%H%x09%ae%x09%an%x09%aI%x09%s"], capture_output=True, text=True)
    for line in out.stdout.splitlines():
        sha, email, name, when, *subject = line.split("\t")
        if email.lower() not in emails and name.lower() not in names:
            continue
        d = datetime.fromisoformat(when.replace("Z", "+00:00"))  # Python 3.9 reads no "Z"
        yield sha, [int(d.timestamp()), int(d.utcoffset().total_seconds() // 60), repo, ("\t".join(subject))[:100]]


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--email", action="append", default=[], help="another email you commit with (your account's are found)")
    ap.add_argument("--name", action="append", default=[], help="another name you commit as (your account's name is one)")
    ap.add_argument("--repo", action="append", default=[], help="another repository (owner/name) to read")
    ap.add_argument("--out", default=str(HERE.parent / "data" / "github.json"))
    ap.add_argument("--send", help="also copy the result there with scp (host:path)")
    a = ap.parse_args(argv)
    me = gh("user")
    emails = {e.lower() for e in a.email} | {f"{me['id']}+{me['login']}@users.noreply.github.com".lower(), f"{me['login']}@users.noreply.github.com".lower()}
    try:
        emails |= {e["email"].lower() for e in gh("user/emails") or []}
    except SystemExit:  # the token may not read emails (scope user:email): the git config's then
        pass
    git_email = subprocess.run(["git", "config", "--global", "user.email"], capture_output=True, text=True).stdout.strip()
    if git_email:
        emails.add(git_email.lower())
    names = {n.lower() for n in [me.get("name") or "", *a.name] if n}
    repos = sorted(set(repositories(me["login"], int(me["created_at"][:4]))) | set(a.repo))
    print(f"{len(repos)} repositories with your commits", file=sys.stderr)
    CACHE.mkdir(parents=True, exist_ok=True)
    found = {}
    for i, repo in enumerate(repos, 1):
        path = fetch(repo)
        if path:
            for sha, c in commits(path, repo, emails, names):
                found.setdefault(sha, c)  # a fork's copy: the first repository read keeps it
        print(f"  {i}/{len(repos)} {repo}: {len(found)} commits so far", file=sys.stderr)
    doc = {"login": me["login"], "commits": sorted(found.values())}
    Path(a.out).write_text(json.dumps(doc, ensure_ascii=False, separators=(",", ":")))
    if a.send:
        subprocess.run(["scp", a.out, a.send], check=True)
    print(f"{len(doc['commits'])} commits in {len({c[2] for c in doc['commits']})} repositories")


if __name__ == "__main__":
    main()
