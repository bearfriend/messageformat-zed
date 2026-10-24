// Pure analysis: MessageFormat resource text in, diagnostics (document offsets) out.
// No LSP types here so everything can be unit-tested directly.
import { parse } from '@formatjs/icu-messageformat-parser';
import { structureRegEx, validateMessage } from 'messageformat-validator';

// `parseLocales` is not part of messageformat-validator's public `exports`, so import it by file URL.
const { parseLocales } = await import(new URL('./validate.js', import.meta.resolve('messageformat-validator')));

export const DEFAULT_LOCALE = 'en';

const NBSP = '\u00a0';

const SYNTAX_MESSAGES = {
	EXPECT_ARGUMENT_CLOSING_BRACE: 'Expected "}" to close the argument',
	EXPECT_ARGUMENT_NAME: 'Expected an argument name after "{"',
	EXPECT_ARGUMENT_TYPE: 'Expected an argument type (number, date, time, plural, select, selectordinal)',
	EXPECT_PLURAL_ARGUMENT_SELECTOR: 'Expected a plural category or "=N" selector',
	EXPECT_SELECT_ARGUMENT_SELECTOR: 'Expected a select key',
	EXPECT_SELECT_ARGUMENT_OPTIONS: 'Expected "," followed by select options',
	EXPECT_PLURAL_ARGUMENT_OPTIONS: 'Expected "," followed by plural options',
	INVALID_TAG: 'Invalid tag',
	UNCLOSED_TAG: 'Unclosed tag',
	UNMATCHED_CLOSING_TAG: 'Closing tag has no matching opening tag',
};

/**
 * The locale that plural rules should use, taken from the file name the way
 * messageformat-validator does (`fr-ca.mf.js` -> `fr-ca`). Falls back to
 * `fallback` when the name is not a locale Intl knows about (`messages.mf.js`).
 */
export function localeFromFileName(fileName, fallback = DEFAULT_LOCALE) {
	const base = decodeURIComponent(String(fileName).split(/[\\/]/).pop() ?? '');
	const candidate = base.split('.')[0];
	try {
		if (candidate && Intl.PluralRules.supportedLocalesOf([candidate]).length) {
			return candidate;
		}
	}
	catch {
		// Not a well-formed language tag.
	}
	return fallback;
}

/** Where each parsed entry's key and value text sit in the document. */
function valueRanges(contents, parsed) {
	const ranges = new Map();
	let cursor = 0;
	for (const [key, entry] of Object.entries(parsed)) {
		const text = String(entry);
		const at = contents.indexOf(text, cursor);
		if (at === -1) continue;
		cursor = at + text.length;
		const lead = text.match(/^\s*/)[0].length;
		const keyStart = at + lead + entry.keyQuote.length;
		const start = at
			+ lead
			+ entry.keyQuote.length * 2
			+ entry.key.length
			+ entry.keySpace.length
			+ 1 // ":"
			+ entry.valSpace.length
			+ entry.valQuote.length;
		ranges.set(key, {
			key,
			keyStart,
			keyEnd: keyStart + entry.key.length,
			start,
			end: start + entry.val.length,
			message: entry.val,
			comment: entry.comment ?? '',
		});
	}
	return ranges;
}

function escapeRegExp(s) {
	return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Every later occurrence of each duplicated key (the first one is the "real" one). */
function duplicateKeyRanges(contents, duplicateKeys) {
	const found = [];
	for (const key of duplicateKeys) {
		const re = new RegExp(`(?<=^|\\s)(["'\`]?)(${escapeRegExp(key)})\\1\\s*:\\s*["'\`]`, 'gm');
		const hits = Array.from(contents.matchAll(re));
		for (const hit of hits.slice(1)) {
			const start = hit.index + hit[1].length;
			found.push({ key, start, end: start + key.length });
		}
	}
	return found;
}

function nbspRanges(message) {
	const found = [];
	for (const match of message.matchAll(structureRegEx)) {
		let at = match[0].indexOf(NBSP);
		while (at !== -1) {
			found.push({ start: match.index + at, end: match.index + at + 1 });
			at = match[0].indexOf(NBSP, at + 1);
		}
	}
	return found;
}

function syntaxError(message, error) {
	const code = error.message;
	const text = SYNTAX_MESSAGES[code]
		?? code.charAt(0) + code.slice(1).toLowerCase().replaceAll('_', ' ');
	const start = error.location?.start.offset ?? 0;
	let end = error.location?.end.offset ?? start + 1;
	// Multi-line messages: keep the squiggle on the line where the problem starts.
	const newline = message.indexOf('\n', start);
	if (newline !== -1 && newline < end) end = newline;
	if (end <= start) end = Math.min(start + 1, message.length);
	return { start, end, code, text };
}

function semanticIssues({ message, locale, source, overrides }) {
	const issues = [];
	const record = (severity) => (type, text, position) => issues.push({ severity, type, text, position });
	const reporter = { error: record('error'), warning: record('warning'), config() {} };
	try {
		// Without a source file the message is its own source. That makes the comparison checks
		// (argument, option, untranslated, split) trivially clean and leaves `other`,
		// `category-missing` and `category`.
		validateMessage({
			targetMessage: message,
			targetLocale: locale,
			sourceMessage: source ? source.message : message,
			sourceLocale: source?.locale,
			overrides,
		}, reporter);
	}
	catch {
		// A validator crash must never take the server down; the syntax pass still reports.
	}
	return issues;
}

const MAX_LISTED_KEYS = 8;

function missingMessage(keys, sourceLocale) {
	const listed = keys.slice(0, MAX_LISTED_KEYS).map(k => `"${k}"`).join(', ');
	const more = keys.length > MAX_LISTED_KEYS ? ` and ${keys.length - MAX_LISTED_KEYS} more` : '';
	return `${keys.length} ${keys.length === 1 ? 'message is' : 'messages are'} missing compared to ${sourceLocale}: ${listed}${more}`;
}

/**
 * @param {string} contents full document text
 * @param {string} fileName used only to pick the plural-rule locale
 * @param {{ defaultLocale?: string, source?: { locale: string, contents: string } }} [options]
 *   `source` is the source-locale file; with it, messages are also compared against their source.
 * @returns {{ start: number, end: number, severity: 'error' | 'warning', code: string, message: string }[]}
 */
export function analyze(contents, fileName, options = {}) {
	const locale = localeFromFileName(fileName, options.defaultLocale ?? DEFAULT_LOCALE);
	const file = `${locale}.mf.js`;
	const diagnostics = [];

	const { parsed, duplicateKeys } = parseLocales([{ contents, file }])[locale];
	const ranges = valueRanges(contents, parsed);
	const sourceParsed = options.source
		? parseLocales([{ contents: options.source.contents, file: `${options.source.locale}.mf.js` }])[options.source.locale].parsed
		: undefined;

	for (const { key, keyStart, keyEnd, start, end, message, comment } of ranges.values()) {
		const whole = { start, end: Math.max(end, start + 1) };
		const add = (severity, code, text, range = whole) =>
			diagnostics.push({ ...range, severity, code, message: text });

		const nbsps = nbspRanges(message);
		for (const range of nbsps) {
			add('error', 'nbsp', 'Non-breaking space in message structure', { start: start + range.start, end: start + range.end });
		}

		let syntaxFailed = false;
		try {
			parse(message, { captureLocation: true, requiresOtherClause: false });
		}
		catch (e) {
			syntaxFailed = true;
			const balanced = (message.match(/{/g)?.length ?? 0) === (message.match(/}/g)?.length ?? 0);
			if (!nbsps.length || !balanced) {
				const err = syntaxError(message, e);
				add('error', 'parse', err.text, { start: start + err.start, end: start + err.end });
			}
		}
		if (sourceParsed && !sourceParsed[key]) {
			add('error', 'extraneous', 'Message does not exist in the source locale', { start: keyStart, end: Math.max(keyEnd, keyStart + 1) });
		}
		if (syntaxFailed) continue;

		const source = sourceParsed?.[key]
			? { message: String(sourceParsed[key].val), locale: options.source.locale }
			: undefined;
		const overrides = Array.from(comment.matchAll(/mfv-(?<override>[a-z]+)/g), m => m.groups.override);

		for (const issue of semanticIssues({ message, locale, source, overrides })) {
			switch (issue.type) {
			case 'nbsp':
				break; // reported above with an exact position
			case 'source':
				add('warning', 'source', `The source message for "${key}" could not be parsed`);
				break;
			case 'category': {
				const name = issue.text.match(/Unsupported category "([^"]+)"/)?.[1];
				const at = name ? message.lastIndexOf(name, issue.position?.column) : -1;
				add(issue.severity, issue.type, issue.text, at === -1 ? whole : { start: start + at, end: start + at + name.length });
				break;
			}
			default:
				add(issue.severity, issue.type, issue.text);
			}
		}

	}

	for (const { key, start, end } of duplicateKeyRanges(contents, duplicateKeys)) {
		diagnostics.push({ start, end, severity: 'error', code: 'duplicate', message: `Duplicate key "${key}"` });
	}

	if (sourceParsed) {
		const missing = Object.keys(sourceParsed).filter(key => !(key in parsed));
		if (missing.length) {
			// One summary at the top of the file: a translation in progress can lack dozens of keys.
			const firstLine = contents.indexOf('\n');
			diagnostics.push({
				start: 0,
				end: firstLine === -1 ? contents.length : firstLine,
				severity: 'warning',
				code: 'missing',
				message: missingMessage(missing, options.source.locale),
			});
		}
	}

	return diagnostics.sort((a, b) => a.start - b.start);
}
