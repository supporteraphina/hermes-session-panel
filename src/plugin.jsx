/**
 * Session panel for Hermes Desktop: a side panel with what the focused chat is doing.
 *
 *   Agents       Hermes itself, its live helper agents and background jobs
 *   Environment  backend, working folder, git repo and branch
 *   Context      context window use split by category
 *   Connectors   MCP servers and connected apps
 *   Outputs      files this chat delivered
 *   Changes      uncommitted work in the folder and the pull requests this chat opened
 *
 * Opens from the title bar (list icon) or ⌘K "Toggle session panel" as a tile beside the
 * chat, so it can sit next to the VPS browser and the app's own right sidebar.
 * Gateway RPC gives agents, context and connectors; panel.py (shipped inside this file and
 * written to ~/.hermes/session-panel/ on the backend) reads state.db, git and GitHub.
 */
import { Codicon, host, PALETTE_AREA, atom, useQuery, useValue } from '@hermes/plugin-sdk'
import { useEffect, useState } from 'react'

import { TitlebarIcon } from './titlebar-fix.jsx'

import PANEL_PY from './panel.py'

const ID = 'session-panel'
const KEY = `${ID}:panel`
const PANE_ID = `plugin-workspace:${KEY}`
const PY = '/usr/bin/python3'
const SCRIPT = '"$HOME/.hermes/session-panel/panel.py"'

let os = null
const $mcpBySession = atom({})
const $none = atom(null)
// Older desktops lack some atoms; read those through a null stand-in instead of crashing.
const st = name => host.state?.[name] || $none

// ------------------------------------------------------------------ helpers
const b64 = text => btoa(unescape(encodeURIComponent(text)))

function hash(text) {
  let h = 5381
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0
  return (h >>> 0).toString(36)
}

const errorText = err => (err instanceof Error ? err.message : String(err?.message ?? err))

async function exec(command) {
  const res = await host.request('shell.exec', { command })
  if (!res || res.code !== 0) throw new Error((res && (res.stderr || res.stdout)) || 'command failed')
  return res.stdout || ''
}

function breadcrumb(event, detail = {}) {
  try {
    const line = b64(JSON.stringify({ t: new Date().toISOString(), event, ...detail }) + '\n')
    void host.request('shell.exec', { command: `echo ${line} | base64 -d >> "$HOME/.hermes/session-panel.log"` }).catch(() => {})
  } catch {
    // diagnostics only
  }
}

let scriptReady = null
function ensureScript() {
  if (!scriptReady) {
    const version = hash(PANEL_PY)
    const dir = '"$HOME/.hermes/session-panel"'
    scriptReady = exec(
      `mkdir -p ${dir} && if [ "$(cat ${dir}/.v 2>/dev/null)" != "${version}" ]; then ` +
        `echo ${b64(PANEL_PY)} | base64 -d > ${dir}/panel.py && echo ${version} > ${dir}/.v; fi; echo ok`
    ).catch(err => {
      scriptReady = null
      throw err
    })
  }
  return scriptReady
}

async function loadBackend(stored, cwd) {
  await ensureScript()
  const safeCwd = cwd && /^[\w/.@+\- ]+$/.test(cwd) ? ` --cwd '${cwd}'` : ''
  const head = (await exec(`${PY} ${SCRIPT} --session ${stored}${safeCwd}`)).trim().split('\n').pop()
  const first = JSON.parse(head)
  if (!first.chunks) return first
  let text = ''
  for (let i = 0; i < first.chunks; i++) text += await exec(`${PY} ${SCRIPT} --chunk ${i} --key ${first.key}`)
  return JSON.parse(text)
}

function fmtTok(n) {
  n = Number(n) || 0
  if (n >= 1e6) return `${+(n / 1e6).toFixed(n % 1e6 ? 1 : 0)}M`
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`
  return String(n)
}

function fmtAge(seconds) {
  const s = Math.max(0, Math.round(seconds))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m`
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`
}

const base = path => String(path || '').split('/').filter(Boolean).pop() || path

function fileIcon(path) {
  const ext = String(path).split('.').pop().toLowerCase()
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes(ext)) return 'file-media'
  if (['mp4', 'mov', 'webm', 'mp3', 'wav', 'm4a', 'ogg'].includes(ext)) return 'play-circle'
  if (['md', 'txt'].includes(ext)) return 'markdown'
  if (['pdf', 'docx', 'xlsx', 'pptx', 'csv'].includes(ext)) return 'file'
  if (['html', 'htm'].includes(ext)) return 'globe'
  return 'file-code'
}

// ------------------------------------------------------------------ look
const C = {
  text: 'var(--ui-text-primary, var(--foreground))',
  sub: 'var(--ui-text-secondary)',
  muted: 'var(--ui-text-tertiary)',
  faint: 'var(--ui-text-quaternary)',
  line: 'var(--ui-stroke-tertiary, var(--border))',
  green: 'var(--ui-green, #55a583)',
  red: 'var(--ui-red, #e75e78)',
  purple: 'var(--ui-purple, #a78bfa)',
  hover: 'var(--ui-row-hover-background, rgb(255 255 255 / 0.04))'
}

const S = {
  card: { border: `1px solid ${C.line}`, borderRadius: 12, padding: '10px 12px 12px', display: 'flex', flexDirection: 'column', gap: 6 },
  head: { display: 'flex', alignItems: 'center', gap: 4, background: 'none', border: 0, padding: '2px 0', color: C.text, fontSize: 13, fontWeight: 500, cursor: 'pointer', textAlign: 'left' },
  row: { display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, fontSize: 13, color: C.sub, borderRadius: 6, padding: '3px 4px', margin: '0 -4px' },
  clip: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 },
  note: { fontSize: 12, color: C.muted, lineHeight: 1.4 },
  num: { fontVariantNumeric: 'tabular-nums', color: C.muted, fontSize: 12, flexShrink: 0 }
}

function readCollapsed() {
  try {
    return JSON.parse(localStorage.getItem(`${ID}:collapsed`) || '{}')
  } catch {
    return {}
  }
}
const $collapsed = atom(readCollapsed())

function Card({ id, title, right, children }) {
  const collapsed = useValue($collapsed)
  const open = !collapsed[id]
  const toggle = () => {
    const next = { ...$collapsed.get(), [id]: open }
    $collapsed.set(next)
    try {
      localStorage.setItem(`${ID}:collapsed`, JSON.stringify(next))
    } catch {
      // not persisted
    }
  }
  return (
    <section style={S.card}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <button onClick={toggle} style={S.head} type="button">
          {title}
          <Codicon name={open ? 'chevron-down' : 'chevron-right'} size="0.75rem" style={{ opacity: 0.55 }} />
        </button>
        <span style={{ marginLeft: 'auto', ...S.num }}>{right}</span>
      </div>
      {open ? children : null}
    </section>
  )
}

function Row({ icon, iconColor, children, right, title, onClick }) {
  const [hover, setHover] = useState(false)
  return (
    <div
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{ ...S.row, cursor: onClick ? 'pointer' : 'default', background: onClick && hover ? C.hover : 'transparent' }}
      title={title}
    >
      {icon ? <Codicon name={icon} size="0.9rem" style={{ color: iconColor || C.muted, flexShrink: 0 }} /> : null}
      <div style={{ ...S.clip, flex: 1 }}>{children}</div>
      {right != null ? <span style={S.num}>{right}</span> : null}
    </div>
  )
}

function Dot({ color, pulse }) {
  return (
    <span
      style={{
        display: 'block',
        width: 7,
        height: 7,
        borderRadius: 99,
        background: color,
        flexShrink: 0,
        boxShadow: pulse ? `0 0 0 3px color-mix(in srgb, ${color} 25%, transparent)` : 'none'
      }}
    />
  )
}

function ShowMore({ items, limit = 5, render }) {
  const [all, setAll] = useState(false)
  const shown = all ? items : items.slice(0, limit)
  return (
    <>
      {shown.map(render)}
      {items.length > limit ? (
        <button onClick={() => setAll(!all)} style={{ ...S.note, background: 'none', border: 0, padding: '2px 0', textAlign: 'left', cursor: 'pointer' }} type="button">
          {all ? 'Show less' : `Show ${items.length - limit} more`}
        </button>
      ) : null}
    </>
  )
}

// ------------------------------------------------------------------ sections
function Agents({ sid, busy }) {
  const model = useValue(st('model'))
  const { data } = useQuery({
    queryKey: [ID, 'agents', sid],
    enabled: Boolean(sid),
    refetchInterval: busy ? 3000 : 12000,
    queryFn: async () => {
      const [subs, procs] = await Promise.all([
        host.request('subagent.list', { session_id: sid }).catch(() => null),
        host.request('process.list', { session_id: sid }).catch(() => null)
      ])
      return { subs: subs?.subagents || [], failed: subs?.delegations || [], procs: procs?.processes || [] }
    }
  })
  const subs = data?.subs || []
  const procs = (data?.procs || []).filter(p => !/exited|done|killed/i.test(p.status || ''))
  const failed = (data?.failed || []).slice(0, 3)
  const now = Date.now() / 1000
  const live = subs.filter(s => !['completed', 'failed', 'interrupted', 'cancelled'].includes(String(s.status || '').toLowerCase()))
  return (
    <Card id="agents" right={live.length + procs.length ? `${live.length + procs.length} running` : null} title="Agents">
      <Row icon="hubot" iconColor={busy ? C.green : C.muted} right={busy ? 'Working' : 'Idle'}>
        <span style={{ color: C.text }}>Hermes</span>
        <span style={{ color: C.faint }}>{model ? `  ${model}` : ''}</span>
      </Row>
      {subs.map(s => {
        const status = String(s.status || 'running').toLowerCase()
        const running = !['completed', 'failed', 'interrupted', 'cancelled'].includes(status)
        const color = status === 'failed' ? C.red : running ? C.green : C.faint
        const meta = [s.model, s.tool_count != null ? `${s.tool_count} tools` : null, s.last_tool, s.started_at ? fmtAge(now - s.started_at) : null]
          .filter(Boolean)
          .join(' · ')
        return (
          <div key={s.subagent_id} style={{ ...S.row, alignItems: 'flex-start' }} title={s.goal || ''}>
            <span style={{ width: 14.4, flexShrink: 0, display: 'flex', justifyContent: 'center', paddingTop: 6 }}>
              <Dot color={color} pulse={running} />
            </span>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{ ...S.clip, color: C.text }}>{s.goal || 'Helper agent'}</div>
              <div style={{ ...S.clip, ...S.note }}>{meta || status}</div>
            </div>
          </div>
        )
      })}
      {procs.map(p => (
        <Row icon="terminal" key={p.session_id} right={p.uptime != null ? fmtAge(p.uptime) : p.status} title={p.command}>
          {p.command}
        </Row>
      ))}
      {failed.map(f => (
        <Row icon="error" iconColor={C.red} key={`${f.delegation_id}:${f.task_index}`} title={f.error || ''}>
          {f.goal || 'Helper agent'} <span style={{ color: C.faint }}>failed</span>
        </Row>
      ))}
      {!subs.length && !procs.length && !failed.length ? <div style={S.note}>No helper agents or background jobs in this chat.</div> : null}
    </Card>
  )
}

function useConnectionLabel() {
  const connectionId = useValue(st('connectionId'))
  const { data } = useQuery({
    queryKey: [ID, 'connections'],
    staleTime: 5 * 60 * 1000,
    queryFn: async () => (typeof host.connections === 'function' ? host.connections() : [])
  })
  const rows = Array.isArray(data) ? data : []
  const row = rows.find(r => r.id === connectionId) || rows.find(r => r.primary)
  return row?.label || row?.name || null
}

function Environment({ env, loading }) {
  const label = useConnectionLabel()
  const git = env?.git
  return (
    <Card id="environment" title="Environment">
      <Row icon="cloud" title={env ? `${env.user}@${env.host}` : ''}>
        {label || env?.host || 'Backend'}
      </Row>
      <Row icon="folder" onClick={env?.cwd ? () => copy(env.cwd) : undefined} title={env?.cwd ? `${env.cwd} (click to copy)` : ''}>
        {env?.cwd ? base(env.cwd) || env.cwd : loading ? 'Loading' : 'Unknown'}
      </Row>
      {git ? (
        <>
          <Row icon="repo" onClick={git.repo?.includes('/') ? () => open(`https://github.com/${git.repo}`) : undefined} title={git.root}>
            {git.repo}
          </Row>
          <Row icon="git-branch">{git.branch}</Row>
        </>
      ) : env ? (
        <div style={{ ...S.note, paddingLeft: 22 }}>Folder is not a git repo</div>
      ) : null}
    </Card>
  )
}

function Context({ sid, busy }) {
  const usage = useValue(st('focusedUsage'))
  const [openFiles, setOpenFiles] = useState(false)
  const { data, refetch, dataUpdatedAt } = useQuery({
    queryKey: [ID, 'context', sid],
    enabled: Boolean(sid),
    refetchInterval: busy ? 15000 : 60000,
    queryFn: () => host.request('session.context_breakdown', { session_id: sid })
  })
  useEffect(() => {
    if (!busy && sid) void refetch()
  }, [busy, sid, refetch])
  const max = data?.context_max || usage?.context_max || 0
  const used = data?.context_used || usage?.context_used || 0
  const pct = max ? Math.round((used / max) * 100) : data?.context_percent || usage?.context_percent || 0
  const cats = (data?.categories || []).filter(c => c.tokens > 0)
  const est = cats.reduce((s, c) => s + c.tokens, 0) || 1
  const files = data?.context_files || []
  return (
    <Card id="context" title="Context">
      {max ? (
        <>
          <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', fontSize: 13 }}>
            <span style={{ color: C.text }}>{pct}% used</span>
            <span style={S.num}>
              {fmtTok(used)} / {fmtTok(max)}
            </span>
          </div>
          <div style={{ display: 'flex', height: 6, borderRadius: 99, overflow: 'hidden', background: `color-mix(in srgb, ${C.faint} 30%, transparent)` }}>
            {cats.length ? (
              cats.map(c => <span key={c.id} style={{ width: `${(c.tokens / est) * Math.min(100, pct)}%`, background: c.color, marginRight: 1 }} />)
            ) : (
              <span style={{ width: `${Math.min(100, pct)}%`, background: 'var(--ui-accent)' }} />
            )}
          </div>
          {cats.map(c => (
            <div key={c.id} style={{ ...S.row, padding: '1px 4px' }}>
              <span style={{ width: 10, height: 10, borderRadius: 3, background: c.color, flexShrink: 0 }} />
              <span style={{ ...S.clip, flex: 1 }}>{c.label}</span>
              <span style={S.num}>{fmtTok(c.tokens)}</span>
              <span style={{ ...S.num, width: 44, textAlign: 'right' }}>{((c.tokens / max) * 100).toFixed(1)}%</span>
            </div>
          ))}
          <div style={{ ...S.row, padding: '1px 4px' }}>
            <span style={{ width: 10, height: 10, borderRadius: 3, border: `1px solid ${C.line}`, flexShrink: 0 }} />
            <span style={{ ...S.clip, flex: 1 }}>Free space</span>
            <span style={S.num}>{fmtTok(Math.max(0, max - used))}</span>
            <span style={{ ...S.num, width: 44, textAlign: 'right' }}>{(Math.max(0, 1 - used / max) * 100).toFixed(1)}%</span>
          </div>
          {files.length ? (
            <>
              <button onClick={() => setOpenFiles(!openFiles)} style={{ ...S.row, background: 'none', border: 0, cursor: 'pointer', padding: '3px 4px' }} type="button">
                <Codicon name={openFiles ? 'chevron-down' : 'chevron-right'} size="0.75rem" />
                <span style={{ flex: 1, textAlign: 'left' }}>Context files</span>
                <span style={S.num}>{files.length}</span>
              </button>
              {openFiles
                ? files.map(f => (
                    <Row icon="file" key={f.path} right={f.loaded ? fmtTok(f.est_tokens) : f.status} title={f.path}>
                      <span style={{ color: f.loaded ? C.sub : C.faint }}>{f.label || base(f.path)}</span>
                    </Row>
                  ))
                : null}
            </>
          ) : null}
          <div style={S.note}>
            {cats.length ? 'Split is estimated. ' : 'Send a message to see the split. '}
            {dataUpdatedAt ? `Updated ${fmtAge((Date.now() - dataUpdatedAt) / 1000)} ago.` : ''}
          </div>
        </>
      ) : (
        <div style={S.note}>Send a message to see context usage.</div>
      )}
    </Card>
  )
}

function Connectors({ sid }) {
  const live = useValue($mcpBySession)[sid] || null
  const { data } = useQuery({
    queryKey: [ID, 'connectors'],
    staleTime: 5 * 60 * 1000,
    refetchInterval: 5 * 60 * 1000,
    queryFn: async () => {
      const [cfg, hosted] = await Promise.all([
        host.request('config.get', { key: 'full' }).catch(() => null),
        host.request('connectors.list', { owner: { type: 'account' } }).catch(() => null)
      ])
      const servers = Object.entries(cfg?.config?.mcp_servers || {}).map(([name, v]) => ({ name, enabled: v?.enabled !== false }))
      const apps = (hosted?.connectors || []).filter(c => c.connected).map(c => ({ name: c.connector, status: c.connection_status }))
      return { servers, apps }
    }
  })
  const liveByName = Object.fromEntries((live || []).map(s => [s.name, s]))
  const items = [
    ...(data?.servers || []).map(s => {
      const l = liveByName[s.name]
      const status = !s.enabled || l?.disabled ? 'off' : l?.status || (l?.error ? 'failed' : l?.connected ? 'connected' : null)
      const ok = l?.connected === true || /^(connected|ready|active|ok)$/i.test(status || '')
      const tools = l?.tools ?? l?.tool_count
      return {
        key: `mcp:${s.name}`,
        name: s.name.replace(/_/g, ' '),
        icon: 'plug',
        color: status === 'off' ? C.faint : l?.error || /fail|error/i.test(status || '') ? C.red : ok ? C.green : C.muted,
        right: status === 'off' ? 'off' : typeof tools === 'number' ? `${tools} tools` : 'MCP',
        title: l?.error || status || 'MCP server'
      }
    }),
    ...(data?.apps || []).map(a => ({ key: `app:${a.name}`, name: a.name, icon: 'link', color: C.green, right: 'app', title: a.status || 'connected' }))
  ]
  return (
    <Card id="connectors" right={items.length || null} title="Connectors">
      {items.length ? (
        <ShowMore
          items={items}
          render={it => (
            <Row icon={it.icon} iconColor={it.color} key={it.key} right={it.right} title={it.title}>
              {it.name}
            </Row>
          )}
        />
      ) : (
        <div style={S.note}>{data ? 'No connectors set up.' : 'Loading'}</div>
      )}
    </Card>
  )
}

function Outputs({ env }) {
  const files = env?.outputs || []
  return (
    <Card id="outputs" right={files.length || null} title="Outputs">
      {files.length ? (
        <ShowMore
          items={files}
          render={f => (
            <Row icon={fileIcon(f.path)} key={f.path} onClick={() => copy(f.path)} title={`${f.path} (click to copy)`}>
              {base(f.path)}
            </Row>
          )}
        />
      ) : (
        <div style={S.note}>{env ? 'No files delivered in this chat yet.' : 'Loading'}</div>
      )}
    </Card>
  )
}

const PR_LOOK = {
  MERGED: { icon: 'git-merge', color: C.purple },
  OPEN: { icon: 'git-pull-request', color: C.green },
  CLOSED: { icon: 'git-pull-request-closed', color: C.red }
}

function Changes({ env }) {
  const git = env?.git
  const prs = env?.prs || []
  const dirty = git && git.dirty > 0
  return (
    <Card id="changes" right={prs.length || null} title="Changes">
      {dirty ? (
        <Row icon="diff" iconColor="var(--ui-yellow, #c08532)" title={git.root}>
          {git.dirty} uncommitted file{git.dirty === 1 ? '' : 's'} in {base(git.root)}{' '}
          <span style={{ color: C.green }}>+{git.add}</span> <span style={{ color: C.red }}>−{git.del}</span>
        </Row>
      ) : null}
      {prs.length ? (
        <ShowMore
          items={prs}
          render={p => {
            const look = p.draft ? { icon: 'git-pull-request-draft', color: C.faint } : PR_LOOK[p.state] || { icon: 'git-pull-request', color: C.muted }
            return (
              <div key={p.url} onClick={() => open(p.url)} style={{ ...S.row, alignItems: 'flex-start', cursor: 'pointer' }} title={p.url}>
                <Codicon name={look.icon} size="0.9rem" style={{ color: look.color, flexShrink: 0, marginTop: 2 }} />
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ ...S.clip, color: C.text }}>{p.title || `${p.repo} #${p.num}`}</div>
                  <div style={{ ...S.note, display: 'flex', gap: 6, whiteSpace: 'nowrap' }}>
                    <span style={S.clip}>
                      {p.repo} #{p.num}
                    </span>
                    {p.add != null ? <span style={{ color: C.green }}>+{p.add}</span> : null}
                    {p.del != null ? <span style={{ color: C.red }}>−{p.del}</span> : null}
                    <span style={{ marginLeft: 'auto', flexShrink: 0 }}>{p.draft ? 'draft' : (p.state || '').toLowerCase()}</span>
                  </div>
                </div>
              </div>
            )
          }}
        />
      ) : null}
      {!dirty && !prs.length ? <div style={S.note}>{env ? 'No changes or pull requests in this chat yet.' : 'Loading'}</div> : null}
    </Card>
  )
}

// ------------------------------------------------------------------ panel
function copy(text) {
  Promise.resolve(os?.writeClipboard?.(text))
    .then(ok => host.notify?.({ kind: ok === false ? 'error' : 'success', message: ok === false ? 'Could not copy' : 'Path copied' }))
    .catch(() => {})
}

function open(url) {
  Promise.resolve(os?.openExternal?.(url)).catch(() => {})
}

function SessionPanel() {
  const sid = useValue(st('focusedSessionId'))
  const stored = useValue(st('focusedStoredSessionId'))
  const cwd = useValue(st('cwd'))
  const busy = Boolean(useValue(st('busy')))
  const backend = useQuery({
    queryKey: [ID, 'backend', stored, cwd],
    enabled: Boolean(stored && /^[\w.-]+$/.test(stored)),
    refetchInterval: busy ? 20000 : 60000,
    staleTime: 10000,
    queryFn: () => loadBackend(stored, cwd)
  })
  useEffect(() => {
    if (backend.error) breadcrumb('backend-error', { message: errorText(backend.error) })
  }, [backend.error])
  const env = backend.data || null
  if (!sid && !stored) {
    return <div style={{ padding: 16, ...S.note }}>Open a chat to see its details.</div>
  }
  return (
    <div style={{ height: '100%', overflowY: 'auto' }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: 12, maxWidth: 520 }}>
        <Agents busy={busy} sid={sid} />
        <Environment env={env} loading={backend.isLoading} />
        <Context busy={busy} sid={sid} />
        <Connectors sid={sid} />
        <Outputs env={env} />
        <Changes env={env} />
        {backend.error && !env ? <div style={{ ...S.note, color: C.red }}>{errorText(backend.error)}</div> : null}
      </div>
    </div>
  )
}

let titlebarReported = false
function reportTitlebar(info) {
  if (titlebarReported) return
  titlebarReported = true
  breadcrumb('titlebar', info)
}

export default {
  id: ID,
  name: 'Session panel',
  register(ctx) {
    os = ctx.os || null
    let closeTile = null

    const isVisible = () => {
      try {
        return Boolean(host.paneVisibility?.(PANE_ID)?.get())
      } catch {
        return false
      }
    }

    const toggle = () => {
      try {
        if (closeTile && isVisible()) {
          closeTile()
          closeTile = null
        } else if (closeTile) {
          host.revealPane?.(PANE_ID)
        } else {
          closeTile = host.openWorkspace(KEY, {
            title: 'Session',
            minWidth: '18rem',
            dock: { pane: 'workspace', pos: 'right' },
            render: () => <SessionPanel />,
            onClose: () => {
              closeTile = null
            }
          })
        }
        breadcrumb('toggle', { open: Boolean(closeTile), visible: isVisible() })
      } catch (err) {
        breadcrumb('toggle-error', { message: errorText(err) })
        host.notify?.({ kind: 'error', message: `Session panel: ${errorText(err)}` })
      }
    }

    // Live MCP status rides on session.info events; keep the latest per runtime session.
    const onInfo = ev => {
      const sid = ev?.session_id || ev?.payload?.session_id
      const servers = ev?.payload?.mcp_servers ?? ev?.mcp_servers ?? ev?.payload?.info?.mcp_servers
      if (sid && Array.isArray(servers)) $mcpBySession.set({ ...$mcpBySession.get(), [sid]: servers })
    }
    if (typeof ctx.onEvent === 'function') ctx.onEvent('session.info', onInfo)
    else host.onEvent?.('session.info', onInfo)

    ctx.onDispose?.(() => closeTile?.())
    breadcrumb('loaded', { workspace: typeof host.openWorkspace === 'function' })
    void ensureScript().catch(err => breadcrumb('install-error', { message: errorText(err) }))

    ctx.register({
      id: 'titlebar',
      area: 'titleBar.tools.right',
      data: {
        id: 'session-panel',
        label: 'Session details',
        icon: (
          <TitlebarIcon onReport={reportTitlebar}>
            <Codicon className="leading-none" name="list-unordered" size="13.9px" />
          </TitlebarIcon>
        ),
        onSelect: toggle
      }
    })

    ctx.register({
      id: 'palette',
      area: PALETTE_AREA,
      data: {
        id: 'session-panel.toggle',
        label: 'Toggle session panel',
        keywords: ['session', 'context', 'agents', 'outputs', 'changes', 'connectors', 'environment'],
        run: toggle
      }
    })
  }
}
