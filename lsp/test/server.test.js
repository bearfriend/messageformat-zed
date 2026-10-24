import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { test } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
