import { describe, expect, it } from 'vitest'
import { projectSidebar, type SidebarSession } from '../src/client/sidebar-model.ts'
import type { TaskRoomSummary } from '../src/app/task-rooms.ts'

const session = (id: string, overrides: Partial<SidebarSession> = {}): SidebarSession => ({
  id, displayTitle: id, cwd: 'C:\\project', running: false, blank: false, updatedAt: Date.parse('2026-01-01T00:00:00Z'), ...overrides,
})

const room = (key: string, workers: TaskRoomSummary['workers'] = [], overrides: Partial<TaskRoomSummary> = {}): TaskRoomSummary => ({
  key, title: key, source: 'dsh-session', updatedAt: '2026-01-01T00:00:00.000Z', workers, pending: false, ...overrides,
})

const worker = (id: string, sessionId: string, overrides: Partial<TaskRoomSummary['workers'][number]> = {}) => ({
  id, title: `Task ${id}`, stage: 'working', summary: '', sessionId, active: false, subscribed: true, ...overrides,
})

describe('projectSidebar', () => {
  it('matches Windows paths case-insensitively and filters main, ordinary, archived, blank, and worker sessions', () => {
    const sessions = [
      session('master', { cwd: 'C:/PROJECT/' }),
      session('win-match', { cwd: 'c:/project\\' }),
      session('ordinary-other-dir', { cwd: 'C:\\other' }),
      session('blank', { blank: true }),
      session('blank-running', { blank: true, running: true }),
      session('archived'),
      session('worker-w1'),
    ]
    const result = projectSidebar({ masterId: 'master', stateDir: 'C:\\Project\\', sessions,
      rooms: [room('dsh-session:master', [worker('w1', 'worker-w1')])], archivedIds: ['archived'] })
    expect(result.mainSessions.map(item => item.id)).toEqual(['win-match', 'blank-running'])
    expect(result.groups[0]?.sessionIds).toContain('worker-w1')
    expect(result.groups[0]?.sessionIds).not.toContain('master')
    expect(result.groups[0]?.sessionIds).not.toContain('win-match')
  })

  it('keeps Linux path case significant', () => {
    const result = projectSidebar({ masterId: 'master', stateDir: '/home/Agent/project/', sessions: [
      session('same', { cwd: '/home/Agent/project' }),
      session('different-case', { cwd: '/home/agent/project' }),
    ], rooms: [] })
    expect(result.mainSessions.map(item => item.id)).toEqual(['same'])
  })

  it('merges duplicate workers across rooms with stable ids and sorted keys', () => {
    const a = room('web:z-room', [worker('w1', 'worker-w1')], { source: 'web', title: 'Investigate cache' })
    const b = room('web:a-room', [worker('w1', 'worker-w1')], { source: 'web', title: 'Investigate cache' })
    const project = [session('worker-w1')]
    const first = projectSidebar({ masterId: 'master', stateDir: 'C:\\project', sessions: project, rooms: [a, b] })
    const second = projectSidebar({ masterId: 'master', stateDir: 'C:\\project', sessions: project, rooms: [b, a] })
    expect(first.groups).toHaveLength(1)
    expect(first.groups[0]).toMatchObject({ id: 'workers:w1', roomKeys: ['web:a-room', 'web:z-room'], workers: [worker('w1', 'worker-w1')] })
    expect(second.groups).toEqual(first.groups)
  })

  it('joins overlapping multi-worker rooms transitively and keeps independent task groups apart', () => {
    const sessions = [session('worker-w1'), session('worker-w2'), session('worker-w3'), session('worker-w4')]
    const rooms = [
      room('web:one', [worker('w1', 'worker-w1'), worker('w2', 'worker-w2')], { source: 'web', title: 'First task' }),
      room('web:two', [worker('w2', 'worker-w2'), worker('w3', 'worker-w3')], { source: 'web', title: 'First task' }),
      room('web:separate', [worker('w4', 'worker-w4')], { source: 'web', title: 'Other task' }),
    ]
    const result = projectSidebar({ masterId: 'master', stateDir: 'C:\\project', sessions, rooms })
    expect(result.groups.map(group => group.roomKeys)).toEqual([['web:one', 'web:two'], ['web:separate']])
    expect(result.groups[0]).toMatchObject({ title: 'First task', workers: [worker('w1', 'worker-w1'), worker('w2', 'worker-w2'), worker('w3', 'worker-w3')] })
  })

  it('splits unrelated workers from the master room while joining its worker to an ordinary multi-worker room', () => {
    const workers = ['w1', 'w2', 'w3', 'w4', 'w5']
    const sessions = workers.map(id => session(`worker-${id}`, { cwd: `C:\\project\\work\\${id}` }))
    const result = projectSidebar({ masterId: 'master', stateDir: 'C:\\project', sessions, rooms: [
      room('dsh-session:master', [worker('w1', 'worker-w1'), worker('w2', 'worker-w2'), worker('w3', 'worker-w3')]),
      room('web:normal-multi', [worker('w1', 'worker-w1'), worker('w4', 'worker-w4'), worker('w5', 'worker-w5')],
        { source: 'web', title: 'Shared task' }),
    ] })
    expect(result.groups.map(group => ({ id: group.id, roomKeys: group.roomKeys, workers: group.workers.map(item => item.id) })))
      .toEqual([
        { id: 'workers:w1,w4,w5', roomKeys: ['dsh-session:master', 'web:normal-multi'], workers: ['w1', 'w4', 'w5'] },
        { id: 'workers:w2', roomKeys: ['dsh-session:master'], workers: ['w2'] },
        { id: 'workers:w3', roomKeys: ['dsh-session:master'], workers: ['w3'] },
      ])
  })

  it('includes worker descendants and same-workspace sessions without looping on parent cycles', () => {
    const sessions = [
      session('worker-w1'),
      session('child', { parentId: 'worker-w1', cwd: undefined }),
      session('grandchild', { parentId: 'child', cwd: undefined }),
      session('cycle', { parentId: 'cycle', cwd: undefined }),
      session('extra-in-workspace', { parentId: 'child' }),
      session('main', { cwd: 'C:\\project' }),
    ]
    const result = projectSidebar({ masterId: 'master', stateDir: 'C:\\project', sessions,
      rooms: [room('web:task', [worker('w1', 'worker-w1')], { source: 'web' })] })
    expect(result.groups[0]?.sessionIds).toEqual(expect.arrayContaining(['worker-w1', 'child', 'grandchild', 'extra-in-workspace']))
    expect(result.groups[0]?.sessionIds).not.toContain('main')
    expect(result.groups[0]?.sessionIds).not.toContain('cycle')
    expect(result.mainSessions.map(item => item.id)).toEqual(['main'])
  })

  it('projects authorized QQ rooms whose Worker workspace is a task subdirectory without duplicating its main anchor', () => {
    const sessions = [
      session('master', { cwd: 'C:\\project' }),
      session('main', { cwd: 'C:\\project' }),
      session('worker-qq', { cwd: 'C:\\project\\work\\task-42' }),
      session('worker-qq-child', { cwd: 'C:\\project\\work\\task-42\\nested', parentId: 'worker-qq' }),
    ]
    const result = projectSidebar({ masterId: 'master', stateDir: 'C:\\project', sessions,
      rooms: [room('dsh-session:main', [worker('qq', 'worker-qq')], { source: 'qq', title: 'QQ task' })] })
    expect(result.mainSessions.map(item => item.id)).toEqual(['main'])
    expect(result.groups).toHaveLength(1)
    expect(result.groups[0]).toMatchObject({ title: 'Task qq', roomKeys: ['dsh-session:main'] })
    expect(result.groups[0]?.sessionIds).toEqual(['worker-qq', 'worker-qq-child'])
    expect(result.groups[0]?.sessionIds).not.toContain('main')
    expect(result.groups[0]?.sessionIds).not.toContain('master')
  })

  it('shows empty web rooms and catalog-backed DSH room anchors, with status and recency ordering', () => {
    const sessions = [session('anchor', { updatedAt: Date.parse('2026-01-03T00:00:00Z') })]
    const rooms = [
      room('web:empty', [], { source: 'web', title: 'Untitled', updatedAt: '2026-01-01T00:00:00.000Z' }),
      room('dsh-session:anchor', [], { title: 'Imported task', updatedAt: '2026-01-02T00:00:00.000Z' }),
      room('web:person', [worker('waiting', '', { stage: 'person' })], { source: 'web', title: 'Need review', pending: false,
        updatedAt: '2026-01-01T00:00:00.000Z' }),
      room('web:active', [worker('active', '', { active: true })], { source: 'web', title: 'Active task',
        updatedAt: '2026-01-01T00:00:00.000Z' }),
    ]
    const result = projectSidebar({ masterId: 'master', stateDir: 'C:\\project', sessions, rooms })
    expect(result.groups.map(group => group.id)).toEqual(['workers:waiting', 'workers:active', 'dsh-session:anchor', 'web:empty'])
    expect(result.groups.find(group => group.id === 'web:empty')).toMatchObject({ title: 'web:empty', sessionIds: [] })
    expect(result.groups.find(group => group.id === 'dsh-session:anchor')?.sessionIds).not.toContain('anchor')
    expect(result.groups.find(group => group.id === 'workers:waiting')).toMatchObject({ pending: true, title: 'Task waiting' })
  })
})
