'use client'

import { useCallback, useEffect, useMemo, useRef, type DragEvent } from 'react'
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  applyNodeChanges,
  applyEdgeChanges,
  type Connection,
  type NodeChange,
  type EdgeChange,
  type Node,
  type Edge,
  type ReactFlowInstance,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { useProtocolBuilderStore, type BuilderEdgeData, type BuilderNodeData } from '@/features/protocols/builder/protocol-builder-store'
import { getNodeTypeForKind } from '@/features/protocols/builder/utils/template-to-nodes'
import { isBuilderTemplateReadOnly } from '@/features/protocols/builder/utils/builder-template-access'
import { PhaseNode, BranchNode, LoopNode, ParallelNode, JoinNode, ForEachNode, SubflowNode, SwarmNode, CompleteNode } from './node-types'
import { DefaultEdge, BranchEdge, LoopEdge } from './edge-types'
import { NodePalette } from './node-palette'
import { NodeInspector } from './node-inspector'
import { ValidationPanel } from './validation-panel'
import type { ProtocolStepKind, ProtocolTemplate } from '@/types'

const nodeTypes = {
  phase: PhaseNode,
  branch: BranchNode,
  loop: LoopNode,
  parallel: ParallelNode,
  join: JoinNode,
  forEach: ForEachNode,
  subflow: SubflowNode,
  swarm: SwarmNode,
  complete: CompleteNode,
}

const edgeTypes = {
  default: DefaultEdge,
  branch: BranchEdge,
  loop: LoopEdge,
}

function BuiltInTemplatePanel({
  template,
  onSelectStep,
}: {
  template: ProtocolTemplate | null
  onSelectStep: (stepId: string) => void
}) {
  const steps = template?.steps && template.steps.length > 0
    ? template.steps
    : template?.defaultPhases ?? []

  return (
    <div className="flex w-52 shrink-0 flex-col overflow-y-auto rounded-lg border bg-card p-3 shadow-sm">
      <div className="mb-3">
        <div className="text-xs font-bold uppercase tracking-[0.03em] text-muted-foreground">
          Built-in template
        </div>
        <div className="mt-1 text-sm font-semibold text-foreground">{template?.name || 'Template'}</div>
        {template?.description && (
          <div className="mt-1 text-xs leading-relaxed text-muted-foreground">
            {template.description}
          </div>
        )}
      </div>

      <div className="space-y-1">
        {steps.map((step, index) => (
          <button
            key={step.id}
            type="button"
            onClick={() => onSelectStep(step.id)}
            className="w-full rounded-md border bg-background px-3 py-2 text-left"
            title={step.kind.replace(/_/g, ' ')}
          >
            <div className="text-[10px] font-semibold uppercase tracking-[0.03em] text-muted-foreground">
              Step {index + 1}
            </div>
            <div className="mt-1 text-sm font-medium text-foreground">{step.label}</div>
            <div className="mt-1 text-xs capitalize text-muted-foreground">
              {step.kind.replace(/_/g, ' ')}
            </div>
          </button>
        ))}
      </div>
    </div>
  )
}

export function ProtocolBuilderCanvas() {
  const nodes = useProtocolBuilderStore((s) => s.nodes)
  const edges = useProtocolBuilderStore((s) => s.edges)
  const setNodes = useProtocolBuilderStore((s) => s.setNodes)
  const setEdges = useProtocolBuilderStore((s) => s.setEdges)
  const selectNode = useProtocolBuilderStore((s) => s.selectNode)
  const selectEdge = useProtocolBuilderStore((s) => s.selectEdge)
  const addNode = useProtocolBuilderStore((s) => s.addNode)
  const addEdge = useProtocolBuilderStore((s) => s.addEdge)
  const pushUndo = useProtocolBuilderStore((s) => s.pushUndo)
  const isDirty = useProtocolBuilderStore((s) => s.isDirty)
  const undo = useProtocolBuilderStore((s) => s.undo)
  const redo = useProtocolBuilderStore((s) => s.redo)
  const currentTemplate = useProtocolBuilderStore((s) => s.currentTemplate)
  const flowRef = useRef<ReactFlowInstance<Node<BuilderNodeData>, Edge<BuilderEdgeData>> | null>(null)

  const readOnly = isBuilderTemplateReadOnly(currentTemplate)

  useEffect(() => {
    if (nodes.length === 0) return
    const frame = window.requestAnimationFrame(() => {
      void flowRef.current?.fitView({ padding: 0.24, duration: 160 })
    })
    return () => window.cancelAnimationFrame(frame)
  }, [nodes.length, edges.length])

  const onNodesChange = useCallback(
    (changes: NodeChange<Node<BuilderNodeData>>[]) => {
      const allowedChanges = readOnly
        ? changes.filter((change) => change.type === 'select')
        : changes
      if (allowedChanges.length === 0) return
      setNodes(applyNodeChanges(allowedChanges, nodes), { markDirty: !readOnly })
    },
    [nodes, readOnly, setNodes],
  )

  const onEdgesChange = useCallback(
    (changes: EdgeChange[]) => {
      const allowedChanges = readOnly
        ? changes.filter((change) => change.type === 'select')
        : changes
      if (allowedChanges.length === 0) return
      setEdges(applyEdgeChanges(allowedChanges, edges) as typeof edges, { markDirty: !readOnly })
    },
    [edges, readOnly, setEdges],
  )

  const onConnect = useCallback(
    (connection: Connection) => {
      if (readOnly) return
      pushUndo()
      addEdge({
        id: `${connection.source}--${connection.target}--${Date.now()}`,
        source: connection.source!,
        target: connection.target!,
        sourceHandle: connection.sourceHandle,
        targetHandle: connection.targetHandle,
        type: 'default',
        data: { edgeType: 'default' },
      })
    },
    [addEdge, pushUndo, readOnly],
  )

  const onNodeClick = useCallback(
    (_event: React.MouseEvent, node: Node) => {
      selectNode(node.id)
    },
    [selectNode],
  )

  const onEdgeClick = useCallback(
    (_event: React.MouseEvent, edge: { id: string }) => {
      selectEdge(edge.id)
    },
    [selectEdge],
  )

  const onPaneClick = useCallback(() => {
    selectNode(null)
    selectEdge(null)
  }, [selectNode, selectEdge])

  const onDragOver = useCallback((e: DragEvent) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
  }, [])

  const onDrop = useCallback(
    (e: DragEvent) => {
      e.preventDefault()
      if (readOnly) return
      const kind = e.dataTransfer.getData('application/x-protocol-node-kind') as ProtocolStepKind
      const label = e.dataTransfer.getData('application/x-protocol-node-label')
      if (!kind) return

      pushUndo()

      const nodeData: BuilderNodeData = { label: label || kind, kind }
      const newNode: Node<BuilderNodeData> = {
        id: crypto.randomUUID(),
        type: getNodeTypeForKind(kind),
        position: { x: e.nativeEvent.offsetX - 70, y: e.nativeEvent.offsetY - 30 },
        data: nodeData,
      }
      addNode(newNode)
    },
    [addNode, pushUndo, readOnly],
  )

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (readOnly) return
      if ((e.metaKey || e.ctrlKey) && e.key === 'z') {
        e.preventDefault()
        if (e.shiftKey) redo()
        else undo()
      }
    },
    [readOnly, undo, redo],
  )

  const memoizedNodeTypes = useMemo(() => nodeTypes, [])
  const memoizedEdgeTypes = useMemo(() => edgeTypes, [])

  return (
    <div className="flex h-full min-h-0 w-full min-w-0 gap-3" onKeyDown={onKeyDown} tabIndex={0}>
      {readOnly ? <BuiltInTemplatePanel template={currentTemplate} onSelectStep={selectNode} /> : <NodePalette />}
      <div className="relative min-h-0 min-w-0 flex-1 overflow-hidden rounded-lg border">
        {isDirty && (
          <div className="absolute left-1/2 top-2 z-10 -translate-x-1/2 rounded-xs bg-amber-500/10 px-2 py-1 text-xs text-amber-500">
            Unsaved changes
          </div>
        )}
        {nodes.length === 0 && (
          <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center p-6">
            <div className="pointer-events-auto max-w-md rounded-lg border bg-card/95 p-4 text-center shadow-sm">
              <div className="text-sm font-semibold text-foreground">No visual steps</div>
              <div className="mt-1 text-sm text-muted-foreground">
                This template does not expose a protocol graph yet.
              </div>
            </div>
          </div>
        )}
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={memoizedNodeTypes}
          edgeTypes={memoizedEdgeTypes}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onNodeClick={onNodeClick}
          onEdgeClick={onEdgeClick}
          onPaneClick={onPaneClick}
          onDragOver={onDragOver}
          onDrop={onDrop}
          onInit={(instance) => {
            flowRef.current = instance
          }}
          fitView
          fitViewOptions={{ padding: 0.24 }}
          nodesDraggable={!readOnly}
          nodesConnectable={!readOnly}
          edgesReconnectable={!readOnly}
          deleteKeyCode={readOnly ? null : 'Delete'}
          defaultEdgeOptions={{ type: 'default', data: { edgeType: 'default' } }}
        >
          <Background />
          <Controls />
          <MiniMap />
        </ReactFlow>
      </div>
      <div className="flex w-72 shrink-0 flex-col gap-3">
        <NodeInspector />
        <ValidationPanel />
      </div>
    </div>
  )
}
