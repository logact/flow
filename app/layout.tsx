import type { Metadata, Viewport } from 'next';
import './globals.css';
import { AuthControl } from '@/components/AuthControl';

export const metadata: Metadata = {
  title: 'Flow — 刷着学，自然记住',
  description: '像刷短视频一样，轻松完成每天的词汇学习。',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#000000',
};

// 站点以裸 HTTP 提供服务：静态预渲染响应带 s-maxage，链路上的共享缓存可能忽略
// Vary 把 RSC 变体当 HTML 返回。强制动态渲染后 HTML/RSC 均不可缓存，避免串包。
export const dynamic = 'force-dynamic';

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>{children}<AuthControl /></body>
    </html>
  );
}
