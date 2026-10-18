/* Session panel for Hermes Desktop. Source: src/ in this repo. */
import{Codicon as $,host as h,PALETTE_AREA as Z,atom as q,useQuery as R,useValue as w}from"@hermes/plugin-sdk";import{useEffect as G,useState as L}from"react";var O=`#!/usr/bin/env python3
"""Backend half of the Hermes Session panel desktop plugin.

Reads one chat (and the chats it was compressed from) out of state.db read only and
prints compact JSON: where the chat works (folder, git repo, branch), the files it
delivered, and the pull requests it opened, with their live state from GitHub.

    panel.py --session <stored id> [--cwd <dir>]      JSON, or {"chunks": n, "key": k} when long
    panel.py --chunk <i> --key <k>                    one slice of a long answer

Stdlib only. shell.exec keeps only the last 4000 characters of stdout, so long answers
are written to a file and read back in slices.
"""
from __future__ import annotations

import argparse
import concurrent.futures as cf
import json
import os
import re
import socket
import sqlite3
import subprocess
import time
from pathlib import Path

HOME = Path(os.environ.get("HERMES_HOME") or Path.home() / ".hermes")
STATE = HOME / "session-panel"
PR_CACHE = STATE / "pr-cache.json"
CHUNK = 3500
MAX_OUTPUTS = 30
MAX_PRS = 12

PR_RE = re.compile(r"https://github\\.com/([\\w.-]+)/([\\w.-]+)/pull/(\\d+)")
MEDIA_RE = re.compile(r"MEDIA:(/[^\\s)\\]\`'\\"<>]+)")
SKIP_PARTS = ("/.hermes/cache/", "/tmp/", "/.worktrees/", "/node_modules/")
GH_ENV = {**os.environ, "GH_CONFIG_DIR": str(Path.home() / ".config" / "gh"), "GH_PROMPT_DISABLED": "1", "NO_COLOR": "1"}
for var in ("XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "DISPLAY"):
    GH_ENV.pop(var, None)


def run(args: list[str], cwd: str | None = None, timeout: float = 8) -> str:
    try:
        out = subprocess.run(args, cwd=cwd, capture_output=True, text=True, timeout=timeout, env=GH_ENV)
        return out.stdout.strip() if out.returncode == 0 else ""
    except Exception:
        return ""


def lineage(db: sqlite3.Connection, session_id: str) -> list[str]:
    """The chat plus every chat it was compressed from, oldest first."""
    ids, seen, cur = [], set(), session_id
    while cur and cur not in seen and len(ids) < 50:
        seen.add(cur)
        ids.append(cur)
        row = db.execute("select parent_session_id from sessions where id = ?", (cur,)).fetchone()
        cur = row[0] if row else None
    return list(reversed(ids))


def git_info(cwd: str) -> dict | None:
    if not cwd or not os.path.isdir(cwd):
        return None
    root = run(["git", "-C", cwd, "rev-parse", "--show-toplevel"])
    if not root:
        return None
    info = {"root": root, "branch": run(["git", "-C", root, "rev-parse", "--abbrev-ref", "HEAD"])}
    remote = run(["git", "-C", root, "remote", "get-url", "origin"])
    m = re.search(r"github\\.com[:/]([\\w.-]+)/([\\w.-]+?)(?:\\.git)?$", remote)
    info["repo"] = f"{m.group(1)}/{m.group(2)}" if m else (Path(root).name if not remote else remote.rsplit("/", 1)[-1])
    status = run(["git", "-C", root, "status", "--porcelain"])
    info["dirty"] = len([line for line in status.splitlines() if line.strip()])
    stat = run(["git", "-C", root, "diff", "--shortstat", "HEAD"])
    add = re.search(r"(\\d+) insertion", stat)
    dele = re.search(r"(\\d+) deletion", stat)
    info["add"] = int(add.group(1)) if add else 0
    info["del"] = int(dele.group(1)) if dele else 0
    return info


def scan(db: sqlite3.Connection, ids: list[str]) -> tuple[list[dict], list[str]]:
    outputs: dict[str, dict] = {}
    prs: dict[str, float] = {}
    marks = ",".join("?" * len(ids))
    rows = db.execute(
        f"select role, content, tool_calls, timestamp from messages where session_id in ({marks}) order by timestamp, id",
        ids,
    )
    for role, content, tool_calls, ts in rows:
        ts = float(ts or 0)
        text = content if isinstance(content, str) else ""
        if role == "assistant" and tool_calls:
            try:
                calls = json.loads(tool_calls)
            except Exception:
                calls = []
            for call in calls or []:
                fn = (call or {}).get("function") or {}
                if fn.get("name") != "write_file":
                    continue
                try:
                    args = json.loads(fn.get("arguments") or "{}")
                except Exception:
                    args = {}
                path = args.get("path")
                if isinstance(path, str) and path.startswith("/"):
                    outputs[path] = {"path": path, "ts": ts, "via": "write"}
        if role == "assistant" and "MEDIA:" in text:
            for path in MEDIA_RE.findall(text):
                outputs[path.rstrip(".,;")] = {"path": path.rstrip(".,;"), "ts": ts, "via": "media"}
        if role in ("tool", "assistant") and "github.com/" in text:
            for owner, repo, num in PR_RE.findall(text):
                prs[f"https://github.com/{owner}/{repo}/pull/{num}"] = ts
    files = []
    for item in sorted(outputs.values(), key=lambda o: -o["ts"]):
        path = item["path"]
        if item["via"] == "write" and any(part in path for part in SKIP_PARTS):
            continue
        try:
            st = os.stat(path)
        except OSError:
            continue
        files.append({"path": path, "size": st.st_size, "ts": int(item["ts"])})
        if len(files) >= MAX_OUTPUTS:
            break
    ordered = [url for url, _ in sorted(prs.items(), key=lambda kv: -kv[1])][:MAX_PRS]
    return files, ordered


def pr_details(urls: list[str]) -> list[dict]:
    try:
        cache = json.loads(PR_CACHE.read_text())
    except Exception:
        cache = {}
    now = time.time()

    def fresh(url: str) -> bool:
        hit = cache.get(url)
        if not hit:
            return False
        ttl = 7 * 86400 if hit.get("state") in ("MERGED", "CLOSED") else 120
        return now - hit.get("at", 0) < ttl

    def fetch(url: str) -> tuple[str, dict | None]:
        raw = run(["gh", "pr", "view", url, "--json", "number,title,state,additions,deletions,isDraft,headRefName"], timeout=12)
        try:
            data = json.loads(raw)
        except Exception:
            return url, None
        data["at"] = now
        return url, data

    todo = [u for u in urls if not fresh(u)]
    if todo:
        with cf.ThreadPoolExecutor(max_workers=6) as pool:
            for url, data in pool.map(fetch, todo):
                if data:
                    cache[url] = data
        try:
            STATE.mkdir(parents=True, exist_ok=True)
            PR_CACHE.write_text(json.dumps(cache))
        except OSError:
            pass
    out = []
    for url in urls:
        m = PR_RE.search(url)
        hit = cache.get(url) or {}
        out.append({
            "url": url,
            "repo": m.group(2),
            "num": int(m.group(3)),
            "title": (hit.get("title") or "")[:90],
            "state": hit.get("state") or "",
            "draft": bool(hit.get("isDraft")),
            "add": hit.get("additions"),
            "del": hit.get("deletions"),
        })
    return out


def build(session_id: str, cwd: str) -> dict:
    db_path = HOME / "state.db"
    db = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True, timeout=5)
    try:
        ids = lineage(db, session_id) if session_id else []
        row = db.execute("select cwd, git_branch from sessions where id = ?", (session_id,)).fetchone() if session_id else None
        session_cwd = (row[0] if row else None) or cwd or str(Path.home())
        files, pr_urls = scan(db, ids) if ids else ([], [])
    finally:
        db.close()
    return {
        "host": socket.gethostname(),
        "user": os.environ.get("USER") or Path.home().name,
        "cwd": session_cwd,
        "git": git_info(session_cwd),
        "outputs": files,
        "prs": pr_details(pr_urls) if pr_urls else [],
        "chats": len(ids),
        "at": int(time.time()),
    }


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--session", default="")
    ap.add_argument("--cwd", default="")
    ap.add_argument("--chunk", type=int)
    ap.add_argument("--key", default="")
    a = ap.parse_args()
    if a.chunk is not None:
        key = re.sub(r"[^\\w.-]", "_", a.key)[:80]
        text = (STATE / f"out-{key}.json").read_text()
        print(text[a.chunk * CHUNK:(a.chunk + 1) * CHUNK], end="")
        return
    text = json.dumps(build(a.session, a.cwd), separators=(",", ":"))
    if len(text) <= CHUNK:
        print(text)
        return
    key = re.sub(r"[^\\w.-]", "_", a.session or "none")[:80]
    STATE.mkdir(parents=True, exist_ok=True)
    (STATE / f"out-{key}.json").write_text(text)
    print(json.dumps({"chunks": (len(text) + CHUNK - 1) // CHUNK, "key": key}))


if __name__ == "__main__":
    main()
`;import{Fragment as N,jsx as o,jsxs as d}from"react/jsx-runtime";var x="session-panel",z=`${x}:panel`,U=`plugin-workspace:${z}`,B="/usr/bin/python3",K='"$HOME/.hermes/session-panel/panel.py"',j=null,H=q({}),ee=q(null),v=e=>h.state?.[e]||ee,W=e=>btoa(unescape(encodeURIComponent(e)));function te(e){let t=5381;for(let r=0;r<e.length;r++)t=(t<<5)+t+e.charCodeAt(r)|0;return(t>>>0).toString(36)}var C=e=>e instanceof Error?e.message:String(e?.message??e);async function I(e){let t=await h.request("shell.exec",{command:e});if(!t||t.code!==0)throw new Error(t&&(t.stderr||t.stdout)||"command failed");return t.stdout||""}function E(e,t={}){try{let r=W(JSON.stringify({t:new Date().toISOString(),event:e,...t})+`
`);h.request("shell.exec",{command:`echo ${r} | base64 -d >> "$HOME/.hermes/session-panel.log"`}).catch(()=>{})}catch{}}var A=null;function J(){if(!A){let e=te(O),t='"$HOME/.hermes/session-panel"';A=I(`mkdir -p ${t} && if [ "$(cat ${t}/.v 2>/dev/null)" != "${e}" ]; then echo ${W(O)} | base64 -d > ${t}/panel.py && echo ${e} > ${t}/.v; fi; echo ok`).catch(r=>{throw A=null,r})}return A}async function ne(e,t){await J();let r=t&&/^[\w/.@+\- ]+$/.test(t)?` --cwd '${t}'`:"",a=(await I(`${B} ${K} --session ${e}${r}`)).trim().split(`
`).pop(),s=JSON.parse(a);if(!s.chunks)return s;let n="";for(let u=0;u<s.chunks;u++)n+=await I(`${B} ${K} --chunk ${u} --key ${s.key}`);return JSON.parse(n)}function S(e){return e=Number(e)||0,e>=1e6?`${+(e/1e6).toFixed(e%1e6?1:0)}M`:e>=1e3?`${(e/1e3).toFixed(1)}k`:String(e)}function D(e){let t=Math.max(0,Math.round(e));return t<60?`${t}s`:t<3600?`${Math.floor(t/60)}m`:`${Math.floor(t/3600)}h ${Math.floor(t%3600/60)}m`}var P=e=>String(e||"").split("/").filter(Boolean).pop()||e;function oe(e){let t=String(e).split(".").pop().toLowerCase();return["png","jpg","jpeg","gif","webp","svg"].includes(t)?"file-media":["mp4","mov","webm","mp3","wav","m4a","ogg"].includes(t)?"play-circle":["md","txt"].includes(t)?"markdown":["pdf","docx","xlsx","pptx","csv"].includes(t)?"file":["html","htm"].includes(t)?"globe":"file-code"}var l={text:"var(--ui-text-primary, var(--foreground))",sub:"var(--ui-text-secondary)",muted:"var(--ui-text-tertiary)",faint:"var(--ui-text-quaternary)",line:"var(--ui-stroke-tertiary, var(--border))",green:"var(--ui-green, #55a583)",red:"var(--ui-red, #e75e78)",purple:"var(--ui-purple, #a78bfa)",hover:"var(--ui-row-hover-background, rgb(255 255 255 / 0.04))"},c={card:{border:`1px solid ${l.line}`,borderRadius:12,padding:"10px 12px 12px",display:"flex",flexDirection:"column",gap:6},head:{display:"flex",alignItems:"center",gap:4,background:"none",border:0,padding:"2px 0",color:l.text,fontSize:13,fontWeight:500,cursor:"pointer",textAlign:"left"},row:{display:"flex",alignItems:"center",gap:8,minWidth:0,fontSize:13,color:l.sub,borderRadius:6,padding:"3px 4px",margin:"0 -4px"},clip:{overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",minWidth:0},note:{fontSize:12,color:l.muted,lineHeight:1.4},num:{fontVariantNumeric:"tabular-nums",color:l.muted,fontSize:12,flexShrink:0}};function se(){try{return JSON.parse(localStorage.getItem(`${x}:collapsed`)||"{}")}catch{return{}}}var M=q(se());function _({id:e,title:t,right:r,children:a}){let n=!w(M)[e],u=()=>{let f={...M.get(),[e]:n};M.set(f);try{localStorage.setItem(`${x}:collapsed`,JSON.stringify(f))}catch{}};return d("section",{style:c.card,children:[d("div",{style:{display:"flex",alignItems:"center",gap:8},children:[d("button",{onClick:u,style:c.head,type:"button",children:[t,o($,{name:n?"chevron-down":"chevron-right",size:"0.75rem",style:{opacity:.55}})]}),o("span",{style:{marginLeft:"auto",...c.num},children:r})]}),n?a:null]})}function y({icon:e,iconColor:t,children:r,right:a,title:s,onClick:n}){let[u,f]=L(!1);return d("div",{onClick:n,onMouseEnter:()=>f(!0),onMouseLeave:()=>f(!1),style:{...c.row,cursor:n?"pointer":"default",background:n&&u?l.hover:"transparent"},title:s,children:[e?o($,{name:e,size:"0.9rem",style:{color:t||l.muted,flexShrink:0}}):null,o("div",{style:{...c.clip,flex:1},children:r}),a!=null?o("span",{style:c.num,children:a}):null]})}function re({color:e,pulse:t}){return o("span",{style:{display:"block",width:7,height:7,borderRadius:99,background:e,flexShrink:0,boxShadow:t?`0 0 0 3px color-mix(in srgb, ${e} 25%, transparent)`:"none"}})}function F({items:e,limit:t=5,render:r}){let[a,s]=L(!1),n=a?e:e.slice(0,t);return d(N,{children:[n.map(r),e.length>t?o("button",{onClick:()=>s(!a),style:{...c.note,background:"none",border:0,padding:"2px 0",textAlign:"left",cursor:"pointer"},type:"button",children:a?"Show less":`Show ${e.length-t} more`}):null]})}function ie({sid:e,busy:t}){let r=w(v("model")),{data:a}=R({queryKey:[x,"agents",e],enabled:!!e,refetchInterval:t?3e3:12e3,queryFn:async()=>{let[i,m]=await Promise.all([h.request("subagent.list",{session_id:e}).catch(()=>null),h.request("process.list",{session_id:e}).catch(()=>null)]);return{subs:i?.subagents||[],failed:i?.delegations||[],procs:m?.processes||[]}}}),s=a?.subs||[],n=(a?.procs||[]).filter(i=>!/exited|done|killed/i.test(i.status||"")),u=(a?.failed||[]).slice(0,3),f=Date.now()/1e3,g=s.filter(i=>!["completed","failed","interrupted","cancelled"].includes(String(i.status||"").toLowerCase()));return d(_,{id:"agents",right:g.length+n.length?`${g.length+n.length} running`:null,title:"Agents",children:[d(y,{icon:"hubot",iconColor:t?l.green:l.muted,right:t?"Working":"Idle",children:[o("span",{style:{color:l.text},children:"Hermes"}),o("span",{style:{color:l.faint},children:r?`  ${r}`:""})]}),s.map(i=>{let m=String(i.status||"running").toLowerCase(),b=!["completed","failed","interrupted","cancelled"].includes(m),T=m==="failed"?l.red:b?l.green:l.faint,k=[i.model,i.tool_count!=null?`${i.tool_count} tools`:null,i.last_tool,i.started_at?D(f-i.started_at):null].filter(Boolean).join(" \xB7 ");return d("div",{style:{...c.row,alignItems:"flex-start"},title:i.goal||"",children:[o("span",{style:{width:14.4,flexShrink:0,display:"flex",justifyContent:"center",paddingTop:6},children:o(re,{color:T,pulse:b})}),d("div",{style:{minWidth:0,flex:1},children:[o("div",{style:{...c.clip,color:l.text},children:i.goal||"Helper agent"}),o("div",{style:{...c.clip,...c.note},children:k||m})]})]},i.subagent_id)}),n.map(i=>o(y,{icon:"terminal",right:i.uptime!=null?D(i.uptime):i.status,title:i.command,children:i.command},i.session_id)),u.map(i=>d(y,{icon:"error",iconColor:l.red,title:i.error||"",children:[i.goal||"Helper agent"," ",o("span",{style:{color:l.faint},children:"failed"})]},`${i.delegation_id}:${i.task_index}`)),!s.length&&!n.length&&!u.length?o("div",{style:c.note,children:"No helper agents or background jobs in this chat."}):null]})}function ae(){let e=w(v("connectionId")),{data:t}=R({queryKey:[x,"connections"],staleTime:300*1e3,queryFn:async()=>typeof h.connections=="function"?h.connections():[]}),r=Array.isArray(t)?t:[],a=r.find(s=>s.id===e)||r.find(s=>s.primary);return a?.label||a?.name||null}function le({env:e,loading:t}){let r=ae(),a=e?.git;return d(_,{id:"environment",title:"Environment",children:[o(y,{icon:"cloud",title:e?`${e.user}@${e.host}`:"",children:r||e?.host||"Backend"}),o(y,{icon:"folder",onClick:e?.cwd?()=>V(e.cwd):void 0,title:e?.cwd?`${e.cwd} (click to copy)`:"",children:e?.cwd?P(e.cwd)||e.cwd:t?"Loading":"Unknown"}),a?d(N,{children:[o(y,{icon:"repo",onClick:a.repo?.includes("/")?()=>X(`https://github.com/${a.repo}`):void 0,title:a.root,children:a.repo}),o(y,{icon:"git-branch",children:a.branch})]}):e?o("div",{style:{...c.note,paddingLeft:22},children:"Folder is not a git repo"}):null]})}function ce({sid:e,busy:t}){let r=w(v("focusedUsage")),[a,s]=L(!1),{data:n,refetch:u,dataUpdatedAt:f}=R({queryKey:[x,"context",e],enabled:!!e,refetchInterval:t?15e3:6e4,queryFn:()=>h.request("session.context_breakdown",{session_id:e})});G(()=>{!t&&e&&u()},[t,e,u]);let g=n?.context_max||r?.context_max||0,i=n?.context_used||r?.context_used||0,m=g?Math.round(i/g*100):n?.context_percent||r?.context_percent||0,b=(n?.categories||[]).filter(p=>p.tokens>0),T=b.reduce((p,Y)=>p+Y.tokens,0)||1,k=n?.context_files||[];return o(_,{id:"context",title:"Context",children:g?d(N,{children:[d("div",{style:{display:"flex",alignItems:"baseline",justifyContent:"space-between",fontSize:13},children:[d("span",{style:{color:l.text},children:[m,"% used"]}),d("span",{style:c.num,children:[S(i)," / ",S(g)]})]}),o("div",{style:{display:"flex",height:6,borderRadius:99,overflow:"hidden",background:`color-mix(in srgb, ${l.faint} 30%, transparent)`},children:b.length?b.map(p=>o("span",{style:{width:`${p.tokens/T*Math.min(100,m)}%`,background:p.color,marginRight:1}},p.id)):o("span",{style:{width:`${Math.min(100,m)}%`,background:"var(--ui-accent)"}})}),b.map(p=>d("div",{style:{...c.row,padding:"1px 4px"},children:[o("span",{style:{width:10,height:10,borderRadius:3,background:p.color,flexShrink:0}}),o("span",{style:{...c.clip,flex:1},children:p.label}),o("span",{style:c.num,children:S(p.tokens)}),d("span",{style:{...c.num,width:44,textAlign:"right"},children:[(p.tokens/g*100).toFixed(1),"%"]})]},p.id)),d("div",{style:{...c.row,padding:"1px 4px"},children:[o("span",{style:{width:10,height:10,borderRadius:3,border:`1px solid ${l.line}`,flexShrink:0}}),o("span",{style:{...c.clip,flex:1},children:"Free space"}),o("span",{style:c.num,children:S(Math.max(0,g-i))}),d("span",{style:{...c.num,width:44,textAlign:"right"},children:[(Math.max(0,1-i/g)*100).toFixed(1),"%"]})]}),k.length?d(N,{children:[d("button",{onClick:()=>s(!a),style:{...c.row,background:"none",border:0,cursor:"pointer",padding:"3px 4px"},type:"button",children:[o($,{name:a?"chevron-down":"chevron-right",size:"0.75rem"}),o("span",{style:{flex:1,textAlign:"left"},children:"Context files"}),o("span",{style:c.num,children:k.length})]}),a?k.map(p=>o(y,{icon:"file",right:p.loaded?S(p.est_tokens):p.status,title:p.path,children:o("span",{style:{color:p.loaded?l.sub:l.faint},children:p.label||P(p.path)})},p.path)):null]}):null,d("div",{style:c.note,children:[b.length?"Split is estimated. ":"Send a message to see the split. ",f?`Updated ${D((Date.now()-f)/1e3)} ago.`:""]})]}):o("div",{style:c.note,children:"Send a message to see context usage."})})}function de({sid:e}){let t=w(H)[e]||null,{data:r}=R({queryKey:[x,"connectors"],staleTime:300*1e3,refetchInterval:300*1e3,queryFn:async()=>{let[n,u]=await Promise.all([h.request("config.get",{key:"full"}).catch(()=>null),h.request("connectors.list",{owner:{type:"account"}}).catch(()=>null)]),f=Object.entries(n?.config?.mcp_servers||{}).map(([i,m])=>({name:i,enabled:m?.enabled!==!1})),g=(u?.connectors||[]).filter(i=>i.connected).map(i=>({name:i.connector,status:i.connection_status}));return{servers:f,apps:g}}}),a=Object.fromEntries((t||[]).map(n=>[n.name,n])),s=[...(r?.servers||[]).map(n=>{let u=a[n.name],f=!n.enabled||u?.disabled?"off":u?.status||(u?.error?"failed":u?.connected?"connected":null),g=u?.connected===!0||/^(connected|ready|active|ok)$/i.test(f||""),i=u?.tools??u?.tool_count;return{key:`mcp:${n.name}`,name:n.name.replace(/_/g," "),icon:"plug",color:f==="off"?l.faint:u?.error||/fail|error/i.test(f||"")?l.red:g?l.green:l.muted,right:f==="off"?"off":typeof i=="number"?`${i} tools`:"MCP",title:u?.error||f||"MCP server"}}),...(r?.apps||[]).map(n=>({key:`app:${n.name}`,name:n.name,icon:"link",color:l.green,right:"app",title:n.status||"connected"}))];return o(_,{id:"connectors",right:s.length||null,title:"Connectors",children:s.length?o(F,{items:s,render:n=>o(y,{icon:n.icon,iconColor:n.color,right:n.right,title:n.title,children:n.name},n.key)}):o("div",{style:c.note,children:r?"No connectors set up.":"Loading"})})}function ue({env:e}){let t=e?.outputs||[];return o(_,{id:"outputs",right:t.length||null,title:"Outputs",children:t.length?o(F,{items:t,render:r=>o(y,{icon:oe(r.path),onClick:()=>V(r.path),title:`${r.path} (click to copy)`,children:P(r.path)},r.path)}):o("div",{style:c.note,children:e?"No files delivered in this chat yet.":"Loading"})})}var pe={MERGED:{icon:"git-merge",color:l.purple},OPEN:{icon:"git-pull-request",color:l.green},CLOSED:{icon:"git-pull-request-closed",color:l.red}};function fe({env:e}){let t=e?.git,r=e?.prs||[],a=t&&t.dirty>0;return d(_,{id:"changes",right:r.length||null,title:"Changes",children:[a?d(y,{icon:"diff",iconColor:"var(--ui-yellow, #c08532)",title:t.root,children:[t.dirty," uncommitted file",t.dirty===1?"":"s"," in ",P(t.root)," ",d("span",{style:{color:l.green},children:["+",t.add]})," ",d("span",{style:{color:l.red},children:["\u2212",t.del]})]}):null,r.length?o(F,{items:r,render:s=>{let n=s.draft?{icon:"git-pull-request-draft",color:l.faint}:pe[s.state]||{icon:"git-pull-request",color:l.muted};return d("div",{onClick:()=>X(s.url),style:{...c.row,alignItems:"flex-start",cursor:"pointer"},title:s.url,children:[o($,{name:n.icon,size:"0.9rem",style:{color:n.color,flexShrink:0,marginTop:2}}),d("div",{style:{minWidth:0,flex:1},children:[o("div",{style:{...c.clip,color:l.text},children:s.title||`${s.repo} #${s.num}`}),d("div",{style:{...c.note,display:"flex",gap:6,whiteSpace:"nowrap"},children:[d("span",{style:c.clip,children:[s.repo," #",s.num]}),s.add!=null?d("span",{style:{color:l.green},children:["+",s.add]}):null,s.del!=null?d("span",{style:{color:l.red},children:["\u2212",s.del]}):null,o("span",{style:{marginLeft:"auto",flexShrink:0},children:s.draft?"draft":(s.state||"").toLowerCase()})]})]})]},s.url)}}):null,!a&&!r.length?o("div",{style:c.note,children:e?"No changes or pull requests in this chat yet.":"Loading"}):null]})}function V(e){Promise.resolve(j?.writeClipboard?.(e)).then(t=>h.notify?.({kind:t===!1?"error":"success",message:t===!1?"Could not copy":"Path copied"})).catch(()=>{})}function X(e){Promise.resolve(j?.openExternal?.(e)).catch(()=>{})}function he(){let e=w(v("focusedSessionId")),t=w(v("focusedStoredSessionId")),r=w(v("cwd")),a=!!w(v("busy")),s=R({queryKey:[x,"backend",t,r],enabled:!!(t&&/^[\w.-]+$/.test(t)),refetchInterval:a?2e4:6e4,staleTime:1e4,queryFn:()=>ne(t,r)});G(()=>{s.error&&E("backend-error",{message:C(s.error)})},[s.error]);let n=s.data||null;return!e&&!t?o("div",{style:{padding:16,...c.note},children:"Open a chat to see its details."}):o("div",{style:{height:"100%",overflowY:"auto"},children:d("div",{style:{display:"flex",flexDirection:"column",gap:10,padding:12,maxWidth:520},children:[o(ie,{busy:a,sid:e}),o(le,{env:n,loading:s.isLoading}),o(ce,{busy:a,sid:e}),o(de,{sid:e}),o(ue,{env:n}),o(fe,{env:n}),s.error&&!n?o("div",{style:{...c.note,color:l.red},children:C(s.error)}):null]})})}var xe={id:x,name:"Session panel",register(e){j=e.os||null;let t=null,r=()=>{try{return!!h.paneVisibility?.(U)?.get()}catch{return!1}},a=()=>{try{t&&r()?(t(),t=null):t?h.revealPane?.(U):t=h.openWorkspace(z,{title:"Session",minWidth:"18rem",dock:{pane:"workspace",pos:"right"},render:()=>o(he,{}),onClose:()=>{t=null}}),E("toggle",{open:!!t,visible:r()})}catch(n){E("toggle-error",{message:C(n)}),h.notify?.({kind:"error",message:`Session panel: ${C(n)}`})}},s=n=>{let u=n?.session_id||n?.payload?.session_id,f=n?.payload?.mcp_servers??n?.mcp_servers??n?.payload?.info?.mcp_servers;u&&Array.isArray(f)&&H.set({...H.get(),[u]:f})};typeof e.onEvent=="function"?e.onEvent("session.info",s):h.onEvent?.("session.info",s),e.onDispose?.(()=>t?.()),E("loaded",{workspace:typeof h.openWorkspace=="function"}),J().catch(n=>E("install-error",{message:C(n)})),e.register({id:"titlebar",area:"titleBar.tools.right",data:{id:"session-panel",label:"Session details",icon:o($,{className:"leading-none",name:"list-unordered",size:"13.9px"}),onSelect:a}}),e.register({id:"palette",area:Z,data:{id:"session-panel.toggle",label:"Toggle session panel",keywords:["session","context","agents","outputs","changes","connectors","environment"],run:a}})}};export{xe as default};
