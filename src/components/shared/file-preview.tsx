'use client'

import type { PendingFile } from '@/stores/use-chat-store'

export function FilePreview({ file, onRemove }: { file: PendingFile; onRemove: () => void }) {
  const isImage = file.file.type.startsWith('image/')
  return (
    <div className="relative">
      {isImage ? (
        <img
          src={URL.createObjectURL(file.file)}
          alt="Preview"
          className="h-16 rounded-sm object-cover border border-line-subtle"
        />
      ) : (
        <div className="flex items-center gap-2.5 px-3 py-2.5 rounded-md border border-line-subtle bg-layer-1">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" className="text-text-3 shrink-0">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
            <polyline points="14 2 14 8 20 8" />
          </svg>
          <span className="text-[13px] text-text-2 font-600 truncate max-w-[180px]">{file.file.name}</span>
        </div>
      )}
      <button
        onClick={onRemove}
        className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full border border-line-default bg-raised
          text-text-2 text-[10px] cursor-pointer flex items-center justify-center
          hover:bg-danger-soft hover:text-danger hover:border-danger/20 transition-colors"
      >
        &times;
      </button>
    </div>
  )
}
