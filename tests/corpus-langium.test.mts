/**
 * Corpus conformance test for the Langium Forester parser.
 *
 * Parses every .tree file in tests/corpus/ and asserts that the Langium
 * parser produces zero lexer/parser errors.  This ensures the shared
 * corpus stays in sync with the Langium grammar.
 *
 * Run with: pnpm run test:corpus
 */

import { readdirSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { EmptyFileSystem } from 'langium';
import { parseHelper } from 'langium/test';
import {
    isDocument,
    type Document,
} from '../src/language/generated/ast.js';
import { createForesterServices } from '../src/language/forester-module.js';

// ── Minimal test framework ───────────────────────────────────────────────────

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => Promise<void>): Promise<void> {
    try {
        await fn();
        passed++;
        console.log(`\u2713 ${name}`);
    } catch (e) {
        failed++;
        console.log(`\u2717 ${name}`);
        console.log(`  ${e instanceof Error ? e.message : e}`);
    }
}

// ── Setup ────────────────────────────────────────────────────────────────────

const { Forester } = createForesterServices(EmptyFileSystem);
const parse = parseHelper<Document>(Forester);

const corpusDir = resolve(import.meta.dirname ?? '.', '..', 'tests', 'corpus');
const fixtures = readdirSync(corpusDir)
    .filter(f => f.endsWith('.tree'))
    .sort();

// ── Tests ────────────────────────────────────────────────────────────────────

console.log('\n=== Corpus Conformance Tests (Langium) ===\n');

for (const fixture of fixtures) {
    const filePath = join(corpusDir, fixture);
    const source = readFileSync(filePath, 'utf-8');

    await test(`${fixture} parses without errors`, async () => {
        const doc = await parse(source);
        const { lexerErrors, parserErrors } = doc.parseResult;

        if (lexerErrors.length > 0) {
            throw new Error(
                `Lexer errors:\n${lexerErrors.map(e => `  - ${e.message}`).join('\n')}`,
            );
        }
        if (parserErrors.length > 0) {
            throw new Error(
                `Parser errors:\n${parserErrors.map(e => `  - ${e.message}`).join('\n')}`,
            );
        }

        const root = doc.parseResult.value;
        if (!isDocument(root)) {
            throw new Error('Root is not a Document');
        }

        // Ensure at least one node was parsed (unless the fixture is intentionally empty)
        if (source.trim().length > 0 && root.nodes.length === 0) {
            // Allow files that are only comments (comments are hidden tokens)
            const nonCommentContent = source.replace(/%[^\n]*/g, '').trim();
            if (nonCommentContent.length > 0) {
                throw new Error('Document has content but parsed zero nodes');
            }
        }
    });
}

// ── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed, ${passed + failed} total\n`);
if (failed > 0) {
    process.exit(1);
}
