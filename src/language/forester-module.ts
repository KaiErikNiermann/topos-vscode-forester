/**
 * Langium dependency-injection module for the Forester language.
 * Wires custom services into the Langium container.
 *
 * Formatting is delegated to the handrolled formatter-core.ts via the
 * ForesterLspFormatter adapter, which exposes it as a standard LSP
 * textDocument/formatting handler for all editor clients.
 */
import type { Module } from 'langium';
import { inject } from 'langium';
import type { DefaultSharedModuleContext, LangiumServices, LangiumSharedServices, PartialLangiumServices } from 'langium/lsp';
import { createDefaultModule, createDefaultSharedModule } from 'langium/lsp';
import { ForesterGeneratedModule, ForesterGeneratedSharedModule } from './generated/module.js';
import { ForesterDocumentValidator } from './forester-validator.js';
import { registerForesterValidationChecks } from './forester-validator-checks.js';
import { ForesterSemanticTokenProvider } from './forester-semantic-tokens.js';
import { ForesterDefinitionProvider } from './forester-definition-provider.js';
import { ForesterCodeLensProvider } from './forester-codelens-provider.js';
import { ForesterCodeActionProvider } from './forester-code-actions.js';
import { ForesterLspFormatter } from './forester-lsp-formatter.js';
import { ForesterLspInlayHintProvider } from './forester-lsp-inlay-hints.js';

/**
 * Forester-specific services added on top of the default Langium LSP services.
 */
export type ForesterAddedServices = Record<string, never>;

/** Combined service type for the Forester language. */
export type ForesterServices = LangiumServices & ForesterAddedServices;

/**
 * DI module registering Forester-specific overrides.
 */
export const ForesterModule: Module<ForesterServices, PartialLangiumServices> = {
    validation: {
        DocumentValidator: (services) => new ForesterDocumentValidator(services),
    },
    lsp: {
        SemanticTokenProvider: (services) => new ForesterSemanticTokenProvider(services),
        DefinitionProvider: (services) => new ForesterDefinitionProvider(services),
        CodeLensProvider: (services) => new ForesterCodeLensProvider(services),
        CodeActionProvider: (services) => new ForesterCodeActionProvider(services),
        Formatter: () => new ForesterLspFormatter(),
        InlayHintProvider: () => new ForesterLspInlayHintProvider(),
    },
};

/**
 * Create the full set of Langium services for the Forester language.
 * Called from main.ts (language server entry point).
 */
export function createForesterServices(context: DefaultSharedModuleContext): {
    shared: LangiumSharedServices;
    Forester: ForesterServices;
} {
    const shared = inject(
        createDefaultSharedModule(context),
        ForesterGeneratedSharedModule,
    ) as LangiumSharedServices;

    const Forester = inject(
        createDefaultModule({ shared }),
        ForesterGeneratedModule,
        ForesterModule,
    ) as ForesterServices;

    shared.ServiceRegistry.register(Forester);
    registerForesterValidationChecks(Forester);

    return { shared, Forester };
}
