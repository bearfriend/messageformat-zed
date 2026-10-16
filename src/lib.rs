use zed_extension_api as zed;

struct MessageFormatExtension {
    // No additional state needed for basic grammar support
}

impl zed::Extension for MessageFormatExtension {
    fn new() -> Self {
        Self {}
    }
}

zed::register_extension!(MessageFormatExtension);

#[cfg(test)]
mod tests {
    use std::collections::HashSet;
    use std::fs;
    use std::path::{Path, PathBuf};

    /// One shipped language: where it lives here, which `[grammars.*]` entry it uses,
    /// and where the matching grammar and queries live in the grammar repo.
    struct Lang {
        dir: &'static str,
        grammar: &'static str,
        /// Directory in the grammar repo that holds `src/node-types.json`.
        grammar_dir: &'static str,
        /// Directory in the grammar repo that holds the source queries.
        queries_dir: &'static str,
    }

    const LANGS: [Lang; 2] = [
        Lang {
            dir: "languages/messageformat",
            grammar: "messageformat",
            grammar_dir: ".",
            queries_dir: "queries",
        },
        Lang {
            dir: "languages/messageformat_message",
            grammar: "messageformat_message",
            grammar_dir: "message",
            queries_dir: "message/queries",
        },
    ];

    const QUERIES: [&str; 2] = ["highlights.scm", "brackets.scm"];

    fn root() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
    }

    fn read(rel: &str) -> String {
        fs::read_to_string(root().join(rel)).unwrap_or_else(|e| panic!("cannot read {rel}: {e}"))
    }

    fn toml(rel: &str) -> toml::Table {
        read(rel).parse().unwrap_or_else(|e| panic!("{rel} is not valid TOML: {e}"))
    }

    /// The grammar repo that `extension.toml` points at (a sibling checkout).
    /// Returns None when it isn't available, e.g. in a standalone clone.
    fn grammar_repo() -> Option<PathBuf> {
        let dir = root().join("../tree-sitter-messageformat");
        Path::new(&dir.join("src/node-types.json")).exists().then_some(dir)
    }

    fn strings(value: &toml::Value) -> Vec<&str> {
        value.as_array().expect("array").iter().filter_map(|v| v.as_str()).collect()
    }

    #[test]
    fn extension_manifest_is_consistent() {
        let ext = toml("extension.toml");
        assert_eq!(ext["id"].as_str(), Some("messageformat"));
        assert_eq!(ext["schema_version"].as_integer(), Some(1));
        let grammars = ext["grammars"].as_table().expect("[grammars] table");
        for lang in &LANGS {
            assert!(grammars.contains_key(lang.grammar), "missing [grammars.{}]", lang.grammar);
        }
        assert_eq!(grammars.len(), LANGS.len(), "extension.toml declares a grammar no test knows about");
        let cargo = toml("Cargo.toml");
        assert_eq!(ext["version"].as_str(), cargo["package"]["version"].as_str());
    }

    #[test]
    fn grammar_pin_is_publishable() {
        let ext = toml("extension.toml");
        let repo = ext["repository"].as_str().expect("extension repository");
        assert!(repo.starts_with("https://"), "extension repository must be https: {repo}");
        let mut revs = HashSet::new();
        for lang in &LANGS {
            let grammar = &ext["grammars"][lang.grammar];
            let url = grammar["repository"].as_str().expect("grammar repository");
            assert!(
                url.starts_with("https://"),
                "[grammars.{}] repository must be a public https URL: {url}",
                lang.grammar
            );
            let rev = grammar["rev"].as_str().expect("grammar rev");
            assert!(
                rev.len() == 40 && rev.chars().all(|c| c.is_ascii_hexdigit()),
                "[grammars.{}] rev must be a full commit SHA: {rev}",
                lang.grammar
            );
            revs.insert(rev);
        }
        assert_eq!(revs.len(), 1, "both grammars must be pinned to the same commit: {revs:?}");
        assert!(root().join("LICENSE").exists(), "LICENSE is required to publish");
    }

    #[test]
    fn message_grammar_is_built_from_the_message_subdirectory() {
        let ext = toml("extension.toml");
        assert_eq!(ext["grammars"]["messageformat_message"]["path"].as_str(), Some("message"));
        assert!(ext["grammars"]["messageformat"].get("path").is_none());
    }

    #[test]
    fn language_config_references_declared_grammar() {
        let ext = toml("extension.toml");
        for lang in &LANGS {
            let cfg = toml(&format!("{}/config.toml", lang.dir));
            assert_eq!(cfg["grammar"].as_str(), Some(lang.grammar), "{}", lang.dir);
            assert!(ext["grammars"].as_table().unwrap().contains_key(lang.grammar));
        }
    }

    #[test]
    fn resource_language_config() {
        let cfg = toml("languages/messageformat/config.toml");
        let suffixes = strings(&cfg["path_suffixes"]);
        for expected in ["mf", "mf.js", "msg", "messages"] {
            assert!(suffixes.contains(&expected), "missing suffix {expected}");
        }
        assert_eq!(cfg["line_comments"][0].as_str(), Some("// "));
    }

    #[test]
    fn message_language_config() {
        let cfg = toml("languages/messageformat_message/config.toml");
        assert_eq!(cfg["name"].as_str(), Some("MessageFormat Message"));
        let fence = cfg["code_fence_block_name"].as_str().expect("code_fence_block_name");
        // Zed resolves a Markdown fence by language name or path suffix, so the fence
        // name has to be one of the suffixes or it would never be found.
        assert!(strings(&cfg["path_suffixes"]).contains(&fence), "fence `{fence}` is not resolvable");
        // Bare messages have no comment syntax: `//` in a message is just text.
        assert!(cfg.get("line_comments").is_none());
    }

    #[test]
    fn languages_do_not_claim_each_others_names() {
        let a = toml("languages/messageformat/config.toml");
        let b = toml("languages/messageformat_message/config.toml");
        let names = |cfg: &toml::Table| -> HashSet<String> {
            let mut set: HashSet<String> =
                strings(&cfg["path_suffixes"]).iter().map(|s| s.to_lowercase()).collect();
            set.insert(cfg["name"].as_str().unwrap().to_lowercase());
            if let Some(fence) = cfg.get("code_fence_block_name").and_then(|v| v.as_str()) {
                set.insert(fence.to_lowercase());
            }
            set
        };
        let overlap: Vec<_> = names(&a).intersection(&names(&b)).cloned().collect();
        assert!(overlap.is_empty(), "languages resolve the same names: {overlap:?}");
    }

    /// Every `injection.language` the grammar repo's host queries emit must resolve to
    /// the message language, otherwise Zed would leave those layers pending forever.
    #[test]
    fn message_language_answers_to_every_injection_name() {
        let Some(grammar) = grammar_repo() else {
            eprintln!("skipped: ../tree-sitter-messageformat not found");
            return;
        };
        let cfg = toml("languages/messageformat_message/config.toml");
        let mut known: HashSet<String> =
            strings(&cfg["path_suffixes"]).iter().map(|s| s.to_lowercase()).collect();
        known.insert(cfg["name"].as_str().unwrap().to_lowercase());

        let mut used = HashSet::new();
        for entry in fs::read_dir(grammar.join("injections")).unwrap() {
            let path = entry.unwrap().path();
            if path.extension().and_then(|e| e.to_str()) != Some("scm") {
                continue;
            }
            used.extend(injection_languages(&fs::read_to_string(&path).unwrap()));
        }
        assert!(!used.is_empty(), "found no injection.language strings; is the extraction broken?");
        for name in used {
            assert!(
                known.contains(&name.to_lowercase()),
                "injection.language \"{name}\" is not a name or path suffix of the message language"
            );
        }
    }

    fn injection_languages(query: &str) -> HashSet<String> {
        const KEY: &str = "injection.language \"";
        let mut out = HashSet::new();
        for line in query.lines() {
            let line = line.split(';').next().unwrap_or("");
            if let Some(at) = line.find(KEY) {
                let rest = &line[at + KEY.len()..];
                if let Some(end) = rest.find('"') {
                    out.insert(rest[..end].to_string());
                }
            }
        }
        out
    }

    #[test]
    fn injection_language_extraction() {
        let q = "; injection.language \"commented\"\n(#set! injection.language \"a_b\")\n(#set! injection.language \"c\") ; x";
        assert_eq!(injection_languages(q), HashSet::from(["a_b".to_string(), "c".to_string()]));
    }

    #[test]
    fn query_files_are_present() {
        for lang in &LANGS {
            for q in QUERIES {
                let text = read(&format!("{}/{q}", lang.dir));
                assert!(text.contains('@'), "{}/{q} has no captures", lang.dir);
            }
        }
    }

    /// Strip `;` comments and string literals so only node names remain.
    fn node_names(query: &str) -> HashSet<String> {
        let mut cleaned = String::new();
        for line in query.lines() {
            let mut in_str = false;
            let mut prev = ' ';
            for c in line.chars() {
                if c == '"' && prev != '\\' {
                    in_str = !in_str;
                    continue;
                }
                if !in_str {
                    if c == ';' {
                        break;
                    }
                    cleaned.push(c);
                }
                prev = c;
            }
            cleaned.push('\n');
        }
        let mut names = HashSet::new();
        let chars: Vec<char> = cleaned.chars().collect();
        for (i, c) in chars.iter().enumerate() {
            if *c == '(' {
                let name: String = chars[i + 1..]
                    .iter()
                    .take_while(|c| c.is_alphanumeric() || **c == '_')
                    .collect();
                if !name.is_empty() {
                    names.insert(name);
                }
            }
        }
        names
    }

    #[test]
    fn node_name_extraction_ignores_comments_strings_and_predicates() {
        let q = "; (ignored)\n(a (b) @x \"(not_a_node)\")\n((c) @y (#eq? @y \"z\"))";
        let got = node_names(q);
        assert_eq!(got, HashSet::from(["a".into(), "b".into(), "c".into()]));
    }

    #[test]
    fn queries_only_use_node_types_that_exist_in_the_grammar() {
        let Some(grammar) = grammar_repo() else {
            eprintln!("skipped: ../tree-sitter-messageformat not found");
            return;
        };
        for lang in &LANGS {
            let types: serde_json::Value = serde_json::from_str(
                &fs::read_to_string(grammar.join(lang.grammar_dir).join("src/node-types.json"))
                    .unwrap(),
            )
            .unwrap();
            let known: HashSet<&str> = types
                .as_array()
                .unwrap()
                .iter()
                .filter(|t| t["named"].as_bool() == Some(true))
                .filter_map(|t| t["type"].as_str())
                .collect();
            for q in QUERIES {
                let text = read(&format!("{}/{q}", lang.dir));
                for name in node_names(&text) {
                    assert!(
                        known.contains(name.as_str()),
                        "{}/{q} references unknown node type `{name}`",
                        lang.dir
                    );
                }
            }
        }
    }

    #[test]
    fn shipped_queries_match_the_grammar_repo() {
        let Some(grammar) = grammar_repo() else {
            eprintln!("skipped: ../tree-sitter-messageformat not found");
            return;
        };
        for lang in &LANGS {
            for q in QUERIES {
                let theirs =
                    fs::read_to_string(grammar.join(lang.queries_dir).join(q)).unwrap();
                assert_eq!(
                    read(&format!("{}/{q}", lang.dir)),
                    theirs,
                    "{}/{q} is out of sync with the grammar repo; run scripts/sync-grammar.sh",
                    lang.dir
                );
            }
        }
    }
}
