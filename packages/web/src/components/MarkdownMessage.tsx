import { useState, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

function flattenText(value: ReactNode): string {
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (Array.isArray(value)) return value.map(flattenText).join('');
  if (value && typeof value === 'object' && 'props' in value) {
    return flattenText((value as { props?: { children?: ReactNode } }).props?.children);
  }
  return '';
}

function CodeBlock({ children }: { children: ReactNode }) {
  const [copied, setCopied] = useState(false);
  const code = flattenText(children).replace(/\n$/, '');
  const copy = async (): Promise<void> => {
    await navigator.clipboard.writeText(code);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };
  return <div className="markdown-code-block">
    <div className="markdown-code-head"><span>CODE</span><button type="button" onClick={() => void copy()}>{copied ? '복사됨' : '복사'}</button></div>
    <pre>{children}</pre>
  </div>;
}

export function MarkdownMessage({ children }: { children: string }) {
  return <div className="markdown-body">
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        pre: ({ children: code }) => <CodeBlock>{code}</CodeBlock>,
        a: ({ href, children: label }) => <a href={href} target="_blank" rel="noreferrer">{label}</a>,
      }}
    >
      {children}
    </ReactMarkdown>
  </div>;
}
