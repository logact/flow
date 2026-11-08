const fs=require('node:fs');

describe('P writing renderer contract',()=>{
 test('starts clock only on explicit start and submits final text with full elapsed time',()=>{const source=fs.readFileSync(require.resolve('../components/new-algorithm-p-fluency-renderer.tsx'),'utf8');expect(source).toContain('started.current=now()');expect(source).toContain('(now()-started.current)/1000');});
 test('does not render target forms or example answer and preserves text on short response',()=>{const source=fs.readFileSync(require.resolve('../components/new-algorithm-p-fluency-renderer.tsx'),'utf8');expect(source).not.toContain('targetForm');expect(source).not.toContain('exampleAnswer');expect(source).toContain("setPhase('short')");expect(source).toContain('草稿已保留');expect(source).toContain('elapsed_seconds:elapsedSeconds');});
 test('does not calculate score in the client and restarts after interruption',()=>{const source=fs.readFileSync(require.resolve('../components/new-algorithm-p-fluency-renderer.tsx'),'utf8');expect(source).not.toContain('scoreAfter');expect(source).toContain("setPhase('interrupted')");expect(source).toContain('started.current=null');});
});
