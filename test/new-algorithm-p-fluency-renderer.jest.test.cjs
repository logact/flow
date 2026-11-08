const fs=require('node:fs');

describe('P writing renderer contract',()=>{
 test('starts the authoritative clock through the server before writing',()=>{const source=fs.readFileSync(require.resolve('../components/new-algorithm-p-fluency-renderer.tsx'),'utf8');expect(source).toContain('await onStart()');expect(source).toContain("setPhase('writing')");});
 test('does not send client elapsed time or reveal answer and preserves a short draft',()=>{const source=fs.readFileSync(require.resolve('../components/new-algorithm-p-fluency-renderer.tsx'),'utf8');expect(source).not.toContain('targetForm');expect(source).not.toContain('exampleAnswer');expect(source).toContain("setPhase('short')");expect(source).toContain('草稿已保留');expect(source).toContain('onSubmit({text})');expect(source).not.toContain('elapsed_seconds');});
 test('does not calculate score and records server interruption before a fresh start',()=>{const source=fs.readFileSync(require.resolve('../components/new-algorithm-p-fluency-renderer.tsx'),'utf8');expect(source).not.toContain('scoreAfter');expect(source).toContain("setPhase('interrupted')");expect(source).toContain('onInterrupt()');expect(source).toContain('started.current=false');});
});
