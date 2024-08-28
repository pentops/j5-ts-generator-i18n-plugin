import { PluginFile, type GeneratedSchema } from '@pentops/jsonapi-jdef-ts-generator';
import { match, P } from 'ts-pattern';
import { I18nPluginFileGeneratorConfig } from './plugin';
import { camelCase } from 'change-case';

export const I18NEXT_IMPORT_PATH = 'i18next';
export const I18NEXT_DEFAULT_EXPORT_NAME = 'i18n';
export const I18NEXT_INIT_FUNCTION_NAME = 'init';
export const I18NEXT_USE_FUNCTION_NAME = 'use';

export interface Translation {
  // JSON dot notation
  key: string;
  value: string;
}

export interface ProspectiveTranslation {
  key: string;
  newValue: string | undefined;
  existingValue: string | undefined;
}

export function buildProspectiveTranslations(
  newValues: Map<string, Translation>,
  existingValues: Map<string, Translation>,
): Map<string, ProspectiveTranslation> {
  const prospects = new Map<string, ProspectiveTranslation>();
  const allKeys = new Set([...newValues.keys(), ...existingValues.keys()]);

  for (const key of allKeys) {
    const newValue = newValues.get(key);
    const existingValue = existingValues.get(key);

    prospects.set(key, { key, newValue: newValue?.value, existingValue: existingValue?.value });
  }

  return prospects;
}

export type NamespaceWriter = (file: PluginFile<string, I18nPluginFileGeneratorConfig>) => string;

export const defaultNamespaceWriter: NamespaceWriter = (file) => camelCase(file.config.fileName.replace('.json', ''));

export type I18nPluginTranslationWriter = (schema: GeneratedSchema, schemaPath: string) => Translation[] | undefined;

export const defaultSchemaTranslationWriter: I18nPluginTranslationWriter = (schema: GeneratedSchema, schemaPath: string): Translation[] | undefined =>
  match(schema)
    .with({ rawSchema: { oneOf: P.not(P.nullish) } }, (s) =>
      Array.from(s.rawSchema.oneOf.properties.values()).map((property) => ({
        key: `${schemaPath}.${property.name}`,
        value: property.name,
      })),
    )
    .with({ rawSchema: { enum: P.not(P.nullish) } }, (s) =>
      s.rawSchema.enum.options.map((value) => ({
        key: `${schemaPath}.${value.name}`,
        value: value.name,
      })),
    )
    .otherwise(() => undefined);

export type I18nPluginTranslationPathGetter = (schema: GeneratedSchema) => string | undefined;

export const defaultTranslationPathOrGetter: I18nPluginTranslationPathGetter = (schema: GeneratedSchema): string | undefined =>
  match(schema)
    .with({ rawSchema: { oneOf: P.not(P.nullish) } }, () => `oneOf.${schema.generatedName}`)
    .with({ rawSchema: { enum: P.not(P.nullish) } }, () => `enum.${schema.generatedName}`)
    .otherwise(() => undefined);

/**
 * The `Translation` value returned will be used to replace the existing value.
 * Return null to exclude the translation altogether. If newValue is undefined, a translation that wasn't translated
 * in the current generation pass was found. If existingValue is undefined, a new translation was found.
 */
export type I18nPluginConflictHandler = (
  prospectiveTranslation: ProspectiveTranslation,
  prospects: Map<string, ProspectiveTranslation>,
) => Translation | null;

export const defaultConflictHandler: I18nPluginConflictHandler = (prospect) => {
  return match({ n: prospect.newValue, e: prospect.existingValue })
    .returnType<Translation | null>()
    .with({ n: P.not(P.nullish), e: P.nullish }, ({ n }) => ({
      key: prospect.key,
      value: n,
    }))
    .with({ n: P.not(P.nullish), e: P.not(P.nullish) }, ({ e }) => ({ key: prospect.key, value: e }))
    .with({ n: P.nullish, e: P.not(P.nullish) }, ({ e }) => ({ key: prospect.key, value: e }))
    .otherwise(() => null);
};
