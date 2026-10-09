import globals from 'globals';

export default [
  {
    files: ['app.js', 'indoor-court.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.browser, Chart: 'readonly' }
    },
    rules: { 'no-undef': 'error' }
  }
];
