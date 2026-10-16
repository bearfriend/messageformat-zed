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

    #[test]
    fn extension_manifest_is_consistent() {
        let ext = toml("extension.toml");
        assert_eq!(ext["id"].as_str(), Some("messageformat"));
        assert_eq!(ext["schema_version"].as_integer(), Some(1));
        let grammars = ext["grammars"].as_table().expect("[grammars] table");
        assert!(grammars.contains_key("messageformat"));
        let cargo = toml("Cargo.toml");
        assert_eq!(ext["version"].as_str(), cargo["package"]["version"].as_str());
    }

    #[test]
    fn grammar_pin_is_publishable() {
        let ext = toml("extension.toml");
        let repo = ext["repository"].as_str().expect("extension repository");
        assert!(repo.starts_with("https://"), "extension repository must be https: {repo}");
        let grammar = &ext["grammars"]["messageformat"];
        let url = grammar["repository"].as_str().expect("grammar repository");
        assert!(url.starts_with("https://"), "grammar repository must be a public https URL: {url}");
        let rev = grammar["rev"].as_str().expect("grammar rev");
        assert!(
            rev.len() == 40 && rev.chars().all(|c| c.is_ascii_hexdigit()),
            "grammar rev must be a full commit SHA: {rev}"
        );
        assert!(root().join("LICENSE").exists(), "LICENSE is required to publish");
    }

    #[test]
    fn language_config_references_declared_grammar() {
        let ext = toml("extension.toml");
        let cfg = toml("languages/messageformat/config.toml");
        let grammar = cfg["grammar"].as_str().expect("grammar key");
        assert!(ext["grammars"].as_table().unwrap().contains_key(grammar));
        let suffixes: Vec<_> = cfg["path_suffixes"]
            .as_array()
            .expect("path_suffixes")
            .iter()
            .filter_map(|v| v.as_str())
            .collect();
        assert!(suffixes.contains(&"msg"));
        assert_eq!(cfg["line_comments"][0].as_str(), Some("// "));
    }

    #[test]
    fn query_files_are_present() {
        for q in ["highlights.scm", "brackets.scm"] {
            let text = read(&format!("languages/messageformat/{q}"));
            assert!(text.contains('@'), "{q} has no captures");
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
        let types: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(grammar.join("src/node-types.json")).unwrap())
                .unwrap();
        let known: HashSet<&str> = types
            .as_array()
            .unwrap()
            .iter()
            .filter(|t| t["named"].as_bool() == Some(true))
            .filter_map(|t| t["type"].as_str())
            .collect();
        for q in ["highlights.scm", "brackets.scm"] {
            let text = read(&format!("languages/messageformat/{q}"));
            for name in node_names(&text) {
                assert!(known.contains(name.as_str()), "{q} references unknown node type `{name}`");
            }
        }
    }

    #[test]
    fn shipped_queries_match_the_grammar_repo() {
        let Some(grammar) = grammar_repo() else {
            eprintln!("skipped: ../tree-sitter-messageformat not found");
            return;
        };
        for q in ["highlights.scm", "brackets.scm"] {
            let theirs = fs::read_to_string(grammar.join("queries").join(q)).unwrap();
            assert_eq!(
                read(&format!("languages/messageformat/{q}")),
                theirs,
                "{q} is out of sync with the grammar repo; run scripts/sync-grammar.sh"
            );
        }
    }
}
