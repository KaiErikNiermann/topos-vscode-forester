/**
 * Langium language server entry point for the Forester language.
 *
 * This file is bundled separately by esbuild (task 34) into
 * out/language/main.js and launched as a Node.js worker process by
 * the VSCode extension host (task 31).
 */
import { startLanguageServer } from 'langium/lsp';
import { NodeFileSystem } from 'langium/node';
import { createConnection, ProposedFeatures } from 'vscode-languageserver/node.js';
import { createForesterServices } from './forester-module.js';

// Create the LSP connection using stdin/stdout (standard for VSCode language servers)
const connection = createConnection(ProposedFeatures.all);

// Instantiate all Langium services with the Node.js file system
const { shared } = createForesterServices({ connection, ...NodeFileSystem });

// Start listening — this wires up all LSP request handlers
startLanguageServer(shared);
