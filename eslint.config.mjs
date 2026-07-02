import config from '@prelude/eslint-config'

export default [
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/coverage/**'
    ]
  },
  ...config,
  {
    languageOptions: {
      parserOptions: {
        project: './tsconfig.json',
        tsconfigRootDir: import.meta.dirname
      }
    },
    rules: {
      // Session and variable slots are intentionally mutable engine state.
      'no-param-reassign': [ 'error', {
        props: true,
        ignorePropertyModificationsFor: [ 'ctx', 'acc', 'r', 'session', 'variable', 'connection' ],
        ignorePropertyModificationsForRegex: [ '^mutable', 'Ctx$', '^ref', 'Ref$' ]
      } ],
      // Mutually recursive grammars and AST types need the type-aware variant
      // with lazy variable references allowed.
      'no-use-before-define': 'off',
      '@typescript-eslint/no-use-before-define': [
        'error',
        { functions: false, classes: true, variables: false, ignoreTypeReferences: true }
      ]
    }
  }
]
