import { Translation } from './helpers';
import { match, P } from 'ts-pattern';

export interface WrittenTranslation {
  key: string;
  value: string;
  source?:
    | {
        enum: {
          fullGrpcName: string;
          generatedName: string;
          values: Record<string, string>;
        };
      }
    | {
        oneOf: {
          fullGrpcName: string;
          generatedName: string;
          values: string[];
        };
      }
    | {
        polymorph: {
          fullGrpcName: string;
          generatedName: string;
          members?: string[];
        };
      };
}

export interface I18nPluginState {
  translationsWritten: Record<string, WrittenTranslation>;
}

export function buildState(translationsWritten: Record<string, Translation>): I18nPluginState {
  return {
    translationsWritten: Object.entries(translationsWritten).reduce<Record<string, WrittenTranslation>>((acc, [key, value]) => {
      return match(value.source)
        .with({ generatedValueNames: P.not(P.nullish), rawSchema: { enum: { derivedHelperType: P.nullish } } }, (s) => ({
          ...acc,
          [key]: {
            key,
            value: value.value,
            source: {
              enum: {
                fullGrpcName: s.rawSchema.enum.fullGrpcName,
                generatedName: s.generatedName,
                values: Object.fromEntries(s.generatedValueNames.entries()),
              },
            },
          },
        }))
        .with({ generatedValueNames: P.not(P.nullish), rawSchema: { enum: { derivedHelperType: P.not(P.nullish) } } }, (s) => ({
          ...acc,
          [key]: {
            key,
            value: value.value,
            source: {
              oneOf: {
                fullGrpcName: s.rawSchema.enum.fullGrpcName,
                generatedName: s.generatedName,
                values: Array.from(s.generatedValueNames.keys()),
              },
            },
          },
        }))
        .otherwise(() => ({
          ...acc,
          [key]: {
            key,
            value: value.value,
          },
        }));
    }, {}),
  };
}
