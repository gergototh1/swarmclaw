import type React from 'react'

interface Props {
  onCancel: () => void
  onSave: () => void
  saveLabel?: string
  saveDisabled?: boolean
  /** Extra buttons rendered on the left (e.g. Archive, Delete) */
  left?: React.ReactNode
}

export function SheetFooter({ onCancel, onSave, saveLabel = 'Save', saveDisabled, left }: Props) {
  return (
    <div className="flex gap-3 pt-2 border-t border-line-subtle">
      {left}
      <button
        onClick={onCancel}
        className="flex-1 py-3.5 rounded-[14px] border border-line-default bg-transparent text-text-2 text-[15px] font-600 cursor-pointer hover:bg-surface-2 transition-all"
        style={{ fontFamily: 'inherit' }}
      >
        Cancel
      </button>
      <button
        onClick={onSave}
        disabled={saveDisabled}
        className="flex-1 py-3.5 rounded-[14px] border-none bg-accent-bright text-white text-[15px] font-600 cursor-pointer active:scale-[0.97] disabled:opacity-30 transition-all shadow-[0_4px_20px_rgba(99,102,241,0.25)] hover:brightness-110"
        style={{ fontFamily: 'inherit' }}
      >
        {saveLabel}
      </button>
    </div>
  )
}
