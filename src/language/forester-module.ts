/**
 * Langium dependency-injection module for the Forester language.
 * Wires custom services (formatter, hover provider) into the Langium container.
 */
import type { LangiumSharedCoreServices, Module } from 'langium';
import { inject } from 'langium';
import type { DefaultSharedModuleContext, LangiumServices, LangiumSharedServices, PartialLangiumServices } from 'langium/lsp';
import { createDefaultModule, createDefaultSharedModule } from 'langium/lsp';
import { ForesterFormatter } from './forester-formatter.js';
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
 *
 * Task 15-20: ForesterFormatter registered as lsp.Formatter.
 * Task 23-26: HoverProvider will be added here once implemented.
 */
export const ForesterModule: Module<ForesterServices, PartialLangiumServices> = {
    lsp: {
        Formatter: () => new ForesterFormatter(),
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

    return { shared, Forester };
}
