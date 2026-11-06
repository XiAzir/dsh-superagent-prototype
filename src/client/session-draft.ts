import { useCallback, useRef, useState } from 'react'

/** Write synchronously so leaving a page immediately after typing still preserves the draft. */
export function useSessionDraft<T>(key: string, initial: T): [T, (next: T | ((current: T) => T)) => void] {
  const [value, setValue] = useState<T>(() => {
    try { const stored = sessionStorage.getItem(key); return stored ? JSON.parse(stored) as T : initial } catch { return initial }
  })
  const current = useRef(value)
  const update = useCallback((next: T | ((current: T) => T)) => {
    let latest = current.current
    try { const stored = sessionStorage.getItem(key); if (stored) latest = JSON.parse(stored) as T } catch { /* Fall back to this editor's state. */ }
    const value = typeof next === 'function' ? (next as (current: T) => T)(latest) : next
    current.current = value
    try { sessionStorage.setItem(key, JSON.stringify(value)) } catch { /* Keep editing when storage is full or unavailable. */ }
    setValue(value)
  }, [key])
  return [value, update]
}
