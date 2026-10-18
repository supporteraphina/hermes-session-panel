/* Session panel for Hermes Desktop. Source: src/ in this repo. */
import{Codicon as $,host as h,PALETTE_AREA as le,atom as q,useQuery as A,useValue as w}from"@hermes/plugin-sdk";import{useEffect as W,useState as L}from"react";import{useLayoutEffect as ee,useRef as te}from"react";import{jsx as ie}from"react/jsx-runtime";var ne="hermes:titlebar-chrome-changed";function oe(e){for(let t=e?.parentElement;t&&t!==document.body;t=t.parentElement)if(getComputedStyle(t).position==="fixed")return t;return null}function re(e,t){return e.left<t.right&&t.left<e.right&&e.top<t.bottom&&t.top<e.bottom}function se(e){if(!e)return null;let t=e.getBoundingClientRect(),s=0;for(let i of document.querySelectorAll("[data-window-drag-handle]")){let r=i.getBoundingClientRect();r.width&&re(t,r)&&s++}return s}function F({children:e,onReport:t}){let s=te(null);return ee(()=>{let i=oe(s.current);if(!i)return;let r=!1;if(i.hasAttribute("data-titlebar-cluster")||(i.setAttribute("data-titlebar-cluster","right"),r=!0,window.dispatchEvent(new CustomEvent(ne))),t){let n=setTimeout(()=>t({tagged:r,cluster:i.getAttribute("data-titlebar-cluster"),dragOverlap:se(i)}),1500);return()=>clearTimeout(n)}},[t]),ie("span",{ref:s,style:{display:"inline-flex",alignItems:"center",justifyContent:"center"},children:e})}var P=`#!/usr/bin/env python3
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
`;import{Fragment as T,jsx as o,jsxs as d}from"react/jsx-runtime";var b="session-panel",J=`${b}:panel`,U=`plugin-workspace:${J}`,K="/usr/bin/python3",G='"$HOME/.hermes/session-panel/panel.py"',j=null,M=q({}),ce=q(null),v=e=>h.state?.[e]||ce,V=e=>btoa(unescape(encodeURIComponent(e)));function de(e){let t=5381;for(let s=0;s<e.length;s++)t=(t<<5)+t+e.charCodeAt(s)|0;return(t>>>0).toString(36)}var C=e=>e instanceof Error?e.message:String(e?.message??e);async function H(e){let t=await h.request("shell.exec",{command:e});if(!t||t.code!==0)throw new Error(t&&(t.stderr||t.stdout)||"command failed");return t.stdout||""}function _(e,t={}){try{let s=V(JSON.stringify({t:new Date().toISOString(),event:e,...t})+`
`);h.request("shell.exec",{command:`echo ${s} | base64 -d >> "$HOME/.hermes/session-panel.log"`}).catch(()=>{})}catch{}}var R=null;function X(){if(!R){let e=de(P),t='"$HOME/.hermes/session-panel"';R=H(`mkdir -p ${t} && if [ "$(cat ${t}/.v 2>/dev/null)" != "${e}" ]; then echo ${V(P)} | base64 -d > ${t}/panel.py && echo ${e} > ${t}/.v; fi; echo ok`).catch(s=>{throw R=null,s})}return R}async function ue(e,t){await X();let s=t&&/^[\w/.@+\- ]+$/.test(t)?` --cwd '${t}'`:"",i=(await H(`${K} ${G} --session ${e}${s}`)).trim().split(`
`).pop(),r=JSON.parse(i);if(!r.chunks)return r;let n="";for(let u=0;u<r.chunks;u++)n+=await H(`${K} ${G} --chunk ${u} --key ${r.key}`);return JSON.parse(n)}function E(e){return e=Number(e)||0,e>=1e6?`${+(e/1e6).toFixed(e%1e6?1:0)}M`:e>=1e3?`${(e/1e3).toFixed(1)}k`:String(e)}function D(e){let t=Math.max(0,Math.round(e));return t<60?`${t}s`:t<3600?`${Math.floor(t/60)}m`:`${Math.floor(t/3600)}h ${Math.floor(t%3600/60)}m`}var N=e=>String(e||"").split("/").filter(Boolean).pop()||e;function pe(e){let t=String(e).split(".").pop().toLowerCase();return["png","jpg","jpeg","gif","webp","svg"].includes(t)?"file-media":["mp4","mov","webm","mp3","wav","m4a","ogg"].includes(t)?"play-circle":["md","txt"].includes(t)?"markdown":["pdf","docx","xlsx","pptx","csv"].includes(t)?"file":["html","htm"].includes(t)?"globe":"file-code"}var l={text:"var(--ui-text-primary, var(--foreground))",sub:"var(--ui-text-secondary)",muted:"var(--ui-text-tertiary)",faint:"var(--ui-text-quaternary)",line:"var(--ui-stroke-tertiary, var(--border))",green:"var(--ui-green, #55a583)",red:"var(--ui-red, #e75e78)",purple:"var(--ui-purple, #a78bfa)",hover:"var(--ui-row-hover-background, rgb(255 255 255 / 0.04))"},c={card:{border:`1px solid ${l.line}`,borderRadius:12,padding:"10px 12px 12px",display:"flex",flexDirection:"column",gap:6},head:{display:"flex",alignItems:"center",gap:4,background:"none",border:0,padding:"2px 0",color:l.text,fontSize:13,fontWeight:500,cursor:"pointer",textAlign:"left"},row:{display:"flex",alignItems:"center",gap:8,minWidth:0,fontSize:13,color:l.sub,borderRadius:6,padding:"3px 4px",margin:"0 -4px"},clip:{overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",minWidth:0},note:{fontSize:12,color:l.muted,lineHeight:1.4},num:{fontVariantNumeric:"tabular-nums",color:l.muted,fontSize:12,flexShrink:0}};function fe(){try{return JSON.parse(localStorage.getItem(`${b}:collapsed`)||"{}")}catch{return{}}}var I=q(fe());function k({id:e,title:t,right:s,children:i}){let n=!w(I)[e],u=()=>{let f={...I.get(),[e]:n};I.set(f);try{localStorage.setItem(`${b}:collapsed`,JSON.stringify(f))}catch{}};return d("section",{style:c.card,children:[d("div",{style:{display:"flex",alignItems:"center",gap:8},children:[d("button",{onClick:u,style:c.head,type:"button",children:[t,o($,{name:n?"chevron-down":"chevron-right",size:"0.75rem",style:{opacity:.55}})]}),o("span",{style:{marginLeft:"auto",...c.num},children:s})]}),n?i:null]})}function y({icon:e,iconColor:t,children:s,right:i,title:r,onClick:n}){let[u,f]=L(!1);return d("div",{onClick:n,onMouseEnter:()=>f(!0),onMouseLeave:()=>f(!1),style:{...c.row,cursor:n?"pointer":"default",background:n&&u?l.hover:"transparent"},title:r,children:[e?o($,{name:e,size:"0.9rem",style:{color:t||l.muted,flexShrink:0}}):null,o("div",{style:{...c.clip,flex:1},children:s}),i!=null?o("span",{style:c.num,children:i}):null]})}function he({color:e,pulse:t}){return o("span",{style:{display:"block",width:7,height:7,borderRadius:99,background:e,flexShrink:0,boxShadow:t?`0 0 0 3px color-mix(in srgb, ${e} 25%, transparent)`:"none"}})}function B({items:e,limit:t=5,render:s}){let[i,r]=L(!1),n=i?e:e.slice(0,t);return d(T,{children:[n.map(s),e.length>t?o("button",{onClick:()=>r(!i),style:{...c.note,background:"none",border:0,padding:"2px 0",textAlign:"left",cursor:"pointer"},type:"button",children:i?"Show less":`Show ${e.length-t} more`}):null]})}function ge({sid:e,busy:t}){let s=w(v("model")),{data:i}=A({queryKey:[b,"agents",e],enabled:!!e,refetchInterval:t?3e3:12e3,queryFn:async()=>{let[a,m]=await Promise.all([h.request("subagent.list",{session_id:e}).catch(()=>null),h.request("process.list",{session_id:e}).catch(()=>null)]);return{subs:a?.subagents||[],failed:a?.delegations||[],procs:m?.processes||[]}}}),r=i?.subs||[],n=(i?.procs||[]).filter(a=>!/exited|done|killed/i.test(a.status||"")),u=(i?.failed||[]).slice(0,3),f=Date.now()/1e3,g=r.filter(a=>!["completed","failed","interrupted","cancelled"].includes(String(a.status||"").toLowerCase()));return d(k,{id:"agents",right:g.length+n.length?`${g.length+n.length} running`:null,title:"Agents",children:[d(y,{icon:"hubot",iconColor:t?l.green:l.muted,right:t?"Working":"Idle",children:[o("span",{style:{color:l.text},children:"Hermes"}),o("span",{style:{color:l.faint},children:s?`  ${s}`:""})]}),r.map(a=>{let m=String(a.status||"running").toLowerCase(),x=!["completed","failed","interrupted","cancelled"].includes(m),O=m==="failed"?l.red:x?l.green:l.faint,S=[a.model,a.tool_count!=null?`${a.tool_count} tools`:null,a.last_tool,a.started_at?D(f-a.started_at):null].filter(Boolean).join(" \xB7 ");return d("div",{style:{...c.row,alignItems:"flex-start"},title:a.goal||"",children:[o("span",{style:{width:14.4,flexShrink:0,display:"flex",justifyContent:"center",paddingTop:6},children:o(he,{color:O,pulse:x})}),d("div",{style:{minWidth:0,flex:1},children:[o("div",{style:{...c.clip,color:l.text},children:a.goal||"Helper agent"}),o("div",{style:{...c.clip,...c.note},children:S||m})]})]},a.subagent_id)}),n.map(a=>o(y,{icon:"terminal",right:a.uptime!=null?D(a.uptime):a.status,title:a.command,children:a.command},a.session_id)),u.map(a=>d(y,{icon:"error",iconColor:l.red,title:a.error||"",children:[a.goal||"Helper agent"," ",o("span",{style:{color:l.faint},children:"failed"})]},`${a.delegation_id}:${a.task_index}`)),!r.length&&!n.length&&!u.length?o("div",{style:c.note,children:"No helper agents or background jobs in this chat."}):null]})}function me(){let e=w(v("connectionId")),{data:t}=A({queryKey:[b,"connections"],staleTime:300*1e3,queryFn:async()=>typeof h.connections=="function"?h.connections():[]}),s=Array.isArray(t)?t:[],i=s.find(r=>r.id===e)||s.find(r=>r.primary);return i?.label||i?.name||null}function ye({env:e,loading:t}){let s=me(),i=e?.git;return d(k,{id:"environment",title:"Environment",children:[o(y,{icon:"cloud",title:e?`${e.user}@${e.host}`:"",children:s||e?.host||"Backend"}),o(y,{icon:"folder",onClick:e?.cwd?()=>Y(e.cwd):void 0,title:e?.cwd?`${e.cwd} (click to copy)`:"",children:e?.cwd?N(e.cwd)||e.cwd:t?"Loading":"Unknown"}),i?d(T,{children:[o(y,{icon:"repo",onClick:i.repo?.includes("/")?()=>Q(`https://github.com/${i.repo}`):void 0,title:i.root,children:i.repo}),o(y,{icon:"git-branch",children:i.branch})]}):e?o("div",{style:{...c.note,paddingLeft:22},children:"Folder is not a git repo"}):null]})}function we({sid:e,busy:t}){let s=w(v("focusedUsage")),[i,r]=L(!1),{data:n,refetch:u,dataUpdatedAt:f}=A({queryKey:[b,"context",e],enabled:!!e,refetchInterval:t?15e3:6e4,queryFn:()=>h.request("session.context_breakdown",{session_id:e})});W(()=>{!t&&e&&u()},[t,e,u]);let g=n?.context_max||s?.context_max||0,a=n?.context_used||s?.context_used||0,m=g?Math.round(a/g*100):n?.context_percent||s?.context_percent||0,x=(n?.categories||[]).filter(p=>p.tokens>0),O=x.reduce((p,Z)=>p+Z.tokens,0)||1,S=n?.context_files||[];return o(k,{id:"context",title:"Context",children:g?d(T,{children:[d("div",{style:{display:"flex",alignItems:"baseline",justifyContent:"space-between",fontSize:13},children:[d("span",{style:{color:l.text},children:[m,"% used"]}),d("span",{style:c.num,children:[E(a)," / ",E(g)]})]}),o("div",{style:{display:"flex",height:6,borderRadius:99,overflow:"hidden",background:`color-mix(in srgb, ${l.faint} 30%, transparent)`},children:x.length?x.map(p=>o("span",{style:{width:`${p.tokens/O*Math.min(100,m)}%`,background:p.color,marginRight:1}},p.id)):o("span",{style:{width:`${Math.min(100,m)}%`,background:"var(--ui-accent)"}})}),x.map(p=>d("div",{style:{...c.row,padding:"1px 4px"},children:[o("span",{style:{width:10,height:10,borderRadius:3,background:p.color,flexShrink:0}}),o("span",{style:{...c.clip,flex:1},children:p.label}),o("span",{style:c.num,children:E(p.tokens)}),d("span",{style:{...c.num,width:44,textAlign:"right"},children:[(p.tokens/g*100).toFixed(1),"%"]})]},p.id)),d("div",{style:{...c.row,padding:"1px 4px"},children:[o("span",{style:{width:10,height:10,borderRadius:3,border:`1px solid ${l.line}`,flexShrink:0}}),o("span",{style:{...c.clip,flex:1},children:"Free space"}),o("span",{style:c.num,children:E(Math.max(0,g-a))}),d("span",{style:{...c.num,width:44,textAlign:"right"},children:[(Math.max(0,1-a/g)*100).toFixed(1),"%"]})]}),S.length?d(T,{children:[d("button",{onClick:()=>r(!i),style:{...c.row,background:"none",border:0,cursor:"pointer",padding:"3px 4px"},type:"button",children:[o($,{name:i?"chevron-down":"chevron-right",size:"0.75rem"}),o("span",{style:{flex:1,textAlign:"left"},children:"Context files"}),o("span",{style:c.num,children:S.length})]}),i?S.map(p=>o(y,{icon:"file",right:p.loaded?E(p.est_tokens):p.status,title:p.path,children:o("span",{style:{color:p.loaded?l.sub:l.faint},children:p.label||N(p.path)})},p.path)):null]}):null,d("div",{style:c.note,children:[x.length?"Split is estimated. ":"Send a message to see the split. ",f?`Updated ${D((Date.now()-f)/1e3)} ago.`:""]})]}):o("div",{style:c.note,children:"Send a message to see context usage."})})}function be({sid:e}){let t=w(M)[e]||null,{data:s}=A({queryKey:[b,"connectors"],staleTime:300*1e3,refetchInterval:300*1e3,queryFn:async()=>{let[n,u]=await Promise.all([h.request("config.get",{key:"full"}).catch(()=>null),h.request("connectors.list",{owner:{type:"account"}}).catch(()=>null)]),f=Object.entries(n?.config?.mcp_servers||{}).map(([a,m])=>({name:a,enabled:m?.enabled!==!1})),g=(u?.connectors||[]).filter(a=>a.connected).map(a=>({name:a.connector,status:a.connection_status}));return{servers:f,apps:g}}}),i=Object.fromEntries((t||[]).map(n=>[n.name,n])),r=[...(s?.servers||[]).map(n=>{let u=i[n.name],f=!n.enabled||u?.disabled?"off":u?.status||(u?.error?"failed":u?.connected?"connected":null),g=u?.connected===!0||/^(connected|ready|active|ok)$/i.test(f||""),a=u?.tools??u?.tool_count;return{key:`mcp:${n.name}`,name:n.name.replace(/_/g," "),icon:"plug",color:f==="off"?l.faint:u?.error||/fail|error/i.test(f||"")?l.red:g?l.green:l.muted,right:f==="off"?"off":typeof a=="number"?`${a} tools`:"MCP",title:u?.error||f||"MCP server"}}),...(s?.apps||[]).map(n=>({key:`app:${n.name}`,name:n.name,icon:"link",color:l.green,right:"app",title:n.status||"connected"}))];return o(k,{id:"connectors",right:r.length||null,title:"Connectors",children:r.length?o(B,{items:r,render:n=>o(y,{icon:n.icon,iconColor:n.color,right:n.right,title:n.title,children:n.name},n.key)}):o("div",{style:c.note,children:s?"No connectors set up.":"Loading"})})}function xe({env:e}){let t=e?.outputs||[];return o(k,{id:"outputs",right:t.length||null,title:"Outputs",children:t.length?o(B,{items:t,render:s=>o(y,{icon:pe(s.path),onClick:()=>Y(s.path),title:`${s.path} (click to copy)`,children:N(s.path)},s.path)}):o("div",{style:c.note,children:e?"No files delivered in this chat yet.":"Loading"})})}var ve={MERGED:{icon:"git-merge",color:l.purple},OPEN:{icon:"git-pull-request",color:l.green},CLOSED:{icon:"git-pull-request-closed",color:l.red}};function _e({env:e}){let t=e?.git,s=e?.prs||[],i=t&&t.dirty>0;return d(k,{id:"changes",right:s.length||null,title:"Changes",children:[i?d(y,{icon:"diff",iconColor:"var(--ui-yellow, #c08532)",title:t.root,children:[t.dirty," uncommitted file",t.dirty===1?"":"s"," in ",N(t.root)," ",d("span",{style:{color:l.green},children:["+",t.add]})," ",d("span",{style:{color:l.red},children:["\u2212",t.del]})]}):null,s.length?o(B,{items:s,render:r=>{let n=r.draft?{icon:"git-pull-request-draft",color:l.faint}:ve[r.state]||{icon:"git-pull-request",color:l.muted};return d("div",{onClick:()=>Q(r.url),style:{...c.row,alignItems:"flex-start",cursor:"pointer"},title:r.url,children:[o($,{name:n.icon,size:"0.9rem",style:{color:n.color,flexShrink:0,marginTop:2}}),d("div",{style:{minWidth:0,flex:1},children:[o("div",{style:{...c.clip,color:l.text},children:r.title||`${r.repo} #${r.num}`}),d("div",{style:{...c.note,display:"flex",gap:6,whiteSpace:"nowrap"},children:[d("span",{style:c.clip,children:[r.repo," #",r.num]}),r.add!=null?d("span",{style:{color:l.green},children:["+",r.add]}):null,r.del!=null?d("span",{style:{color:l.red},children:["\u2212",r.del]}):null,o("span",{style:{marginLeft:"auto",flexShrink:0},children:r.draft?"draft":(r.state||"").toLowerCase()})]})]})]},r.url)}}):null,!i&&!s.length?o("div",{style:c.note,children:e?"No changes or pull requests in this chat yet.":"Loading"}):null]})}function Y(e){Promise.resolve(j?.writeClipboard?.(e)).then(t=>h.notify?.({kind:t===!1?"error":"success",message:t===!1?"Could not copy":"Path copied"})).catch(()=>{})}function Q(e){Promise.resolve(j?.openExternal?.(e)).catch(()=>{})}function ke(){let e=w(v("focusedSessionId")),t=w(v("focusedStoredSessionId")),s=w(v("cwd")),i=!!w(v("busy")),r=A({queryKey:[b,"backend",t,s],enabled:!!(t&&/^[\w.-]+$/.test(t)),refetchInterval:i?2e4:6e4,staleTime:1e4,queryFn:()=>ue(t,s)});W(()=>{r.error&&_("backend-error",{message:C(r.error)})},[r.error]);let n=r.data||null;return!e&&!t?o("div",{style:{padding:16,...c.note},children:"Open a chat to see its details."}):o("div",{style:{height:"100%",overflowY:"auto"},children:d("div",{style:{display:"flex",flexDirection:"column",gap:10,padding:12,maxWidth:520},children:[o(ge,{busy:i,sid:e}),o(ye,{env:n,loading:r.isLoading}),o(we,{busy:i,sid:e}),o(be,{sid:e}),o(xe,{env:n}),o(_e,{env:n}),r.error&&!n?o("div",{style:{...c.note,color:l.red},children:C(r.error)}):null]})})}var z=!1;function Se(e){z||(z=!0,_("titlebar",e))}var Pe={id:b,name:"Session panel",register(e){j=e.os||null;let t=null,s=()=>{try{return!!h.paneVisibility?.(U)?.get()}catch{return!1}},i=()=>{try{t&&s()?(t(),t=null):t?h.revealPane?.(U):t=h.openWorkspace(J,{title:"Session",minWidth:"18rem",dock:{pane:"workspace",pos:"right"},render:()=>o(ke,{}),onClose:()=>{t=null}}),_("toggle",{open:!!t,visible:s()})}catch(n){_("toggle-error",{message:C(n)}),h.notify?.({kind:"error",message:`Session panel: ${C(n)}`})}},r=n=>{let u=n?.session_id||n?.payload?.session_id,f=n?.payload?.mcp_servers??n?.mcp_servers??n?.payload?.info?.mcp_servers;u&&Array.isArray(f)&&M.set({...M.get(),[u]:f})};typeof e.onEvent=="function"?e.onEvent("session.info",r):h.onEvent?.("session.info",r),e.onDispose?.(()=>t?.()),_("loaded",{workspace:typeof h.openWorkspace=="function"}),X().catch(n=>_("install-error",{message:C(n)})),e.register({id:"titlebar",area:"titleBar.tools.right",data:{id:"session-panel",label:"Session details",icon:o(F,{onReport:Se,children:o($,{className:"leading-none",name:"list-unordered",size:"13.9px"})}),onSelect:i}}),e.register({id:"palette",area:le,data:{id:"session-panel.toggle",label:"Toggle session panel",keywords:["session","context","agents","outputs","changes","connectors","environment"],run:i}})}};export{Pe as default};
