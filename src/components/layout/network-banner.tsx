'use client'

import { useAppStore } from '@/stores/use-app-store'

export function NetworkBanner() {
  const info = useAppStore((s) => s.networkInfo)
  if (!info) return null

  return (
    <div className="flex items-center gap-2 px-3 pt-1.5 text-[10px] text-text-3">
      <span className="w-[5px] h-[5px] rounded-full bg-success shrink-0" />
      <code className="font-mono text-[10px] text-text-3 select-all">
        {info.ip}:{info.port}
      </code>
    </div>
  )
}
