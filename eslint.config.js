'use strict';

const js = require('@eslint/js');
const globals = require('globals');
const n = require('eslint-plugin-n');
const prettier = require('eslint-config-prettier');

module.exports = [
  { ignores: ['node_modules/**', 'Log/**', 'coverage/**'] },

  js.configs.recommended,
  n.configs['flat/recommended-script'],

  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'commonjs',
      globals: { ...globals.node, ...globals.es2023 }
    },
    rules: {
      // Unused args are allowed when prefixed with _, and Express error handlers
      // must keep their 4th `next` parameter to be recognised as error middleware.
      'no-unused-vars': [
        'error',
        {
          args: 'after-used',
          argsIgnorePattern: '^_|^next$',
          caughtErrors: 'all',
          caughtErrorsIgnorePattern: '^_'
        }
      ],

      // Guards against the class of defects catalogued in the review.
      'no-console': 'off', // server.js/logger legitimately use it today (CQ-24)
      // server.js exits deliberately when the DB pool cannot be created at startup.
      'n/no-process-exit': 'off',

      // Global fetch is technically flagged experimental until Node 21, but it is
      // stable and relied upon on the supported Node 20 floor
      // (services/flightViewService.js). Everything else stays version-checked.
      'n/no-unsupported-features/node-builtins': ['error', { ignores: ['fetch'] }],
      'require-atomic-updates': 'error',
      'no-return-await': 'error',
      'prefer-const': 'error',
      'no-var': 'error',
      eqeqeq: ['error', 'always', { null: 'ignore' }],

      // CQ-40: every process.env read belongs in config/env.js. The exemptions below
      // are the known outstanding violations, scheduled for Phase 3.
      'n/no-process-env': 'error',

      // The lazy `require('mssql')` inside a function is deliberate (CQ-02).
      'n/no-unpublished-require': 'off',
      'n/no-missing-require': ['error', { allowModules: ['mssql'] }]
    }
  },

  {
    // config/env.js is the single sanctioned place to read process.env.
    files: ['config/env.js'],
    rules: { 'n/no-process-env': 'off' }
  },

  {
    // oracleRepository still WRITES process.env.TNS_ADMIN, because the Oracle client
    // reads it out-of-band. It no longer reads any configuration from process.env.
    files: ['repositories/oracleRepository.js'],
    rules: { 'n/no-process-env': 'off' }
  },

  {
    // Dev-only tooling, not part of the running service. Its process.env reads are
    // stub knobs rather than application configuration, so they do not belong in
    // config/env.js.
    files: ['scripts/**/*.js'],
    rules: { 'n/no-process-env': 'off' }
  },

  {
    files: ['test/**/*.js'],
    rules: {
      'n/no-process-env': 'off',
      // Characterization tests deliberately swap module exports to install stubs.
      // Node is single-threaded here, so these are not real races.
      'require-atomic-updates': 'off'
    }
  },

  // Must stay last so formatting rules never fight Prettier.
  prettier
];
