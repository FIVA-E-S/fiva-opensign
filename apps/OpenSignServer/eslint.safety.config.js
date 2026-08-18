export default [
  {
    files: ['cloud/**/*.js', 'migrationdb/**/*.js', 'spec/**/*.js', 'index.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        Buffer: 'readonly',
        Parse: 'readonly',
        URL: 'readonly',
        clearTimeout: 'readonly',
        console: 'readonly',
        global: 'readonly',
        globalThis: 'readonly',
        process: 'readonly',
        setInterval: 'readonly',
        setTimeout: 'readonly',
      },
    },
    rules: {
      'no-constant-binary-expression': 'error',
      'no-dupe-args': 'error',
      'no-dupe-keys': 'error',
      'no-await-in-loop': 'error',
      'no-unreachable': 'error',
      'no-unused-vars': 'off',
    },
  },
];
