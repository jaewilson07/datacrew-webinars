"""claude.yml is a thin caller of the shared @claude mention workflow, pinned by commit SHA.

The checkout, secret-fetch and claude-code-action steps (and their action pins) live in
datacrew-space/ci-workflows, so this file holds no steps and no action versions.
"""

from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]
SHARED_MENTION_WORKFLOW = "datacrew-space/ci-workflows/.github/workflows/claude-mention.yml"
SHARED_MENTION_SHA = "f838ff0adefdfcfa4924c9f092d23348aff7b8c5"  # pragma: allowlist secret


def _load() -> dict:
    return yaml.safe_load(
        (ROOT / ".github" / "workflows" / "claude.yml").read_text(encoding="utf-8")
    )


def test_claude_yml_is_a_pinned_caller_of_the_shared_mention_workflow():
    doc = _load()
    assert set(doc["jobs"]) == {"claude"}
    job = doc["jobs"]["claude"]
    assert job["uses"] == f"{SHARED_MENTION_WORKFLOW}@{SHARED_MENTION_SHA}"
    assert set(job) == {"uses", "permissions", "with", "secrets"}
    # PyYAML reads the bare key `on` as boolean True.
    assert doc.get("on", doc.get(True)) == {
        "issue_comment": {"types": ["created"]},
        "pull_request_review_comment": {"types": ["created"]},
        "issues": {"types": ["opened"]},
        "pull_request_review": {"types": ["submitted"]},
    }
    assert doc["permissions"] == {"contents": "read"}
    assert job["permissions"] == {
        "contents": "read",
        "pull-requests": "read",
        "issues": "read",
        "id-token": "write",
        "actions": "read",
    }


def test_claude_yml_passes_exactly_the_declared_inputs_and_secrets():
    job = _load()["jobs"]["claude"]
    assert job["with"] == {
        "runs-on": "${{ vars.CI_RUNS_ON || '\"ubuntu-latest\"' }}",
        "infisical-domain": "https://infisical.datacrew.space",
        "infisical-project-slug": "hostinger_vps",
    }
    assert job["secrets"] == {
        "INFISICAL_CLIENT_ID": "${{ secrets.INFISICAL_CLIENT_ID }}",
        "INFISICAL_CLIENT_SECRET": "${{ secrets.INFISICAL_CLIENT_SECRET }}",
    }
