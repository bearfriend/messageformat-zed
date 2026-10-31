"""Tests for install_vscode.py. Run with: python3 -m unittest discover -s scripts"""
import hashlib
import json
import os
import re
import shutil
import stat
import subprocess
import tempfile
import unittest
import unittest.mock
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path

import install_vscode as iv

REPO = Path(__file__).resolve().parent.parent


def loads_jsonc(text):
    """Independent JSONC reader for the tests (does not reuse the module's scanner)."""
    out, i, n = [], 0, len(text)
    while i < n:
        c = text[i]
        if c == '"':
            j = i + 1
            while text[j] != '"':
                j += 2 if text[j] == "\\" else 1
            out.append(text[i : j + 1])
            i = j + 1
        elif text.startswith("//", i):
            while i < n and text[i] != "\n":
                i += 1
        elif text.startswith("/*", i):
            i = text.index("*/", i) + 2
        else:
            out.append(c)
            i += 1
    stripped = re.sub(r",(\s*[}\]])", r"\1", "".join(out))
    return json.loads(stripped)


ENTRIES = {
    "tree-sitter-vscode.languageConfigs": [{"lang": "messageformat", "parser": "/x/y.wasm"}],
    "glspc.server.command": "/usr/bin/node",
    "[messageformat]": {"editor.semanticHighlighting.enabled": True},
}


class MergeSettingsTest(unittest.TestCase):
    def merge(self, text, entries=ENTRIES):
        new, added, skipped = iv.merge_settings(text, entries)
        return new, added, skipped

    def test_empty_file(self):
        new, added, skipped = self.merge("")
        self.assertEqual(loads_jsonc(new), ENTRIES)
        self.assertEqual(sorted(added), sorted(ENTRIES))
        self.assertEqual(skipped, [])

    def test_empty_object(self):
        new, _, _ = self.merge("{}\n")
        self.assertEqual(loads_jsonc(new), ENTRIES)

    def test_preserves_comments_and_values_without_trailing_comma(self):
        text = '{\n    // my theme\n    "workbench.colorTheme": "One Dark", /* inline */\n    "editor.fontSize": 14\n}\n'
        new, _, _ = self.merge(text)
        self.assertIn("// my theme", new)
        self.assertIn("/* inline */", new)
        parsed = loads_jsonc(new)
        self.assertEqual(parsed["workbench.colorTheme"], "One Dark")
        self.assertEqual(parsed["editor.fontSize"], 14)
        self.assertEqual(parsed["glspc.server.command"], "/usr/bin/node")

    def test_trailing_comma_and_trailing_comment_stay_valid(self):
        text = '{\n    "a": {\n        "b": 1\n    },\n    //"glspc.trace.server": "verbose"\n}\n'
        new, _, _ = self.merge(text)
        self.assertIn('//"glspc.trace.server": "verbose"', new)
        parsed = loads_jsonc(new)
        self.assertEqual(parsed["a"], {"b": 1})
        self.assertEqual(parsed["glspc.server.command"], "/usr/bin/node")
        # the comment still follows our block instead of being glued to one of its lines
        self.assertLess(new.index("glspc.server.command"), new.index('//"glspc.trace.server"'))

    def test_trailing_line_comment_on_last_entry(self):
        text = '{\n    "a": 1, // note\n}\n'
        new, _, _ = self.merge(text)
        self.assertIn('"a": 1, // note\n', new)
        self.assertEqual(loads_jsonc(new)["a"], 1)

    def test_existing_managed_key_is_skipped_and_untouched(self):
        text = '{\n    "glspc.server.command": "/opt/other-server"\n}\n'
        new, added, skipped = self.merge(text)
        self.assertEqual(skipped, ["glspc.server.command"])
        self.assertNotIn("glspc.server.command", added)
        parsed = loads_jsonc(new)
        self.assertEqual(parsed["glspc.server.command"], "/opt/other-server")
        self.assertEqual(new.count('"glspc.server.command"'), 1)
        self.assertIn("[messageformat]", parsed)

    def test_names_in_comments_nested_objects_and_values_do_not_count(self):
        text = (
            "{\n"
            '    // "glspc.server.command": "old"\n'
            '    "nested": { "glspc.server.command": 1 },\n'
            '    "note": "glspc.server.command",\n'
            '    "list": ["glspc.server.command"]\n'
            "}\n"
        )
        new, added, skipped = self.merge(text)
        self.assertEqual(skipped, [])
        self.assertIn("glspc.server.command", added)
        self.assertEqual(loads_jsonc(new)["glspc.server.command"], "/usr/bin/node")

    def test_adds_missing_entries_inside_an_existing_object_and_keeps_the_rest(self):
        text = (
            "{\n"
            '    "files.associations": {\n'
            '        "*.mf.js": "javascript",\n'
            '        "*.tpl": "html" // mine\n'
            "    },\n"
            '    "editor.fontSize": 14\n'
            "}\n"
        )
        entries = {"files.associations": {"*.mf": "messageformat", "*.mf.js": "messageformat"}}
        new, added, skipped = iv.merge_settings(text, entries)
        parsed = loads_jsonc(new)
        self.assertEqual(
            parsed["files.associations"],
            {"*.mf.js": "javascript", "*.tpl": "html", "*.mf": "messageformat"},
        )
        self.assertIn("// mine", new)
        self.assertEqual(parsed["editor.fontSize"], 14)
        self.assertEqual(added, ['files.associations["*.mf"]'])
        self.assertEqual(skipped, ['files.associations["*.mf.js"]'])

    def test_nested_insert_layout_is_exact_and_has_no_header_comment(self):
        text = '{\n    "files.associations": {\n        "*.tpl": "html"\n    },\n    "a": 1\n}\n'
        new, _, _ = iv.merge_settings(text, {"files.associations": {"*.mf": "messageformat"}})
        self.assertEqual(
            new,
            '{\n    "files.associations": {\n        "*.tpl": "html",\n'
            '        "*.mf": "messageformat"\n    },\n    "a": 1\n}\n',
        )

    def test_several_nested_objects_and_new_keys_in_one_merge(self):
        text = '{\n    "x": {"a": 1},\n    "y": {\n        "b": 2\n    },\n    "z": 3\n}\n'
        entries = {"x": {"a": 9, "c": 3}, "y": {"d": 4}, "new": True}
        new, added, skipped = iv.merge_settings(text, entries)
        parsed = loads_jsonc(new)
        self.assertEqual(parsed["x"], {"a": 1, "c": 3})
        self.assertEqual(parsed["y"], {"b": 2, "d": 4})
        self.assertEqual((parsed["z"], parsed["new"]), (3, True))
        self.assertEqual(sorted(added), sorted(['x["c"]', 'y["d"]', "new"]))
        self.assertEqual(skipped, ['x["a"]'])

    def test_nested_insert_into_empty_and_inline_objects(self):
        entries = {"files.associations": {"*.mf": "messageformat"}}
        for text in ('{"files.associations": {}}', '{\n  "files.associations": { "*.a": "b" }\n}\n'):
            new, added, _ = iv.merge_settings(text, entries)
            self.assertEqual(loads_jsonc(new)["files.associations"]["*.mf"], "messageformat", text)
            self.assertEqual(added, ['files.associations["*.mf"]'])

    def test_nested_merge_is_idempotent(self):
        entries = {"files.associations": {"*.mf": "messageformat"}}
        once, _, _ = iv.merge_settings('{\n    "files.associations": {"*.a": "b"}\n}\n', entries)
        twice, added, skipped = iv.merge_settings(once, entries)
        self.assertEqual(twice, once)
        self.assertEqual((added, skipped), ([], ["files.associations"]))

    def test_existing_non_object_value_is_left_alone(self):
        new, added, skipped = iv.merge_settings('{"files.associations": null}', {"files.associations": {"*.mf": "x"}})
        self.assertEqual(loads_jsonc(new), {"files.associations": None})
        self.assertEqual((added, skipped), ([], ["files.associations"]))

    def test_idempotent(self):
        once, _, _ = self.merge('{\n    "a": 1\n}\n')
        twice, added, skipped = self.merge(once)
        self.assertEqual(twice, once)
        self.assertEqual(added, [])
        self.assertEqual(sorted(skipped), sorted(ENTRIES))

    def test_matches_tab_indentation(self):
        new, _, _ = self.merge('{\n\t"a": 1\n}\n')
        self.assertIn('\n\t"glspc.server.command"', new)
        self.assertEqual(loads_jsonc(new)["a"], 1)

    def test_single_line_object(self):
        new, _, _ = self.merge('{"a": 1}')
        parsed = loads_jsonc(new)
        self.assertEqual(parsed["a"], 1)
        self.assertEqual(parsed["glspc.server.command"], "/usr/bin/node")

    def test_non_object_root_is_rejected(self):
        with self.assertRaises(ValueError):
            self.merge("[1, 2]")

    def test_unterminated_string_is_rejected(self):
        with self.assertRaises(ValueError):
            self.merge('{"a": "oops}')


class LanguageVsixTest(unittest.TestCase):
    def test_contents(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "lang.vsix"
            iv.write_language_vsix(path)
            with zipfile.ZipFile(path) as z:
                names = set(z.namelist())
                self.assertEqual(
                    names,
                    {"[Content_Types].xml", "extension.vsixmanifest", "extension/package.json"},
                )
                pkg = json.loads(z.read("extension/package.json"))
                manifest = ET.fromstring(z.read("extension.vsixmanifest"))
                ET.fromstring(z.read("[Content_Types].xml"))
        lang = pkg["contributes"]["languages"][0]
        self.assertEqual(lang["id"], "messageformat")
        self.assertEqual(lang["extensions"], [".mf", ".mf.js", ".mf.json"])
        self.assertEqual(lang["filenamePatterns"], ["*.mf", "*.mf.js", "*.mf.json"])
        ns = {"v": "http://schemas.microsoft.com/developer/vsx-schema/2011"}
        identity = manifest.find("v:Metadata/v:Identity", ns)
        self.assertEqual(identity.get("Version"), pkg["version"])
        self.assertEqual(identity.get("Publisher"), pkg["publisher"])
        self.assertEqual(identity.get("Id"), pkg["name"])


class ManagedSettingsTest(unittest.TestCase):
    def build(self, **kw):
        defaults = dict(grammar_dir=Path("/g"), lsp=None)
        defaults.update(kw)
        return iv.managed_settings(**defaults)

    def test_tree_sitter_entry_points_into_the_grammar_dir(self):
        s = self.build()
        (cfg,) = s["tree-sitter-vscode.languageConfigs"]
        self.assertEqual(cfg["lang"], "messageformat")
        self.assertEqual(cfg["parser"], "/g/tree-sitter-messageformat.wasm")
        self.assertEqual(cfg["highlights"], "/g/highlights.scm")
        self.assertEqual(cfg["folds"], "/g/folds.scm")
        self.assertEqual(s["[messageformat]"], {"editor.semanticHighlighting.enabled": True})

    def test_file_associations_cover_every_suffix(self):
        s = self.build()
        self.assertEqual(
            s["files.associations"],
            {"*.mf": "messageformat", "*.mf.js": "messageformat", "*.mf.json": "messageformat"},
        )
        self.assertEqual(sorted(s["files.associations"]), sorted("*" + x for x in iv.FILE_SUFFIXES))

    def test_mappings_use_the_keys_and_types_the_extension_understands(self):
        (cfg,) = self.build()["tree-sitter-vscode.languageConfigs"]
        mappings = cfg["semanticTokenTypeMappings"]
        self.assertTrue(mappings)
        for name, mapping in mappings.items():
            self.assertIn(mapping["targetTokenType"], iv.SEMANTIC_TOKEN_TYPES, name)
            for modifier in mapping.get("targetTokenModifiers", []):
                self.assertIn(modifier, iv.SEMANTIC_TOKEN_MODIFIERS, name)
            self.assertEqual(set(mapping) - {"targetTokenType", "targetTokenModifiers"}, set(), name)

    def test_every_non_standard_capture_in_the_queries_is_mapped(self):
        queries = (REPO / "languages/messageformat/highlights.scm").read_text()
        captures = set(re.findall(r"@([A-Za-z_.]+)", queries))
        (cfg,) = self.build()["tree-sitter-vscode.languageConfigs"]
        mappings = cfg["semanticTokenTypeMappings"]
        for capture in captures:
            base = capture.split(".")[0]
            if capture in mappings:
                continue
            self.assertIn(base, iv.SEMANTIC_TOKEN_TYPES, f"@{capture} would be dropped")

    def test_no_lsp_omits_glspc_keys(self):
        self.assertFalse([k for k in self.build() if k.startswith("glspc.")])

    def test_published_server_runs_through_npx_with_node_on_path(self):
        s = self.build(lsp=iv.LspCommand.published(npx="/n/bin/npx", node="/n/bin/node"))
        self.assertEqual(s["glspc.server.command"], "/n/bin/npx")
        # `@latest` makes npx ask the registry; a bare name reuses whatever old copy its cache holds
        self.assertEqual(
            s["glspc.server.commandArguments"], ["-y", "messageformat-language-server@latest", "--stdio"]
        )
        self.assertEqual(s["glspc.server.languageId"], ["messageformat"])
        self.assertEqual(s["glspc.server.environmentVariables"], {"PATH": "/n/bin" + os.pathsep + "$PATH"})

    def test_local_server_runs_through_node(self):
        s = self.build(lsp=iv.LspCommand.local(node="/n/bin/node", server_js="/s/server.js"))
        self.assertEqual(s["glspc.server.command"], "/n/bin/node")
        self.assertEqual(s["glspc.server.commandArguments"], ["/s/server.js", "--stdio"])
        self.assertNotIn("glspc.server.environmentVariables", s)


class TreeSitterCommandTest(unittest.TestCase):
    def test_default_runs_the_cli_package_through_npx(self):
        cmd = iv.tree_sitter_command(None, npx="/n/npx")
        self.assertEqual(cmd, ["/n/npx", "-y", iv.TREE_SITTER_CLI_PACKAGE])
        # `npx tree-sitter` is the node bindings library and has no executable
        self.assertTrue(iv.TREE_SITTER_CLI_PACKAGE.startswith("tree-sitter-cli@"))

    def test_custom_command_is_split_like_a_shell_would(self):
        self.assertEqual(iv.tree_sitter_command("npx -y tree-sitter-cli", npx=None), ["npx", "-y", "tree-sitter-cli"])
        self.assertEqual(iv.tree_sitter_command("/opt/my ts/bin/ts", npx=None), ["/opt/my", "ts/bin/ts"])
        self.assertEqual(iv.tree_sitter_command('"/opt/my ts/bin/ts"', npx=None), ["/opt/my ts/bin/ts"])

    def test_pinned_range_matches_the_grammar_repos_dev_dependency(self):
        sibling = REPO.parent / "tree-sitter-messageformat/package.json"
        if not sibling.exists():
            self.skipTest("grammar repo not checked out next to this one")
        wanted = json.loads(sibling.read_text())["devDependencies"]["tree-sitter-cli"]
        self.assertEqual(iv.TREE_SITTER_CLI_PACKAGE, f"tree-sitter-cli@{wanted}")


class PinnedGrammarTest(unittest.TestCase):
    def test_reads_repository_and_rev_from_extension_toml(self):
        repo, rev = iv.pinned_grammar(REPO / "extension.toml")
        self.assertRegex(repo, r"^https://.*tree-sitter-messageformat")
        self.assertRegex(rev, r"^[0-9a-f]{40}$")
        toml = (REPO / "extension.toml").read_text()
        self.assertIn(f'rev = "{rev}"', toml)


def git(cwd, *args):
    subprocess.run(
        ["git", "-c", "user.name=t", "-c", "user.email=t@t", *args],
        cwd=cwd, check=True, capture_output=True,
    )


class EndToEndTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.grammar_repo = self.tmp / "grammar-repo"
        (self.grammar_repo / "queries").mkdir(parents=True)
        (self.grammar_repo / "queries/highlights.scm").write_text("(comment) @comment\n")
        (self.grammar_repo / "queries/folds.scm").write_text("(resource) @fold\n")
        (self.grammar_repo / "queries/injections.scm").write_text("; not copied\n")
        git(self.grammar_repo, "init", "-q")
        git(self.grammar_repo, "add", ".")
        git(self.grammar_repo, "commit", "-q", "-m", "init")
        (self.grammar_repo / "queries/highlights.scm").write_text("(comment) @string ; newer, uncommitted\n")
        self.wasm = self.tmp / "prebuilt.wasm"
        self.wasm.write_bytes(b"\0asm")
        self.dest = self.tmp / "grammar-files"
        self.settings = self.tmp / "settings.json"
        self.fake_code = self.tmp / "fake-code"
        self.code_log = self.tmp / "code.log"
        self.fake_code.write_text(f'#!/bin/sh\necho "$@" >> "{self.code_log}"\n')
        self.fake_code.chmod(self.fake_code.stat().st_mode | stat.S_IEXEC)
        self.node = shutil.which("node")
        if not self.node:
            self.skipTest("node not available")

    def run_main(self, *extra):
        argv = [
            str(self.dest),
            "--grammar-repo", str(self.grammar_repo),
            "--rev", "HEAD",
            "--wasm", str(self.wasm),
            "--settings", str(self.settings),
            "--code", str(self.fake_code),
            *extra,
        ]
        return iv.main(argv)

    def test_full_run(self):
        self.settings.write_text('{\n    // mine\n    "editor.fontSize": 14\n}\n')
        self.assertEqual(self.run_main("--server-js", "/s/server.js"), 0)

        self.assertEqual((self.dest / "tree-sitter-messageformat.wasm").read_bytes(), b"\0asm")
        # queries come from the committed rev, not the working tree
        self.assertEqual((self.dest / "highlights.scm").read_text(), "(comment) @comment\n")
        self.assertEqual((self.dest / "folds.scm").read_text(), "(resource) @fold\n")
        self.assertFalse((self.dest / "injections.scm").exists())

        text = self.settings.read_text()
        self.assertIn("// mine", text)
        parsed = loads_jsonc(text)
        self.assertEqual(parsed["editor.fontSize"], 14)
        (cfg,) = parsed["tree-sitter-vscode.languageConfigs"]
        self.assertEqual(cfg["parser"], str(self.dest.resolve() / "tree-sitter-messageformat.wasm"))
        self.assertEqual(parsed["glspc.server.commandArguments"], ["/s/server.js", "--stdio"])
        self.assertEqual(len(list(self.tmp.glob("settings.json.bak-*"))), 1)

        calls = self.code_log.read_text().splitlines()
        self.assertEqual(calls[0], "--install-extension AlecGhost.tree-sitter-vscode")
        self.assertEqual(calls[1], "--install-extension zsol.vscode-glspc")
        self.assertRegex(calls[2], r"^--install-extension \S+messageformat-lang-[\d.]+\.vsix --force$")
        self.assertEqual(len(calls), 3)

    def test_queries_come_from_the_requested_rev_not_head(self):
        old = subprocess.run(
            ["git", "rev-parse", "HEAD"], cwd=self.grammar_repo, check=True, capture_output=True, text=True
        ).stdout.strip()
        (self.grammar_repo / "queries/highlights.scm").write_text("(comment) @keyword ; second commit\n")
        git(self.grammar_repo, "commit", "-q", "-am", "second")
        self.assertEqual(self.run_main("--no-lsp", "--no-install", "--no-settings", "--rev", old), 0)
        self.assertEqual((self.dest / "highlights.scm").read_text(), "(comment) @comment\n")

    def test_second_run_changes_nothing_and_makes_no_backup(self):
        self.assertEqual(self.run_main("--server-js", "/s/server.js"), 0)
        first = self.settings.read_text()
        self.assertEqual(self.run_main("--server-js", "/s/server.js"), 0)
        self.assertEqual(self.settings.read_text(), first)
        self.assertEqual(list(self.tmp.glob("settings.json.bak-*")), [])

    def test_missing_settings_file_is_created(self):
        self.assertEqual(self.run_main("--no-lsp"), 0)
        parsed = loads_jsonc(self.settings.read_text())
        self.assertIn("tree-sitter-vscode.languageConfigs", parsed)
        self.assertFalse([k for k in parsed if k.startswith("glspc.")])
        calls = self.code_log.read_text().splitlines()
        self.assertFalse([c for c in calls if "glspc" in c])

    def test_no_install_and_no_settings(self):
        self.assertEqual(self.run_main("--no-lsp", "--no-install", "--no-settings"), 0)
        self.assertFalse(self.code_log.exists())
        self.assertFalse(self.settings.exists())
        self.assertTrue((self.dest / "highlights.scm").exists())

    def test_existing_keys_are_reported_not_overwritten(self):
        self.settings.write_text('{\n    "glspc.server.command": "/opt/python-lsp"\n}\n')
        self.assertEqual(self.run_main("--server-js", "/s/server.js"), 0)
        parsed = loads_jsonc(self.settings.read_text())
        self.assertEqual(parsed["glspc.server.command"], "/opt/python-lsp")
        self.assertNotIn("glspc.server.languageId", parsed)  # keep the existing server config coherent

    def test_builds_the_parser_with_the_cli_from_a_checkout_of_the_rev(self):
        log = self.tmp / "ts.log"
        fake = self.tmp / "fake-tree-sitter"
        fake.write_text(
            "#!/bin/sh\n"
            f'echo "$@" >> "{log}"\n'
            f'git rev-parse HEAD >> "{log}"\n'
            f'head -1 queries/highlights.scm >> "{log}"\n'
            'while [ $# -gt 0 ]; do if [ "$1" = "-o" ]; then printf built > "$2"; fi; shift; done\n'
        )
        fake.chmod(fake.stat().st_mode | stat.S_IEXEC)
        argv = [
            str(self.dest), "--grammar-repo", str(self.grammar_repo), "--rev", "HEAD", "--no-lsp",
            "--no-install", "--no-settings", "--tree-sitter", str(fake),
        ]
        self.assertEqual(iv.main(argv), 0)
        self.assertEqual((self.dest / "tree-sitter-messageformat.wasm").read_text(), "built")
        args, head, first_query_line = log.read_text().splitlines()
        self.assertEqual(args, f"build --wasm -o {self.dest.resolve() / 'tree-sitter-messageformat.wasm'}")
        self.assertRegex(head, r"^[0-9a-f]{40}$")
        self.assertEqual(first_query_line, "(comment) @comment")  # committed content, not the working tree

    def test_a_failing_build_explains_what_to_do(self):
        fake = self.tmp / "failing-tree-sitter"
        fake.write_text("#!/bin/sh\necho boom >&2\nexit 3\n")
        fake.chmod(fake.stat().st_mode | stat.S_IEXEC)
        argv = [
            str(self.dest), "--grammar-repo", str(self.grammar_repo), "--rev", "HEAD", "--no-lsp",
            "--no-install", "--no-settings", "--tree-sitter", str(fake),
        ]
        with self.assertRaises(SystemExit) as ctx:
            iv.main(argv)
        self.assertIn("boom", str(ctx.exception))
        self.assertIn("--wasm", str(ctx.exception))

    def test_full_run_adds_file_associations_next_to_existing_ones(self):
        self.settings.write_text('{\n    "files.associations": {"*.tpl": "html"}\n}\n')
        self.assertEqual(self.run_main("--no-lsp"), 0)
        parsed = loads_jsonc(self.settings.read_text())
        self.assertEqual(
            parsed["files.associations"],
            {"*.tpl": "html", "*.mf": "messageformat", "*.mf.js": "messageformat", "*.mf.json": "messageformat"},
        )

    def test_missing_wasm_and_no_tree_sitter_cli_explains_what_to_do(self):
        argv = [
            str(self.dest), "--grammar-repo", str(self.grammar_repo), "--rev", "HEAD",
            "--settings", str(self.settings), "--code", str(self.fake_code),
            "--tree-sitter", str(self.tmp / "no-such-tree-sitter"),
        ]
        with self.assertRaises(SystemExit) as ctx:
            iv.main(argv)
        self.assertIn("--wasm", str(ctx.exception))


class ShippedFilesTest(unittest.TestCase):
    """Default mode: copy what the repo ships (vscode/ and languages/), no git, network or build."""

    REV = "a" * 40

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.repo = self.tmp / "repo"
        (self.repo / "languages/messageformat").mkdir(parents=True)
        (self.repo / "vscode").mkdir()
        self.write_toml(self.REV, "https://example.invalid/grammar")
        (self.repo / "languages/messageformat/highlights.scm").write_text("(comment) @comment\n")
        (self.repo / "vscode/folds.scm").write_text("(resource) @fold\n")
        (self.repo / "vscode/tree-sitter-messageformat.wasm").write_bytes(b"\0asm-shipped")
        self.write_lock(self.REV)
        self.dest = self.tmp / "dest"
        self.original_repo = iv.REPO
        iv.REPO = self.repo
        self.addCleanup(setattr, iv, "REPO", self.original_repo)

    def write_toml(self, rev, repository):
        (self.repo / "extension.toml").write_text(
            f'[grammars.messageformat]\nrepository = "{repository}"\nrev = "{rev}"\n'
        )

    def write_lock(self, rev, wasm=None):
        digest = hashlib.sha256((wasm or self.repo / "vscode/tree-sitter-messageformat.wasm").read_bytes()).hexdigest()
        (self.repo / "vscode/grammar.lock").write_text(f"# x\nrev = {rev}\nsha256 = {digest}\ntree-sitter-cli = 1.2.3\n")

    def run_main(self, *extra):
        return iv.main([str(self.dest), "--no-install", "--no-settings", "--no-lsp", *extra])

    def test_copies_the_shipped_files_without_git_or_a_build(self):
        # a CLI that would fail proves nothing is built; an unusable git proves nothing is cloned
        self.assertEqual(self.run_main("--tree-sitter", str(self.tmp / "no-such-cli")), 0)
        self.assertEqual((self.dest / "tree-sitter-messageformat.wasm").read_bytes(), b"\0asm-shipped")
        self.assertEqual((self.dest / "highlights.scm").read_text(), "(comment) @comment\n")
        self.assertEqual((self.dest / "folds.scm").read_text(), "(resource) @fold\n")

    def test_never_calls_git_or_the_cli(self):
        with unittest.mock.patch.object(iv, "run", side_effect=AssertionError("must not run commands")):
            self.assertEqual(self.run_main(), 0)

    def test_a_lock_for_another_rev_is_refused_with_the_fix_spelled_out(self):
        self.write_lock("b" * 40)
        with self.assertRaises(SystemExit) as ctx:
            self.run_main()
        message = str(ctx.exception)
        self.assertIn("sync-grammar.sh", message)
        self.assertIn("--rebuild", message)
        self.assertFalse(self.dest.exists())

    def test_a_wasm_that_does_not_match_its_lock_is_refused(self):
        (self.repo / "vscode/tree-sitter-messageformat.wasm").write_bytes(b"tampered")
        with self.assertRaises(SystemExit) as ctx:
            self.run_main()
        self.assertIn("sha256", str(ctx.exception))

    def test_missing_shipped_files_are_reported(self):
        shutil.rmtree(self.repo / "vscode")
        with self.assertRaises(SystemExit) as ctx:
            self.run_main()
        self.assertIn("vscode", str(ctx.exception))

    def test_wasm_option_replaces_only_the_parser(self):
        mine = self.tmp / "mine.wasm"
        mine.write_bytes(b"\0asm-mine")
        self.write_lock("b" * 40)  # the shipped parser is not used, so its lock is irrelevant
        self.assertEqual(self.run_main("--wasm", str(mine)), 0)
        self.assertEqual((self.dest / "tree-sitter-messageformat.wasm").read_bytes(), b"\0asm-mine")
        self.assertEqual((self.dest / "highlights.scm").read_text(), "(comment) @comment\n")
        self.assertEqual((self.dest / "folds.scm").read_text(), "(resource) @fold\n")

    def make_grammar_and_cli(self):
        grammar = self.tmp / "grammar"
        (grammar / "queries").mkdir(parents=True)
        (grammar / "queries/highlights.scm").write_text("(comment) @string ; from git\n")
        (grammar / "queries/folds.scm").write_text("(selector) @fold\n")
        git(grammar, "init", "-q")
        git(grammar, "add", ".")
        git(grammar, "commit", "-q", "-m", "init")
        rev = subprocess.run(["git", "rev-parse", "HEAD"], cwd=grammar, capture_output=True, text=True).stdout.strip()
        self.write_toml(rev, str(grammar))
        fake = self.tmp / "fake-cli"
        fake.write_text(
            "#!/bin/sh\nwhile [ $# -gt 0 ]; do if [ \"$1\" = \"-o\" ]; then printf rebuilt > \"$2\"; fi; shift; done\n"
        )
        fake.chmod(fake.stat().st_mode | stat.S_IEXEC)
        return rev, fake

    def assert_built_from_git(self):
        self.assertEqual((self.dest / "tree-sitter-messageformat.wasm").read_text(), "rebuilt")
        self.assertEqual((self.dest / "highlights.scm").read_text(), "(comment) @string ; from git\n")
        self.assertEqual((self.dest / "folds.scm").read_text(), "(selector) @fold\n")

    def test_rebuild_builds_the_pinned_rev_instead_of_using_the_shipped_parser(self):
        _, fake = self.make_grammar_and_cli()
        self.assertEqual(self.run_main("--rebuild", "--tree-sitter", str(fake)), 0)
        self.assert_built_from_git()

    def test_rev_alone_also_builds_from_git(self):
        rev, fake = self.make_grammar_and_cli()
        self.assertEqual(self.run_main("--rev", rev, "--tree-sitter", str(fake)), 0)
        self.assert_built_from_git()


class RealRepoShipsAConsistentParserTest(unittest.TestCase):
    """The artifacts committed to this repo work with the default mode, as published."""

    def test_default_mode_accepts_the_committed_files(self):
        if not (REPO / "vscode").exists():
            self.fail("vscode/ is missing; run scripts/sync-grammar.sh")
        with tempfile.TemporaryDirectory() as tmp:
            dest = Path(tmp) / "g"
            self.assertEqual(iv.main([str(dest), "--no-install", "--no-settings", "--no-lsp"]), 0)
            self.assertEqual(
                (dest / "highlights.scm").read_text(), (REPO / "languages/messageformat/highlights.scm").read_text()
            )
            self.assertEqual((dest / "tree-sitter-messageformat.wasm").read_bytes()[:4], b"\0asm")


if __name__ == "__main__":
    unittest.main()
