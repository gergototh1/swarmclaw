'use client'

import { useEffect, useRef, useState, useCallback } from 'react'
import { api } from '@/lib/app/api-client'
import { useAppStore } from '@/stores/use-app-store'
import {
  IDENTITY_VIEWPORT,
  fitViewport,
  panViewport,
  viewportTransform,
  zoomViewportAt,
  type GraphViewport,
} from '@/lib/memory-graph-viewport'

interface Node {
  id: string
  title: string
  category: string
  agentId?: string | null
  x: number
  y: number
  vx: number
  vy: number
}

interface Link {
  source: string
  target: string
  type: string
}

/** Kinetic energy threshold — stop simulation when total energy drops below this. */
const SETTLE_THRESHOLD = 0.5

export function MemoryGraphView() {
  const [initialData, setInitialData] = useState<{ nodes: Node[]; links: Link[] } | null>(null)
  const [loading, setLoading] = useState(true)
  const [hoveredNode, setHoveredNode] = useState<string | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const svgRef = useRef<SVGSVGElement>(null)
  const requestRef = useRef<number>(null)
  const nodesRef = useRef<Node[]>([])
  const linksRef = useRef<Link[]>([])

  const selectedMemoryId = useAppStore((s) => s.selectedMemoryId)
  const setSelectedMemoryId = useAppStore((s) => s.setSelectedMemoryId)
  const memoryAgentFilter = useAppStore((s) => s.memoryAgentFilter)
  const setMemoryGraphNodeIds = useAppStore((s) => s.setMemoryGraphNodeIds)

  // The canvas transform. Kept in a ref as well as in state: the wheel and drag
  // handlers need the current value without re-subscribing on every frame.
  const [viewport, setViewport] = useState<GraphViewport>(IDENTITY_VIEWPORT)
  const viewportRef = useRef<GraphViewport>(IDENTITY_VIEWPORT)
  const dragRef = useRef<{ x: number; y: number; moved: boolean } | null>(null)
  const applyViewport = useCallback((next: GraphViewport) => {
    viewportRef.current = next
    setViewport(next)
  }, [])

  useEffect(() => {
    async function load() {
      setLoading(true)
      try {
        const url = `/memory/graph${memoryAgentFilter ? `?agentId=${memoryAgentFilter}` : ''}`
        const res = await api<{ nodes: Node[]; links: Link[] }>('GET', url)

        // Initialize positions
        const nodes = res.nodes.map(n => ({
          ...n,
          x: Math.random() * 800,
          y: Math.random() * 600,
          vx: 0,
          vy: 0
        }))

        nodesRef.current = nodes
        linksRef.current = res.links
        // The sidebar lists exactly what the canvas holds, so publish the set.
        setMemoryGraphNodeIds(nodes.map((n) => n.id))
        setInitialData({ nodes, links: res.links })
      } catch (err) {
        console.error('Failed to load memory graph', err)
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [memoryAgentFilter, setMemoryGraphNodeIds])

  // Write positions directly to SVG DOM — no React state updates per frame
  const updateDOM = useCallback(() => {
    const svg = svgRef.current
    if (!svg) return
    const nodes = nodesRef.current

    // Update link positions
    const lineElements = svg.querySelectorAll<SVGLineElement>('[data-link]')
    lineElements.forEach((el) => {
      const srcId = el.getAttribute('data-src')
      const tgtId = el.getAttribute('data-tgt')
      const s = nodes.find(n => n.id === srcId)
      const t = nodes.find(n => n.id === tgtId)
      if (s && t) {
        el.setAttribute('x1', String(s.x))
        el.setAttribute('y1', String(s.y))
        el.setAttribute('x2', String(t.x))
        el.setAttribute('y2', String(t.y))
      }
    })

    // Update node positions
    const gElements = svg.querySelectorAll<SVGGElement>('[data-node-id]')
    gElements.forEach((el) => {
      const id = el.getAttribute('data-node-id')
      const node = nodes.find(n => n.id === id)
      if (node) {
        el.setAttribute('transform', `translate(${node.x},${node.y})`)
      }
    })
  }, [])

  // Force-directed simulation running in refs, writing to DOM imperatively
  useEffect(() => {
    const nodes = nodesRef.current
    const links = linksRef.current
    if (nodes.length === 0) return

    const animate = () => {
      let totalEnergy = 0

      // 1. Repulsion between all nodes
      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          const dx = nodes[i].x - nodes[j].x
          const dy = nodes[i].y - nodes[j].y
          const distSq = dx * dx + dy * dy + 0.1
          const force = 400 / distSq
          const fx = dx * force
          const fy = dy * force
          nodes[i].vx += fx
          nodes[i].vy += fy
          nodes[j].vx -= fx
          nodes[j].vy -= fy
        }
      }

      // 2. Attraction along links
      for (const link of links) {
        const source = nodes.find(n => n.id === link.source)
        const target = nodes.find(n => n.id === link.target)
        if (source && target) {
          const dx = target.x - source.x
          const dy = target.y - source.y
          const dist = Math.sqrt(dx * dx + dy * dy) + 0.1
          const force = (dist - 100) * 0.02
          const fx = (dx / dist) * force
          const fy = (dy / dist) * force
          source.vx += fx
          source.vy += fy
          target.vx -= fx
          target.vy -= fy
        }
      }

      // 3. Centering force
      const cx = 400
      const cy = 300
      for (const node of nodes) {
        node.vx += (cx - node.x) * 0.01
        node.vy += (cy - node.y) * 0.01
      }

      // 4. Update positions with damping
      for (const node of nodes) {
        node.x += node.vx
        node.y += node.vy
        node.vx *= 0.8
        node.vy *= 0.8
        totalEnergy += node.vx * node.vx + node.vy * node.vy
      }

      // Write positions to DOM imperatively
      updateDOM()

      // Stop when settled
      if (totalEnergy > SETTLE_THRESHOLD) {
        requestRef.current = requestAnimationFrame(animate)
      }
    }

    requestRef.current = requestAnimationFrame(animate)
    return () => {
      if (requestRef.current) cancelAnimationFrame(requestRef.current)
    }
  }, [initialData, updateDOM])

  /*
   * Wheel zooms about the cursor, drag pans.
   *
   * The drag records whether it actually moved: without that, letting go over a
   * node after a pan would also open that memory, and a graph you cannot drag
   * without selecting something is worse than one that does not drag at all.
   */
  const screenPoint = useCallback((clientX: number, clientY: number) => {
    const rect = svgRef.current?.getBoundingClientRect()
    return { x: clientX - (rect?.left ?? 0), y: clientY - (rect?.top ?? 0) }
  }, [])

  const handleWheel = useCallback((event: React.WheelEvent<SVGSVGElement>) => {
    event.preventDefault()
    const factor = Math.exp(-event.deltaY * 0.0015)
    applyViewport(zoomViewportAt(viewportRef.current, screenPoint(event.clientX, event.clientY), factor))
  }, [applyViewport, screenPoint])

  const handlePointerDown = useCallback((event: React.PointerEvent<SVGSVGElement>) => {
    // Primary button only: a right-click belongs to the browser's menu.
    if (event.button !== 0) return
    // No pointer capture yet. Capturing here retargets every later pointer
    // event — and the click that follows — to the <svg>, so a click on a node
    // never reached the node and nothing ever opened. Capture starts only once
    // the pointer has actually moved far enough to be a drag.
    dragRef.current = { x: event.clientX, y: event.clientY, moved: false }
  }, [])

  const handlePointerMove = useCallback((event: React.PointerEvent<SVGSVGElement>) => {
    const drag = dragRef.current
    if (!drag) return
    const dx = event.clientX - drag.x
    const dy = event.clientY - drag.y
    // A few pixels of wobble while clicking is not a drag.
    if (!drag.moved && Math.abs(dx) + Math.abs(dy) < 3) return
    if (!drag.moved) {
      drag.moved = true
      // Now it is a drag: take the pointer so leaving the canvas mid-drag does
      // not strand it.
      event.currentTarget.setPointerCapture(event.pointerId)
    }
    drag.x = event.clientX
    drag.y = event.clientY
    applyViewport(panViewport(viewportRef.current, dx, dy))
  }, [applyViewport])

  const endDrag = useCallback((event: React.PointerEvent<SVGSVGElement>) => {
    if (dragRef.current && event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    // Cleared on the next tick so the click that follows this pointerup can
    // still see that a drag happened.
    const wasDragging = dragRef.current
    setTimeout(() => { if (dragRef.current === wasDragging) dragRef.current = null }, 0)
  }, [])

  const zoomByButton = useCallback((factor: number) => {
    const rect = svgRef.current?.getBoundingClientRect()
    const centre = { x: (rect?.width ?? 800) / 2, y: (rect?.height ?? 600) / 2 }
    applyViewport(zoomViewportAt(viewportRef.current, centre, factor))
  }, [applyViewport])

  const fitToNodes = useCallback(() => {
    const rect = svgRef.current?.getBoundingClientRect()
    applyViewport(fitViewport(
      nodesRef.current.map((n) => ({ x: n.x, y: n.y })),
      { width: rect?.width || 800, height: rect?.height || 600 },
    ))
  }, [applyViewport])

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-accent-bright"></div>
      </div>
    )
  }

  const nodes = nodesRef.current
  const links = linksRef.current

  return (
    <div ref={containerRef} className="flex-1 relative overflow-hidden bg-surface rounded-lg border border-line-subtle">
      {/*
        * No viewBox: the wrapper group below carries the transform, so one
        * screen pixel stays one screen pixel and the zoom arithmetic is honest.
        */}
      <svg
        ref={svgRef}
        width="100%"
        height="100%"
        onWheel={handleWheel}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        className="touch-none select-none cursor-grab active:cursor-grabbing"
      >
        <g transform={viewportTransform(viewport)}>
        {/* Links */}
        {links.map((link, i) => {
          const s = nodes.find(n => n.id === link.source)
          const t = nodes.find(n => n.id === link.target)
          if (!s || !t) return null
          // An edge touching the node under the cursor, or the selected one,
          // is the neighbourhood the user is actually asking about.
          const focus = hoveredNode || selectedMemoryId
          const touchesFocus = !!focus && (link.source === focus || link.target === focus)
          return (
            <line
              key={i}
              data-link=""
              data-src={link.source}
              data-tgt={link.target}
              x1={s.x} y1={s.y}
              x2={t.x} y2={t.y}
              stroke="currentColor"
              strokeOpacity={touchesFocus ? 0.75 : 0.28}
              strokeWidth={touchesFocus ? 1.75 : 1}
              className="text-text-3"
            />
          )
        })}

        {/* Nodes */}
        {nodes.map(node => (
          <g
            key={node.id}
            data-node-id={node.id}
            transform={`translate(${node.x},${node.y})`}
            onMouseEnter={() => setHoveredNode(node.id)}
            onMouseLeave={() => setHoveredNode(null)}
            onClick={() => { if (!dragRef.current?.moved) setSelectedMemoryId(node.id) }}
            className="cursor-pointer"
          >
            {/*
              * A 5px dot is a small target, and it shrinks further as you zoom
              * out. This invisible disc is what the pointer actually hits.
              */}
            <circle r={14} fill="transparent" />
            <circle
              r={selectedMemoryId === node.id ? 8 : 5}
              fill={node.category === 'knowledge' ? '#10B981' : '#6366F1'}
              stroke="currentColor"
              strokeWidth={selectedMemoryId === node.id ? 2 : 0}
              className="transition-all text-text"
            />
            {(hoveredNode === node.id || selectedMemoryId === node.id) && (
              <text
                y="-12"
                textAnchor="middle"
                className="text-[10px] fill-text font-600 pointer-events-none"
                style={{ filter: 'drop-shadow(0 2px 4px rgba(0,0,0,0.5))' }}
              >
                {node.title}
              </text>
            )}
          </g>
        ))}
        </g>
      </svg>

      {/* Zoom controls */}
      <div className="absolute top-4 right-4 flex flex-col gap-1">
        <button
          onClick={() => zoomByButton(1.3)}
          aria-label="Zoom in"
          className="w-8 h-8 rounded-sm bg-surface/90 backdrop-blur border border-line-subtle text-text-2 text-[16px] leading-none cursor-pointer"
          style={{ fontFamily: 'inherit' }}
        >+</button>
        <button
          onClick={() => zoomByButton(1 / 1.3)}
          aria-label="Zoom out"
          className="w-8 h-8 rounded-sm bg-surface/90 backdrop-blur border border-line-subtle text-text-2 text-[16px] leading-none cursor-pointer"
          style={{ fontFamily: 'inherit' }}
        >−</button>
        <button
          onClick={fitToNodes}
          aria-label="Fit graph to view"
          title="Fit to view"
          className="w-8 h-8 rounded-sm bg-surface/90 backdrop-blur border border-line-subtle text-text-3 text-[10px] leading-none cursor-pointer"
          style={{ fontFamily: 'inherit' }}
        >fit</button>
      </div>

      {/* Legend */}
      <div className="absolute bottom-4 left-4 p-3 bg-surface/80 backdrop-blur rounded-lg border border-line-subtle flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <div className="w-3 h-3 rounded-full bg-success" />
          <span className="text-[11px] text-text-3">Knowledge</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="w-3 h-3 rounded-full bg-accent-bright" />
          <span className="text-[11px] text-text-3">Note / Working</span>
        </div>
      </div>
    </div>
  )
}
