import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { test } from 'node:test';
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const server = fileURLToPath(new URL('../server.js', import.meta.url));

/** Minimal LSP client over stdio: just enough framing to drive the server. */
function startClient() {
	const child = spawn(process.execPath, [server, '--stdio'], { stdio: ['pipe', 'pipe', 'inherit'] });
	let buffer = Buffer.alloc(0);
	const waiting = [];
	const seen = [];

	child.stdout.on('data', (chunk) => {
		buffer = Buffer.concat([buffer, chunk]);
		for (;;) {
			const headerEnd = buffer.indexOf('\r\n\r\n');
			if (headerEnd === -1) return;
			const length = Number(/Content-Length: (\d+)/i.exec(buffer.subarray(0, headerEnd).toString())[1]);
			if (buffer.length < headerEnd + 4 + length) return;
			const message = JSON.parse(buffer.subarray(headerEnd + 4, headerEnd + 4 + length).toString());
			buffer = buffer.subarray(headerEnd + 4 + length);
			seen.push(message);
			for (const w of [...waiting]) {
				if (w.match(message)) {
					waiting.splice(waiting.indexOf(w), 1);
					w.resolve(message);
				}
			}
		}
	});

	const send = (message) => {
		const body = JSON.stringify({ jsonrpc: '2.0', ...message });
		child.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
	};

	return {
		send,
		child,
		/** Resolves with the next matching message; `fresh` ignores messages that already arrived. */
		next(match, ms = 5000, fresh = false) {
			const already = fresh ? undefined : seen.find(match);
			if (already) return Promise.resolve(already);
			return new Promise((resolve, reject) => {
				const timer = setTimeout(() => reject(new Error('timed out waiting for server message')), ms);
				waiting.push({ match, resolve: (m) => { clearTimeout(timer); resolve(m); } });
			});
		},
		async stop() {
			send({ id: 99, method: 'shutdown' });
			await this.next(m => m.id === 99);
			send({ method: 'exit' });
			await new Promise(resolve => child.once('exit', resolve));
		},
	};
}

const diagnosticsFor = (uri) => (m) => m.method === 'textDocument/publishDiagnostics' && m.params.uri === uri;

test('server publishes diagnostics with line/column ranges, updates on edit, and clears on close', async () => {
	const client = startClient();
	const uri = 'file:///project/lang/fr-ca.mf.js';
	try {
		client.send({ id: 1, method: 'initialize', params: { processId: null, rootUri: null, capabilities: {} } });
		const init = await client.next(m => m.id === 1);
		assert.equal(init.result.serverInfo.name, 'messageformat-language-server');
		client.send({ method: 'initialized', params: {} });

		const text = 'export default {\n\tgreeting: "Hello {name",\n\titems: "{n, plural, one {# a} other {# b}}",\n};\n';
		client.send({ method: 'textDocument/didOpen', params: { textDocument: { uri, languageId: 'MessageFormat', version: 1, text } } });
		const opened = (await client.next(diagnosticsFor(uri))).params;
		assert.equal(opened.version, 1);
		const byCode = Object.fromEntries(opened.diagnostics.map(d => [d.code, d]));
		// Line 1 (0-based), `{name` starts after `\tgreeting: "Hello ` (col 18) and is 5 chars long.
		assert.deepEqual(byCode.parse.range, { start: { line: 1, character: 18 }, end: { line: 1, character: 23 } });
		assert.equal(byCode.parse.severity, 1);
		assert.equal(byCode.parse.source, 'messageformat');
		// fr-ca locale is applied from the file name: the plural is missing `many`
		assert.equal(byCode['category-missing'].severity, 2);
		assert.equal(byCode['category-missing'].range.start.line, 2);

		// Fix the first message with an incremental edit: the parse error disappears.
		client.send({
			method: 'textDocument/didChange',
			params: {
				textDocument: { uri, version: 2 },
				contentChanges: [{ range: { start: { line: 1, character: 23 }, end: { line: 1, character: 23 } }, text: '}' }],
			},
		});
		const edited = (await client.next(m => diagnosticsFor(uri)(m) && m.params.version === 2)).params;
		assert.deepEqual(edited.diagnostics.map(d => d.code), ['category-missing']);

		client.send({ method: 'textDocument/didClose', params: { textDocument: { uri } } });
		const closed = await client.next(m => diagnosticsFor(uri)(m) && m.params.diagnostics.length === 0 && m.params.version === undefined);
		assert.deepEqual(closed.params.diagnostics, []);
	}
	finally {
		await client.stop();
	}
});

test('server compares against the source file on disk, prefers its open buffer, and revalidates dependants', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'mf-server-'));
	const wrap = (...entries) => `export default {\n${entries.map(e => `\t${e},\n`).join('')}};\n`;
	const enText = wrap('hello: "Hello {name}"', 'bye: "Goodbye"');
	writeFileSync(join(dir, 'en.mf.js'), enText);
	const frText = wrap('hello: "Bonjour {nom}"', 'extra: "Plus"');
	writeFileSync(join(dir, 'fr.mf.js'), frText);
	const enUri = pathToFileURL(join(dir, 'en.mf.js')).href;
	const frUri = pathToFileURL(join(dir, 'fr.mf.js')).href;

	const client = startClient();
	try {
		client.send({ id: 1, method: 'initialize', params: { processId: null, rootUri: null, capabilities: {} } });
		await client.next(m => m.id === 1);
		client.send({ method: 'initialized', params: {} });

		// Only fr is open: its source (en) is read from disk.
		client.send({ method: 'textDocument/didOpen', params: { textDocument: { uri: frUri, languageId: 'MessageFormat', version: 1, text: frText } } });
		const first = (await client.next(diagnosticsFor(frUri))).params;
		const codes = first.diagnostics.map(d => d.code).sort();
		assert.deepEqual(codes, ['argument', 'extraneous', 'missing']);
		const extraneous = first.diagnostics.find(d => d.code === 'extraneous');
		assert.deepEqual(extraneous.range, { start: { line: 2, character: 1 }, end: { line: 2, character: 6 } });

		// Open en with a changed buffer (not saved): fr must be compared against the buffer, not the disk copy.
		const bufferText = wrap('hello: "Hello {nom}"', 'extra: "More"');
		client.send({ method: 'textDocument/didOpen', params: { textDocument: { uri: enUri, languageId: 'MessageFormat', version: 1, text: bufferText } } });
		const revalidated = (await client.next(diagnosticsFor(frUri), 5000, true)).params;
		assert.deepEqual(revalidated.diagnostics.map(d => d.code), [], 'fr is clean against the unsaved en buffer');

		// Editing the source revalidates the translation that depends on it.
		client.send({
			method: 'textDocument/didChange',
			params: { textDocument: { uri: enUri, version: 2 }, contentChanges: [{ text: wrap('hello: "Hello {name}"', 'extra: "More"') }] },
		});
		const afterEdit = (await client.next(diagnosticsFor(frUri), 5000, true)).params;
		assert.deepEqual(afterEdit.diagnostics.map(d => d.code), ['argument'], '{nom} no longer matches the source argument');
	}
	finally {
		await client.stop();
		rmSync(dir, { recursive: true, force: true });
	}
});

test('initializationOptions.compareToSource=false skips source comparison but keeps standalone checks', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'mf-server-'));
	const wrap = (...entries) => `export default {\n${entries.map(e => `\t${e},\n`).join('')}};\n`;
	writeFileSync(join(dir, 'en.mf.js'), wrap('hello: "Hello {name}"', 'bye: "Goodbye"', 'items: "{n, plural, one {# a} other {# b}}"'));
	// Differs from the source (argument, missing, extraneous) and has a plural without `many` for fr.
	const frText = wrap('hello: "Bonjour {nom}"', 'extra: "Plus"', 'items: "{n, plural, one {# article} other {# articles}}"');
	writeFileSync(join(dir, 'fr.mf.js'), frText);
	const frUri = pathToFileURL(join(dir, 'fr.mf.js')).href;

	const run = async (initializationOptions) => {
		const client = startClient();
		try {
			client.send({ id: 1, method: 'initialize', params: { processId: null, rootUri: null, capabilities: {}, initializationOptions } });
			await client.next(m => m.id === 1);
			client.send({ method: 'initialized', params: {} });
			client.send({ method: 'textDocument/didOpen', params: { textDocument: { uri: frUri, languageId: 'MessageFormat', version: 1, text: frText } } });
			return (await client.next(diagnosticsFor(frUri))).params.diagnostics.map(d => d.code).sort();
		}
		finally {
			await client.stop();
		}
	};

	try {
		assert.deepEqual(await run({}), ['argument', 'category-missing', 'extraneous', 'missing'], 'comparison is on by default');
		assert.deepEqual(await run({ compareToSource: true }), ['argument', 'category-missing', 'extraneous', 'missing']);
		assert.deepEqual(await run({ compareToSource: false }), ['category-missing']);
		assert.deepEqual(await run({ compareToSource: 'no' }), ['argument', 'category-missing', 'extraneous', 'missing'], 'only a literal false disables it');
		assert.deepEqual(await run({ compareToSource: 0 }), ['argument', 'category-missing', 'extraneous', 'missing'], 'other falsy values do not disable it');
	}
	finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

// --- Source files changing on disk -------------------------------------------------------------

const wrapEntries = (...entries) => `export default {\n${entries.map(e => `\t${e},\n`).join('')}};\n`;
const codesOf = (message) => message.params.diagnostics.map(d => d.code).sort();
const withCodes = (uri, expected) => (m) => diagnosticsFor(uri)(m) && JSON.stringify(codesOf(m)) === JSON.stringify(expected);
const quiet = (client, uri, ms = 800) => client.next(diagnosticsFor(uri), ms, true).then(
	(m) => { throw new Error(`unexpected diagnostics for ${uri}: ${JSON.stringify(codesOf(m))}`); },
	() => undefined,
);

async function withWatchedFixture(files, body) {
	const dir = mkdtempSync(join(tmpdir(), 'mf-watch-'));
	for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
	const client = startClient();
	try {
		client.send({ id: 1, method: 'initialize', params: { processId: null, rootUri: null, capabilities: {} } });
		await client.next(m => m.id === 1);
		client.send({ method: 'initialized', params: {} });
		const open = (name, version = 1, text = files[name]) => {
			const uri = pathToFileURL(join(dir, name)).href;
			client.send({ method: 'textDocument/didOpen', params: { textDocument: { uri, languageId: 'MessageFormat', version, text } } });
			return uri;
		};
		await body({ client, dir, open, uriOf: name => pathToFileURL(join(dir, name)).href });
	}
	finally {
		await client.stop();
		rmSync(dir, { recursive: true, force: true });
	}
}

test('a source file changed on disk revalidates the open translations that depend on it', async () => {
	const fr = wrapEntries('hello: "Bonjour {nom}"');
	await withWatchedFixture({ 'en.mf.js': wrapEntries('hello: "Hello {nom}"'), 'fr.mf.js': fr }, async ({ client, dir, open }) => {
		const frUri = open('fr.mf.js');
		await client.next(withCodes(frUri, []));

		writeFileSync(join(dir, 'en.mf.js'), wrapEntries('hello: "Hello {name}"'));
		await client.next(withCodes(frUri, ['argument']), 3000, true);

		// Atomic save (write a temp file, rename over the source), as most editors do.
		writeFileSync(join(dir, 'en.tmp'), wrapEntries('hello: "Hello {nom}"'));
		renameSync(join(dir, 'en.tmp'), join(dir, 'en.mf.js'));
		await client.next(withCodes(frUri, []), 3000, true);
	});
});

test('a source file that appears, or a config added, on disk is picked up', async () => {
	const fr = wrapEntries('hello: "Bonjour {nom}"', 'extra: "Plus"');
	await withWatchedFixture({ 'fr.mf.js': fr }, async ({ client, dir, open }) => {
		const frUri = open('fr.mf.js');
		await client.next(withCodes(frUri, []));

		writeFileSync(join(dir, 'en.mf.js'), wrapEntries('hello: "Hello {nom}"'));
		await client.next(withCodes(frUri, ['extraneous']), 3000, true);

		// A config naming another source switches the comparison.
		writeFileSync(join(dir, 'de.mf.js'), wrapEntries('hello: "Hallo {name}"', 'extra: "Mehr"'));
		writeFileSync(join(dir, 'mfv.config.json'), JSON.stringify({ source: 'de' }));
		await client.next(withCodes(frUri, ['argument']), 3000, true);
	});
});

test('disk changes do not override a source that is open in a buffer, or touch closed documents', async () => {
	const files = { 'en.mf.js': wrapEntries('hello: "Hello {nom}"'), 'fr.mf.js': wrapEntries('hello: "Bonjour {nom}"') };
	await withWatchedFixture(files, async ({ client, dir, open, uriOf }) => {
		const frUri = open('fr.mf.js');
		await client.next(withCodes(frUri, []));
		open('en.mf.js');
		await client.next(withCodes(frUri, []), 3000, true);

		// en is open and unchanged in the editor, so its buffer wins over what is on disk.
		writeFileSync(join(dir, 'en.mf.js'), wrapEntries('hello: "Hello {name}"'));
		await quiet(client, frUri);

		client.send({ method: 'textDocument/didClose', params: { textDocument: { uri: uriOf('fr.mf.js') } } });
		await client.next(m => diagnosticsFor(frUri)(m) && m.params.version === undefined, 3000, true);
		writeFileSync(join(dir, 'en.mf.js'), wrapEntries('hello: "Hello {other}"'));
		await quiet(client, frUri);
	});
});

test('compareToSource=false never watches the disk', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'mf-watch-'));
	writeFileSync(join(dir, 'en.mf.js'), wrapEntries('hello: "Hello {nom}"'));
	const frText = wrapEntries('hello: "Bonjour {nom}"');
	const frUri = pathToFileURL(join(dir, 'fr.mf.js')).href;
	const client = startClient();
	try {
		client.send({ id: 1, method: 'initialize', params: { processId: null, rootUri: null, capabilities: {}, initializationOptions: { compareToSource: false } } });
		await client.next(m => m.id === 1);
		client.send({ method: 'initialized', params: {} });
		client.send({ method: 'textDocument/didOpen', params: { textDocument: { uri: frUri, languageId: 'MessageFormat', version: 1, text: frText } } });
		await client.next(withCodes(frUri, []));
		writeFileSync(join(dir, 'en.mf.js'), wrapEntries('hello: "Hello {name}"'));
		await quiet(client, frUri);
	}
	finally {
		await client.stop();
		rmSync(dir, { recursive: true, force: true });
	}
});

test('a config in a parent directory is watched too', async () => {
	const root = mkdtempSync(join(tmpdir(), 'mf-watch-'));
	const dir = join(root, 'lang');
	mkdirSync(dir);
	writeFileSync(join(root, 'mfv.config.json'), JSON.stringify({ source: 'de' }));
	writeFileSync(join(dir, 'de.mf.js'), wrapEntries('hello: "Hallo {name}"'));
	writeFileSync(join(dir, 'en.mf.js'), wrapEntries('hello: "Hello {nom}"'));
	const fr = wrapEntries('hello: "Bonjour {nom}"');
	const frUri = pathToFileURL(join(dir, 'fr.mf.js')).href;
	const client = startClient();
	try {
		client.send({ id: 1, method: 'initialize', params: { processId: null, rootUri: null, capabilities: {} } });
		await client.next(m => m.id === 1);
		client.send({ method: 'initialized', params: {} });
		client.send({ method: 'textDocument/didOpen', params: { textDocument: { uri: frUri, languageId: 'MessageFormat', version: 1, text: fr } } });
		await client.next(withCodes(frUri, ['argument']));

		writeFileSync(join(root, 'mfv.config.json'), JSON.stringify({ source: 'en' }));
		await client.next(withCodes(frUri, []), 3000, true);
	}
	finally {
		await client.stop();
		rmSync(root, { recursive: true, force: true });
	}
});

test('watchers are released once the last document depending on a directory closes', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'mf-watch-'));
	const logPath = join(dir, 'server.log');
	writeFileSync(join(dir, 'en.mf.js'), wrapEntries('hello: "Hello"'));
	const frText = wrapEntries('hello: "Bonjour"');
	writeFileSync(join(dir, 'fr.mf.js'), frText);
	const frUri = pathToFileURL(join(dir, 'fr.mf.js')).href;
	const previous = process.env.MESSAGEFORMAT_LS_LOG;
	process.env.MESSAGEFORMAT_LS_LOG = logPath;
	const client = startClient();
	process.env.MESSAGEFORMAT_LS_LOG = previous;
	if (previous === undefined) delete process.env.MESSAGEFORMAT_LS_LOG;
	const lines = () => readFileSync(logPath, 'utf8').split('\n');
	try {
		client.send({ id: 1, method: 'initialize', params: { processId: null, rootUri: null, capabilities: {} } });
		await client.next(m => m.id === 1);
		client.send({ method: 'initialized', params: {} });
		client.send({ method: 'textDocument/didOpen', params: { textDocument: { uri: frUri, languageId: 'MessageFormat', version: 1, text: frText } } });
		await client.next(diagnosticsFor(frUri));
		assert.equal(lines().filter(l => l.endsWith(`watching ${dir}`)).length, 1);
		assert.equal(lines().filter(l => l.endsWith(`unwatched ${dir}`)).length, 0);

		client.send({ method: 'textDocument/didClose', params: { textDocument: { uri: frUri } } });
		await client.next(m => diagnosticsFor(frUri)(m) && m.params.version === undefined, 3000, true);
		assert.equal(lines().filter(l => l.endsWith(`unwatched ${dir}`)).length, 1);
	}
	finally {
		await client.stop();
		rmSync(dir, { recursive: true, force: true });
	}
});

// --- Quick fixes ----------------------------------------------------------------------------------

/** Applies LSP TextEdits (single document) to `text`. */
function applyTextEdits(text, edits) {
	const lineStarts = [0];
	for (let i = 0; i < text.length; i++) if (text[i] === '\n') lineStarts.push(i + 1);
	const offset = ({ line, character }) => lineStarts[line] + character;
	return edits
		.toSorted((a, b) => offset(b.range.start) - offset(a.range.start))
		.reduce((t, e) => t.slice(0, offset(e.range.start)) + e.newText + t.slice(offset(e.range.end)), text);
}

test('code actions offer quick fixes for nbsp and untranslated diagnostics', async () => {
	const lines = (...entries) => `export default {\n${entries.map(e => `\t${e}\n`).join('')}};\n`;
	const enText = lines('hello: "Hello",', 'items: "{n, plural, one {# a} other {# b}}",');
	const frText = lines('hello: "Hello",', 'items: "{n,\u00a0plural, one {# a} many {# b} other {# b}}",');
	await withWatchedFixture({ 'en.mf.js': enText, 'fr.mf.js': frText }, async ({ client, open, uriOf }) => {
		const frUri = open('fr.mf.js');
		const published = (await client.next(diagnosticsFor(frUri))).params.diagnostics;
		const byCode = Object.fromEntries(published.map(d => [d.code, d]));
		assert.ok(byCode.untranslated && byCode.nbsp, `got ${JSON.stringify(published.map(d => d.code))}`);

		const ask = async (id, range, diagnostics = []) => {
			client.send({ id, method: 'textDocument/codeAction', params: { textDocument: { uri: frUri }, range, context: { diagnostics } } });
			return (await client.next(m => m.id === id)).result;
		};

		// Cursor on the nbsp, with the client's diagnostic echoed back.
		const nbsp = await ask(10, byCode.nbsp.range, [byCode.nbsp]);
		assert.deepEqual(nbsp.map(a => a.title), ['Replace non-breaking space with a space']);
		assert.equal(nbsp[0].kind, 'quickfix');
		assert.deepEqual(nbsp[0].diagnostics.map(d => d.code), ['nbsp']);
		assert.equal(applyTextEdits(frText, nbsp[0].edit.changes[frUri]), frText.replace('{n,\u00a0plural', '{n, plural'));

		// A zero-width cursor inside the untranslated message, with no diagnostics from the client.
		const cursor = { line: byCode.untranslated.range.start.line, character: byCode.untranslated.range.start.character + 1 };
		const untranslated = await ask(11, { start: cursor, end: cursor });
		assert.deepEqual(untranslated.map(a => a.title), ['Mark as sufficiently translated (mfv-translated;)']);
		assert.equal(untranslated[0].diagnostics, undefined);
		assert.equal(applyTextEdits(frText, untranslated[0].edit.changes[frUri]), frText.replace('"Hello",', '"Hello", // mfv-translated;'));

		// A range that touches no fixable diagnostic.
		assert.deepEqual(await ask(12, { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } }), []);

		// A range spanning both returns both.
		const both = await ask(13, { start: { line: 0, character: 0 }, end: { line: 5, character: 0 } });
		assert.deepEqual(both.map(a => a.title).sort(), ['Mark as sufficiently translated (mfv-translated;)', 'Replace non-breaking space with a space']);

		// Unknown documents are not an error.
		client.send({ id: 14, method: 'textDocument/codeAction', params: { textDocument: { uri: uriOf('nope.mf.js') }, range: byCode.nbsp.range, context: { diagnostics: [] } } });
		assert.deepEqual((await client.next(m => m.id === 14)).result, []);
	});
});

test('the server advertises quick fix code actions', async () => {
	const client = startClient();
	try {
		client.send({ id: 1, method: 'initialize', params: { processId: null, rootUri: null, capabilities: {} } });
		const { result } = await client.next(m => m.id === 1);
		assert.deepEqual(result.capabilities.codeActionProvider, { codeActionKinds: ['quickfix', 'refactor.rewrite'] });
	}
	finally {
		await client.stop();
	}
});

test('code actions only attach the client diagnostic that has the same range', async () => {
	const text = 'export default {\n\ta: "{n,\u00a0plural,\u00a0one {x} other {y}}",\n};\n';
	await withWatchedFixture({ 'en.mf.js': text }, async ({ client, open, uriOf }) => {
		const uri = open('en.mf.js');
		const nbsps = (await client.next(diagnosticsFor(uri))).params.diagnostics.filter(d => d.code === 'nbsp');
		assert.equal(nbsps.length, 2);
		client.send({
			id: 20,
			method: 'textDocument/codeAction',
			params: { textDocument: { uri }, range: { start: nbsps[0].range.start, end: nbsps[1].range.end }, context: { diagnostics: [nbsps[1]] } },
		});
		const actions = (await client.next(m => m.id === 20)).result;
		assert.equal(actions.length, 2);
		assert.equal(actions[0].diagnostics, undefined, 'the first nbsp was not echoed by the client');
		assert.deepEqual(actions[1].diagnostics, [nbsps[1]]);
	});
});

test('code action requests are logged, so a missing lightbulb can be diagnosed from the log', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'mf-log-'));
	const logPath = join(dir, 'server.log');
	const text = 'export default {\n\ta: "{n,\u00a0plural, one {x} other {y}}",\n};\n';
	writeFileSync(join(dir, 'en.mf.js'), text);
	const uri = pathToFileURL(join(dir, 'en.mf.js')).href;
	const previous = process.env.MESSAGEFORMAT_LS_LOG;
	process.env.MESSAGEFORMAT_LS_LOG = logPath;
	const client = startClient();
	if (previous === undefined) delete process.env.MESSAGEFORMAT_LS_LOG;
	else process.env.MESSAGEFORMAT_LS_LOG = previous;
	try {
		client.send({ id: 1, method: 'initialize', params: { processId: null, rootUri: null, capabilities: {} } });
		await client.next(m => m.id === 1);
		client.send({ method: 'initialized', params: {} });
		client.send({ method: 'textDocument/didOpen', params: { textDocument: { uri, languageId: 'MessageFormat', version: 1, text } } });
		const { diagnostics } = (await client.next(diagnosticsFor(uri))).params;
		const nbsp = diagnostics.find(d => d.code === 'nbsp');
		client.send({ id: 2, method: 'textDocument/codeAction', params: { textDocument: { uri }, range: nbsp.range, context: { diagnostics: [nbsp, nbsp] } } });
		await client.next(m => m.id === 2);
		const line = readFileSync(logPath, 'utf8').split('\n').find(l => l.includes('codeAction'));
		assert.ok(line, 'a codeAction line is logged');
		assert.match(line, new RegExp(`codeAction ${uri.replaceAll('.', '\\.')} 1:8-1:9 \\(client sent 2 diagnostic\\(s\\)\\): 1 action\\(s\\)`));
	}
	finally {
		await client.stop();
		rmSync(dir, { recursive: true, force: true });
	}
});

// --- mfv-backed fixes -------------------------------------------------------------------------

const askForActions = (client, uri) => async (id, range, context = { diagnostics: [] }) => {
	client.send({ id, method: 'textDocument/codeAction', params: { textDocument: { uri }, range, context } });
	return (await client.next(m => m.id === id)).result;
};
const at = (line, character) => ({ start: { line, character }, end: { line, character } });

test('code actions correct argument names using the source file', async () => {
	const lines = (...entries) => `export default {\n${entries.map(e => `\t${e}\n`).join('')}};\n`;
	const enText = lines('hello: "Hello {name}",');
	const frText = lines('hello: "Bonjour {Name}",');
	await withWatchedFixture({ 'en.mf.js': enText, 'fr.mf.js': frText }, async ({ client, open }) => {
		const uri = open('fr.mf.js');
		const published = (await client.next(diagnosticsFor(uri))).params.diagnostics;
		const argument = published.find(d => d.code === 'argument');
		assert.ok(argument, `got ${JSON.stringify(published.map(d => d.code))}`);
		const actions = await askForActions(client, uri)(30, argument.range, { diagnostics: [argument] });
		const fix = actions.find(a => a.kind === 'quickfix');
		assert.equal(fix.title, 'Correct argument names using the source message');
		assert.deepEqual(fix.diagnostics, [argument]);
		assert.equal(applyTextEdits(frText, fix.edit.changes[uri]), lines('hello: "Bonjour {name}",'));
	});
});

test('code actions add the select options the source file has, and attach the diagnostic they fix', async () => {
	const lines = (...entries) => `export default {\n${entries.map(e => `\t${e}\n`).join('')}};\n`;
	const enText = lines('g: "{g, select, male {He} female {She} other {They}}",');
	const frText = lines('g: "{g, select, male {Il} other {Ils}}",');
	await withWatchedFixture({ 'en.mf.js': enText, 'fr.mf.js': frText }, async ({ client, open }) => {
		const uri = open('fr.mf.js');
		const published = (await client.next(diagnosticsFor(uri))).params.diagnostics;
		const missing = published.find(d => d.code === 'option-missing');
		assert.ok(missing, `got ${JSON.stringify(published.map(d => d.code))}`);
		const actions = await askForActions(client, uri)(31, missing.range, { diagnostics: [missing] });
		const fix = actions.find(a => a.title === 'Add options that the source message has');
		assert.ok(fix, `got ${JSON.stringify(actions.map(a => a.title))}`);
		assert.equal(fix.kind, 'quickfix');
		assert.deepEqual(fix.diagnostics, [missing]);
		assert.equal(applyTextEdits(frText, fix.edit.changes[uri]), lines('g: "{g, select, male {Il} female {Ils} other {Ils}}",'));
	});
});

test('code actions remove an extraneous or duplicate entry and copy a missing one, and attach the diagnostic they fix', async () => {
	const lines = (...entries) => `export default {\n${entries.map(e => `\t${e}\n`).join('')}};\n`;
	const enText = lines('hello: "Hello",', 'bye: "Bye",');
	const frText = lines('hello: "Bonjour",', 'old: "Ancien", // gone', 'hello: "Salut",');
	await withWatchedFixture({ 'en.mf.js': enText, 'fr.mf.js': frText }, async ({ client, open }) => {
		const uri = open('fr.mf.js');
		const published = (await client.next(diagnosticsFor(uri))).params.diagnostics;
		const ask = askForActions(client, uri);
		const fixFor = async (id, code, title) => {
			const diagnostic = published.find(d => d.code === code);
			assert.ok(diagnostic, `got ${JSON.stringify(published.map(d => d.code))}`);
			const actions = await ask(id, diagnostic.range, { diagnostics: [diagnostic] });
			const fix = actions.find(a => a.title === title);
			assert.ok(fix, `got ${JSON.stringify(actions.map(a => a.title))}`);
			assert.equal(fix.kind, 'quickfix');
			assert.deepEqual(fix.diagnostics, [diagnostic]);
			return applyTextEdits(frText, fix.edit.changes[uri]);
		};
		assert.equal(await fixFor(40, 'extraneous', 'Remove this message, which the source does not have'), lines('hello: "Bonjour",', 'hello: "Salut",'));
		assert.equal(await fixFor(41, 'duplicate', 'Remove this duplicate message'), lines('hello: "Bonjour",', 'old: "Ancien", // gone'));
		assert.equal(await fixFor(42, 'missing', 'Add the missing message, copied from en'), lines('hello: "Bonjour",', 'bye: "Bye",', 'old: "Ancien", // gone', 'hello: "Salut",'));
	});
});

test('a message mfv would reformat gets a rewrite action under the cursor, and only for clients that want it', async () => {
	const text = 'export default {\n\t"a": "It\'s {n, plural, other {x} one {y}}",\n\tb: "Hello",\n};\n';
	await withWatchedFixture({ 'en.mf.js': text }, async ({ client, open }) => {
		const uri = open('en.mf.js');
		assert.deepEqual((await client.next(diagnosticsFor(uri))).params.diagnostics, []);
		const ask = askForActions(client, uri);

		const inside = await ask(40, at(1, 12));
		assert.deepEqual(inside.map(a => [a.title, a.kind]), [['Format message with mfv', 'refactor.rewrite']]);
		assert.equal(inside[0].diagnostics, undefined);
		assert.equal(applyTextEdits(text, inside[0].edit.changes[uri]), text.replace('"It\'s {n, plural, other {x} one {y}}"', '"{n, plural, one {It\u2019s y} other {It\u2019s x}}"'));

		const line = text.split('\n')[1];
		const openQuote = line.indexOf('"a"'); // the key's own opening quote
		const closeQuote = line.lastIndexOf('"');
		assert.equal((await ask(46, at(1, openQuote))).length, 1, 'on the key\'s opening quote');
		assert.equal((await ask(47, at(1, closeQuote + 1))).length, 1, 'just after the closing quote');
		assert.deepEqual(await ask(48, at(1, openQuote - 1)), [], 'before the key');
		assert.deepEqual(await ask(49, at(1, closeQuote + 2)), [], 'after the comma');
		assert.deepEqual(await ask(41, at(2, 8)), [], 'an entry that is already formatted');
		assert.deepEqual(await ask(42, at(0, 3)), [], 'outside any entry');
		assert.deepEqual(await ask(43, at(1, 12), { diagnostics: [], only: ['quickfix'] }), []);
		assert.equal((await ask(44, at(1, 12), { diagnostics: [], only: ['refactor'] })).length, 1);
		assert.equal((await ask(45, at(1, 12), { diagnostics: [], only: ['source'] })).length, 0);
	});
});

test('the same fix is not offered twice when several diagnostics in a message call for it', async () => {
	const text = 'export default {\n\ta: "{n, plural, one {x} few {y} many {z} other {w}}",\n};\n';
	await withWatchedFixture({ 'en.mf.js': text }, async ({ client, open }) => {
		const uri = open('en.mf.js');
		const published = (await client.next(diagnosticsFor(uri))).params.diagnostics;
		assert.equal(published.filter(d => d.code === 'category').length, 2);
		const actions = await askForActions(client, uri)(50, { start: at(1, 0).start, end: at(1, 70).end });
		const titles = actions.filter(a => a.kind === 'quickfix').map(a => a.title);
		assert.deepEqual(titles, ['Remove unsupported plural categories']);
	});
});
