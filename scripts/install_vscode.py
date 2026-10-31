#!/usr/bin/env python3
"""Set up MessageFormat support in VS Code.

    scripts/install_vscode.py GRAMMAR_DIR [options]

GRAMMAR_DIR is where the grammar files are kept: the parser (tree-sitter-messageformat.wasm)
and the highlights.scm / folds.scm queries. It is created if it does not exist.

What it does:
  1. Copies the grammar files this repo ships (vscode/ and languages/messageformat/) into
     GRAMMAR_DIR. They are kept in line with the grammar revision pinned in extension.toml by
     scripts/sync-grammar.sh, so nothing is cloned or built. Options:
       --wasm PATH   use your own parser instead of the shipped one
       --rebuild     clone the pinned grammar revision and build the parser with
                     `npx tree-sitter-cli build --wasm` (needs Docker or Emscripten);
                     --grammar-repo / --rev do the same for another repository or revision
  2. Installs the VS Code extensions via the `code` CLI: tree-sitter-vscode (highlighting),
     a tiny local extension that registers the `messageformat` language for .mf, .mf.js and
     .mf.json files, and, unless --no-lsp, vscode-glspc (language client).
  3. Adds the matching entries to your user settings.json. Existing keys are never
     overwritten, comments are kept, and a settings.json.bak-<time> backup is made first.

The language server defaults to the published `messageformat-language-server` package
(through npx); pass --server-js to use a local checkout (lsp/server.js) instead.

Only the standard library is used.
"""
import argparse
import hashlib
import json
import os
import re
import shlex
import shutil
import subprocess
import sys
import tempfile
import time
import zipfile
from dataclasses import dataclass, field
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent

LANGUAGE_ID = "messageformat"
WASM_NAME = "tree-sitter-messageformat.wasm"
QUERY_FILES = {"highlights.scm": "queries/highlights.scm", "folds.scm": "queries/folds.scm"}
# Shipped by this repo (see scripts/sync-grammar.sh): file name -> path relative to the repo root.
SHIPPED_FILES = {
    WASM_NAME: "vscode/" + WASM_NAME,
    "highlights.scm": "languages/messageformat/highlights.scm",
    "folds.scm": "vscode/folds.scm",
}
SHIPPED_LOCK = "vscode/grammar.lock"

# The CLI lives in `tree-sitter-cli`; the npm package called `tree-sitter` is the node
# bindings library and has no executable, so `npx tree-sitter` fails on a clean machine.
# The range matches the grammar repo's devDependencies.
TREE_SITTER_CLI_PACKAGE = "tree-sitter-cli@^0.27.1"

TREE_SITTER_EXTENSION = "AlecGhost.tree-sitter-vscode"
LSP_CLIENT_EXTENSION = "zsol.vscode-glspc"
SERVER_PACKAGE = "messageformat-language-server"

LANGUAGE_EXTENSION_NAME = "messageformat-lang"
LANGUAGE_EXTENSION_PUBLISHER = "local"
LANGUAGE_EXTENSION_VERSION = "0.0.2"
FILE_SUFFIXES = [".mf", ".mf.js", ".mf.json"]

# The only token types and modifiers tree-sitter-vscode forwards to VS Code; anything else
# is silently dropped, so every mapping has to land on one of these.
SEMANTIC_TOKEN_TYPES = [
    "namespace", "class", "enum", "interface", "struct", "typeParameter", "type", "parameter",
    "variable", "property", "enumMember", "decorator", "event", "function", "method", "macro",
    "label", "comment", "string", "keyword", "number", "regexp", "operator",
]
SEMANTIC_TOKEN_MODIFIERS = [
    "declaration", "definition", "readonly", "static", "deprecated", "abstract", "async",
    "modification", "documentation", "defaultLibrary",
]

# Capture names from the highlights query that are not standard semantic token types.
# (tree-sitter-vscode takes `targetTokenType`/`targetTokenModifiers`, nothing else.)
TOKEN_MAPPINGS = {
    "constant": {"targetTokenType": "enumMember"},
    "constant.builtin": {"targetTokenType": "enumMember", "targetTokenModifiers": ["defaultLibrary"]},
    "tag": {"targetTokenType": "class"},
    "punctuation.bracket": {"targetTokenType": "operator"},
    "punctuation.delimiter": {"targetTokenType": "operator"},
    "string.escape": {"targetTokenType": "regexp"},
    "string.special": {"targetTokenType": "regexp"},
    "variable.special": {"targetTokenType": "macro"},
}


# --------------------------------------------------------------------------- settings.json


@dataclass
class LspCommand:
    command: str
    args: list
    env: dict = field(default_factory=dict)

    @classmethod
    def published(cls, npx, node):
        return cls(
            npx,
            ["-y", SERVER_PACKAGE, "--stdio"],
            # npx's shebang needs `node` on PATH, which GUI-launched VS Code often lacks (nvm)
            {"PATH": os.path.dirname(node) + os.pathsep + "$PATH"},
        )

    @classmethod
    def local(cls, node, server_js):
        return cls(node, [str(server_js), "--stdio"])


def managed_settings(grammar_dir, lsp):
    """The settings.json entries this script owns, keyed by top-level setting name."""
    grammar_dir = Path(grammar_dir)
    settings = {
        # Without these VS Code may hand .mf.js and .mf.json to JavaScript and JSON.
        "files.associations": {"*" + suffix: LANGUAGE_ID for suffix in FILE_SUFFIXES},
        "tree-sitter-vscode.languageConfigs": [
            {
                "lang": LANGUAGE_ID,
                "parser": str(grammar_dir / WASM_NAME),
                "highlights": str(grammar_dir / "highlights.scm"),
                "folds": str(grammar_dir / "folds.scm"),
                "semanticTokenTypeMappings": TOKEN_MAPPINGS,
            }
        ],
        # No TextMate grammar exists, so semantic tokens are the only highlighting.
        f"[{LANGUAGE_ID}]": {"editor.semanticHighlighting.enabled": True},
    }
    if lsp:
        settings["glspc.server.command"] = lsp.command
        settings["glspc.server.commandArguments"] = lsp.args
        settings["glspc.server.languageId"] = [LANGUAGE_ID]
        if lsp.env:
            settings["glspc.server.environmentVariables"] = lsp.env
    return settings


def _scan(text):
    """Tokens of a JSONC document as (kind, start, end); comments and whitespace are skipped.

    kind is "str", "punct" (one of {}[],:) or "other" (numbers, true, false, null).
    """
    i, n = 0, len(text)
    while i < n:
        c = text[i]
        if c in " \t\r\n\ufeff":
            i += 1
        elif text.startswith("//", i):
            while i < n and text[i] != "\n":
                i += 1
        elif text.startswith("/*", i):
            end = text.find("*/", i + 2)
            if end < 0:
                raise ValueError("unterminated /* comment in settings.json")
            i = end + 2
        elif c == '"':
            j = i + 1
            while j < n and text[j] != '"':
                if text[j] == "\n":
                    raise ValueError("unterminated string in settings.json")
                j += 2 if text[j] == "\\" else 1
            if j >= n:
                raise ValueError("unterminated string in settings.json")
            yield "str", i, j + 1
            i = j + 1
        elif c in "{}[],:":
            yield "punct", i, i + 1
            i += 1
        else:
            j = i
            while j < n and text[j] not in ' \t\r\n"{}[],:' and not text.startswith(("//", "/*"), j):
                j += 1
            yield "other", i, j
            i = j


def _root_object(text):
    """Locate the root object.

    Returns (spans, open_pos, last_pos, last_is_comma, close_pos): spans maps each top-level
    key to the (start, end) of its value text (None, None if it has no value); last_pos is the
    end of the last token inside the object (None if empty).
    """
    depth, expect_key, cur = 0, False, None
    spans = {}
    open_pos = last_pos = None
    last_is_comma = False
    for kind, start, end in _scan(text):
        tok = text[start:end]
        punct = tok if kind == "punct" else ""
        if depth == 0:
            if open_pos is not None or tok != "{":
                raise ValueError("settings.json root must be an object")
            open_pos, depth, expect_key = start, 1, True
            continue
        if depth == 1:
            if expect_key and kind == "str":
                cur = json.loads(tok)
                spans[cur] = [None, None]
                expect_key = False
            elif cur is not None and spans[cur][0] is None and punct not in (":", ",", "}"):
                spans[cur][0] = start
            if punct in (",", "}") and cur is not None and spans[cur][0] is not None:
                spans[cur][1] = last_pos
        if punct in ("{", "["):
            depth += 1
        elif punct in ("}", "]"):
            depth -= 1
            if depth == 0:
                return {k: tuple(v) for k, v in spans.items()}, open_pos, last_pos, last_is_comma, start
        if depth == 1 and punct == ",":
            expect_key, cur = True, None
        last_pos, last_is_comma = end, punct == "," and depth == 1
    raise ValueError("settings.json has an unclosed object")


def merge_settings(text, entries, header=True, indent=None, close_indent=""):
    """Add what is missing, keeping comments and layout.

    Returns (new_text, added, skipped). A top-level key that already exists is never changed,
    with one exception: when both its existing value and the entry are objects (for example
    `files.associations`), the missing members are added inside it. Names of members are
    reported as key["member"].
    """
    if not text.strip():
        text = "{}\n"
    spans, open_pos, last_pos, last_is_comma, _close = _root_object(text)

    if indent is None:
        first_key = re.search(r'\n([ \t]+)"', text[open_pos:])
        indent = first_key.group(1) if first_key else "    "

    added, skipped, todo, nested = [], [], {}, []
    for key, value in entries.items():
        if key not in spans:
            todo[key] = value
            continue
        vs, ve = spans[key]
        existing = text[vs:ve] if vs is not None else ""
        if isinstance(value, dict) and existing.startswith("{"):
            sub, sub_added, sub_skipped = merge_settings(
                existing, value, header=False, indent=indent * 2, close_indent=indent
            )
            if sub_added:
                nested.append((vs, ve, sub))
                added += [f"{key}[{json.dumps(k)}]" for k in sub_added]
                skipped += [f"{key}[{json.dumps(k)}]" for k in sub_skipped]
                continue
        skipped.append(key)

    new = text
    if todo:
        lines = ["// MessageFormat (added by scripts/install_vscode.py)"] if header else []
        items = list(todo.items())
        for index, (key, value) in enumerate(items):
            body = json.dumps(value, indent=indent, ensure_ascii=False).replace("\n", "\n" + indent)
            comma = "," if index < len(items) - 1 or last_is_comma else ""
            lines.append(f"{json.dumps(key)}: {body}{comma}")
        block = "\n".join(indent + line for line in lines)

        if last_pos is None:  # empty object
            at = open_pos + 1
            nxt = text[at : at + 1]
            tail = "" if nxt == "\n" else "\n" + close_indent
            new = text[:at] + "\n" + block + tail + text[at:]
        else:
            # Insert after the last entry's line (including a trailing comment on that line).
            m = re.match(r"[ \t]*(//[^\n]*|/\*[^\n]*?\*/)?", text[last_pos:])
            line_end = last_pos + m.end()
            nxt = text[line_end : line_end + 1]
            comma_fix = "" if last_is_comma else ","
            new = (
                text[:last_pos]
                + comma_fix
                + text[last_pos:line_end]
                + "\n"
                + block
                + ("" if nxt in ("\n", "\r") else "\n")
                + text[line_end:]
            )
        added += list(todo)

    # Nested edits all lie before the insertion point above, so their offsets are still valid.
    for vs, ve, sub in sorted(nested, reverse=True):
        new = new[:vs] + sub + new[ve:]
    return new, added, skipped


# --------------------------------------------------------------------------- language vsix


def write_language_vsix(path):
    """Write a minimal VSIX that only registers the `messageformat` language id.

    tree-sitter-vscode cannot register a language by itself, and VS Code ignores folders
    dropped into ~/.vscode/extensions that are not listed in extensions.json.
    """
    pkg = {
        "name": LANGUAGE_EXTENSION_NAME,
        "publisher": LANGUAGE_EXTENSION_PUBLISHER,
        "version": LANGUAGE_EXTENSION_VERSION,
        "displayName": "MessageFormat (language registration)",
        "engines": {"vscode": "^1.80.0"},
        "contributes": {
            "languages": [
                {
                    "id": LANGUAGE_ID,
                    "aliases": ["MessageFormat"],
                    "extensions": FILE_SUFFIXES,
                    "filenamePatterns": ["*" + s for s in FILE_SUFFIXES],
                }
            ]
        },
    }
    manifest = f"""<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011">
  <Metadata>
    <Identity Language="en-US" Id="{LANGUAGE_EXTENSION_NAME}" Version="{LANGUAGE_EXTENSION_VERSION}" Publisher="{LANGUAGE_EXTENSION_PUBLISHER}"/>
    <DisplayName>{pkg["displayName"]}</DisplayName>
    <Description xml:space="preserve">Registers the {LANGUAGE_ID} language id for {", ".join(FILE_SUFFIXES)}</Description>
  </Metadata>
  <Installation><InstallationTarget Id="Microsoft.VisualStudio.Code"/></Installation>
  <Dependencies/>
  <Assets><Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true"/></Assets>
</PackageManifest>
"""
    content_types = (
        '<?xml version="1.0" encoding="utf-8"?>\n'
        '<Types><Default Extension=".json" ContentType="application/json"/>'
        '<Default Extension=".vsixmanifest" ContentType="text/xml"/></Types>\n'
    )
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("[Content_Types].xml", content_types)
        z.writestr("extension.vsixmanifest", manifest)
        z.writestr("extension/package.json", json.dumps(pkg, indent=2))


# --------------------------------------------------------------------------- grammar files


def pinned_grammar(extension_toml):
    """(repository, rev) of the first [grammars.*] section in extension.toml."""
    section = re.search(r"^\[grammars\.[^\]]+\]\s*\n(.*?)(?=^\[|\Z)", Path(extension_toml).read_text(), re.S | re.M)
    if not section:
        raise ValueError("no [grammars.*] section in extension.toml")
    fields = dict(re.findall(r'^(\w+)\s*=\s*"(.*)"', section.group(1), re.M))
    return fields["repository"], fields["rev"]


def run(cmd, **kw):
    return subprocess.run(cmd, check=True, capture_output=True, text=True, **kw)


def read_lock(path):
    return dict(re.findall(r"^([\w-]+) = (.*)$", Path(path).read_text(), re.M))


def write_shipped_files(dest, wasm):
    """Copy the files this repo ships. The shipped parser must belong to the pinned grammar rev."""
    missing = [rel for name, rel in SHIPPED_FILES.items() if not (wasm and name == WASM_NAME) and not (REPO / rel).exists()]
    if missing or not (REPO / SHIPPED_LOCK).exists():
        raise SystemExit(
            f"error: {', '.join(missing + ([] if (REPO / SHIPPED_LOCK).exists() else [SHIPPED_LOCK]))} missing "
            "from the vscode/ directory of this repo; run scripts/sync-grammar.sh (or use --rebuild)."
        )
    if not wasm:
        lock = read_lock(REPO / SHIPPED_LOCK)
        _, pinned = pinned_grammar(REPO / "extension.toml")
        if lock.get("rev") != pinned:
            raise SystemExit(
                f"error: the shipped parser is for grammar rev {lock.get('rev', '<none>')}, but extension.toml pins {pinned}.\n"
                "Run scripts/sync-grammar.sh to update it, or use --rebuild to build the pinned revision now."
            )
        digest = hashlib.sha256((REPO / SHIPPED_FILES[WASM_NAME]).read_bytes()).hexdigest()
        if digest != lock.get("sha256"):
            raise SystemExit(
                f"error: {SHIPPED_FILES[WASM_NAME]} does not match the sha256 in {SHIPPED_LOCK}.\n"
                "Run scripts/sync-grammar.sh, or use --rebuild."
            )
    dest.mkdir(parents=True, exist_ok=True)
    for name, rel in SHIPPED_FILES.items():
        if name == WASM_NAME and wasm:
            shutil.copyfile(wasm, dest / name)
        else:
            shutil.copyfile(REPO / rel, dest / name)
    return pinned_grammar(REPO / "extension.toml")[1]


def tree_sitter_command(custom, npx):
    """Command (as an argv prefix) that runs the tree-sitter CLI."""
    if custom:
        return shlex.split(custom)
    return [npx, "-y", TREE_SITTER_CLI_PACKAGE] if npx else None


def write_grammar_files(dest, repo, rev, wasm, tree_sitter):
    dest.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory() as tmp:
        clone = Path(tmp) / "grammar"
        try:
            run(["git", "clone", "--quiet", "--no-checkout", repo, str(clone)])
            commit = run(["git", "-C", str(clone), "rev-parse", f"{rev}^{{commit}}"]).stdout.strip()
            for name, source in QUERY_FILES.items():
                shown = run(["git", "-C", str(clone), "show", f"{commit}:{source}"]).stdout
                (dest / name).write_text(shown)
        except subprocess.CalledProcessError as e:
            raise SystemExit(f"error: could not read the grammar at {repo} @ {rev}:\n{e.stderr.strip()}")
        if wasm:
            shutil.copyfile(wasm, dest / WASM_NAME)
        else:
            try:
                run(["git", "-C", str(clone), "checkout", "--quiet", "--detach", commit])
                run([*tree_sitter, "build", "--wasm", "-o", str(dest / WASM_NAME)], cwd=clone)
            except subprocess.CalledProcessError as e:
                raise SystemExit(
                    "error: building the parser with the tree-sitter CLI failed:\n"
                    f"{(e.stderr or e.stdout).strip()}\nBuild the parser yourself and pass it with --wasm PATH."
                )
    return commit


# --------------------------------------------------------------------------- main


def default_settings_path():
    if sys.platform == "darwin":
        return Path.home() / "Library/Application Support/Code/User/settings.json"
    if sys.platform.startswith("win"):
        return Path(os.environ.get("APPDATA", Path.home())) / "Code/User/settings.json"
    return Path.home() / ".config/Code/User/settings.json"


def default_code_cli():
    found = shutil.which("code")
    if found:
        return found
    bundled = Path("/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code")
    return str(bundled) if bundled.exists() else None


def install_extension(code, ref, force=False):
    cmd = [code, "--install-extension", str(ref)] + (["--force"] if force else [])
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        print(f"warning: could not install {ref}: {(result.stderr or result.stdout).strip()}", file=sys.stderr)
        return False
    print(f"installed {ref}")
    return True


def parse_args(argv):
    p = argparse.ArgumentParser(
        description="Install MessageFormat support (highlighting + language server) into VS Code.",
        epilog="Files are written to GRAMMAR_DIR; see the top of this file for details.",
    )
    p.add_argument("grammar_dir", metavar="GRAMMAR_DIR", help="directory for the grammar .wasm and .scm files")
    p.add_argument("--wasm", help="use this parser instead of the shipped one (or instead of building, with --rebuild)")
    p.add_argument(
        "--rebuild",
        action="store_true",
        help="clone the pinned grammar revision and build the parser instead of using the shipped files",
    )
    p.add_argument("--grammar-repo", help="like --rebuild, for this grammar repository URL or path")
    p.add_argument("--rev", help="like --rebuild, for this grammar revision (default: the pinned rev, or HEAD with --grammar-repo)")
    p.add_argument(
        "--tree-sitter",
        help=f"command that runs the tree-sitter CLI (default: npx -y {TREE_SITTER_CLI_PACKAGE})",
    )
    p.add_argument("--settings", help="settings.json to update (default: the VS Code user settings)")
    p.add_argument("--code", help="VS Code CLI (default: `code` on PATH or the macOS app bundle)")
    p.add_argument("--server-js", help="run this local lsp/server.js instead of the published npm package")
    p.add_argument("--no-lsp", action="store_true", help="highlighting only: skip the language server")
    p.add_argument("--no-install", action="store_true", help="do not install VS Code extensions")
    p.add_argument("--no-settings", action="store_true", help="do not touch settings.json")
    return p.parse_args(argv)


def main(argv=None):
    args = parse_args(sys.argv[1:] if argv is None else argv)
    dest = Path(args.grammar_dir).expanduser().resolve()

    from_git = args.rebuild or args.grammar_repo or args.rev
    if args.grammar_repo:
        repo, rev = args.grammar_repo, args.rev or "HEAD"
    else:
        repo, pinned = pinned_grammar(REPO / "extension.toml")
        rev = args.rev or pinned

    tree_sitter = None
    if from_git and not args.wasm:
        tree_sitter = tree_sitter_command(args.tree_sitter, shutil.which("npx"))
        if not tree_sitter or not shutil.which(tree_sitter[0]):
            raise SystemExit(
                f"error: could not run the tree-sitter CLI ({(tree_sitter or ['npx'])[0]!r} was not found), "
                "so the parser cannot be built.\n"
                "Install Node.js (for npx), point --tree-sitter at a CLI, or pass a prebuilt parser with --wasm PATH."
            )

    lsp = None
    if not args.no_lsp:
        node = shutil.which("node")
        if not node:
            raise SystemExit("error: node was not found on PATH (needed for the language server); use --no-lsp to skip it")
        if args.server_js:
            server_js = Path(args.server_js).expanduser().resolve()
            if not server_js.exists():
                print(f"warning: {server_js} does not exist", file=sys.stderr)
            lsp = LspCommand.local(node, server_js)
        else:
            npx = shutil.which("npx")
            if not npx:
                raise SystemExit("error: npx was not found on PATH; use --server-js or --no-lsp")
            lsp = LspCommand.published(npx, node)

    if from_git:
        commit = write_grammar_files(dest, repo, rev, args.wasm, tree_sitter)
    else:
        commit = write_shipped_files(dest, args.wasm)
    print(f"wrote {WASM_NAME}, {', '.join(QUERY_FILES)} to {dest} (grammar {commit[:12]})")

    if not args.no_install:
        code = args.code or default_code_cli()
        if not code:
            print("warning: the `code` CLI was not found; install the extensions yourself:", file=sys.stderr)
            print(f"  {TREE_SITTER_EXTENSION}" + ("" if args.no_lsp else f", {LSP_CLIENT_EXTENSION}"), file=sys.stderr)
            print("  and the language registration (see README: VS Code)", file=sys.stderr)
        else:
            install_extension(code, TREE_SITTER_EXTENSION)
            if lsp:
                install_extension(code, LSP_CLIENT_EXTENSION)
            with tempfile.TemporaryDirectory() as tmp:
                vsix = Path(tmp) / f"{LANGUAGE_EXTENSION_NAME}-{LANGUAGE_EXTENSION_VERSION}.vsix"
                write_language_vsix(vsix)
                install_extension(code, vsix, force=True)

    if not args.no_settings:
        settings_path = Path(args.settings).expanduser() if args.settings else default_settings_path()
        text = settings_path.read_text() if settings_path.exists() else ""
        entries = managed_settings(dest, lsp)
        existing = _root_object(text or "{}")[0]
        glspc_keys = [k for k in entries if k.startswith("glspc.")]
        if "glspc.server.command" in existing and not all(k in existing for k in glspc_keys):
            # A server is already configured by hand; adding half a config would mix the two.
            for key in glspc_keys:
                del entries[key]
            print(
                "note: glspc.server.command is already set, so the language server settings were left alone.\n"
                f"      Add {LANGUAGE_ID!r} to glspc.server.languageId yourself, or remove the glspc.server.* keys and rerun.",
                file=sys.stderr,
            )
        new, added, skipped = merge_settings(text, entries)
        if added:
            settings_path.parent.mkdir(parents=True, exist_ok=True)
            if settings_path.exists():
                backup = settings_path.with_name(f"{settings_path.name}.bak-{time.strftime('%Y%m%d-%H%M%S')}")
                shutil.copyfile(settings_path, backup)
                print(f"backed up {settings_path.name} to {backup.name}")
            settings_path.write_text(new)
            print(f"updated {settings_path}: added {', '.join(added)}")
        if skipped:
            print(f"left existing settings alone: {', '.join(skipped)}")
        if not added and not skipped:
            print("settings.json already up to date")

    print("\nDone. In VS Code run \"Developer: Reload Window\", then open a .mf or .mf.js file.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
