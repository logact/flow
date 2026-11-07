module.exports = {
  testEnvironment: 'node',
  testMatch: ['**/test/**/*.jest.test.cjs'],
  transform: {
    '^.+\\.tsx?$': ['@swc/jest', { jsc: { parser: { syntax: 'typescript' }, target: 'es2022' }, module: { type: 'commonjs' } }],
  },
};
