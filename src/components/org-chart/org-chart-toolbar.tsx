'use client'

interface Props {
  onAutoLayout: () => void
  onZoomIn: () => void
  onZoomOut: () => void
  onFitToScreen: () => void
  scale: number
}

export function OrgChartToolbar({ onAutoLayout, onZoomIn, onZoomOut, onFitToScreen, scale }: Props) {
  return (
    <div className="absolute top-4 right-4 z-20 flex items-center gap-1 bg-raised/90 backdrop-blur-sm border border-line-subtle rounded-sm px-1.5 py-1 shadow-lg" onPointerDown={(e) => e.stopPropagation()}>
      <ToolbarBtn title="Auto-layout" onClick={onAutoLayout}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" />
          <rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" />
        </svg>
      </ToolbarBtn>
      <div className="w-px h-5 bg-layer-3 mx-0.5" />
      <ToolbarBtn title="Zoom in" onClick={onZoomIn}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" /><line x1="11" y1="8" x2="11" y2="14" /><line x1="8" y1="11" x2="14" y2="11" />
        </svg>
      </ToolbarBtn>
      <span className="text-[10px] font-mono text-text-3 min-w-[36px] text-center">{Math.round(scale * 100)}%</span>
      <ToolbarBtn title="Zoom out" onClick={onZoomOut}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" /><line x1="8" y1="11" x2="14" y2="11" />
        </svg>
      </ToolbarBtn>
      <div className="w-px h-5 bg-layer-3 mx-0.5" />
      <ToolbarBtn title="Fit to screen" onClick={onFitToScreen}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3" />
        </svg>
      </ToolbarBtn>
    </div>
  )
}

function ToolbarBtn({ children, title, onClick }: { children: React.ReactNode; title: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      title={title}
      className="w-7 h-7 rounded-xs flex items-center justify-center transition-colors cursor-pointer bg-transparent border-none text-text-3 hover:text-text hover:bg-layer-2"
    >
      {children}
    </button>
  )
}
