/** User-facing task labels shared by the workbench and task views. */
import type { TaskRoomSummary, TaskRoomView } from '../app/task-rooms.ts'

export function sourceLabel(source: string, chinese: boolean): string {
  return ({ web: chinese ? '网页' : 'Web', 'dsh-session': chinese ? '会话' : 'Chat', qq: 'QQ', github: 'GitHub', feishu: chinese ? '飞书' : 'Feishu' } as Record<string, string>)[source] ?? source
}

export function roomTitle(room: TaskRoomSummary, chinese: boolean): string {
  return room.workers[0]?.title || room.title || (chinese ? '未命名任务' : 'Untitled task')
}

export function roomStatus(room: TaskRoomSummary | TaskRoomView, chinese: boolean): {
  key: 'attention' | 'working' | 'waiting' | 'queued' | 'ended' | 'conversation'
  label: string; tone: 'warning' | 'info' | 'success' | 'neutral'
} {
  const copy = (zh: string, en: string) => chinese ? zh : en
  if (room.workers.some(worker => worker.stage === 'person')) return { key: 'attention', label: copy('需要你处理', 'Needs you'), tone: 'warning' }
  if (room.workers.some(worker => worker.active && worker.stage === 'working')) return { key: 'working', label: copy('执行中', 'In progress'), tone: 'info' }
  if (room.pending) return { key: 'queued', label: copy('正在处理请求', 'Processing request'), tone: 'info' }
  if (room.workers.some(worker => worker.active)) return { key: 'waiting', label: copy('等待后续', 'Waiting'), tone: 'warning' }
  if (room.workers.length) return { key: 'ended', label: copy('已结束', 'Ended'), tone: 'neutral' }
  const messages = 'messages' in room ? room.messages : []
  const latestUser = messages.findLast(message => message.kind === 'user')
  const replied = messages.some(message => message.kind !== 'user' && message.kind !== 'assignment' && message.actor.role !== 'system'
    && (!latestUser || message.at >= latestUser.at))
  return { key: 'conversation', label: replied ? copy('已答复', 'Answered') : copy('对话', 'Conversation'), tone: replied ? 'success' : 'neutral' }
}
