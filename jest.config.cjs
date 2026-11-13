module.exports = {
  testEnvironment: 'node',
  testMatch: ['**/test/**/*.jest.test.ts'],
  transform: {
    '^.+\\.m?[tj]sx?$': ['@swc/jest', { jsc: { parser: { syntax: 'typescript' }, target: 'es2022' }, module: { type: 'commonjs' } }],
  },
  // pdfjs-dist 仅以 ESM 发布（legacy/build/pdf.mjs），需要经 @swc/jest 转为 CommonJS 后 Jest 才能加载。
  transformIgnorePatterns: ['/node_modules/(?!pdfjs-dist/)'],
};
