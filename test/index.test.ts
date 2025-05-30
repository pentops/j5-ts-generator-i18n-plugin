import { describe, it, expect } from 'vitest';
import { match, P } from 'ts-pattern';
import { camelCase, capitalCase, kebabCase, pascalCase } from 'change-case';
import {
  parseApiSource,
  GeneratedSchema,
  PackageSummary,
  APISource,
  ParsedMethod,
  Builder,
  mergeConfig,
  defaultEnumKeyNameWriter,
} from '@pentops/jsonapi-jdef-ts-generator';
import { I18nPlugin, I18nPluginFileGeneratorConfig, I18nPluginTranslationWriter, Translation } from '../src';
import mockApiSource from './helpers/mock-api.json';

function typeNameWriter(x: string) {
  return x
    .split(/[./]/)
    .filter((x) => x)
    .map((x) => pascalCase(x))
    .join('');
}

function methodNameWriter(method: ParsedMethod) {
  return method.fullGrpcName
    .split(/[./]/)
    .reduce<string[]>((acc, curr) => {
      if (curr) {
        acc.push(acc.length === 0 ? camelCase(curr) : pascalCase(curr));
      }

      return acc;
    }, [])
    .join('');
}

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
    .with({ rawSchema: { polymorph: P.not(P.nullish) } }, (s) =>
      s.rawSchema.polymorph.members?.map((value) => {
        const path = value;

        if (existingValues?.has(path)) {
          return existingValues.get(path)!;
        }

        return {
          key: path,
          value: titleCaseName(value, caseOverrides),
        };
      }),
    )
    .otherwise(() => undefined);

describe(I18nPlugin, () => {
  const source = parseApiSource(mockApiSource as unknown as APISource);

  it('should write translations according to specified parameters', async () => {
    const p = new I18nPlugin({
      indexFile: {
        directory: './generated',
        fileName: 'index.ts',
        middleware: [{ importSpecifier: 'initReactI18next', importPath: 'react-i18next' }],
        addGeneratedResources: true,
      },
      defaultNamespaceFile: {
        languages: ['en'],
        directory: '../translation/translations',
        fileName: 'common.json',
      },
      files: (generatedSchemas) => {
        const directory = '../translation/translations';
        const files: Map<string, I18nPluginFileGeneratorConfig> = new Map();

        function getValidSchemaPackage(schema: GeneratedSchema) {
          return match(schema)
            .with(
              P.union(
                { rawSchema: { enum: { derivedHelperType: undefined } } },
                { rawSchema: { oneOf: P.not(P.nullish) } },
                { rawSchema: { polymorph: { members: P.not(P.nullish) } } },
              ),
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

    const gen = await new Builder(
      process.cwd(),
      mergeConfig({
        dryRun: { log: false },
        typeOutput: {
          directory: './types/generated',
          fileName: 'api.ts',
        },
        clientOutput: {
          directory: './api-client/generated/client-functions',
          fileName: 'index.ts',
        },
        types: {
          enumType: 'enum',
          enumKeyNameWriter: defaultEnumKeyNameWriter,
          nameWriter: typeNameWriter,
        },
        client: {
          methodNameWriter,
        },
        plugins: [p as any],
      }),
      source,
    ).build();

    expect(gen).toBeDefined();

    const files = [...p.files].sort((a, b) => a.config.fileName.localeCompare(b.config.fileName));

    for (const file of files) {
      expect((file as any)._builtFile.writtenContent).toMatchSnapshot();
    }
  });
});
