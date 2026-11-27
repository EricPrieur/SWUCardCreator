import { useEffect, useState } from 'react'

// A newer version of the site out: a bar that offers to reload. Each deploy names the site's code
// anew (assets/index-<hash>.js); the page compares the name in the site's front page with the
// one it runs, every few minutes and whenever the tab is seen again (a phone kept an old copy
// open for hours, its user still without a new switch; 2026-11-27). It only asks: a reload could
// lose a card or a game in progress.
const CHECK_EVERY = 5 * 60 * 1000
const BUNDLE = /assets\/index-[\w-]+\.js/

const running = () => {
  const script = document.querySelector<HTMLScriptElement>('script[type="module"][src*="assets/index-"]')
  return script?.src.match(BUNDLE)?.[0]
}

export function UpdateBanner() {
  const [newer, setNewer] = useState(false)
  const [closed, setClosed] = useState(false)

  useEffect(() => {
    const mine = running()
    // The dev server has no bundle to compare
    if (!mine) return
    const check = async () => {
      try {
        const response = await fetch(new URL('./', window.location.href), { cache: 'no-store' })
        if (!response.ok) return
        const live = (await response.text()).match(BUNDLE)?.[0]
        if (live && live !== mine) setNewer(true)
      } catch {
        // Offline: checked again later
      }
    }
    const seen = () => document.visibilityState === 'visible' && check()
    const timer = window.setInterval(check, CHECK_EVERY)
    document.addEventListener('visibilitychange', seen)
    return () => {
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', seen)
    }
  }, [])

  if (!newer || closed) return null
  return (
    <div className="update-banner" role="status">
      <span>A new version of the site is out.</span>
      <button className="button" type="button" onClick={() => window.location.reload()}>
        Reload
      </button>
      <button className="update-close" type="button" aria-label="Close" title="Not now" onClick={() => setClosed(true)}>
        ×
      </button>
    </div>
  )
}
