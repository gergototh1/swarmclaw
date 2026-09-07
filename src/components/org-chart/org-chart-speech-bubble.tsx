'use client'

import { useEffect, useState } from 'react'

interface Props {
  text: string
  x: number
  y: number
}

export function OrgChartSpeechBubble({ text, x, y }: Props) {
  const [visible, setVisible] = useState(true)

  useEffect(() => {
    const timer = setTimeout(() => setVisible(false), 4000)
    return () => clearTimeout(timer)
  }, [])

  if (!visible) return null

  return (
    <div
      className="absolute pointer-events-none z-40"
      style={{
        left: x,
        top: y - 36,
        animation: 'fadeInOut 4s ease-in-out forwards',
      }}
    >
      <div className="relative bg-raised/95 border border-line-default rounded-sm px-2.5 py-1.5 shadow-lg max-w-[120px]">
        <div className="text-[9px] text-text-2 truncate">{text.slice(0, 40)}</div>
        {/* Tail */}
        <div className="absolute left-1/2 -translate-x-1/2 bottom-[-5px] w-0 h-0 border-l-[5px] border-l-transparent border-r-[5px] border-r-transparent border-t-[5px] border-t-line-default" />
      </div>
    </div>
  )
}
