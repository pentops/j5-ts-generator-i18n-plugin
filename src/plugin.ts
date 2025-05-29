import ts, { factory } from 'typescript';
import type { InitOptions, ResourceLanguage } from 'i18next';
import {
  createObjectLiteral,
  type GeneratedClientFunction,
  type GeneratedSchema,
  type Optional,
  BasePlugin,
  type IPluginConfig,
  type IPluginFileConfig,
  type IPluginRunOutput,
  defaultGeneratorFileReader,
  type IWritableFile,
} from '@pentops/jsonapi-jdef-ts-generator';
import { camelCase } from 'change-case';
import setWith from 'lodash.setwith';
import { sortByKey } from '@pentops/sort-helpers';
import {
  buildProspectiveTranslations,
  buildResourcesObjectLiteral,
  defaultConflictHandler,
  defaultDefinedAnySchemaTranslationPathGetter,
  defaultI18nPluginDefinedAnySchemaTranslationWriter,
  defaultNamespaceWriter,
  defaultSchemaTranslationWriter,
  defaultTranslationPathOrGetter,
  gatherTranslations,
  I18N_INIT_OPTS_VAR_NAME,
  I18N_NAMESPACES_TYPE_NAME,
  I18NEXT_DEFAULT_EXPORT_NAME,
  I18NEXT_IMPORT_PATH,
  I18NEXT_INIT_FUNCTION_NAME,
  I18NEXT_USE_FUNCTION_NAME,
  type I18nPluginConflictHandler,
  I18nPluginDefinedAnySchemaTranslationPathGetter,
  I18nPluginDefinedAnySchemaTranslationWriter,
  type I18nPluginTranslationPathGetter,
  type I18nPluginTranslationWriter,
  type NamespaceWriter,
  parseExistingValue,
  type Translation,
} from './helpers';
import { I18nPluginFile } from './plugin-file';
import { buildState, I18nPluginState } from './state';

export interface I18nPluginFileGeneratorConfig<TFileContentType = string> extends Omit<IPluginFileConfig<TFileContentType>, 'exportFromIndexFile'> {
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

export interface I18nIndexFileConfig<TFileContentType = string> extends IPluginFileConfig<TFileContentType> {
  addGeneratedResources?: boolean;
  initOptions?: InitOptions;
  middleware?: I18nIndexMiddlewareConfig[];
  topOfFileComment?: string;
}

export interface I18nPluginDefaultNamespaceFileConfig
  extends Omit<I18nPluginFileGeneratorConfig, 'translationPathOrGetter' | 'translationWriter' | 'language'> {
  languages: string[];
  translationPathOrGetter?: I18nPluginDefinedAnySchemaTranslationPathGetter;
  translationWriter?: I18nPluginDefinedAnySchemaTranslationWriter;
}

export interface I18nPluginConfig extends IPluginConfig<I18nPluginFile> {
  conflictHandler: I18nPluginConflictHandler;
  // defaultNamespaceFile is where schema names for defined any values will go
  defaultNamespaceFile?: I18nPluginDefaultNamespaceFileConfig;
  files: I18nPluginFileGeneratorConfig[] | I18nPluginFileConfigCreator;
  indexFile?: I18nIndexFileConfig;
  namespaceWriter: NamespaceWriter;
}

export type I18nPluginConfigInput = Optional<I18nPluginConfig, 'conflictHandler' | 'namespaceWriter'>;

export class I18nPlugin extends BasePlugin<string, I18nPluginFileGeneratorConfig, I18nPluginFile, I18nPluginConfig, I18nPluginState> {
  name = 'I18nPlugin';
  private writtenTranslations: Record<string, Translation> = {};

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
    super.createPluginFilesFromConfig(
      (fileConfig || []).map((config) => ({ ...config, exportFromIndexFile: false, directory: `${config.directory}/${config.language}` })),
    );
  }

  private mergeAndBuildTranslations(newTranslations: Map<string, Translation>, existingTranslationsInFile: Map<string, Translation>) {
    const prospects = buildProspectiveTranslations(newTranslations, existingTranslationsInFile);

    const finalTranslationsForFile = new Map<string, Translation>();

    for (const [key, value] of prospects) {
      if (value.newValue !== undefined && value.existingValue !== undefined && value.newValue === value.existingValue) {
        finalTranslationsForFile.set(key, { key, value: value.newValue, source: value.source });
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
      setWith(fileContent, translation.key, translation.value, Object);
      this.writtenTranslations[translation.key] = translation;
    }

    return JSON.stringify(fileContent, null, 2);
  }

  public async run(): Promise<IPluginRunOutput<I18nPluginFile>> {
    for (const file of this.files) {
      let fileData: ResourceLanguage | undefined;

      try {
        fileData = parseExistingValue((await file.pollForExistingFileContent())?.content);
      } catch {}

      const existingTranslationsInFile = gatherTranslations(fileData);
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
              translation.source = schema;
              newTranslations.set(translation.key, translation);
            }
          }
        }
      }

      file.setRawContent(this.mergeAndBuildTranslations(newTranslations, existingTranslationsInFile));
    }

    if (this.pluginConfig.defaultNamespaceFile) {
      await this.generateDefaultNamespaceFiles();
    }

    if (this.pluginConfig.indexFile) {
      this.generateIndexFile();
    }

    const out = await this.buildFiles();

    return {
      files: out.reduce<IWritableFile[]>((acc, curr) => (curr ? [...acc, curr] : acc), []),
    };
  }

  private async generateDefaultNamespaceFile(language: string) {
    if (!this.pluginConfig.defaultNamespaceFile) {
      return;
    }

    const defaultNamespaceFile = this.createPluginFile(
      {
        ...this.pluginConfig.defaultNamespaceFile,
        directory: `${this.pluginConfig.defaultNamespaceFile.directory}/${language}`,
        language,
        exportFromIndexFile: false,
      },
      defaultGeneratorFileReader,
    );

    let fileData: ResourceLanguage | undefined;

    try {
      fileData = parseExistingValue((await defaultNamespaceFile.pollForExistingFileContent())?.content);
    } catch {}

    const existingTranslationsInFile = gatherTranslations(fileData);
    const newTranslations: Map<string, Translation> = new Map();

    for (const schemaName of this.definedAnySchemas) {
      const translationPath = (this.pluginConfig.defaultNamespaceFile.translationPathOrGetter || defaultDefinedAnySchemaTranslationPathGetter)(
        language,
        schemaName,
      );

      if (translationPath) {
        const translation = (this.pluginConfig.defaultNamespaceFile.translationWriter || defaultI18nPluginDefinedAnySchemaTranslationWriter)(
          language,
          schemaName,
          this.generatedSchemas.get(schemaName),
          translationPath,
        );

        if (translation) {
          newTranslations.set(translation.key, translation);
        }
      }
    }

    defaultNamespaceFile.setRawContent(this.mergeAndBuildTranslations(newTranslations, existingTranslationsInFile));
    this.files.push(defaultNamespaceFile);
  }

  private async generateDefaultNamespaceFiles() {
    if (!this.pluginConfig.defaultNamespaceFile || !this.pluginConfig.defaultNamespaceFile.languages.length) {
      return;
    }

    await Promise.all(this.pluginConfig.defaultNamespaceFile.languages.map((language) => this.generateDefaultNamespaceFile(language)));
  }

  private generateIndexFile() {
    if (!this.pluginConfig.indexFile) {
      return;
    }

    const { addGeneratedResources, initOptions, middleware, ...defaultFileConfig } = this.pluginConfig.indexFile;

    const indexFile = this.createPluginFile(
      {
        ...defaultFileConfig,
        exportFromIndexFile: false,
      },
      defaultGeneratorFileReader,
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

    const resourcesObjectLiteral = buildResourcesObjectLiteral(resources, resourcesByLanguageAndNamespace);

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

    const builtLanguages = Array.from(new Set(Object.keys(resourcesByLanguageAndNamespace)));

    const resourcesAccess = factory.createIndexedAccessTypeNode(
      factory.createTypeQueryNode(factory.createIdentifier(I18N_INIT_OPTS_VAR_NAME)),
      factory.createLiteralTypeNode(factory.createStringLiteral('resources', true)),
    );

    if (this.pluginConfig.defaultNamespaceFile) {
      indexFile.addNodes(
        factory.createVariableStatement(
          [factory.createModifier(ts.SyntaxKind.ExportKeyword)],
          factory.createVariableDeclarationList(
            [
              factory.createVariableDeclaration(
                I18N_INIT_OPTS_VAR_NAME,
                undefined,
                undefined,
                factory.createAsExpression(
                  createObjectLiteral({
                    ...remainingInitOptions,
                    resources: resourcesObjectLiteral,
                    defaultNS: this.pluginConfig.defaultNamespaceFile.namespaceName,
                  }),
                  factory.createTypeReferenceNode('const'),
                ),
              ),
            ],
            ts.NodeFlags.Const,
          ),
        ),
        factory.createIdentifier('\n'),
      );
    }

    indexFile.addNodes(
      factory.createTypeAliasDeclaration(
        [factory.createModifier(ts.SyntaxKind.ExportKeyword)],
        I18N_NAMESPACES_TYPE_NAME,
        undefined,
        factory.createUnionTypeNode(
          builtLanguages.map((lang) =>
            ts.factory.createTypeOperatorNode(
              ts.SyntaxKind.KeyOfKeyword,
              factory.createIndexedAccessTypeNode(resourcesAccess, factory.createLiteralTypeNode(factory.createStringLiteral(lang, true))),
            ),
          ),
        ),
      ),
      factory.createIdentifier('\n'),
    );

    callExpression = factory.createCallExpression(
      factory.createPropertyAccessExpression(
        callExpression || factory.createIdentifier(I18NEXT_DEFAULT_EXPORT_NAME),
        factory.createIdentifier(I18NEXT_INIT_FUNCTION_NAME),
      ),
      undefined,
      [factory.createIdentifier(I18N_INIT_OPTS_VAR_NAME)],
    );

    indexFile.addNodes(callExpression, factory.createIdentifier('\n'));

    indexFile.addManualExport(undefined, { namedExports: [I18NEXT_DEFAULT_EXPORT_NAME], typeOnlyExports: [] });
    indexFile.generateHeading();
  }

  getState(): I18nPluginState | undefined {
    return buildState(this.writtenTranslations);
  }
}
