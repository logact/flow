const sendMail = jest.fn();

jest.mock('nodemailer', () => ({
  __esModule: true,
  default: { createTransport: jest.fn(() => ({ sendMail })) },
}));

describe('email authentication', () => {
  const originalEnv = process.env;
  let auth: typeof import('../lib/server/auth');

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    process.env = {
      ...originalEnv,
      FLOW_STORAGE: 'memory',
      FLOW_AUTH_SECRET: 'unit-test-secret-that-is-at-least-32-characters',
      QQ_SMTP_USER: 'sender@qq.com',
      QQ_SMTP_AUTH_CODE: 'smtp-test-code',
    };
    const persisted = (globalThis as typeof globalThis & { flowAuthMemory?: { challenges: Map<string, unknown>; sessions: Map<string, unknown>; users: Map<string, unknown> } }).flowAuthMemory;
    persisted?.challenges.clear(); persisted?.sessions.clear(); persisted?.users.clear();
    sendMail.mockResolvedValue({ messageId: 'mock-message' });
    auth = require('../lib/server/auth');
  });

  afterEach(() => { jest.useRealTimers(); });
  afterAll(() => { process.env = originalEnv; });

  async function issueCode(email = 'learner@example.com') {
    await auth.sendLoginCode(email);
    const body = sendMail.mock.calls.at(-1)?.[0]?.text as string;
    return body.match(/验证码是 (\d{6})/)?.[1] as string;
  }

  it('sends a six-digit code and accepts it once, creating a stable user and learner identity', async () => {
    const code = await issueCode(' Learner@Example.com ');
    const first = auth.verifyLoginCode('learner@example.com', code);
    expect(first.user.userId).toMatch(/^usr_/);
    expect(first.user.learnerId).toMatch(/^learner_/);
    expect(auth.getAuthenticatedUser(first.token)).toEqual(first.user);
    expect(() => auth.verifyLoginCode('learner@example.com', code)).toThrow('验证码错误或已失效');

    jest.useFakeTimers().setSystemTime(Date.now() + 60 * 1000);
    const nextCode = await issueCode('learner@example.com');
    const second = auth.verifyLoginCode('learner@example.com', nextCode);
    expect(second.user).toEqual(first.user);
  });

  it('rejects malformed, incorrect, expired and exhausted challenges', async () => {
    const code = await issueCode();
    expect(() => auth.verifyLoginCode('learner@example.com', '12')).toThrow('验证码错误或已失效');
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect(() => auth.verifyLoginCode('learner@example.com', '000000')).toThrow('验证码错误或已失效');
    }
    expect(() => auth.verifyLoginCode('learner@example.com', code)).toThrow('验证码错误或已失效');

    jest.useFakeTimers().setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    await issueCode('expired@example.com');
    jest.advanceTimersByTime(10 * 60 * 1000);
    expect(() => auth.verifyLoginCode('expired@example.com', sendMail.mock.calls.at(-1)[0].text.match(/验证码是 (\d{6})/)[1])).toThrow('验证码错误或已失效');
    jest.useRealTimers();
  });

  it('enforces resend cooldown and revokes logged-out sessions', async () => {
    const code = await issueCode();
    await expect(auth.sendLoginCode('learner@example.com')).rejects.toThrow('验证码发送过于频繁');
    const session = auth.verifyLoginCode('learner@example.com', code);
    auth.revokeSession(session.token);
    expect(auth.getAuthenticatedUser(session.token)).toBeNull();
  });

  it('does not persist a challenge when SMTP sending fails and rejects missing SMTP configuration', async () => {
    sendMail.mockRejectedValueOnce(new Error('SMTP unavailable'));
    await expect(auth.sendLoginCode('learner@example.com')).rejects.toThrow('SMTP unavailable');
    expect(() => auth.verifyLoginCode('learner@example.com', '000000')).toThrow('验证码错误或已失效');

    delete process.env.QQ_SMTP_AUTH_CODE;
    await expect(auth.sendLoginCode('other@example.com')).rejects.toThrow('尚未配置 QQ 邮箱 SMTP');
  });

  it('requires a sufficiently long authentication secret', async () => {
    process.env.FLOW_AUTH_SECRET = 'short';
    await expect(auth.sendLoginCode('learner@example.com')).rejects.toThrow('FLOW_AUTH_SECRET');
  });
});
