import typescript from '@rollup/plugin-typescript';
import { nodeResolve } from '@rollup/plugin-node-resolve';
import commonjs from '@rollup/plugin-commonjs';

const plugins = [typescript(), commonjs(), nodeResolve({ resolveOnly: ['ts-pattern', 'lodash.setwith', 'change-case', '@pentops/sort-helpers'] })];

export default [
  {
    input: 'src/index.ts',
    output: {
      dir: 'dist',
      format: 'es',
    },
    plugins,
  },
];
