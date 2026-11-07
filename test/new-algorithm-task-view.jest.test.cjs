const fs=require('node:fs');

describe('isolated new algorithm task UI contract',()=>{
  const source=fs.readFileSync(require.resolve('../components/new-algorithm-task-view.tsx'),'utf8');
  test('calls only the new-algorithm task endpoint and submits server responses',()=>{
    expect(source).toContain("fetch('/api/new-algorithm/task'");
    expect(source).toContain('JSON.stringify({instanceId:completedTask.instanceId,response:responseBody})');
    expect(source).toContain('result.settlement.scoreBefore');
    expect(source).toContain('result.settlement.scoreAfter');
    expect(source).toContain('axis:completedTask.axis,type:completedTask.type');
    expect(source).toContain('result.axis.toUpperCase()');
  });
  test('renders ENCODE confirmation and accessible choice controls without client scoring',()=>{
    expect(source).toContain('确认并继续');
    expect(source).toContain('role="group" aria-label="选择答案"');
    expect(source).toContain('aria-pressed={selected===index}');
    expect(source).not.toContain('correct_index');
    expect(source).not.toContain('scoreAfter =');
  });
});
