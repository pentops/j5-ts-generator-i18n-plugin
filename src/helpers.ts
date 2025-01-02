import { factory } from 'typescript';
import { createObjectLiteral, type GeneratedSchema } from '@pentops/jsonapi-jdef-ts-generator';
import { match, P } from 'ts-pattern';
import { camelCase } from 'change-case';
import type { Resource, ResourceLanguage } from 'i18next';
import { I18nPluginFile } from './plugin-file';

export const I18NEXT_IMPORT_PATH = 'i18next';
export const I18NEXT_DEFAULT_EXPORT_NAME = 'i18n';
export const I18NEXT_INIT_FUNCTION_NAME = 'init';
export const I18NEXT_USE_FUNCTION_NAME = 'use';

export const I18N_INIT_OPTS_VAR_NAME = 'i18nOpts';
export const I18N_NAMESPACES_TYPE_NAME = 'I18nNamespaces';

export interface Translation {
  // JSON dot notation
  key: string;
  value: string;
  source?: GeneratedSchema;
}

export interface ProspectiveTranslation {
  key: string;
  newValue: string | undefined;
  existingValue: string | undefined;
  source?: GeneratedSchema;
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

    prospects.set(key, {
      key,
      newValue: newValue?.value,
      existingValue: existingValue?.value,
      source: newValue?.source || existingValue?.source,
    });
  }

  return prospects;
}

export type NamespaceWriter = (file: I18nPluginFile) => string;

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

export function parseExistingValue(value: string | undefined): ResourceLanguage | undefined {
  if (!value) {
    return undefined;
  }

  try {
    return JSON.parse(value);
  } catch (e) {
    throw new Error(`I18nPlugin: failed to parse existing value: ${value}. ${e}`);
  }
}

export function gatherTranslations(fileData: ResourceLanguage | undefined) {
  const translations = new Map<string, Translation>();

  if (!fileData) {
    return translations;
  }

  const gather = (data: string | Record<string, any>, path: string = '') => {
    if (typeof data === 'object') {
      for (const [key, value] of Object.entries(data)) {
        gather(value, path ? `${path}.${key}` : key);
      }
    } else {
      translations.set(path, { key: path, value: data });
    }
  };

  gather(fileData);

  return translations;
}

export function buildResourcesObjectLiteral(providedResources: Resource, generatedResources: Record<string, Record<string, string>>) {
  const mergedResources: Record<string, Record<string, string | object>> = {};
  const allLanguages = Array.from(new Set(Object.keys(providedResources).concat(Object.keys(generatedResources))));

  for (const language of allLanguages) {
    const provided = providedResources[language] || {};
    const generated = generatedResources[language] || {};
    const allNamespaces = Array.from(new Set(Object.keys(provided).concat(Object.keys(generated))));

    if (!mergedResources[language]) {
      mergedResources[language] = {};
    }

    for (const namespace of allNamespaces) {
      const value = match({ provided: provided[namespace], generated: generated[namespace] })
        .with({ generated: P.not(undefined) }, ({ generated: g }) => factory.createIdentifier(g))
        .with({ provided: P.not(undefined) }, ({ provided: p }) => p)
        .otherwise(() => undefined);

      if (value) {
        mergedResources[language][namespace] = value;
      }
    }
  }

  return createObjectLiteral(mergedResources);
}
