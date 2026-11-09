module.exports = {
  testEnvironment: 'node',
  testMatch: ['**/test/**/*.jest.test.ts'],
  transform: {
    '^.+\\.tsx?$': ['@swc/jest', { jsc: { parser: { syntax: 'typescript' }, target: 'es2022' }, module: { type: 'commonjs' } }],
  },
};
