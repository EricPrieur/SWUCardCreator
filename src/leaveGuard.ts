// Something on the page with changes not saved yet: leaving the page asks whether to save them
// first, and closing or reloading the browser tab warns. One at a time: the page open sets it.
export type LeaveGuard = {
  // What is unsaved, as the question names it: "Fremen Red Aggro"
  what: string
  save: () => void
}

let current: LeaveGuard | null = null

const warn = (event: BeforeUnloadEvent) => {
  event.preventDefault()
}

export function setLeaveGuard(guard: LeaveGuard | null) {
  if (!current && guard) window.addEventListener('beforeunload', warn)
  if (current && !guard) window.removeEventListener('beforeunload', warn)
  current = guard
}

export const leaveGuard = () => current
