import { BasePlugin, BasePluginFile } from '@pentops/jsonapi-jdef-ts-generator';
import { I18nPluginFileGeneratorConfig } from './plugin';

export class I18nPluginFile extends BasePluginFile<string, I18nPluginFileGeneratorConfig, BasePlugin<any>> {}
