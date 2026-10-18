// Shared fix for plugin title bar buttons (Hermes Desktop 0.22).
//
// Plugin tools render in their own cluster LEFT of the app's fixed right cluster, but the
// pane strip only reserves room up to `[data-titlebar-cluster="right"]`. Its 48px
// window-drag handle then lands exactly on the plugin buttons, and Electron gives
// app-region drag priority regardless of z-index, so on macOS the click moves the window
// instead of reaching the button. Tagging the plugin cluster as part of the right cluster
// makes the app's own measurement (first match in DOM order) reserve it as well.
import { useLayoutEffect, useRef } from 'react'

const CHROME_CHANGED = 'hermes:titlebar-chrome-changed'

function fixedAncestor(node) {
  for (let el = node?.parentElement; el && el !== document.body; el = el.parentElement) {
    if (getComputedStyle(el).position === 'fixed') return el
  }
  return null
}

function overlaps(a, b) {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom
}

/** Drag handles still covering the cluster, for the diagnostics log. */
export function dragOverlap(cluster) {
  if (!cluster) return null
  const r = cluster.getBoundingClientRect()
  let hits = 0
  for (const handle of document.querySelectorAll('[data-window-drag-handle]')) {
    const h = handle.getBoundingClientRect()
    if (h.width && overlaps(r, h)) hits++
  }
  return hits
}

export function TitlebarIcon({ children, onReport }) {
  const ref = useRef(null)
  useLayoutEffect(() => {
    const cluster = fixedAncestor(ref.current)
    if (!cluster) return
    let tagged = false
    if (!cluster.hasAttribute('data-titlebar-cluster')) {
      cluster.setAttribute('data-titlebar-cluster', 'right')
      tagged = true
      window.dispatchEvent(new CustomEvent(CHROME_CHANGED))
    }
    if (onReport) {
      const timer = setTimeout(() => onReport({ tagged, cluster: cluster.getAttribute('data-titlebar-cluster'), dragOverlap: dragOverlap(cluster) }), 1500)
      return () => clearTimeout(timer)
    }
  }, [onReport])
  return (
    <span ref={ref} style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>
      {children}
    </span>
  )
}
