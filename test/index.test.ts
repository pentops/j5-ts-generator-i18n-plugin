import { I18nPlugin, I18nPluginFileGeneratorConfig } from '../src/plugin';
import { capitalCase, kebabCase } from 'change-case';
import { parseApiSource, Generator, GeneratedSchema, PackageSummary, APISource, defaultConfig } from '@pentops/jsonapi-jdef-ts-generator';
import { match, P } from 'ts-pattern';
import mockApiSource from './helpers/mock-api.json';
import { I18nPluginTranslationWriter, Translation } from '../src';

export const defaultMinorWords = [
  'and',
  'as',
  'but',
  'for',
  'if',
  'nor',
  'or',
  'so',
  'yet',
  'a',
  'an',
  'the',
  'as',
  'at',
  'by',
  'for',
  'in',
  'of',
  'off',
  'on',
  'per',
  'to',
  'up',
  'via',
  'with',
];

export function titleCaseName(name: string, forcedCaseWords: Record<string, string> = {}, minorWords: string[] = defaultMinorWords) {
  const capitalCased = capitalCase(name);
  const split = capitalCased.split(' ');

  return split
    .map((word, i) => {
      const lowerCasedWord = word.toLowerCase();

      if (forcedCaseWords[lowerCasedWord]) {
        return forcedCaseWords[lowerCasedWord];
      }

      if (i !== 0 && minorWords.includes(lowerCasedWord)) {
        return lowerCasedWord;
      }

      return word;
    })
    .join(' ');
}

function getPackageFileName(pkg: PackageSummary) {
  if (pkg.label) {
    return kebabCase(pkg.label.toLowerCase());
  }

  return kebabCase(pkg.package.split('.')[0].toLowerCase());
}

const caseOverrides: Record<string, string> = {
  api: 'API',
  id: 'ID',
  url: 'URL',
  jwt: 'JWT',
};

const i18nTranslationWriter: I18nPluginTranslationWriter = (
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
          value: titleCaseName(property.name, caseOverrides),
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
          value: titleCaseName(value.name, caseOverrides),
        };
      }),
    )
    .otherwise(() => undefined);

describe(I18nPlugin, () => {
  it('should write translations according to specified parameters', () => {
    const p = new I18nPlugin({
      indexFile: {
        directory: './generated',
        fileName: 'index.ts',
        middleware: [{ importSpecifier: 'initReactI18next', importPath: 'react-i18next' }],
        addGeneratedResources: true,
      },
      files: (generatedSchemas) => {
        const directory = '../translation/translations/en';
        const files: Map<string, I18nPluginFileGeneratorConfig> = new Map();

        function getValidSchemaPackage(schema: GeneratedSchema) {
          return match(schema)
            .with(
              P.union({ rawSchema: { enum: { derivedHelperType: undefined } } }, { rawSchema: { oneOf: P.not(P.nullish) } }),
              (s) => s.parentPackage,
            )
            .otherwise(() => undefined);
        }

        function getFilterFunction(fullGrpcPackageName: string) {
          return (s: GeneratedSchema) => getValidSchemaPackage(s)?.package === fullGrpcPackageName;
        }

        for (const [, generatedSchema] of generatedSchemas) {
          const pkg = getValidSchemaPackage(generatedSchema);

          if (pkg) {
            const jsonName = getPackageFileName(pkg);

            if (!files.has(jsonName)) {
              files.set(jsonName, {
                directory,
                language: 'en',
                fileName: `${jsonName}.json`,
                translationWriter: i18nTranslationWriter,
                schemaFilter: getFilterFunction(pkg.package),
              });
            }
          }
        }

        return Array.from(files.values());
      },
    });

    new Generator({
      ...defaultConfig,
      dryRun: true,
      plugins: [p],
    }).generate(parseApiSource(mockApiSource as unknown as APISource));

    console.log(p.postRun());
  });
});
