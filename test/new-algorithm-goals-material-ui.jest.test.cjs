const fs=require('node:fs');
const source=fs.readFileSync(require.resolve('../app/new-algorithm/goals/page.tsx'),'utf8');

describe('new algorithm fluency material controls',()=>{
  test('R/P generation buttons call the isolated materials API and show status',()=>{
    expect(source).toContain("fetch('/api/new-algorithm/materials'");
    expect(source).toContain("generateFluency(word,'r')");
    expect(source).toContain("generateFluency(word,'p')");
    expect(source).toContain('生成 R 阅读流利材料');
    expect(source).toContain('生成 P 写作流利材料');
    expect(source).toContain('材料已生成并通过校验');
  });
});
