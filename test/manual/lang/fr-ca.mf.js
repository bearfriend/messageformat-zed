// Manual check for the language server. Open in Zed (language: MessageFormat) and expect the
// diagnostics listed beside each entry. The locale comes from the file name (fr-ca) and the
// source from the default `en`, i.e. en.mf.js next to this file.
export default {
	ok: "Bonjour {name}",
	greeting: "Bonjour {nom}", // error: Unrecognized argument "nom"
	unterminated: "Bonjour {name", // error: Expected "}" ... (squiggle on `{name`)
	noOther: "{g, select, male {Il} female {Elle}}", // error: Missing "other" option
	missingCategories: "{n, plural, one {# article} other {# articles}}", // warning: Missing category "many"
	badCategory: "{n, plural, one {# a} few {# b} many {# c} other {# d}}", // error: Unsupported category "few"
	multi: `{g, select,
		male {Il {x}}
		female {Elle
	}`, // error: syntax error, squiggle only on the first line where it starts
	title: "Dashboard", // warning: untranslated (an "mfv" + "-translated" comment silences it)
	extra: "Plus", // error: Message does not exist in the source locale
	dup: "Un",
	dup: "Deux", // error: Duplicate key "dup"
};
// Also expected: a warning on line 1 saying "onlyInSource" is missing compared to en.
