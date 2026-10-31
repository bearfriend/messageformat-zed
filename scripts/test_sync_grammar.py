"""Tests for sync-grammar.sh. Run with: python3 -m unittest discover -s scripts

The grammar repo and the tree-sitter CLI are fakes, so no network, Docker or Node is needed.
"""
import hashlib
import os
import shutil
import stat
import subprocess
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parent / "sync-grammar.sh"

FAKE_CLI = """#!/bin/sh
# Stands in for `tree-sitter-cli`; the "parser" it builds records the commit it was built from.
if [ "$1" = "--version" ]; then echo "tree-sitter 9.9.9 (fake)"; exit 0; fi
if [ -n "$FAKE_CLI_FAIL" ]; then echo "docker is not running" >&2; exit 1; fi
out=""
while [ $# -gt 0 ]; do if [ "$1" = "-o" ]; then out="$2"; fi; shift; done
printf 'wasm@%s\\n' "$(git rev-parse HEAD)" > "$out"
"""


def git(cwd, *args):
    return subprocess.run(
        ["git", "-c", "user.name=t", "-c", "user.email=t@t", *args],
        cwd=cwd, check=True, capture_output=True, text=True,
    ).stdout.strip()


def sha256(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


class SyncGrammarTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)

        # fake grammar repo with two commits (the second one only changes folds.scm)
        self.grammar = self.tmp / "grammar"
        for d in ("queries", "message/queries"):
            (self.grammar / d).mkdir(parents=True)
        for f in ("highlights", "brackets"):
            (self.grammar / "queries" / f"{f}.scm").write_text(f"; main {f}\n")
            (self.grammar / "message/queries" / f"{f}.scm").write_text(f"; message {f}\n")
        (self.grammar / "queries/folds.scm").write_text("(resource) @fold\n")
        git(self.grammar, "init", "-q", "-b", "main")
        git(self.grammar, "add", ".")
        git(self.grammar, "commit", "-q", "-m", "one")
        self.c1 = git(self.grammar, "rev-parse", "HEAD")
        (self.grammar / "queries/folds.scm").write_text("(resource) @fold\n(selector) @fold\n")
        git(self.grammar, "commit", "-q", "-am", "two")
        self.c2 = git(self.grammar, "rev-parse", "HEAD")

        # fake extension repo root
        self.root = self.tmp / "ext"
        (self.root / "scripts").mkdir(parents=True)
        shutil.copy(SCRIPT, self.root / "scripts/sync-grammar.sh")
        for lang in ("messageformat", "messageformat_message"):
            (self.root / "languages" / lang).mkdir(parents=True)
        self.write_toml(self.c1)
        self.cli = self.tmp / "fake-tree-sitter"
        self.cli.write_text(FAKE_CLI)
        self.cli.chmod(self.cli.stat().st_mode | stat.S_IEXEC)

    def write_toml(self, rev):
        (self.root / "extension.toml").write_text(
            f'[grammars.messageformat]\nrepository = "unused"\nrev = "{rev}"\n\n'
            f'[grammars.messageformat_message]\nrepository = "unused"\nrev = "{rev}"\npath = "message"\n'
        )

    def sync(self, *args, **env):
        e = {**os.environ, "GRAMMAR_REPO": str(self.grammar), "TREE_SITTER_CMD": str(self.cli), **env}
        return subprocess.run(
            [str(self.root / "scripts/sync-grammar.sh"), *args], cwd=self.root, env=e, capture_output=True, text=True
        )

    def lock(self):
        return dict(
            line.split(" = ", 1) for line in (self.root / "vscode/grammar.lock").read_text().splitlines() if " = " in line
        )

    # ------------------------------------------------------------------ sync

    def test_sync_writes_vscode_artifacts_for_the_requested_rev(self):
        r = self.sync(self.c1)
        self.assertEqual(r.returncode, 0, r.stderr)
        v = self.root / "vscode"
        self.assertEqual((v / "tree-sitter-messageformat.wasm").read_text(), f"wasm@{self.c1}\n")
        self.assertEqual((v / "folds.scm").read_text(), "(resource) @fold\n")
        lock = self.lock()
        self.assertEqual(lock["rev"], self.c1)
        self.assertEqual(lock["sha256"], sha256(v / "tree-sitter-messageformat.wasm"))
        self.assertEqual(lock["tree-sitter-cli"], "9.9.9")
        self.assertEqual(sorted(p.name for p in v.iterdir()), ["folds.scm", "grammar.lock", "tree-sitter-messageformat.wasm"])

    def test_sync_defaults_to_the_grammar_head_and_pins_it(self):
        self.assertEqual(self.sync().returncode, 0)
        self.assertEqual(self.lock()["rev"], self.c2)
        self.assertEqual((self.root / "vscode/folds.scm").read_text(), "(resource) @fold\n(selector) @fold\n")
        self.assertIn(f'rev = "{self.c2}"', (self.root / "extension.toml").read_text())

    def test_sync_still_copies_the_zed_queries(self):
        self.sync(self.c1)
        self.assertEqual((self.root / "languages/messageformat/highlights.scm").read_text(), "; main highlights\n")
        self.assertEqual((self.root / "languages/messageformat_message/highlights.scm").read_text(), "; message highlights\n")

    def test_failed_build_changes_nothing(self):
        r = self.sync(self.c2, FAKE_CLI_FAIL="1")
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("docker", r.stderr.lower())
        self.assertFalse((self.root / "vscode").exists())
        self.assertIn(f'rev = "{self.c1}"', (self.root / "extension.toml").read_text())
        self.assertFalse((self.root / "languages/messageformat/highlights.scm").exists())

    # ------------------------------------------------------------------ check

    def test_check_passes_after_sync(self):
        self.sync(self.c1)
        r = self.sync("--check")
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)

    def test_check_fails_when_rev_was_bumped_without_resyncing(self):
        self.sync(self.c1)
        self.write_toml(self.c2)
        r = self.sync("--check")
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("grammar.lock", r.stderr)

    def test_check_fails_when_the_wasm_was_changed(self):
        self.sync(self.c1)
        (self.root / "vscode/tree-sitter-messageformat.wasm").write_text("something else\n")
        r = self.sync("--check")
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("sha256", r.stderr)

    def test_check_fails_when_folds_differ(self):
        self.sync(self.c1)
        (self.root / "vscode/folds.scm").write_text("; edited\n")
        r = self.sync("--check")
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("folds.scm", r.stderr)

    def test_check_fails_when_the_artifacts_are_missing(self):
        self.sync(self.c1)
        shutil.rmtree(self.root / "vscode")
        r = self.sync("--check")
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("vscode", r.stderr)

    def test_verify_build_without_check_is_rejected_and_changes_nothing(self):
        r = self.sync("--verify-build")
        self.assertEqual(r.returncode, 2)
        self.assertIn("--check", r.stderr)
        self.assertFalse((self.root / "vscode").exists())

    def test_unknown_options_are_rejected(self):
        r = self.sync("--nope")
        self.assertEqual(r.returncode, 2)
        self.assertIn("--nope", r.stderr)

    def test_verify_build_catches_a_wasm_that_does_not_match_its_lock(self):
        self.sync(self.c1)
        self.assertEqual(self.sync("--check", "--verify-build").returncode, 0)
        wasm = self.root / "vscode/tree-sitter-messageformat.wasm"
        wasm.write_text("forged\n")
        lock = (self.root / "vscode/grammar.lock").read_text().splitlines()
        lock = [f"sha256 = {sha256(wasm)}" if l.startswith("sha256 = ") else l for l in lock]
        (self.root / "vscode/grammar.lock").write_text("\n".join(lock) + "\n")
        self.assertEqual(self.sync("--check").returncode, 0)  # the cheap check is fooled...
        r = self.sync("--check", "--verify-build")  # ...a rebuild is not
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("rebuild", r.stderr)


if __name__ == "__main__":
    unittest.main()
