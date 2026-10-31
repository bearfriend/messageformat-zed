// Quick fixes: a diagnostic (document offsets) in, text edits (document offsets) out.
// Pure and free of LSP types, like analyze.js, so every fix can be tested by applying it and re-analysing.
import { parse } from '@formatjs/icu-messageformat-parser';
import { formatMessageSync } from 'messageformat-validator';
import { entryAt, escapeRunsOf, semanticIssues } from './analyze.js';

const NBSP = '\u00a0';
export const TRANSLATED_MARKER = 'mfv-translated;';

/** Applies edits (`{ start, end, newText }`, offsets into `contents`); they must not overlap. */
export function applyEdits(contents, edits) {
	return edits
		.toSorted((a, b) => b.start - a.start)
		.reduce((text, { start, end, newText }) => text.slice(0, start) + newText + text.slice(end), contents);
}

function replaceNbsp(contents, { start, end }) {
	if (contents.slice(start, end) !== NBSP) return [];
	return [{
		title: 'Replace non-breaking space with a space',
		edits: [{ start, end, newText: ' ' }],
	}];
}

/** Offset of the end of the line containing `offset`, before its `\r\n` or `\n`. */
function endOfLine(contents, offset) {
	const newline = contents.indexOf('\n', offset);
	const end = newline === -1 ? contents.length : newline;
	return contents[end - 1] === '\r' ? end - 1 : end;
}

function markTranslated(contents, { end }) {
	const eol = endOfLine(contents, end);
	const title = `Mark as sufficiently translated (${TRANSLATED_MARKER})`;
	// Everything after the message on its line is the entry's "comment" as far as mfv is concerned,
	// so an existing `//` comment gets the marker at its start rather than a second comment being added.
	const slashes = contents.slice(end, eol).indexOf('//');
	if (slashes === -1) {
		return [{ title, edits: [{ start: eol, end: eol, newText: ` // ${TRANSLATED_MARKER}` }] }];
	}
	const afterSlashes = end + slashes + 2;
	const gap = /^[ \t]*/.exec(contents.slice(afterSlashes, eol))[0].length;
	const textStart = afterSlashes + gap;
	if (textStart === eol) {
		return [{ title, edits: [{ start: afterSlashes, end: eol, newText: ` ${TRANSLATED_MARKER}` }] }];
	}
	const newText = gap > 0 ? `${TRANSLATED_MARKER} ` : ` ${TRANSLATED_MARKER} `;
	return [{ title, edits: [{ start: textStart, end: textStart, newText }] }];
}

/** Closes the run that `start` is the apostrophe of: a one-character edit, so it works on a message that does not parse. */
function closeEscapeRun(contents, { start, entry }) {
	const run = entry && escapeRunsOf(entry).find(candidate => candidate.start === start);
	if (!run) return [];
	return [{
		title: `Close the escape run with “'”`,
		edits: [{ start: run.closeAt, end: run.closeAt, newText: run.closer }],
	}];
}

// --- Fixes that remove or add whole entries ----------------------------------------------------

const startOfLine = (contents, offset) => contents.lastIndexOf('\n', offset - 1) + 1;
const eolOf = contents => contents.includes('\r\n') ? '\r\n' : '\n';

/**
 * The edit that deletes the lines of the entry spanning `entryStart` to `entryEnd`, or nothing if it shares its line with other code.
 * In JSON the entry before the last one must also lose its comma, as the one it had is now the last.
 */
function removeLines(contents, { entryStart, entryEnd, comma, json }, title) {
	const start = startOfLine(contents, entryStart);
	if (/\S/.test(contents.slice(start, entryStart))) return [];
	const end = contents.startsWith('\r\n', entryEnd) ? entryEnd + 2 : contents.startsWith('\n', entryEnd) ? entryEnd + 1 : entryEnd;
	const edits = [{ start, end, newText: '' }];
	if (json && !comma) {
		const before = contents.slice(0, start).trimEnd();
		if (before.endsWith(',')) edits.unshift({ start: before.length - 1, end: before.length, newText: '' });
	}
	return [{ title, edits }];
}

function removeExtraneous(contents, { entry, json }) {
	return entry ? removeLines(contents, { ...entry, json }, 'Remove this message, which the source does not have') : [];
}

function removeDuplicate(contents, { entryStart, json }) {
	const found = entryStart === undefined ? undefined : entryAt(contents, entryStart);
	return found ? removeLines(contents, { entryStart, entryEnd: found.end, comma: found.comma, json }, 'Remove this duplicate message') : [];
}

/**
 * Copies the messages that the source has and the document lacks (see `copyPlan` in analyze.js).
 * Every copy ends with a comma, except in JSON the last one when nothing follows it.
 */
function copyMissing(contents, { copy, json }) {
	if (!copy) return [];
	const eol = eolOf(contents);
	let indent = '\t';
	if (copy.first) {
		const lead = contents.slice(startOfLine(contents, copy.first.entryStart), copy.first.entryStart);
		if (/^[ \t]*$/.test(lead)) indent = lead;
	}
	const linesOf = (texts, nothingFollows) => texts.map((text, i) => indent + text + (json && nothingFollows && i === texts.length - 1 ? '' : ','));
	const edits = [];
	for (const { after, texts } of copy.groups) {
		if (after) {
			const closeQuote = after.end + after.quote.length;
			const comma = contents[closeQuote] === ',' ? '' : ',';
			// A JSON entry with no comma is the last one: what is added goes at the end of the object.
			const addition = eol + linesOf(texts, !after.comma).join(eol);
			if (comma && closeQuote === after.entryEnd) {
				edits.push({ start: closeQuote, end: closeQuote, newText: comma + addition });
			}
			else {
				if (comma) edits.push({ start: closeQuote, end: closeQuote, newText: comma });
				edits.push({ start: after.entryEnd, end: after.entryEnd, newText: addition });
			}
		}
		else if (copy.first) {
			const start = startOfLine(contents, copy.first.entryStart);
			if (start !== copy.first.entryStart - indent.length) return [];
			edits.push({ start, end: start, newText: linesOf(texts, false).map(line => line + eol).join('') });
		}
		else {
			// No entries at all: go right after the brace that opens the object.
			const brace = contents.indexOf('{');
			if (brace === -1) return [];
			const newline = contents.indexOf('\n', brace);
			const restOfLine = contents.slice(brace + 1, newline === -1 ? undefined : newline);
			edits.push({ start: brace + 1, end: brace + 1, newText: eol + linesOf(texts, true).join(eol) + (/\S/.test(restOfLine) ? eol : '') });
		}
	}
	const title = copy.count === 1
		? `Add the missing message, copied from ${copy.locale}`
		: `Add the ${copy.count} missing messages, copied from ${copy.locale}`;
	return [{ title, edits }];
}

// --- Fixes that rewrite a whole message with mfv's formatter -----------------------------------
//
// The formatter rebuilds a message from its parsed form, so a fix asks for just one rewrite
// (`essentials: false` plus the option that does it) and is only offered if re-checking the new
// message shows the problem gone and no new kind of error.

const unescapeMessage = (message, quote) => message.replaceAll(`\\${quote}`, quote);
const escapeMessage = (message, quote) => message.replaceAll(quote, `\\${quote}`);

const issueCount = (issues, type) => issues.filter(issue => issue.type === type).length;

const meaningOf = message => JSON.stringify(parse(message, { requiresOtherClause: false }));

/**
 * Whether the formatter reprints `message` as the same thing, which it does not for some messages
 * (it drops the currency in `::currency/USD`, and turns a quoted `'#'` in a plural into a placeholder).
 * Different spelling of the same message, like `''` for `'`, is fine.
 */
function reprintsFaithfully(message, locale) {
	const { message: reprinted, error } = formatMessageSync(message, { locale, essentials: false });
	if (error) return false;
	try {
		return meaningOf(reprinted) === meaningOf(message);
	}
	catch {
		return false; // the reprint, or the original, is not even parseable
	}
}

/**
 * The edit that replaces an entry's message with `options`-formatted text, or nothing when the formatter
 * cannot be trusted with the message, the result is unchanged, it still has any of the `resolves` issue types,
 * or it has more errors of some type than before.
 */
function formatEntry(entry, options, resolves, { useSource = false } = {}) {
	const { message, quote, locale, source, key, baseTabs } = entry;
	const unescaped = unescapeMessage(message, quote);
	if (!reprintsFaithfully(unescaped, locale)) return [];
	const result = formatMessageSync(unescaped, {
		locale,
		sourceLocale: useSource ? source?.locale : undefined,
		source: useSource ? source?.message : undefined,
		key,
		baseTabs,
		...options,
	});
	if (result.error) return [];

	const formatted = escapeMessage(result.message, quote);
	if (formatted === message) return [];

	const check = { locale, source, overrides: entry.overrides };
	const before = semanticIssues({ ...check, message });
	const after = semanticIssues({ ...check, message: formatted });
	const regressed = after.some(issue => issue.severity === 'error' && issueCount(after, issue.type) > issueCount(before, issue.type));
	if (regressed || resolves.some(type => issueCount(after, type) > 0)) return [];

	return [{ start: entry.start, end: entry.end, newText: formatted }];
}

const ONLY = { essentials: false };

const rewrite = (title, options, resolves, formatOptions) => (contents, { entry }) => {
	const edits = entry ? formatEntry(entry, { ...ONLY, ...options }, resolves, formatOptions) : [];
	return edits.length ? [{ title, edits }] : [];
};

// Only this fix compares with the source message, as `mfv format` does only with `-c`.
const correctArguments = rewrite('Correct argument names using the source message', {}, ['argument'], { useSource: true });

const addCategories = rewrite('Add missing plural categories', { add: true, sort: true }, []);
// `add` copies the case it adds from the message's own `other` (or last) case. It adds plural categories as well as select options.
const addOther = rewrite('Add missing cases', { add: true, sort: true }, ['other']);
// The source is for the options only. Argument names are the `argument` fix's business, so they are left as they are.
const addSourceOptions = rewrite('Add options that the source message has', { add: true, sort: true, correct: false }, ['option-missing'], { useSource: true });

const renameCategory = rewrite('Rename unsupported plural category', { renameCategories: true }, ['category']);
const removeCategories = rewrite('Remove unsupported plural categories', { remove: true }, ['category']);
const renameOrRemoveCategory = (contents, diagnostic) => [
	...renameCategory(contents, diagnostic),
	...removeCategories(contents, diagnostic),
];

/** Offered for every message, whether or not it has a diagnostic: mfv's default formatting. */
export function rewritesFor(entry) {
	const edits = formatEntry(entry, {}, []);
	return edits.length ? [{ title: 'Format message with mfv', kind: 'refactor.rewrite', edits }] : [];
}

const FIXES = {
	nbsp: replaceNbsp,
	// JSON has no comments to put the marker in.
	untranslated: (contents, diagnostic) => diagnostic.json ? [] : markTranslated(contents, diagnostic),
	escape: closeEscapeRun,
	extraneous: removeExtraneous,
	duplicate: removeDuplicate,
	missing: copyMissing,
	argument: correctArguments,
	category: renameOrRemoveCategory,
	'category-missing': addCategories,
	other: addOther,
	'option-missing': addSourceOptions,
};

/**
 * @param {string} contents the document the diagnostic was produced from
 * @param {{ start: number, end: number, code: string }} diagnostic
 * @returns {{ title: string, edits: { start: number, end: number, newText: string }[] }[]}
 */
export function fixesFor(contents, diagnostic) {
	return FIXES[diagnostic.code]?.(contents, diagnostic) ?? [];
}
