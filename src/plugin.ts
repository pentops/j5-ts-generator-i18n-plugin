import ts, { factory } from 'typescript';
import type { InitOptions, Resource, ResourceLanguage } from 'i18next';
import { match, P } from 'ts-pattern';
import {
  createObjectLiteral,
  defaultPluginFileReader,
  type GeneratedClientFunction,
  type GeneratedSchema,
  Optional,
  BasePlugin,
  type PluginConfig,
  type PluginFileGeneratorConfig,
  BasePluginFile,
} from '@pentops/jsonapi-jdef-ts-generator';
import { camelCase } from 'change-case';
import set from 'lodash.set';
import { sortByKey } from '@pentops/sort-helpers';
import {
  buildProspectiveTranslations,
  defaultConflictHandler,
  defaultNamespaceWriter,
  defaultSchemaTranslationWriter,
  defaultTranslationPathOrGetter,
  I18NEXT_DEFAULT_EXPORT_NAME,
  I18NEXT_IMPORT_PATH,
  I18NEXT_INIT_FUNCTION_NAME,
  I18NEXT_USE_FUNCTION_NAME,
  type I18nPluginConflictHandler,
  I18nPluginFile,
  type I18nPluginTranslationPathGetter,
  type I18nPluginTranslationWriter,
  type NamespaceWriter,
  type Translation,
} from './helpers';

export interface I18nPluginFileGeneratorConfig<TFileContentType = string>
  extends Omit<PluginFileGeneratorConfig<TFileContentType>, 'exportFromIndexFile'> {
  language: string;
  namespaceName?: string;
  translationPathOrGetter?: I18nPluginTranslationPathGetter;
  translationWriter?: I18nPluginTranslationWriter;
  unmatchedTranslationFromExistingFileHandler?: 'keep' | 'remove' | ((translation: Translation) => Translation | null);
}

export type I18nPluginFileConfigCreator<TFileContentType = string> = (
  generatedSchemas: Map<string, GeneratedSchema>,
  generatedClientFunctions: GeneratedClientFunction[],
) => I18nPluginFileGeneratorConfig<TFileContentType>[];

export interface I18nIndexMiddlewareConfig {
  importPath: string;
  importSpecifier: string;
  isDefault?: boolean;
}

export interface I18nIndexFileConfig<TFileContentType = string> extends PluginFileGeneratorConfig<TFileContentType> {
  addGeneratedResources?: boolean;
  initOptions?: InitOptions;
  middleware?: I18nIndexMiddlewareConfig[];
  topOfFileComment?: string;
}

export interface I18nPluginConfig<TFileContentType = string> extends PluginConfig<TFileContentType, I18nPluginFileGeneratorConfig<TFileContentType>> {
  conflictHandler: I18nPluginConflictHandler;
  files: I18nPluginFileGeneratorConfig<TFileContentType>[] | I18nPluginFileConfigCreator<TFileContentType>;
  indexFile?: I18nIndexFileConfig;
  namespaceWriter: NamespaceWriter;
}

export type I18nPluginConfigInput = Optional<I18nPluginConfig, 'conflictHandler' | 'namespaceWriter'>;

export class I18nPlugin extends BasePlugin<string, I18nPluginFileGeneratorConfig, I18nPluginConfig, I18nPluginFile> {
  name = 'I18nPlugin';

  private static buildConfig(config: I18nPluginConfigInput): I18nPluginConfig {
    return {
      ...config,
      conflictHandler: config.conflictHandler ?? defaultConflictHandler,
      namespaceWriter: config.namespaceWriter ?? defaultNamespaceWriter,
    };
  }

  constructor(config: I18nPluginConfigInput) {
    super(I18nPlugin.buildConfig(config));
  }

  protected createPluginFilesFromConfig(fileConfig?: I18nPluginFileGeneratorConfig[]) {
    super.createPluginFilesFromConfig((fileConfig || []).map((config) => ({ ...config, exportFromIndexFile: false })));
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

  public async run() {
    for (const file of this.files) {
      let fileData: ResourceLanguage | undefined;

      try {
        fileData = I18nPlugin.parseExistingValue(await file.getExistingFileContent());
      } catch {}

      const existingTranslationsInFile = I18nPlugin.gatherTranslations(fileData);
      const newTranslations: Map<string, Translation> = new Map();

      for (const [, schema] of this.generatedSchemas) {
        if (file.isFileForSchema(schema)) {
          const translationPath =
            typeof file.config.translationPathOrGetter === 'function'
              ? file.config.translationPathOrGetter(schema)
              : file.config.translationPathOrGetter || defaultTranslationPathOrGetter(schema);

          if (translationPath) {
            const translationsForSchema = file.config.translationWriter
              ? file.config.translationWriter(schema, translationPath)
              : defaultSchemaTranslationWriter(schema, translationPath);

            for (const translation of translationsForSchema || []) {
              newTranslations.set(translation.key, translation);
            }
          }
        }
      }

      const prospects = buildProspectiveTranslations(newTranslations, existingTranslationsInFile);

      const finalTranslationsForFile = new Map<string, Translation>();

      for (const [key, value] of prospects) {
        if (value.newValue !== undefined && value.existingValue !== undefined && value.newValue === value.existingValue) {
          finalTranslationsForFile.set(key, { key, value: value.newValue });
        } else if (value.newValue !== undefined || value.existingValue !== undefined) {
          const finalValue = this.pluginConfig.conflictHandler(value, prospects);

          if (finalValue) {
            finalTranslationsForFile.set(finalValue.key, finalValue);
          }
        }
      }

      const fileContent: ResourceLanguage = {};

      const translationsSortedByKeyName = sortByKey(Array.from(finalTranslationsForFile.values()), (entry) => entry.key);

      for (const translation of translationsSortedByKeyName) {
        set(fileContent, translation.key, translation.value);
      }

      file.setRawContent(JSON.stringify(fileContent, null, 2));
    }

    if (this.pluginConfig.indexFile) {
      this.generateIndexFile();
    }
  }

  private generateIndexFile() {
    if (!this.pluginConfig.indexFile) {
      return;
    }

    const { addGeneratedResources, initOptions, middleware, ...defaultFileConfig } = this.pluginConfig.indexFile;

    const indexFile = this.createPluginFile<string, I18nIndexFileConfig, I18nPluginConfig, any>(
      {
        ...defaultFileConfig,
        exportFromIndexFile: false,
      },
      defaultPluginFileReader,
      this.pluginConfig.defaultFileHooks,
    );

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
          const namespaceName = file.config.namespaceName || this.pluginConfig.namespaceWriter(file);
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
    indexFile.addManualExport(undefined, { namedExports: [I18NEXT_DEFAULT_EXPORT_NAME], typeOnlyExports: [] });
    indexFile.generateHeading();
  }
}
