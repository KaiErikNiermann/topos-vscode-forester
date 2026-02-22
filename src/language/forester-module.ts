/**
 * Langium dependency-injection module for the Forester language.
 * Wires custom services into the Langium container.
 *
 * Formatting is handled by the handrolled formatter-core.ts via the VSCode
 * DocumentFormattingEditProvider (formatter.ts), NOT by the Langium LSP.
 * The Langium AbstractFormatter (forester-formatter.ts) is intentionally
 * NOT registered here — it has word-splitting issues with TEXT tokens.
 */
import type { Module } from 'langium';
import { inject } from 'langium';
import type { DefaultSharedModuleContext, LangiumServices, LangiumSharedServices, PartialLangiumServices } from 'langium/lsp';
import { createDefaultModule, createDefaultSharedModule } from 'langium/lsp';
import { ForesterGeneratedModule, ForesterGeneratedSharedModule } from './generated/module.js';

/**
 * Forester-specific services added on top of the default Langium LSP services.
 * Hover provider will be added in tasks 23-26.
 */
export type ForesterAddedServices = Record<string, never>;

/** Combined service type for the Forester language. */
export type ForesterServices = LangiumServices & ForesterAddedServices;

/**
 * DI module registering Forester-specific overrides.
 * Formatting is NOT registered here — handled by formatter-core.ts instead.
 */
export const ForesterModule: Module<ForesterServices, PartialLangiumServices> = {
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

    return { shared, Forester };
}
