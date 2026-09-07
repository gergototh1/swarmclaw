'use client'

import type { ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import { CodeBlock } from '@/components/chat/code-block'

export interface MarkdownBodyProps {
  text: string
  /** Custom link renderer — return non-null to override default handling */
  renderLink?: (href: string, children: ReactNode) => ReactNode | null
  /** Custom inline code renderer — return non-null to override default */
  renderInlineCode?: (text: string, children: ReactNode, className?: string) => ReactNode | null
  /** Custom paragraph renderer — return non-null to override default */
  renderParagraph?: (node: unknown, children: ReactNode) => ReactNode | null
  /** Media URLs to skip (already rendered elsewhere, e.g. tool events) */
  skipMediaUrls?: Set<string>
}

export function MarkdownBody({
  text,
  renderLink,
  renderInlineCode,
  renderParagraph,
  skipMediaUrls,
}: MarkdownBodyProps) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      rehypePlugins={[rehypeHighlight]}
      components={{
        pre({ children }) {
          return <pre>{children}</pre>
        },
        ...(renderParagraph && {
          p({ node, children }: { node?: unknown; children?: ReactNode }) {
            const custom = renderParagraph(node, children)
            if (custom !== null) return <>{custom}</>
            return <p>{children}</p>
          },
        }),
        code({ className: cn, children }) {
          const isBlock = cn?.startsWith('language-') || cn?.startsWith('hljs')
          if (isBlock) return <CodeBlock className={cn}>{children}</CodeBlock>
          if (renderInlineCode) {
            const rawText = typeof children === 'string' ? children : ''
            const custom = renderInlineCode(rawText, children, cn)
            if (custom !== null) return <>{custom}</>
          }
          return <code className={cn}>{children}</code>
        },
        img({ src, alt }) {
          if (!src || typeof src !== 'string') return null
          if (skipMediaUrls?.has(src)) return null
          const isVideo = /\.(mp4|webm|mov|avi)$/i.test(src)
          if (isVideo) {
            return <video src={src} controls preload="none" className="max-w-full rounded-[10px] border border-white/10 my-2" />
          }
          return (
            <a href={src} download target="_blank" rel="noopener noreferrer" className="block my-2">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={src}
                alt={alt || 'Image'}
                loading="lazy"
                className="max-w-full max-h-[400px] rounded-[10px] border border-line-subtle hover:border-white/25 transition-colors"
                onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }}
              />
            </a>
          )
        },
        a({ href, children }) {
          if (!href) return <>{children}</>
          if (renderLink) {
            const custom = renderLink(href, children)
            if (custom !== null) return <>{custom}</>
          }
          // YouTube embed
          const ytMatch = href.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([a-zA-Z0-9_-]{11})/)
          if (ytMatch) {
            return (
              <div className="my-2">
                <iframe
                  src={`https://www.youtube-nocookie.com/embed/${ytMatch[1]}`}
                  className="w-full max-w-[480px] aspect-video rounded-[10px] border border-line-subtle"
                  allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                  allowFullScreen
                  title="YouTube video"
                />
              </div>
            )
          }
          // Upload download links
          if (href.includes('/api/uploads/')) {
            const filename = href.split('/').pop() || 'file'
            return (
              <a href={href} download={filename} className="text-accent-bright hover:underline">
                {children}
              </a>
            )
          }
          // Default external link
          return (
            <a href={href} target="_blank" rel="noopener noreferrer" className="text-accent-bright hover:underline">
              {children}
            </a>
          )
        },
      }}
    >
      {text}
    </ReactMarkdown>
  )
}
