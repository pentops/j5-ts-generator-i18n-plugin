import type { Resource, ResourceLanguage, InitOptions } from 'i18next';
import { match, P } from 'ts-pattern';
import {
  type GeneratedSchema,
  PluginBase,
  type PluginConfig,
  type PluginFileGeneratorConfig,
  type GeneratedClientFunction, createObjectLiteral,
} from '@pentops/jsonapi-jdef-ts-generator';
import { camelCase } from 'change-case';
import set from 'lodash.set';
import ts, { factory } from 'typescript';

export const I18NEXT_IMPORT_PATH = 'i18next';
export const I18NEXT_DEFAULT_EXPORT_NAME = 'i18n';
export const I18NEXT_INIT_FUNCTION_NAME = 'init';
export const I18NEXT_USE_FUNCTION_NAME = 'use';

export type TranslationValue = string | null;

export interface Translation {
  // JSON dot notation
  key: string;
  value: TranslationValue;
}

export type I18nPluginTranslationPathGetter = (schema: GeneratedSchema) => string | undefined;

export type I18nPluginTranslationWriter = (
  schema: GeneratedSchema,
  schemaPath: string,
  existingValues?: Map<string, Translation>,
) => Translation[] | undefined;

export interface I18nPluginFileGeneratorConfig extends PluginFileGeneratorConfig {
  language: string;
  namespaceName?: string;
  translationPathOrGetter?: string | I18nPluginTranslationPathGetter;
  translationWriter?: I18nPluginTranslationWriter;
  unmatchedTranslationFromExistingFileHandler?: 'keep' | 'remove' | ((translation: Translation) => Translation | null);
}

export type I18nPluginFileConfigCreator = (
  generatedSchemas: Map<string, GeneratedSchema>,
  generatedClientFunctions: GeneratedClientFunction[],
) => I18nPluginFileGeneratorConfig[];

export const defaultTranslationPathOrGetter: I18nPluginTranslationPathGetter = (schema: GeneratedSchema): string | undefined =>
  match(schema)
    .with({ rawSchema: { oneOf: P.not(P.nullish) } }, () => `oneOf.${schema.generatedName}`)
    .with({ rawSchema: { enum: P.not(P.nullish) } }, () => `enum.${schema.generatedName}`)
    .otherwise(() => undefined);

export const defaultSchemaTranslationWriter: I18nPluginTranslationWriter = (
  schema: GeneratedSchema,
  schemaPath: string,
  existingValues?: Map<string, Translation>,
): Translation[] | undefined =>
  match(schema)
    .with({ rawSchema: { oneOf: P.not(P.nullish) } }, (s) =>
      Array.from(s.rawSchema.oneOf.properties.values()).map((property) => {
        const path = `${schemaPath}.${property.name}`;

        if (existingValues?.has(path)) {
          return existingValues.get(path)!;
        }

        return {
          key: path,
          value: property.name,
        };
      }),
    )
    .with({ rawSchema: { enum: P.not(P.nullish) } }, (s) =>
      s.rawSchema.enum.options.map((value) => {
        const path = `${schemaPath}.${value.name}`;

        if (existingValues?.has(path)) {
          return existingValues.get(path)!;
        }

        return {
          key: path,
          value: value.name,
        };
      }),
    )
    .otherwise(() => undefined);

export interface I18nIndexMiddlewareConfig {
  importPath: string;
  importSpecifier: string;
  isDefault?: boolean;
}

export interface I18nIndexFileConfig extends PluginFileGeneratorConfig {
  addGeneratedResources?: boolean;
  initOptions?: InitOptions;
  middleware?: I18nIndexMiddlewareConfig[];
}

export interface I18nPluginConfig extends PluginConfig<I18nPluginFileGeneratorConfig> {
  files: I18nPluginFileGeneratorConfig[] | I18nPluginFileConfigCreator;
  indexFile?: I18nIndexFileConfig;
}

export class I18nPlugin extends PluginBase<I18nPluginFileGeneratorConfig, I18nPluginConfig> {
  name = 'I18nPlugin';

  // eslint-disable-next-line @typescript-eslint/no-useless-constructor
  constructor(config: I18nPluginConfig) {
    super(config);
  }

  private static parseExistingValue(value: string | undefined): ResourceLanguage | undefined {
    if (!value) {
      return undefined;
    }

    try {
      return JSON.parse(value);
    } catch (e) {
      throw new Error(`I18nPlugin: failed to parse existing value: ${value}. ${e}`);
    }
  }

  private static gatherTranslations(fileData: ResourceLanguage | undefined) {
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

  private static buildResourcesObjectLiteral(providedResources: Resource, generatedResources: Record<string, Record<string, string>>) {
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

  private static getFileNamespace(file: I18nPluginFileGeneratorConfig) {
    return file.namespaceName || camelCase(file.fileName.replace('.json', ''));
  }

  private generateIndexFile() {
    if (!this.pluginConfig.indexFile) {
      return;
    }

    const { addGeneratedResources, initOptions, middleware, ...defaultFileConfig } = this.pluginConfig.indexFile;

    const indexFile = this.createPluginFile(defaultFileConfig);

    indexFile.addManualImport(I18NEXT_IMPORT_PATH, [], [], I18NEXT_DEFAULT_EXPORT_NAME);

    const resourcesByLanguageAndNamespace: Record<string, Record<string, string>> = {};
    const { resources = {}, ...remainingInitOptions } = initOptions || {};

    if (addGeneratedResources) {
      const filesToAdd = this.files.filter((file) => file.getHasContent());

      if (filesToAdd.length) {
        for (const file of filesToAdd) {
          if (!resourcesByLanguageAndNamespace[file.config.language]) {
            resourcesByLanguageAndNamespace[file.config.language] = {};
          }

          const languageResources = resourcesByLanguageAndNamespace[file.config.language]!;
          const namespaceName = I18nPlugin.getFileNamespace(file.config);
          const resourceSpecifier = camelCase(`${file.config.language}_${namespaceName}_NS`);

          languageResources[namespaceName] = resourceSpecifier;

          indexFile.addImportToOtherGeneratedFile(file, undefined, undefined, resourceSpecifier);
        }
      }
    }

    const resourcesObjectLiteral = I18nPlugin.buildResourcesObjectLiteral(resources, resourcesByLanguageAndNamespace);

    // The index file is slightly different from the other files generated by this plugin, so just casting to any for now
    this.files.push(indexFile as any);

    let callExpression: ts.CallExpression | undefined;

    // Configure middleware
    for (const m of middleware || []) {
      indexFile.addManualImport(m.importPath, m.isDefault ? undefined : [m.importSpecifier], [], m.isDefault ? m.importSpecifier : undefined);

      callExpression = factory.createCallExpression(
        factory.createPropertyAccessExpression(
          callExpression || factory.createIdentifier(I18NEXT_DEFAULT_EXPORT_NAME),
          factory.createIdentifier(I18NEXT_USE_FUNCTION_NAME),
        ),
        undefined,
        [factory.createIdentifier(m.importSpecifier)],
      );
    }

    callExpression = factory.createCallExpression(
      factory.createPropertyAccessExpression(
        callExpression || factory.createIdentifier(I18NEXT_DEFAULT_EXPORT_NAME),
        factory.createIdentifier(I18NEXT_INIT_FUNCTION_NAME),
      ),
      undefined,
      [createObjectLiteral({ ...remainingInitOptions, resources: resourcesObjectLiteral })],
    );

    indexFile.addNodes(callExpression, factory.createIdentifier('\n'));
    indexFile.addManualExport(undefined, { namedExports: [I18NEXT_DEFAULT_EXPORT_NAME], typeOnlyExports: [] })
  }

  public async run() {
    for (const file of this.files) {
      const fileData = I18nPlugin.parseExistingValue(file.existingFileContent);
      const existingTranslationsInFile = I18nPlugin.gatherTranslations(fileData);
      const generatedTranslations: Map<string, Translation> = new Map();

      for (const [, schema] of this.generatedSchemas) {
        if (file.isFileForSchema(schema)) {
          const translationPath =
            typeof file.config.translationPathOrGetter === 'function'
              ? file.config.translationPathOrGetter(schema)
              : file.config.translationPathOrGetter || defaultTranslationPathOrGetter(schema);

          if (translationPath) {
            const translationsForSchema = file.config.translationWriter
              ? file.config.translationWriter(schema, translationPath, existingTranslationsInFile)
              : defaultSchemaTranslationWriter(schema, translationPath, existingTranslationsInFile);

            for (const translation of translationsForSchema || []) {
              generatedTranslations.set(translation.key, translation);
            }
          }
        }
      }

      for (const [key, value] of existingTranslationsInFile) {
        if (!generatedTranslations.has(key)) {
          const unmatchedTranslationHandler = file.config.unmatchedTranslationFromExistingFileHandler;

          if (typeof unmatchedTranslationHandler === 'function') {
            const newValue = unmatchedTranslationHandler(value);

            if (newValue) {
              generatedTranslations.set(key, newValue);
            }
          } else if (unmatchedTranslationHandler !== 'remove') {
            generatedTranslations.set(key, value);
          }
        }
      }

      const fileContent: ResourceLanguage = {};

      for (const translation of generatedTranslations.values()) {
        if (translation.value !== null && translation.value !== undefined) {
          set(fileContent, translation.key, translation.value);
        }
      }

      file.setRawContent(JSON.stringify(fileContent, null, 2));
    }

    if (this.pluginConfig.indexFile) {
      this.generateIndexFile();
    }
  }
}
