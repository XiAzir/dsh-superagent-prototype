import type { TaskRoomSummary, RoomWorker } from '../app/task-rooms.ts'

export interface SidebarSession {
  id: string
  title?: string
  displayTitle: string
  cwd?: string
  parentId?: string
  running: boolean
  blank: boolean
  updatedAt: number
}

export interface SidebarTaskGroup {
  id: string
  title: string
  updatedAt: string
  pending: boolean
  workers: RoomWorker[]
  sessionIds: string[]
  roomKeys: string[]
}

export interface ProjectSidebarInput {
  masterId: string
  stateDir: string
  sessions: readonly SidebarSession[]
  rooms: readonly TaskRoomSummary[]
  archivedIds?: ReadonlySet<string> | readonly string[]
}

const isWindowsPath = (value: string): boolean => /^[a-zA-Z]:/.test(value) || /^[\\/]{2}/.test(value)

/** Normalize separators and trailing separators without applying host OS path rules. */
const normalizePath = (value: string): string => {
  const windows = isWindowsPath(value)
  let path = value.trim().replace(/[\\/]+$/, '')
  if (windows) path = path.replace(/\//g, '\\').toLowerCase()
  return path
}

const samePath = (left: string | undefined, right: string): boolean =>
  left !== undefined && normalizePath(left) === normalizePath(right)

const isArchived = (ids: ReadonlySet<string> | readonly string[] | undefined, id: string): boolean => {
  if (!ids) return false
  return Array.isArray(ids) ? ids.includes(id) : (ids as ReadonlySet<string>).has(id)
}

const roomSessionId = (key: string): string | undefined =>
  key.startsWith('dsh-session:') && key.length > 'dsh-session:'.length
    ? key.slice('dsh-session:'.length)
    : undefined

const timestamp = (value: string): number => {
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : 0
}

const isoOf = (value: number): string => value > 0 ? new Date(value).toISOString() : ''

const genericTitle = (value: string): boolean => {
  const normalized = value.trim().toLocaleLowerCase()
  return !normalized || /^(new task|task|new conversation|untitled|任务|新任务|新对话|未命名)$/i.test(normalized)
}

interface RoomNode {
  room: TaskRoomSummary
  workers: RoomWorker[]
}

function groupsOfRooms(rooms: readonly TaskRoomSummary[], masterRoomKey: string): RoomNode[][] {
  const nodes: RoomNode[] = []
  for (const room of rooms) {
    const workers = [...new Map(room.workers.map(worker => [worker.id, worker])).values()]
    if (room.key === masterRoomKey && workers.length > 1) {
      for (const worker of workers) nodes.push({ room, workers: [worker] })
    } else nodes.push({ room, workers })
  }

  const parent = nodes.map((_, index) => index)
  const find = (index: number): number => {
    let root = index
    while (parent[root] !== root) root = parent[root]!
    while (parent[index] !== index) {
      const next = parent[index]!
      parent[index] = root
      index = next
    }
    return root
  }
  const union = (left: number, right: number) => {
    const a = find(left), b = find(right)
    if (a !== b) parent[Math.max(a, b)] = Math.min(a, b)
  }

  const firstNodeForWorker = new Map<string, number>()
  nodes.forEach((node, index) => {
    for (const worker of node.workers) {
      const previous = firstNodeForWorker.get(worker.id)
      if (previous === undefined) firstNodeForWorker.set(worker.id, index)
      else union(previous, index)
    }
  })

  const groups = new Map<number, RoomNode[]>()
  nodes.forEach((node, index) => {
    const root = find(index)
    const members = groups.get(root) ?? []
    members.push(node)
    groups.set(root, members)
  })
  return [...groups.values()].map(group => group.sort((a, b) => a.room.key.localeCompare(b.room.key)
    || a.workers.map(worker => worker.id).join(',').localeCompare(b.workers.map(worker => worker.id).join(','))))
}

function descendantsOf(seedIds: Iterable<string>, sessions: ReadonlyMap<string, SidebarSession>): Set<string> {
  const children = new Map<string, string[]>()
  for (const session of sessions.values()) {
    if (!session.parentId) continue
    const list = children.get(session.parentId) ?? []
    list.push(session.id)
    children.set(session.parentId, list)
  }
  const found = new Set<string>()
  const queue = [...seedIds]
  while (queue.length) {
    const id = queue.shift()!
    if (found.has(id)) continue
    found.add(id)
    for (const child of children.get(id) ?? []) if (!found.has(child)) queue.push(child)
  }
  return found
}

/** Projects DSH Sessions and task-room Worker sessions into the project sidebar. */
export function projectSidebar({ masterId, stateDir, sessions, rooms, archivedIds }: ProjectSidebarInput): {
  mainSessions: SidebarSession[]
  groups: SidebarTaskGroup[]
} {
  const catalog = new Map(sessions.map(session => [session.id, session]))
  const workerRootIds = new Set<string>()
  const workerIdentityIds = new Set<string>()
  for (const room of rooms) for (const worker of room.workers) {
    if (worker.id) workerIdentityIds.add(`worker-${worker.id}`)
    if (worker.sessionId) {
      workerRootIds.add(worker.sessionId)
      workerIdentityIds.add(worker.sessionId)
    }
  }
  const workerTree = descendantsOf(workerRootIds, catalog)
  const projectSessions = sessions.filter(session => samePath(session.cwd, stateDir))
  const mainSessions = projectSessions.filter(session => session.id !== masterId
    && !isArchived(archivedIds, session.id)
    && (!session.blank || session.running)
    && !workerIdentityIds.has(session.id)
    && !workerTree.has(session.id))
  const mainIds = new Set(mainSessions.map(session => session.id))

  const projected: SidebarTaskGroup[] = []
  for (const roomNodes of groupsOfRooms(rooms, `dsh-session:${masterId}`)) {
    const roomGroup = [...new Map(roomNodes.map(node => [node.room.key, node.room])).values()]
    const roomKeys = roomGroup.map(room => room.key).sort((a, b) => a.localeCompare(b))
    const workersById = new Map<string, { worker: RoomWorker; roomKey: string }>()
    for (const node of roomNodes) for (const worker of node.workers) {
      const previous = workersById.get(worker.id)
      if (!previous || node.room.key.localeCompare(previous.roomKey) < 0) workersById.set(worker.id, { worker, roomKey: node.room.key })
    }
    const workers = [...workersById.values()].map(item => item.worker).sort((a, b) => a.id.localeCompare(b.id))
    const workerRoots = workers.map(worker => worker.sessionId).filter(Boolean)
    const anchorIds = roomGroup.map(room => roomSessionId(room.key)).filter((id): id is string => !!id)
    const rootCwds = new Set(workerRoots.map(id => catalog.get(id)?.cwd).filter((cwd): cwd is string => !!cwd).map(normalizePath))

    const owned = new Set<string>(workerRoots)
    for (const id of descendantsOf(workerRoots, catalog)) owned.add(id)
    if (rootCwds.size) {
      for (const session of sessions) {
        if (session.cwd && rootCwds.has(normalizePath(session.cwd)) && !mainIds.has(session.id)) owned.add(session.id)
      }
    }
    for (const id of anchorIds) if (catalog.has(id) && id !== masterId && !mainIds.has(id)) owned.add(id)

    const sessionIds = [...owned].filter(id => id !== masterId && !mainIds.has(id) && !isArchived(archivedIds, id))
      .sort((a, b) => (catalog.get(a)?.updatedAt ?? 0) - (catalog.get(b)?.updatedAt ?? 0) || a.localeCompare(b))

    const active = workers.some(worker => worker.active)
    const person = workers.some(worker => worker.stage.toLocaleLowerCase() === 'person')
    const specificRooms = roomGroup.filter(room => room.key !== `dsh-session:${masterId}`)
    const newestRoom = (specificRooms.length ? specificRooms : workers.length ? [] : roomGroup)
      .reduce((newest, room) => Math.max(newest, timestamp(room.updatedAt)), 0)
    const newestSession = sessionIds.reduce((newest, id) => Math.max(newest, catalog.get(id)?.updatedAt ?? 0), 0)
    const workerTitle = workers.find(worker => !genericTitle(worker.title))?.title ?? workers[0]?.title
    const roomTitle = roomGroup.find(room => !genericTitle(room.title))?.title
    const title = workers.length > 1 && roomTitle ? roomTitle : workerTitle ?? roomTitle ?? roomKeys[0]!

    projected.push({
      id: workers.length ? `workers:${workers.map(worker => encodeURIComponent(worker.id)).sort().join(',')}` : roomKeys[0]!,
      title,
      updatedAt: isoOf(Math.max(newestRoom, newestSession)),
      pending: roomGroup.some(room => room.pending) || person,
      workers,
      sessionIds,
      roomKeys,
    })
  }

  projected.sort((a, b) => {
    const personA = a.workers.some(worker => worker.stage.toLocaleLowerCase() === 'person') ? 1 : 0
    const personB = b.workers.some(worker => worker.stage.toLocaleLowerCase() === 'person') ? 1 : 0
    if (personA !== personB) return personB - personA
    const activeA = a.workers.some(worker => worker.active) ? 1 : 0
    const activeB = b.workers.some(worker => worker.active) ? 1 : 0
    if (activeA !== activeB) return activeB - activeA
    return timestamp(b.updatedAt) - timestamp(a.updatedAt) || a.id.localeCompare(b.id)
  })

  return { mainSessions, groups: projected }
}
