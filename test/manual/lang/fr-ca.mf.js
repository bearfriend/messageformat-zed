// Manual check for the language server. Open in Zed (language: MessageFormat) and expect the
// diagnostics listed beside each entry. The locale comes from the file name: fr-ca.
export default {
	ok: "Bonjour {name}",
	unterminated: "Bonjour {name", // error: Expected "}" ... (squiggle on `{name`)
	noOther: "{g, select, male {Il} female {Elle}}", // error: Missing "other" option
	missingCategories: "{n, plural, one {# article} other {# articles}}", // warning: Missing category "many"
	badCategory: "{n, plural, one {# a} few {# b} many {# c} other {# d}}", // error: Unsupported category "few"
	multi: `{g, select,
		male {Il {x}}
		female {Elle
	}`, // error: syntax error, squiggle only on the first line where it starts
	dup: "a",
	dup: "b", // error: Duplicate key "dup"
};
