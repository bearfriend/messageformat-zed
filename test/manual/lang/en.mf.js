// Source locale for the manual language server check. fr-ca.mf.js is compared against this file
// (no mfv.config.json here, so the default source `en` is used).
export default {
	ok: "Hello {name}",
	greeting: "Hello {name}",
	unterminated: "Hello {name}",
	noOther: "{g, select, male {He} female {She} other {They}}",
	missingCategories: "{n, plural, one {# item} other {# items}}",
	badCategory: "{n, plural, one {# item} other {# items}}",
	multi: `{g, select,
		male {He {x}}
		female {She}
		other {They}
	}`,
	title: "Dashboard",
	onlyInSource: "This message is missing from fr-ca",
	dup: "Original",
};
