// Finds the source-locale file for a resource file, the way `mfv` does: the nearest
// `mfv.config.json` names a `source` locale, and the source file sits next to the target.
// Without a config the source defaults to `en`, then `en-us`, but only if such a file exists.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

export const CONFIG_NAME = 'mfv.config.json';
export const DEFAULT_SOURCES = ['en', 'en-us'];

// Extensions a resource file can have, most specific first.
const EXTENSIONS = ['.mf.js', '.mf', '.msg', '.messages', '.js'];

export const localeOf = fileName => basename(fileName).split('.')[0].toLowerCase();

/**
 * Nearest `mfv.config.json` at or above `dir`.
 * @returns {{ path: string, config: { source?: string, locales?: string[] } } | undefined}
 *   A config that exists but is not valid JSON is returned with an `error` and an empty config.
 */
export function findConfig(dir) {
	for (let current = dir; ; current = dirname(current)) {
		const path = join(current, CONFIG_NAME);
		if (existsSync(path)) {
			try {
				const config = JSON.parse(readFileSync(path, 'utf8'));
				return { path, config: config && typeof config === 'object' ? config : {} };
			}
			catch (error) {
				return { path, config: {}, error: error.message };
			}
		}
		if (dirname(current) === current) return undefined;
	}
}

function candidates(dir, locale) {
	let names;
	try {
		names = readdirSync(dir);
	}
	catch {
		return [];
	}
	return names.filter(name => localeOf(name) === locale);
}

/** Orders files so the one with the same extension as the target (then the most specific extension) comes first. */
function rank(name, targetName) {
	const extension = ext => EXTENSIONS.find(e => ext.endsWith(e)) ?? '';
	const own = extension(name);
	const wanted = extension(targetName);
	return (own === wanted ? 0 : 100) + (EXTENSIONS.indexOf(own) + 1 || 99);
}

/**
 * @param {string} filePath absolute path of the file being edited
 * @returns {{ locale: string, path: string, configPath?: string, configError?: string } | undefined}
 *   `undefined` when there is no source to compare against (or the file is itself the source).
 */
export function resolveSource(filePath) {
	const dir = dirname(filePath);
	const targetLocale = localeOf(filePath);
	const found = findConfig(dir);
	const configured = typeof found?.config.source === 'string' ? found.config.source.toLowerCase() : undefined;
	const allowed = Array.isArray(found?.config.locales) ? found.config.locales.map(l => String(l).toLowerCase()) : undefined;

	const locales = configured ? [configured] : DEFAULT_SOURCES;
	for (const locale of locales) {
		const files = candidates(dir, locale).sort((a, b) => rank(a, basename(filePath)) - rank(b, basename(filePath)));
		if (!files.length) continue;
		if (locale === targetLocale) return undefined;
		// mfv only validates the locales listed in the config (plus the source).
		if (allowed && !allowed.includes(targetLocale)) return undefined;
		return { locale, path: join(dir, files[0]), configPath: found?.path, configError: found?.error };
	}
	return undefined;
}
